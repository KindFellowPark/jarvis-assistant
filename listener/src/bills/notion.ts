// Adding one row to Notion's "Bills (recurring)" database, the source of truth for bills. A run
// proposes the row; code writes it, and only once the person has been shown it and has texted
// back (src/approval.ts). A run cannot change or remove a row. The local copy the runs read is
// still made only by jobs/bills_export.ts, which this calls after a write.
import { approvedRow } from "../approval";
import { NOTION_API } from "../config";
import { keychain } from "../keychain";
import { checkSchema, copyBills, DATA_SOURCE, KEYCHAIN_SERVICE, NOTION_VERSION } from "../../jobs/bills_export";

export type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export interface Row {
  bill: string;
  amount: number | null;
  cadence: string | null;
  due_day: number | null;
  renews_on: string | null; // YYYY-MM-DD
  split: string | null;
  notes: string;
}

export interface BillsDeps {
  fetch: Fetch;
  readKey: () => string;
  approved: (row: Row) => boolean; // the person was shown this row and texted back
  refresh: (key: string) => Promise<unknown>; // remake the runs' copies after a write
  adds: { n: number }; // rows added by this server process, which lives for one run
}

export const MAX_ADDS = 3;
const MAX_NOTES = 500;

export const realDeps: BillsDeps = {
  fetch: (url, init) => fetch(url, init) as any,
  readKey: () => keychain(KEYCHAIN_SERVICE),
  approved: approvedRow,
  refresh: copyBills,
  adds: { n: 0 },
};

export const ASK_FIRST =
  "Not added: the person has not been asked yet. Ask once, in one short line that gives the bill's name, its amount and the rest of the row as you will save it, and nothing else. When they answer yes, call add again with the same fields.";

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** Checks the fields a run sent, before any request. */
export function toRow(input: Record<string, unknown>): Row {
  const bill = typeof input.bill === "string" ? input.bill.replace(/\s+/g, " ").trim() : "";
  if (!bill || bill.length > 80) throw new Error("bill is the bill's name, 1 to 80 characters");
  const opt = <T>(v: unknown, read: (v: unknown) => T): T | null => (v === undefined || v === null || v === "" ? null : read(v));
  const amount = opt(input.amount, (v) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100_000) throw new Error("amount is a number of dollars, such as 8.99");
    return Math.round(v * 100) / 100;
  });
  const due_day = opt(input.due_day, (v) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 31) throw new Error("due_day is the day of the month, 1 to 31");
    return v;
  });
  const renews_on = opt(input.renews_on, (v) => {
    if (typeof v !== "string" || !isDate(v)) throw new Error("renews_on is a date, YYYY-MM-DD");
    return v;
  });
  const name = (field: string) => (v: unknown) => {
    if (typeof v !== "string" || !v.trim()) throw new Error(`${field} is one of the tracker's own options`);
    return v.trim();
  };
  const notes = typeof input.notes === "string" ? input.notes.replace(/\s+/g, " ").trim() : "";
  if (notes.length > MAX_NOTES) throw new Error(`notes is at most ${MAX_NOTES} characters`);
  return { bill, amount, cadence: opt(input.cadence, name("cadence")), due_day, renews_on, split: opt(input.split, name("split")), notes };
}

/** The tracker's own spelling of an option, or an error that lists the options. */
function option(properties: any, column: string, wanted: string | null): string | null {
  if (wanted === null) return null;
  const options: string[] = (properties[column]?.select?.options ?? []).map((o: any) => o.name);
  const found = options.find((o) => o.toLowerCase() === wanted.toLowerCase());
  if (!found) throw new Error(`${column} must be one of: ${options.join(", ")}`);
  return found;
}

const titleOf = (page: any) => (page.properties?.Bill?.title ?? []).map((r: any) => r.plain_text ?? "").join("").trim();

export async function addBill(
  input: Record<string, unknown>,
  deps: BillsDeps = realDeps,
): Promise<{ added: boolean; needs_go_ahead?: true; already_there?: true; say?: string; copy_refreshed?: boolean; row: Row }> {
  const asked = toRow(input);
  if (deps.adds.n >= MAX_ADDS) throw new Error(`Jarvis adds at most ${MAX_ADDS} bills in one turn`);
  const key = deps.readKey();
  const headers = { Authorization: `Bearer ${key}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };

  // Reads first, so a column that changed, an option the tracker lacks or a bill already there is
  // caught before the person is asked anything.
  const source = await deps.fetch(`${NOTION_API}/v1/data_sources/${DATA_SOURCE}`, { headers });
  if (!source.ok) throw new Error(`the bill tracker could not be read (${source.status})`);
  const properties = (await source.json()).properties ?? {};
  checkSchema(properties);
  const row: Row = { ...asked, cadence: option(properties, "Cadence", asked.cadence), split: option(properties, "Split", asked.split) };

  let cursor: string | undefined;
  do {
    const res = await deps.fetch(`${NOTION_API}/v1/data_sources/${DATA_SOURCE}/query`, { method: "POST", headers, body: JSON.stringify(cursor ? { start_cursor: cursor } : {}) });
    if (!res.ok) throw new Error(`the bill tracker could not be read (${res.status})`);
    const body = await res.json();
    if ((body.results as any[]).some((p) => titleOf(p).toLowerCase() === row.bill.toLowerCase())) return { added: false, already_there: true, row };
    cursor = body.has_more ? body.next_cursor : undefined;
  } while (cursor);

  if (!deps.approved(row)) return { added: false, needs_go_ahead: true, say: ASK_FIRST, row };

  const res = await deps.fetch(`${NOTION_API}/v1/pages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: DATA_SOURCE },
      properties: {
        Bill: { title: [{ text: { content: row.bill } }] },
        ...(row.amount !== null ? { Amount: { number: row.amount } } : {}),
        ...(row.cadence ? { Cadence: { select: { name: row.cadence } } } : {}),
        ...(row.due_day !== null ? { "Due day": { number: row.due_day } } : {}),
        ...(row.renews_on ? { "Renews on": { date: { start: row.renews_on } } } : {}),
        ...(row.split ? { Split: { select: { name: row.split } } } : {}),
        ...(row.notes ? { Notes: { rich_text: [{ text: { content: row.notes } }] } } : {}),
      },
    }),
  });
  if (!res.ok) throw new Error(`the bill was not added (${res.status})`);
  deps.adds.n++;
  // The row is in Notion either way; a copy that could not be remade is remade within the hour.
  let copy_refreshed = true;
  try {
    await deps.refresh(key);
  } catch {
    copy_refreshed = false;
  }
  return { added: true, copy_refreshed, row };
}
