import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SENDERS, type Sender } from "../src/config";
import { exportReminders, renderReminders, type Reminder } from "../jobs/reminders_export";

const ROWS: Reminder[] = [
  { id: "a", list: "Family", title: "My Paramount+ $8.99 subscription\nwill renew on October 20", due: "2026-10-18" },
  { id: "b", list: "Family", title: "Water" },
  { id: "c", list: "Jarvis", title: "Car registration renewal", due: "2027-01-26T09:00:00-08:00", notes: "30-day window" },
  { id: "d", list: "Family", title: "Pack some more coffee", due: "2026-10-05T20:00:00-07:00", recurring: true },
];
const NOW = new Date("2026-10-05T22:00:00Z"); // 3:00 PM Pacific

let dir: string;
const sender = (key: "alex" | "sam", reminders: boolean): Sender => ({ ...SENDERS.find((s) => s.key === key)!, runDir: join(dir, key), reminders });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-reminders-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("reminders copy", () => {
  test("one section per list, dated reminders first in date order, titles on one line", () => {
    const text = renderReminders(ROWS, NOW);
    expect(text).toContain("Copied by code from the Reminders app on Mon, Oct 5, 2026");
    const family = text.slice(text.indexOf("## Family"), text.indexOf("## Jarvis"));
    expect(family.trim().split("\n").slice(2)).toEqual([
      "- due Mon, Oct 5, 2026 at 8:00 PM, repeats | Pack some more coffee",
      "- due Sun, Oct 18, 2026 | My Paramount+ $8.99 subscription will renew on October 20",
      "- no date | Water",
    ]);
    expect(text).toContain("- due Tue, Jan 26, 2027 at 9:00 AM | Car registration renewal (note: 30-day window)");
  });

  test("an empty set says so", () => {
    expect(renderReminders([], NOW)).toContain("There are no open reminders.");
  });

  test("only a sender with reminders switched on gets a copy; anyone else's old copy is removed", () => {
    const alex = sender("alex", true);
    const sam = sender("sam", false);
    mkdirSync(join(sam.runDir, "data"), { recursive: true });
    writeFileSync(join(sam.runDir, "data/reminders.md"), "old");
    const path = exportReminders(alex, () => ROWS, NOW)!;
    expect(readFileSync(path, "utf8")).toContain("## Jarvis");
    expect(exportReminders(sam, () => ROWS, NOW)).toBeNull();
    expect(existsSync(join(sam.runDir, "data/reminders.md"))).toBe(false);
  });

  test("a failed read removes the old copy and throws", () => {
    const alex = sender("alex", true);
    exportReminders(alex, () => ROWS, NOW);
    expect(() => exportReminders(alex, () => { throw new Error("Reminders access not granted"); }, NOW)).toThrow("not granted");
    expect(existsSync(join(alex.runDir, "data/reminders.md"))).toBe(false);
  });

  test("in config, both senders' runs get the copy", () => {
    for (const s of SENDERS) expect(s.reminders).toBe(true);
  });
});
