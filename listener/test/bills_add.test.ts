// Bills tool checks. A run can propose one row for Notion's "Bills (recurring)" database:
//   1. nothing is written until the person was shown the row and texted back (src/approval.ts);
//   2. bad fields are refused before any request, and an option the tracker lacks comes back with the list;
//   3. a bill already in the tracker is not added twice, and changed columns stop the tool;
//   4. one run adds at most MAX_ADDS rows, and the server offers exactly one tool;
//   5. a yes to the morning check's text counts for a bill row and for nothing else.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastAsk, showsRow } from "../src/approval";
import { Store } from "../src/store";
import { addBill, MAX_ADDS, toRow, type BillsDeps } from "../src/bills/notion";
import { DATA_SOURCE } from "../jobs/bills_export";
import { TOOLS } from "../src/bills/server";

const PROPERTIES = {
  Bill: { type: "title" }, Amount: { type: "number" }, "Due day": { type: "number" }, Autopay: { type: "checkbox" },
  "Pay method": { type: "rich_text" }, "Last paid": { type: "date" }, Notes: { type: "rich_text" }, "Sam Owes": { type: "formula" }, "Renews on": { type: "date" },
  Split: { type: "select", select: { options: [{ name: "Mine" }, { name: "Shared (Alex)" }, { name: "Shared (Sam)" }] } },
  Cadence: { type: "select", select: { options: [{ name: "Monthly" }, { name: "Annual" }, { name: "Every 2 weeks" }] } },
  Feed: { type: "select", select: { options: [{ name: "Email" }] } },
};

function fakeDeps(existing: string[] = ["Rent"], properties: any = PROPERTIES) {
  const calls: { method: string; path: string; body?: any }[] = [];
  const said = { reply: null as string | null }; // Jarvis's last reply to the person, as the approval check sees it
  const refreshed = { n: 0, fail: false };
  const deps: BillsDeps = {
    adds: { n: 0 },
    readKey: () => "k",
    approved: (row) => !!said.reply && showsRow(said.reply, row),
    refresh: async () => {
      refreshed.n++;
      if (refreshed.fail) throw new Error("copy failed");
    },
    fetch: async (url, init) => {
      const method = init?.method ?? "GET";
      const path = new URL(url).pathname;
      calls.push({ method, path, body: init?.body ? JSON.parse(init.body) : undefined });
      const ok = (body: any) => ({ ok: true, status: 200, json: async () => body });
      if (path.endsWith("/query")) return ok({ results: existing.map((t) => ({ properties: { Bill: { title: [{ plain_text: t }] } } })), has_more: false });
      if (path.startsWith("/v1/data_sources/")) return ok({ properties });
      return ok({ id: "new-page" });
    },
  };
  return { deps, calls, said, refreshed };
}
const writes = <T extends { path: string }>(calls: T[]) => calls.filter((c) => c.path === "/v1/pages");
const paramount = { bill: "Paramount+", amount: 8.99, cadence: "monthly", due_day: 20, renews_on: "2026-10-20", notes: "Promo ends; cancel before then." };

describe("the go-ahead", () => {
  test("a row the person has not been shown is not written", async () => {
    const { deps, calls, refreshed } = fakeDeps();
    const out = await addBill(paramount, deps);
    expect(out).toMatchObject({ added: false, needs_go_ahead: true });
    expect(out.say).toContain("Not added");
    expect(writes(calls)).toEqual([]);
    expect(refreshed.n).toBe(0);
  });

  test("a reply about something else, or with a different amount, approves nothing", async () => {
    const { deps, calls, said } = fakeDeps();
    said.reply = "Remove Dentist, Tuesday at 3? Reply yes.";
    expect((await addBill(paramount, deps)).added).toBe(false);
    said.reply = "Add Paramount+ at $12.99 a month? Reply yes.";
    expect((await addBill(paramount, deps)).added).toBe(false);
    expect(writes(calls)).toEqual([]);
  });

  test("once the row was shown and the person texted back, it is written as proposed and the copy is remade", async () => {
    const { deps, calls, said, refreshed } = fakeDeps();
    said.reply = "Add Paramount+ at $8.99 a month, due the 20th, promo ending October 20? Reply yes.";
    const out = await addBill(paramount, deps);
    expect(out).toMatchObject({ added: true, copy_refreshed: true, row: { bill: "Paramount+", amount: 8.99, cadence: "Monthly" } });
    expect(writes(calls)).toHaveLength(1);
    expect(writes(calls)[0]!.body).toEqual({
      parent: { type: "data_source_id", data_source_id: DATA_SOURCE },
      properties: {
        Bill: { title: [{ text: { content: "Paramount+" } }] },
        Amount: { number: 8.99 },
        Cadence: { select: { name: "Monthly" } },
        "Due day": { number: 20 },
        "Renews on": { date: { start: "2026-10-20" } },
        Notes: { rich_text: [{ text: { content: "Promo ends; cancel before then." } }] },
      },
    });
    expect(refreshed.n).toBe(1);
  });

  test("a copy that cannot be remade does not undo or hide the write", async () => {
    const { deps, said, refreshed } = fakeDeps();
    refreshed.fail = true;
    said.reply = "Add Paramount+ at $8.99? Reply yes.";
    expect(await addBill(paramount, deps)).toMatchObject({ added: true, copy_refreshed: false });
  });

  test("the amount is read as a figure however it was written", () => {
    expect(showsRow("Add Rent at $1,700 a month?", { bill: "Rent", amount: 1700 })).toBe(true);
    expect(showsRow("Add Hulu at 20 dollars?", { bill: "Hulu", amount: 20 })).toBe(true);
    expect(showsRow("Add Hulu?", { bill: "Hulu", amount: 20 })).toBe(false);
    expect(showsRow("Add Hulu?", { bill: "Hulu", amount: null })).toBe(true);
    expect(showsRow("Add something at $20?", { bill: "Hulu", amount: 20 })).toBe(false);
  });
});

describe("refusals", () => {
  test("bad fields are refused before any request", async () => {
    const { deps, calls } = fakeDeps();
    for (const bad of [{}, { bill: " " }, { bill: "x".repeat(81) }, { bill: "A", amount: -1 }, { bill: "A", amount: "8.99" }, { bill: "A", due_day: 32 }, { bill: "A", renews_on: "10/20/2026" }, { bill: "A", renews_on: "2026-02-30" }, { bill: "A", notes: "n".repeat(501) }]) {
      await expect(addBill(bad as any, deps)).rejects.toThrow();
    }
    expect(calls).toEqual([]);
  });

  test("an option the tracker lacks comes back with the list, and nothing is written", async () => {
    const { deps, calls, said } = fakeDeps();
    said.reply = "Add Paramount+ at $8.99? Reply yes.";
    await expect(addBill({ ...paramount, cadence: "Quarterly" }, deps)).rejects.toThrow("Cadence must be one of: Monthly, Annual, Every 2 weeks");
    await expect(addBill({ ...paramount, split: "Ours" }, deps)).rejects.toThrow("Split must be one of");
    expect(writes(calls)).toEqual([]);
  });

  test("a bill already in the tracker is not added again, even with a yes", async () => {
    const { deps, calls, said } = fakeDeps(["Rent", "paramount+"]);
    said.reply = "Add Paramount+ at $8.99? Reply yes.";
    expect(await addBill(paramount, deps)).toMatchObject({ added: false, already_there: true });
    expect(writes(calls)).toEqual([]);
  });

  test("changed columns stop the tool before a write", async () => {
    const { Amount: _gone, ...rest } = PROPERTIES;
    const { deps, calls, said } = fakeDeps(["Rent"], rest);
    said.reply = "Add Paramount+ at $8.99? Reply yes.";
    await expect(addBill(paramount, deps)).rejects.toThrow("Bills database columns changed");
    expect(writes(calls)).toEqual([]);
  });

  test(`one run adds at most ${MAX_ADDS} bills`, async () => {
    const { deps, calls, said } = fakeDeps();
    for (let i = 0; i < MAX_ADDS; i++) {
      said.reply = `Add Stream${i}x at $5? Reply yes.`;
      expect((await addBill({ bill: `Stream${i}x`, amount: 5 }, deps)).added).toBe(true);
    }
    said.reply = "Add Streamlast at $5? Reply yes.";
    await expect(addBill({ bill: "Streamlast", amount: 5 }, deps)).rejects.toThrow("at most");
    expect(writes(calls)).toHaveLength(MAX_ADDS);
  });

  test("the fields are tidied, and what was left out stays empty", () => {
    expect(toRow({ bill: "  Hulu \n Live ", amount: 82.994 })).toEqual({ bill: "Hulu Live", amount: 82.99, cadence: null, due_day: null, renews_on: null, split: null, notes: "" });
  });

  test("the server offers exactly one tool, and it cannot change or remove a row", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["add"]);
  });
});

describe("a yes to the morning check", () => {
  const db = () => join(mkdtempSync(join(tmpdir(), "jarvis-bills-approval-")), "queue.sqlite");
  const put = (store: Store, id: string, source: "photon" | "door", mode: "converse" | "ask" | "notify", reply?: string) => {
    Bun.sleepSync(2); // the check orders texts by the millisecond they arrived
    store.receive({ id, source, senderAddress: null, senderKey: "alex", threadId: "t", linePhone: null, mode, text: "x" });
    store.setState(id, "queued");
    if (reply !== undefined) {
      store.setState(id, "model_result", { reply });
      store.setState(id, "send_attempted");
      store.setState(id, "send_confirmed");
    }
  };
  const MORNING = "Paramount+ renews October 20 at $8.99.";

  test("counts for a bill row once Alex texts back, and still not for a calendar removal or an email", () => {
    const path = db();
    const store = new Store(path);
    put(store, "door:nudge:2026-10-06", "door", "ask", MORNING);
    put(store, "m1", "photon", "converse"); // the answer, being worked on now
    expect(lastAsk("alex", path, Date.now(), true)).toBe(MORNING);
    expect(showsRow(MORNING, { bill: "Paramount+", amount: 8.99 })).toBe(true);
    expect(lastAsk("alex", path)).toBeNull(); // what removal and send read
  });

  test("a script's fixed notice does not count, and neither does a script answering a script", () => {
    const path = db();
    const store = new Store(path);
    put(store, "door:renewal", "door", "notify", "Reminder: Paramount+ reaches its date in 7 days, $8.99 on file.");
    put(store, "m1", "photon", "converse");
    expect(lastAsk("alex", path, Date.now(), true)).toBeNull();
    const path2 = db();
    const store2 = new Store(path2);
    put(store2, "door:nudge:a", "door", "ask", MORNING);
    put(store2, "door:nudge:b", "door", "ask"); // a script's question is the one being answered
    expect(lastAsk("alex", path2, Date.now(), true)).toBeNull();
  });
});
