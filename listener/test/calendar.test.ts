// Calendar tool checks. A run can list events, add one, change one and remove one:
//   1. every write is on the primary calendar with sendUpdates=none; no guests are ever added;
//   2. guest names and links never come back;
//   3. bad dates and times are refused before any request, and a repeated add does not add twice;
//   4. a removal happens only once the person has been asked about that event and has texted
//      back (src/approval.ts), and one run removes at most MAX_REMOVALS events;
//   5. a repeating event changes one occurrence unless the whole series is asked for;
//   6. the server offers exactly four tools.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastAsk, names } from "../src/approval";
import { addDays, addEvent, changeEvent, listEvents, MAX_REMOVALS, offsetOn, removeEvent, resetTokenCache, type CalendarDeps } from "../src/calendar/gcal";
import { Store } from "../src/store";
import { TOOLS } from "../src/calendar/server";

function fakeDeps(items: any[] = []) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const said = { reply: "" as string | null }; // Jarvis's last reply to the person, as the approval check sees it
  const deps: CalendarDeps = {
    removals: { n: 0 },
    approved: (title) => !!said.reply && names(said.reply, title),
    readToken: async () => ({ refresh_token: "r", client_id: "c", client_secret: "s" }),
    fetch: async (url, init) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body && url.includes("calendar") ? JSON.parse(init.body) : undefined });
      const ok = (body: any) => ({ ok: true, status: 200, json: async () => body });
      if (url.startsWith("https://oauth2.googleapis.com/token")) return ok({ access_token: "a", expires_in: 3600 });
      const one = new URL(url).pathname.match(/\/events\/([^/]+)$/);
      if (one) {
        const ev = items.find((e) => e.id === one[1]);
        if (!ev) return { ok: false, status: 404, json: async () => ({}) };
        if (method === "GET") return ok(ev);
        if (method === "DELETE") return ok({});
        const patch = JSON.parse(init!.body!);
        const side = (old: any, p: any) => (!p ? old : p.dateTime ? { dateTime: `${p.dateTime}-07:00` } : { date: p.date });
        return ok({ ...ev, ...patch, start: side(ev.start, patch.start), end: side(ev.end, patch.end) });
      }
      if (method === "GET") return ok({ items });
      const sent = JSON.parse(init!.body!);
      return ok({ ...sent, start: sent.start.dateTime ? { dateTime: `${sent.start.dateTime}-07:00` } : sent.start, end: sent.end.dateTime ? { dateTime: `${sent.end.dateTime}-07:00` } : sent.end });
    },
  };
  return { deps, calls, said };
}
const cal = <T extends { url: string }>(calls: T[]) => calls.filter((c) => c.url.includes("googleapis.com/calendar"));

beforeEach(() => resetTokenCache());

describe("what the tool can send", () => {
  test("a list is one GET on the primary calendar, bounded by the two dates in Pacific time", async () => {
    const { deps, calls } = fakeDeps();
    await listEvents({ from: "2026-10-06", to: "2026-10-07", query: "dentist" }, deps);
    const c = cal(calls);
    expect(c.length).toBe(1);
    expect(c[0]!.method).toBe("GET");
    const url = new URL(c[0]!.url);
    expect(url.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(url.searchParams.get("timeMin")).toBe("2026-10-06T00:00:00-07:00");
    expect(url.searchParams.get("timeMax")).toBe("2026-10-08T00:00:00-07:00");
    expect(url.searchParams.get("q")).toBe("dentist");
  });

  test("an add is one check GET and one POST, with no guests and no notifications", async () => {
    const { deps, calls } = fakeDeps();
    const out = await addEvent({ title: "Dentist", date: "2026-10-06", start_time: "15:00", location: "Anytown" }, deps);
    const c = cal(calls);
    expect(c.map((x) => x.method)).toEqual(["GET", "POST"]);
    expect(c[1]!.url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none");
    expect(c[1]!.body).toEqual({
      summary: "Dentist",
      start: { dateTime: "2026-10-06T15:00:00", timeZone: "America/Los_Angeles" },
      end: { dateTime: "2026-10-06T16:00:00", timeZone: "America/Los_Angeles" },
      location: "Anytown",
    });
    expect(out).toMatchObject({ added: true, event: { title: "Dentist", start: "2026-10-06T15:00:00-07:00", all_day: false } });
    expect(calls.filter((x) => !x.url.includes("calendar"))).toMatchObject([{ method: "POST", url: "https://oauth2.googleapis.com/token" }]);
  });

  test("no start time makes an all-day event ending the next day", async () => {
    const { deps, calls } = fakeDeps();
    await addEvent({ title: "Rent due", date: "2026-10-31" }, deps);
    expect(cal(calls)[1]!.body).toEqual({ summary: "Rent due", start: { date: "2026-10-31" }, end: { date: "2026-11-01" } });
  });

  test("extra fields a model might pass are not forwarded", async () => {
    const { deps, calls } = fakeDeps();
    await addEvent({ title: "Dinner", date: "2026-10-06", start_time: "19:00", attendees: [{ email: "x@example.com" }], recurrence: ["RRULE:FREQ=DAILY"] } as any, deps);
    expect(Object.keys(cal(calls)[1]!.body).sort()).toEqual(["end", "start", "summary"]);
  });

  test("the source has one insert, one change and one delete, and nothing that invites or notifies", async () => {
    const src = await Bun.file(new URL("../src/calendar/gcal.ts", import.meta.url)).text();
    for (const word of ['"PUT"', "/move", "quickAdd", "/acl", "sendUpdates=all", "sendUpdates=externalOnly", "sendNotifications", "attendees:"]) expect(src).not.toContain(word);
    expect(src.match(/method: "POST"/g)?.length).toBe(2); // the token refresh and the insert
    expect(src.match(/method: "PATCH"/g)?.length).toBe(1);
    expect(src.match(/method: "DELETE"/g)?.length).toBe(1);
  });

  test("the server offers exactly events, add, change and remove", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["events", "add", "change", "remove"]);
  });
});

describe("what comes back", () => {
  test("ids, titles, times, places and notes: no guest names or links", async () => {
    const { deps } = fakeDeps([
      { id: "abcde1", summary: "Eye doctor", start: { dateTime: "2026-10-06T09:00:00-07:00" }, end: { dateTime: "2026-10-06T10:00:00-07:00" }, location: "Suite 200", description: "portal password hunter2", attendees: [{ email: "a@b.c" }], htmlLink: "https://x", hangoutLink: "https://y" },
      { id: "abcde2", start: { date: "2026-10-07" }, end: { date: "2026-10-08" }, recurringEventId: "series9" },
    ]);
    expect(await listEvents({ from: "2026-10-06", to: "2026-10-07" }, deps)).toEqual([
      { id: "abcde1", title: "Eye doctor", start: "2026-10-06T09:00:00-07:00", end: "2026-10-06T10:00:00-07:00", all_day: false, location: "Suite 200", notes: "portal password hunter2", has_guests: true, guests: ["a@b.c"] },
      { id: "abcde2", title: "(no title)", start: "2026-10-07", end: "2026-10-08", all_day: true, repeats: true },
    ]);
  });
});

const DRIVE = { id: "drive01", summary: "Depart for LA", start: { dateTime: "2026-10-03T12:00:00-07:00" }, end: { dateTime: "2026-10-03T14:30:00-07:00" }, location: "Anytown", description: "private note" };
const STAY = { id: "stay001", summary: "Overnight stay", start: { date: "2026-10-03" }, end: { date: "2026-10-05" } };
const SERIES = { id: "weekly1_20261003", summary: "Trash day", start: { date: "2026-10-03" }, end: { date: "2026-10-04" }, recurringEventId: "weekly1" };
const SHARED = { id: "dinner1", summary: "Dinner", start: { dateTime: "2026-10-03T19:00:00-07:00" }, end: { dateTime: "2026-10-03T20:00:00-07:00" }, attendees: [{ email: "friend@example.com" }] };

describe("changing an event", () => {
  test("a change is one GET of that event and one PATCH with only the changed fields, notifying nobody", async () => {
    const { deps, calls } = fakeDeps([DRIVE]);
    const out = await changeEvent({ id: "drive01", title: "Concert weekend", attendees: [{ email: "x@example.com" }] } as any, deps);
    const c = cal(calls);
    expect(c.map((x) => x.method)).toEqual(["GET", "PATCH"]);
    expect(c[1]!.url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/drive01?sendUpdates=none");
    expect(c[1]!.body).toEqual({ summary: "Concert weekend" });
    expect(out.before.title).toBe("Depart for LA");
    expect(out.event).toMatchObject({ id: "drive01", title: "Concert weekend", start: "2026-10-03T12:00:00-07:00" });
    expect(JSON.stringify(out)).not.toContain("friend@example.com");
  });

  test("a new start time keeps the event's length, and a new end time sets it", async () => {
    const { deps, calls } = fakeDeps([DRIVE]);
    await changeEvent({ id: "drive01", start_time: "11:00" }, deps);
    expect(cal(calls)[1]!.body).toEqual({
      start: { dateTime: "2026-10-03T11:00:00", timeZone: "America/Los_Angeles", date: null },
      end: { dateTime: "2026-10-03T13:30:00", timeZone: "America/Los_Angeles", date: null },
    });
    await changeEvent({ id: "drive01", end_time: "23:45" }, deps);
    expect(cal(calls).at(-1)!.body.end.dateTime).toBe("2026-10-03T23:45:00");
    expect(cal(calls).at(-1)!.body.start.dateTime).toBe("2026-10-03T12:00:00");
  });

  test("moving an all-day event keeps its number of days, and a start time makes it a timed event", async () => {
    const { deps, calls } = fakeDeps([STAY]);
    await changeEvent({ id: "stay001", date: "2026-10-10" }, deps);
    expect(cal(calls)[1]!.body).toEqual({ start: { date: "2026-10-10", dateTime: null, timeZone: null }, end: { date: "2026-10-12", dateTime: null, timeZone: null } });
    await changeEvent({ id: "stay001", start_time: "15:00" }, deps);
    expect(cal(calls).at(-1)!.body.end).toEqual({ dateTime: "2026-10-03T16:00:00", timeZone: "America/Los_Angeles", date: null });
  });

  test("an end day stretches an event past midnight, keeping its end time unless a new one is given", async () => {
    const { deps, calls } = fakeDeps([DRIVE, STAY]);
    await changeEvent({ id: "drive01", end_date: "2026-10-04", end_time: "11:00" }, deps);
    expect(cal(calls).at(-1)!.body).toEqual({
      start: { dateTime: "2026-10-03T12:00:00", timeZone: "America/Los_Angeles", date: null },
      end: { dateTime: "2026-10-04T11:00:00", timeZone: "America/Los_Angeles", date: null },
    });
    await changeEvent({ id: "drive01", end_date: "2026-10-04" }, deps);
    expect(cal(calls).at(-1)!.body.end.dateTime).toBe("2026-10-04T14:30:00");
    await changeEvent({ id: "stay001", end_date: "2026-10-06" }, deps);
    expect(cal(calls).at(-1)!.body.end).toEqual({ date: "2026-10-07", dateTime: null, timeZone: null });
    expect(changeEvent({ id: "drive01", end_date: "2026-10-02" }, deps)).rejects.toThrow("before");
  });

  test("a new event can end on a later day", async () => {
    const { deps, calls } = fakeDeps();
    await addEvent({ title: "Trip", date: "2026-10-03", start_time: "12:00", end_date: "2026-10-04", end_time: "11:00" }, deps);
    expect(cal(calls).at(-1)!.body.end).toEqual({ dateTime: "2026-10-04T11:00:00", timeZone: "America/Los_Angeles" });
    await addEvent({ title: "Trip days", date: "2026-10-03", end_date: "2026-10-04" }, deps);
    expect(cal(calls).at(-1)!.body).toMatchObject({ start: { date: "2026-10-03" }, end: { date: "2026-10-05" } });
    expect(addEvent({ title: "x", date: "2026-10-03", start_time: "12:00", end_date: "2026-10-04" }, deps)).rejects.toThrow("end_time");
  });

  const bad: [string, any][] = [
    ["an id that is not an id", { id: "../x", title: "y" }],
    ["nothing to change", { id: "drive01" }],
    ["an empty title", { id: "drive01", title: "  " }],
    ["a date in words", { id: "drive01", date: "tomorrow" }],
    ["an end before the start", { id: "drive01", start_time: "15:00", end_time: "14:00" }],
  ];
  for (const [name, input] of bad) {
    test(`${name} is refused before any request`, async () => {
      const { deps, calls } = fakeDeps([DRIVE]);
      expect(changeEvent(input, deps)).rejects.toThrow();
      expect(calls.length).toBe(0);
    });
  }

  test("an event with guests can be changed, and no guest is notified or added", async () => {
    const { deps, calls } = fakeDeps([SHARED]);
    const out = await changeEvent({ id: "dinner1", start_time: "19:30" }, deps);
    expect(cal(calls).at(-1)!.url).toContain("/events/dinner1?sendUpdates=none");
    expect(JSON.stringify(cal(calls).at(-1)!.body)).not.toContain("attendees");
    expect(out.event.guests).toEqual(["friend@example.com"]); // addresses only, so a note can be written to them
  });

  test("a repeating event changes one occurrence, or the whole series when asked", async () => {
    const master = { id: "weekly1", summary: "Trash day", start: { date: "2026-09-05" }, end: { date: "2026-09-06" }, recurrence: ["RRULE:FREQ=WEEKLY"] };
    const { deps, calls } = fakeDeps([SERIES, master]);
    await changeEvent({ id: "weekly1_20261003", title: "Trash and recycling" }, deps);
    expect(cal(calls).at(-1)!.url).toContain("/events/weekly1_20261003?");
    await changeEvent({ id: "weekly1_20261003", series: true, title: "Trash and recycling" }, deps);
    expect(cal(calls).at(-1)!.url).toContain("/events/weekly1?");
    expect(changeEvent({ id: "weekly1_20261003", series: true, date: "2026-10-10" }, deps)).rejects.toThrow("not its dates");
    expect(changeEvent({ id: "drive01", series: true, title: "x" }, fakeDeps([DRIVE]).deps)).rejects.toThrow("does not repeat");
  });

  test("an id that is not on the calendar says so", async () => {
    const { deps } = fakeDeps([]);
    expect(changeEvent({ id: "nosuch1", title: "x" }, deps)).rejects.toThrow("no event with that id");
  });
});

describe("removing an event", () => {
  test("before the person has been asked, nothing is removed, however often the run tries", async () => {
    const { deps, calls } = fakeDeps([DRIVE]);
    for (let i = 0; i < 3; i++) expect(await removeEvent({ id: "drive01" }, deps)).toMatchObject({ removed: false, needs_go_ahead: true, event: { title: "Depart for LA" } });
    expect(cal(calls).every((c) => c.method === "GET")).toBe(true);
  });

  test("once Jarvis's last reply named the event, it goes in one DELETE that notifies nobody", async () => {
    const { deps, calls, said } = fakeDeps([DRIVE, STAY]);
    said.reply = 'Remove "Depart for LA" tomorrow at noon? Reply yes.';
    expect(await removeEvent({ id: "drive01" }, deps)).toMatchObject({ removed: true, event: { id: "drive01" } });
    const c = cal(calls);
    expect(c.map((x) => x.method)).toEqual(["GET", "DELETE"]);
    expect(c[1]!.url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/drive01?sendUpdates=none");
  });

  test("a go-ahead covers only the events that were named", async () => {
    const { deps, calls, said } = fakeDeps([DRIVE, STAY]);
    said.reply = 'Remove "Depart for LA" tomorrow at noon? Reply yes.';
    expect(await removeEvent({ id: "stay001" }, deps)).toMatchObject({ removed: false, needs_go_ahead: true });
    expect(cal(calls).some((c) => c.method === "DELETE")).toBe(false);
  });

  test("one go-ahead removes several named events, up to the cap and no further", async () => {
    const many = Array.from({ length: MAX_REMOVALS + 1 }, (_, i) => ({ ...DRIVE, id: `event${String(i).padStart(2, "0")}` }));
    const { deps, calls, said } = fakeDeps(many);
    said.reply = "I'll remove every Depart for LA event. OK?";
    for (let i = 0; i < MAX_REMOVALS; i++) expect((await removeEvent({ id: many[i]!.id }, deps)).removed).toBe(true);
    expect(removeEvent({ id: many[MAX_REMOVALS]!.id }, deps)).rejects.toThrow("at most");
    await Bun.sleep(5);
    expect(cal(calls).filter((c) => c.method === "DELETE").length).toBe(MAX_REMOVALS);
  });

  test("events with guests and single occurrences can be removed; a series only when asked for", async () => {
    const master = { id: "weekly1", summary: "Trash day", start: { date: "2026-09-05" }, end: { date: "2026-09-06" }, recurrence: ["RRULE:FREQ=WEEKLY"] };
    const { deps, calls, said } = fakeDeps([SERIES, SHARED, master]);
    said.reply = "Remove Dinner and Trash day? Reply yes.";
    expect((await removeEvent({ id: "dinner1" }, deps)).removed).toBe(true);
    expect((await removeEvent({ id: "weekly1_20261003" }, deps)).removed).toBe(true);
    expect(await removeEvent({ id: "weekly1_20261003", series: true }, deps)).toMatchObject({ removed: true, whole_series: true });
    expect(cal(calls).filter((c) => c.method === "DELETE").map((c) => new URL(c.url).pathname.split("/").pop())).toEqual(["dinner1", "weekly1_20261003", "weekly1"]);
  });

  test("an id that is not an id is refused before any request", async () => {
    const { deps, calls } = fakeDeps([DRIVE]);
    expect(removeEvent({ id: "../drive01" }, deps)).rejects.toThrow("event id");
    await Bun.sleep(5);
    expect(calls.length).toBe(0);
  });
});

describe("the go-ahead, read from the texts", () => {
  const db = () => join(mkdtempSync(join(tmpdir(), "jarvis-approval-")), "queue.sqlite");
  const text = (store: Store, id: string, body: string, reply?: string, over: { source?: "photon" | "door"; sender?: string } = {}) => {
    store.receive({ id, source: over.source ?? "photon", senderAddress: null, senderKey: (over.sender ?? "alex") as any, threadId: "t", linePhone: null, mode: "converse" as any, text: body });
    store.setState(id, "queued");
    if (reply !== undefined) {
      store.setState(id, "model_result", { reply });
      store.setState(id, "send_attempted");
      store.setState(id, "send_confirmed");
    }
  };

  test("the first text of an exchange approves nothing", () => {
    const path = db();
    const store = new Store(path);
    text(store, "m1", "delete the dentist appointment");
    expect(lastAsk("alex", path)).toBeNull();
  });

  test("a text sent after Jarvis's reply sees that reply, and only for the same person", () => {
    const path = db();
    const store = new Store(path);
    text(store, "m1", "delete the dentist appointment", "Remove Dentist, Tuesday at 3? Reply yes.");
    text(store, "m2", "yes");
    expect(lastAsk("alex", path)).toBe("Remove Dentist, Tuesday at 3? Reply yes.");
    expect(lastAsk("sam", path)).toBeNull();
    expect(lastAsk(undefined, path)).toBeNull();
  });

  test("a script's message cannot stand in for the person's text, and an old question lapses", () => {
    const path = db();
    const store = new Store(path);
    text(store, "m1", "delete the dentist appointment", "Remove Dentist, Tuesday at 3? Reply yes.");
    text(store, "door:x", "check this", undefined, { source: "door" });
    expect(lastAsk("alex", path)).toBeNull();
    const path2 = db();
    const store2 = new Store(path2);
    text(store2, "m1", "delete the dentist appointment", "Remove Dentist, Tuesday at 3? Reply yes.");
    text(store2, "m2", "yes");
    expect(lastAsk("alex", path2, Date.now() + 25 * 3600_000)).toBeNull();
  });

  test("a reply names an event by its whole title or by most of its distinctive words", () => {
    expect(names('I\'d delete the check-in and "Overnight: Seaside Lodge" events.', "Overnight: Seaside Lodge Airport North")).toBe(true);
    expect(names("Remove Gym tomorrow? Reply yes.", "Gym")).toBe(true);
    expect(names("Remove the dentist appointment? Reply yes.", "Overnight: Seaside Lodge Airport North")).toBe(false);
    expect(names("Which one should move to 3pm?", "Dentist")).toBe(false);
  });
});

describe("refusals", () => {
  const bad: [string, any][] = [
    ["a date in words", { title: "x", date: "next Tuesday" }],
    ["an impossible date", { title: "x", date: "2026-13-40" }],
    ["a 12-hour time", { title: "x", date: "2026-10-06", start_time: "3pm" }],
    ["an end before the start", { title: "x", date: "2026-10-06", start_time: "15:00", end_time: "14:00" }],
    ["an empty title", { title: "  ", date: "2026-10-06" }],
  ];
  for (const [name, input] of bad) {
    test(`${name} is refused before any request`, async () => {
      const { deps, calls } = fakeDeps();
      expect(addEvent(input, deps)).rejects.toThrow();
      expect(calls.length).toBe(0);
    });
  }

  test("an identical event already on the calendar is not added again", async () => {
    const { deps, calls } = fakeDeps([{ summary: "Dentist", start: { dateTime: "2026-10-06T15:00:00-07:00" }, end: { dateTime: "2026-10-06T16:00:00-07:00" } }]);
    const out = await addEvent({ title: "Dentist", date: "2026-10-06", start_time: "15:00" }, deps);
    expect(out).toMatchObject({ added: false, already_there: true });
    expect(cal(calls).map((c) => c.method)).toEqual(["GET"]);
  });

  test("a missing sign-in says the calendar is not connected", async () => {
    const { deps } = fakeDeps();
    deps.readToken = async () => { throw new Error("the calendar is not connected yet"); };
    expect(listEvents({ from: "2026-10-06" }, deps)).rejects.toThrow("not connected");
  });
});

describe("dates", () => {
  test("the offset follows daylight saving, and a late event's default end rolls to the next day", async () => {
    expect(offsetOn("2026-10-06")).toBe("-07:00");
    expect(offsetOn("2026-12-06")).toBe("-08:00");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    const { deps, calls } = fakeDeps();
    await addEvent({ title: "Late", date: "2026-10-06", start_time: "23:30" }, deps);
    expect(cal(calls)[1]!.body.end).toEqual({ dateTime: "2026-10-07T00:30:00", timeZone: "America/Los_Angeles" });
  });
});

describe("repeating events and alerts on add", () => {
  test("a monthly reminder is one event with a recurrence rule and its own alert", async () => {
    const { deps, calls } = fakeDeps();
    await addEvent({ title: "Fill up at 7-Eleven", date: "2026-10-07", start_time: "08:00", repeat: "monthly", alert_minutes: 0 }, deps);
    const body = cal(calls)[1]!.body;
    expect(body.recurrence).toEqual(["RRULE:FREQ=MONTHLY"]);
    expect(body.reminders).toEqual({ useDefault: false, overrides: [{ method: "popup", minutes: 0 }] });
    expect(body.attendees).toBeUndefined();
  });

  test("repeat_until ends a timed series at the end of that Pacific day, and an all-day one on that date", async () => {
    const timed = fakeDeps();
    await addEvent({ title: "Class", date: "2026-10-06", start_time: "18:00", repeat: "weekly", repeat_until: "2026-12-15" }, timed.deps);
    expect(cal(timed.calls)[1]!.body.recurrence).toEqual(["RRULE:FREQ=WEEKLY;UNTIL=20261216T075959Z"]); // 23:59:59 PST
    const allDay = fakeDeps();
    await addEvent({ title: "Trash day", date: "2026-10-06", repeat: "weekly", repeat_until: "2026-12-15" }, allDay.deps);
    expect(cal(allDay.calls)[1]!.body.recurrence).toEqual(["RRULE:FREQ=WEEKLY;UNTIL=20261215"]);
  });

  test("an event with no repeat or alert sends neither field", async () => {
    const { deps, calls } = fakeDeps();
    await addEvent({ title: "Dentist", date: "2026-10-06", start_time: "15:00" }, deps);
    expect(cal(calls)[1]!.body.recurrence).toBeUndefined();
    expect(cal(calls)[1]!.body.reminders).toBeUndefined();
  });

  test("a bad repeat, an end before the start, and an alert on an all-day event are refused before any request", async () => {
    const { deps, calls } = fakeDeps();
    await expect(addEvent({ title: "x", date: "2026-10-06", repeat: "fortnightly" }, deps)).rejects.toThrow("repeat must be");
    await expect(addEvent({ title: "x", date: "2026-10-06", repeat: "weekly", repeat_until: "2026-10-01" }, deps)).rejects.toThrow("before date");
    await expect(addEvent({ title: "x", date: "2026-10-06", repeat_until: "2026-11-01" }, deps)).rejects.toThrow("needs repeat");
    await expect(addEvent({ title: "x", date: "2026-10-06", alert_minutes: 10 }, deps)).rejects.toThrow("needs a start_time");
    await expect(addEvent({ title: "x", date: "2026-10-06", start_time: "09:00", alert_minutes: -5 }, deps)).rejects.toThrow("alert_minutes");
    expect(calls.length).toBe(0);
  });

  test("notes longer than the old 600-character cut come back whole", async () => {
    const long = "5:00 PM park. ".repeat(80); // 1,120 characters
    const { deps } = fakeDeps([{ id: "abcde1", summary: "Concert", start: { dateTime: "2026-10-03T16:45:00-07:00" }, end: { dateTime: "2026-10-03T23:45:00-07:00" }, description: long }]);
    expect((await listEvents({ from: "2026-10-03" }, deps))[0]!.notes).toBe(long.trim());
  });
});
