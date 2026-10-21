import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDoor } from "../src/door";
import { Listener } from "../src/listener";
import { Store } from "../src/store";
import { checkSchema, dueReminders, monthlyDue, postReminders, render, status, toBill, type Bill, noticeHours } from "../jobs/bills_export";

const page = (over: Record<string, any> = {}) => ({
  properties: {
    Bill: { type: "title", title: [{ plain_text: "Rent" }] },
    Split: { type: "select", select: { name: "Shared (Alex)" } },
    Amount: { type: "number", number: 1700 },
    Cadence: { type: "select", select: { name: "Monthly" } },
    "Due day": { type: "number", number: 5 },
    Autopay: { type: "checkbox", checkbox: false },
    "Pay method": { type: "rich_text", rich_text: [{ plain_text: "Landlord portal" }] },
    Feed: { type: "select", select: { name: "Email" } },
    "Last paid": { type: "date", date: { start: "2026-09-01" } },
    Notes: { type: "rich_text", rich_text: [] },
    "Sam Owes": { type: "formula", formula: { type: "number", number: 850 } },
    "Renews on": { type: "date", date: null },
    ...over,
  },
});
const bill = (over: Partial<Bill> = {}): Bill => ({ ...toBill(page()), ...over });

describe("bills export", () => {
  test("a row is copied field for field", () => {
    expect(toBill(page())).toEqual({
      bill: "Rent", split: "Shared (Alex)", amount: 1700, cadence: "Monthly", dueDay: 5, autopay: false,
      payMethod: "Landlord portal", feed: "Email", lastPaid: "2026-09-01", notes: "", samOwes: 850, alexOwes: 0, renewsOn: null,
    });
  });

  test("the one signed owes figure splits into who owes whom", () => {
    const owes = (number: number | null) => toBill(page({ "Sam Owes": { type: "formula", formula: { type: "number", number } } }));
    expect(owes(-60)).toMatchObject({ samOwes: 0, alexOwes: 60 }); // Sam paid a shared bill
    expect(owes(null)).toMatchObject({ samOwes: null, alexOwes: null }); // a bill that is Alex's alone, or no amount yet
  });

  test("a renamed or retyped column fails loudly", () => {
    expect(() => toBill(page({ Amount: { type: "rich_text", rich_text: [] } }))).toThrow("Amount: expected number, found rich_text");
    const p = page().properties as any;
    delete p["Due day"];
    expect(() => checkSchema(p)).toThrow("Due day: expected number, found nothing");
  });

  test("monthly due dates", () => {
    expect(monthlyDue(5, "2026-10-01")).toEqual({ previous: "2026-09-05", next: "2026-10-05" });
    expect(monthlyDue(5, "2026-10-05")).toEqual({ previous: "2026-10-05", next: "2026-10-05" });
    expect(monthlyDue(5, "2026-10-06")).toEqual({ previous: "2026-10-05", next: "2026-11-05" });
    expect(monthlyDue(30, "2027-01-31")).toEqual({ previous: "2027-01-30", next: "2027-02-28" });
    expect(monthlyDue(31, "2026-12-31")).toEqual({ previous: "2026-12-31", next: "2026-12-31" });
    expect(monthlyDue(10, "2026-01-03")).toEqual({ previous: "2025-12-10", next: "2026-01-10" });
  });

  test("status follows the bills rule", () => {
    expect(status(bill({ autopay: true }), "2026-10-01")).toEqual({ status: "Autopay", nextDue: "2026-10-05" });
    expect(status(bill({ lastPaid: "2026-09-05" }), "2026-10-01").status).toBe("Paid");
    expect(status(bill({ lastPaid: "2026-09-01" }), "2026-10-01").status).toBe("Unpaid"); // paid before the Sept 5 due date
    expect(status(bill({ lastPaid: null }), "2026-10-01").status).toBe("Unpaid");
    expect(status(bill({ dueDay: null }), "2026-10-01")).toEqual({ status: "Review", nextDue: null });
    expect(status(bill({ cadence: "Annual" }), "2026-10-01")).toEqual({ status: "Review", nextDue: null });
  });

  test("the file carries its date, sorts by next due and marks blanks", () => {
    const out = render([bill({ bill: "Later", dueDay: 20 }), bill({ bill: "Electric", amount: null, dueDay: 3 })], "2026-10-01", "2026-10-01T13:30:00.000Z");
    expect(out).toContain("Generated: 2026-10-01T13:30:00.000Z");
    const lines = out.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Bill"));
    expect(lines[0]).toContain("Electric");
    expect(lines[0]).toContain("not recorded");
    expect(lines[1]).toContain("Later");
    expect(lines[1]).toContain("| $850.00 |  |"); // Sam owes copied, a zero shown blank
  });

  test("an annual bill's next due is its Renews on date", () => {
    const yt = bill({ bill: "YouTube Premium", cadence: "Annual", dueDay: null, autopay: true, renewsOn: "2027-08-10" });
    expect(status(yt, "2026-10-01")).toEqual({ status: "Autopay", nextDue: "2027-08-10" });
    expect(render([yt], "2026-10-01", "x")).toContain("| 2027-08-10 |");
  });

  describe("renewal reminders", () => {
    const yt = bill({ bill: "YouTube Premium", amount: 159.99, renewsOn: "2027-08-10", notes: "Prepaid plan." });
    const on = (today: string) => dueReminders([yt, bill({ bill: "Rent" })], today);

    test("nothing before 30 days, nothing after the date, nothing for a bill with no date", () => {
      expect(on("2027-07-10")).toEqual([]); // 31 days
      expect(on("2027-08-11")).toEqual([]);
    });

    test("one id through the 30-day window and another through the 7-day window", () => {
      expect(on("2027-07-11")[0]!.id).toBe("renewal:youtube-premium:2027-08-10:30");
      expect(on("2027-08-02")[0]!.id).toBe("renewal:youtube-premium:2027-08-10:30"); // 8 days: same notice, door dedupes
      expect(on("2027-08-03")[0]!.id).toBe("renewal:youtube-premium:2027-08-10:7");
      expect(on("2027-08-10")[0]!.id).toBe("renewal:youtube-premium:2027-08-10:7");
    });

    test("the text names the bill, the date, the days and the amount", () => {
      expect(on("2027-07-11")[0]!.text).toBe('Reminder: YouTube Premium reaches its "Renews on" date in 30 days (2027-08-10), $159.99 on file. Prepaid plan.');
      expect(on("2027-08-09")[0]!.text).toContain("tomorrow");
      expect(on("2027-08-10")[0]!.text).toContain("today");
    });

    test("a changed date gets a fresh pair of notices", () => {
      const moved = dueReminders([{ ...yt, renewsOn: "2027-08-20" }], "2027-08-01");
      expect(moved[0]!.id).toBe("renewal:youtube-premium:2027-08-20:30");
    });

    test("a notice is posted to the door once; an unreachable listener is reported, not thrown", async () => {
      const seen: any[] = [];
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { seen.push(await req.json()); return Response.json({ status: "accepted" }, { status: 202 }); } });
      try {
        expect(await postReminders(on("2027-07-11"), server.port)).toEqual(["renewal:youtube-premium:2027-08-10:30: accepted"]);
        expect(seen[0]).toMatchObject({ id: "renewal:youtube-premium:2027-08-10:30", to: "alex", mode: "notify" });
      } finally {
        server.stop(true);
      }
      expect((await postReminders(on("2027-07-11"), 1))[0]).toContain("will retry next run");
    });
  });

  test("end to end: a reminder posted on two mornings reaches Alex's thread once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-remind-"));
    const sent: { threadId: string; text: string }[] = [];
    const store = new Store(join(dir, "queue.sqlite"));
    const listener = new Listener(store, { async send(threadId, _l, text) { sent.push({ threadId, text }); } },
      async () => { throw new Error("a notice must not start a Claude run"); }, { async notify() {} }, () => {});
    const door = startDoor(() => listener, 0);
    try {
      const notices = dueReminders([bill({ bill: "Internet", amount: 41.25, renewsOn: "2027-04-25" })], "2027-03-26");
      expect((await postReminders(notices, door.port))[0]).toContain("no_thread"); // before Alex has ever texted
      store.rememberThread("alex", "thread-alex", null);
      expect((await postReminders(notices, door.port))[0]).toContain("accepted");
      expect((await postReminders(notices, door.port))[0]).toContain("duplicate");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.threadId).toBe("thread-alex");
      expect(sent[0]!.text).toStartWith("Reminder: Internet");
    } finally {
      door.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("notice hours", () => {
  test("renewal texts go out from 7 AM to 9 PM Pacific and never overnight", () => {
    const at = (iso: string) => noticeHours("America/Los_Angeles", new Date(iso));
    expect(at("2026-10-05T07:30:00Z")).toBe(false); // 12:30 AM
    expect(at("2026-10-05T13:30:00Z")).toBe(false); // 6:30 AM
    expect(at("2026-10-05T14:30:00Z")).toBe(true); // 7:30 AM
    expect(at("2026-10-06T03:30:00Z")).toBe(true); // 8:30 PM
    expect(at("2026-10-06T04:30:00Z")).toBe(false); // 9:30 PM
  });
});
