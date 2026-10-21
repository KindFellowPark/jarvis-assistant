// The one approval step, checked on the texts themselves. An action that needs the person's
// go-ahead (removing a calendar event, sending an email, adding a bill row) is allowed when Jarvis's last reply to
// that person named the thing and the run now in flight is answering a text they sent after it. How Jarvis asked
// does not matter, so one "yes" is always enough and Jarvis cannot approve its own request.
// For a bill row only, that last reply may also be the one a script's question produced (the
// morning check), so a yes to the morning text counts. The text being
// answered must still be the person's own, and a script's fixed notice never counts.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./config";
import { plainText } from "./plain";

export const APPROVAL_WINDOW_MS = 24 * 3600_000;

/**
 * Jarvis's last reply to this sender, when the text being answered now came after it. With
 * `scriptAsks`, a run's reply to a script's question counts as well as a reply to a text.
 */
export function lastAsk(senderKey: string | undefined, dbPath = join(STATE_DIR, "queue.sqlite"), now = Date.now(), scriptAsks = false): string | null {
  if (!senderKey || !existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    // The listener works one message at a time, so the oldest queued row is the one being answered.
    const current = db
      .query("SELECT source, created_at FROM messages WHERE sender_key = ? AND state = 'queued' ORDER BY created_at, rowid LIMIT 1")
      .get(senderKey) as { source: string; created_at: string } | null;
    if (!current || current.source !== "photon") return null; // only a text from the person's phone can approve
    const prev = db
      .query(
        `SELECT reply, updated_at FROM messages WHERE sender_key = ? AND ${scriptAsks ? "(source = 'photon' OR (source = 'door' AND mode = 'ask'))" : "source = 'photon'"} AND state = 'send_confirmed' AND reply IS NOT NULL AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(senderKey, current.created_at) as { reply: string; updated_at: string } | null;
    if (!prev || now - Date.parse(prev.updated_at) > APPROVAL_WINDOW_MS) return null;
    return prev.reply;
  } finally {
    db.close();
  }
}

const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** True when the reply named this title: the whole title, or at least half of its distinctive words. */
export function names(reply: string, title: string): boolean {
  const text = reply.toLowerCase();
  const whole = title.toLowerCase().trim();
  if (whole && text.includes(whole)) return true;
  const said = new Set(words(reply));
  const distinctive = [...new Set(words(title).filter((w) => w.length >= 4))];
  if (!distinctive.length) return false;
  return distinctive.filter((w) => said.has(w)).length >= Math.ceil(distinctive.length / 2);
}

/** Whether the person has been asked about this title and has texted back since. */
export function approved(title: string, senderKey = process.env.JARVIS_SENDER): boolean {
  const reply = lastAsk(senderKey);
  return !!reply && names(reply, title);
}

const squash = (s: string) => plainText(s.replace(/\r/g, "")).replace(/\s+/g, " ").trim();

/** True when the reply carried this email in full: every address, the subject and the body word for word. */
export function shows(reply: string, mail: { addresses: string[]; subject: string; body: string }): boolean {
  const text = squash(reply);
  const body = squash(mail.body);
  if (!body || !mail.addresses.length) return false;
  return text.includes(body) && text.includes(squash(mail.subject)) && mail.addresses.every((a) => text.toLowerCase().includes(a.toLowerCase()));
}

/** Whether the person was shown this exact email and has texted back since. */
export function approvedSend(mail: { addresses: string[]; subject: string; body: string }, senderKey = process.env.JARVIS_SENDER): boolean {
  const reply = lastAsk(senderKey);
  return !!reply && shows(reply, mail);
}

/** True when the reply named this bill and, when the row has an amount, carried that amount as a figure. */
export function showsRow(reply: string, row: { bill: string; amount: number | null }): boolean {
  if (!names(reply, row.bill)) return false;
  if (row.amount === null) return true;
  const figures = (reply.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((f) => Number(f.replace(/,/g, "")));
  return figures.some((f) => Math.abs(f - row.amount!) < 0.005);
}

/** Whether the person was shown this bill row, by a reply or by the morning check, and has texted back since. */
export function approvedRow(row: { bill: string; amount: number | null }, senderKey = process.env.JARVIS_SENDER): boolean {
  const reply = lastAsk(senderKey, undefined, undefined, true);
  return !!reply && showsRow(reply, row);
}
