// Hourly export of the Notion "Bills (recurring)" database to a local file Jarvis's runs can
// read. Code copies the rows; no model is involved. Notion is the source of truth, and the
// file says when it was generated so a stale copy announces itself.
//
// Fails loudly and leaves the previous file in place if the database's columns have changed.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DOOR_PORT, NOTION_API, SENDERS, TIME_ZONE } from "../src/config";

// The Notion data source id of the bill tracker. A placeholder here; set JARVIS_BILLS_DATA_SOURCE.
export const DATA_SOURCE = process.env.JARVIS_BILLS_DATA_SOURCE ?? "00000000-0000-0000-0000-000000000000";
// The Notion integration's secret, read from this Keychain item at use time.
export const KEYCHAIN_SERVICE = "notion_integration_token";
// One copy per sender, inside that sender's run folder, so no run reaches into another's.
export const OUT_PATHS = SENDERS.map((s) => join(s.runDir, "data/bills.md"));
export const NOTION_VERSION = "2025-09-03";

const EXPECTED: Record<string, string> = {
  Bill: "title", Split: "select", Amount: "number", Cadence: "select", "Due day": "number",
  Autopay: "checkbox", "Pay method": "rich_text", Feed: "select", "Last paid": "date", Notes: "rich_text",
  "Sam Owes": "formula", "Renews on": "date",
};

export interface Bill {
  bill: string;
  split: string | null;
  amount: number | null;
  cadence: string | null;
  dueDay: number | null;
  autopay: boolean;
  payMethod: string;
  feed: string | null;
  lastPaid: string | null; // YYYY-MM-DD
  notes: string;
  samOwes: number | null; // from Notion's one "Sam Owes" formula: half of Amount when Alex pays a shared bill
  alexOwes: number | null; // the same formula gone negative: half of Amount when Sam pays a shared bill
  renewsOn: string | null; // YYYY-MM-DD: an annual renewal, or the end of a promo rate
}

const text = (rich: any[] | undefined) => (rich ?? []).map((r) => r.plain_text ?? "").join("").trim();

export function checkSchema(properties: Record<string, { type: string }>) {
  const problems = Object.entries(EXPECTED)
    .filter(([name, type]) => properties[name]?.type !== type)
    .map(([name, type]) => `${name}: expected ${type}, found ${properties[name]?.type ?? "nothing"}`);
  if (problems.length) throw new Error(`Bills database columns changed: ${problems.join("; ")}`);
}

export function toBill(page: any): Bill {
  const p = page.properties;
  checkSchema(p);
  const net: number | null = p["Sam Owes"].formula?.number ?? null; // positive: Sam owes Alex; negative: Alex owes Sam
  return {
    bill: text(p.Bill.title),
    split: p.Split.select?.name ?? null,
    amount: p.Amount.number,
    cadence: p.Cadence.select?.name ?? null,
    dueDay: p["Due day"].number,
    autopay: p.Autopay.checkbox,
    payMethod: text(p["Pay method"].rich_text),
    feed: p.Feed.select?.name ?? null,
    lastPaid: p["Last paid"].date?.start?.slice(0, 10) ?? null,
    notes: text(p.Notes.rich_text),
    samOwes: net === null ? null : Math.max(net, 0),
    alexOwes: net === null ? null : Math.max(-net, 0),
    renewsOn: p["Renews on"].date?.start?.slice(0, 10) ?? null,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(Math.min(d, daysIn(y, m)))}`;

/** Due dates around `today` (YYYY-MM-DD) for a monthly bill due on `dueDay`. */
export function monthlyDue(dueDay: number, today: string): { previous: string; next: string } {
  const [y, m] = today.split("-").map(Number) as [number, number, number];
  const thisMonth = iso(y, m, dueDay);
  const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
  const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
  return thisMonth <= today
    ? { previous: thisMonth, next: thisMonth === today ? thisMonth : iso(ny, nm, dueDay) }
    : { previous: iso(py, pm, dueDay), next: thisMonth };
}

/** The household's bill rule: Autopay, Paid, Unpaid or Review. */
export function status(b: Bill, today: string): { status: string; nextDue: string | null } {
  const monthly = b.cadence === "Monthly" && b.dueDay !== null;
  const due = monthly ? monthlyDue(b.dueDay!, today) : null;
  if (b.autopay) return { status: "Autopay", nextDue: due?.next ?? b.renewsOn };
  if (!due) return { status: "Review", nextDue: b.renewsOn };
  return { status: b.lastPaid !== null && b.lastPaid >= due.previous ? "Paid" : "Unpaid", nextDue: due.next };
}

export function render(bills: Bill[], today: string, generatedAt: string): string {
  const cell = (s: string | null) => (s === null || s === "" ? "not recorded" : s.replace(/\|/g, "/").replace(/\n/g, " "));
  const money = (n: number | null) => (n === null ? "not recorded" : `$${n.toFixed(2)}`);
  const owed = (n: number | null) => (n === null || n === 0 ? "" : `$${n.toFixed(2)}`);
  const rows = [...bills]
    .sort((a, b) => (status(a, today).nextDue ?? "9999").localeCompare(status(b, today).nextDue ?? "9999") || a.bill.localeCompare(b.bill))
    .map((b) => {
      const s = status(b, today);
      return `| ${[cell(b.bill), cell(b.split), money(b.amount), cell(b.cadence), b.dueDay === null ? "varies" : String(b.dueDay),
        s.nextDue ?? "see notes", b.autopay ? "Yes" : "No", s.status, cell(b.lastPaid), b.renewsOn ?? "", owed(b.samOwes), owed(b.alexOwes), cell(b.payMethod), b.notes ? cell(b.notes) : ""].join(" | ")} |`;
    });
  return [
    "# Recurring bills",
    "",
    `Generated: ${generatedAt} (date in ${TIME_ZONE}: ${today}).`,
    "Copied by code from the Notion database \"Bills (recurring)\", which is the source of truth. This file is replaced every hour and never edited.",
    "Next due and Status are computed on the Generated date. Status: Autopay (pays itself), Paid or Unpaid (this cycle, from Last paid), Review (no fixed due day; read Notes).",
    "",
    "Renews on is an annual renewal date, or the date a promotional rate ends; the Notes say which. Code texts Alex 30 days and 7 days before it.",
    "Sam owes and Alex owes are Notion's own figures: half the Amount of a shared bill, owed to whoever paid it. Blank means nothing owed or no amount recorded. Whether a month has been settled is not in this file.",
    "",
    "| Bill | Split | Amount | Cadence | Due day | Next due | Autopay | Status | Last paid | Renews on | Sam owes | Alex owes | Pay method | Notes |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

export interface Reminder {
  id: string; // stable per bill, date and stage, so the door ignores a repeat
  text: string;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Notices owed today: one in the 30-day window (30 down to 8 days out) and one in the 7-day
 * window (7 down to 0). A window is used, not an exact day, so a morning the Mac slept through
 * is made up on the next run; the id keeps each notice to one send.
 */
export function dueReminders(bills: Bill[], today: string): Reminder[] {
  const out: Reminder[] = [];
  for (const b of bills) {
    if (!b.renewsOn) continue;
    const days = daysBetween(today, b.renewsOn);
    if (days < 0 || days > 30) continue;
    const stage = days <= 7 ? "7" : "30";
    const slug = b.bill.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
    const amount = b.amount === null ? "amount not recorded" : `$${b.amount.toFixed(2)} on file`;
    out.push({
      id: `renewal:${slug}:${b.renewsOn}:${stage}`,
      text: [`Reminder: ${b.bill} reaches its "Renews on" date ${when} (${b.renewsOn}), ${amount}.`, b.notes].filter(Boolean).join(" "),
    });
  }
  return out;
}

/** Posts each notice to the listener's local door. A notice that cannot be delivered is tried again on the next run. */
export async function postReminders(reminders: Reminder[], port = DOOR_PORT): Promise<string[]> {
  const results: string[] = [];
  for (const r of reminders) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: r.id, to: "alex", mode: "notify", text: r.text }),
      });
      results.push(`${r.id}: ${((await res.json()) as any).status}`);
    } catch (err) {
      results.push(`${r.id}: listener not reachable, will retry next run`);
    }
  }
  return results;
}

async function fetchAll(key: string): Promise<any[]> {
  const pages: any[] = [];
  let cursor: string | undefined;
  do {
    const res = await fetch(`${NOTION_API}/v1/data_sources/${DATA_SOURCE}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify(cursor ? { start_cursor: cursor } : {}),
    });
    if (!res.ok) throw new Error(`Notion query failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as any;
    pages.push(...body.results);
    cursor = body.has_more ? body.next_cursor : undefined;
  } while (cursor);
  return pages;
}

/** Renewal notices go out between 7 in the morning and 9 at night; the copy itself is made every hour. */
export function noticeHours(zone: string, d = new Date()): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hourCycle: "h23" }).format(d));
  return hour >= 7 && hour < 21;
}

export function todayIn(zone: string, d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Reads every row from Notion and replaces each sender's copy. Throws, leaving the old copies, when Notion returns nothing. */
export async function copyBills(key: string): Promise<Bill[]> {
  const bills = (await fetchAll(key)).map(toBill).filter((b) => b.bill);
  if (bills.length === 0) throw new Error("Notion returned no bills; keeping the previous file");
  const out = render(bills, todayIn(TIME_ZONE), new Date().toISOString());
  for (const path of OUT_PATHS) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, out);
    renameSync(`${path}.tmp`, path);
  }
  return bills;
}

if (import.meta.main) {
  const sec = Bun.spawnSync(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
  const key = sec.stdout.toString().trim();
  if (sec.exitCode !== 0 || !key) throw new Error(`Keychain item ${KEYCHAIN_SERVICE} is missing`);
  const bills = await copyBills(key);
  for (const path of OUT_PATHS) console.log(`${new Date().toISOString()} wrote ${bills.length} bills to ${path}`);
  // An hourly run after midnight must not text anyone; a notice held back goes out on a later run.
  if (noticeHours(TIME_ZONE)) {
    for (const line of await postReminders(dueReminders(bills, todayIn(TIME_ZONE)))) console.log(`${new Date().toISOString()} ${line}`);
  }
}
