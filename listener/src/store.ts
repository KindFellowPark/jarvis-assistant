// Durable queue. Every inbound message is written here under its provider id before anything
// else happens, and every state change is logged with a timestamp.
import { Database } from "bun:sqlite";

export type State =
  | "received"
  | "dropped"
  | "queued"
  | "model_result"
  | "failed"
  | "send_attempted"
  | "send_confirmed";

export const OPEN_STATES: State[] = ["received", "queued", "model_result", "send_attempted"];

export interface MessageRow {
  id: string;
  source: "photon" | "door";
  sender_key: string | null;
  sender_address: string | null;
  thread_id: string | null;
  line_phone: string | null;
  mode: "converse" | "ask" | "notify";
  text: string | null;
  state: State;
  reply: string | null;
  reason: string | null;
  denials: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewMessage {
  id: string;
  source: "photon" | "door";
  senderAddress: string | null;
  senderKey: string | null;
  threadId: string | null;
  linePhone: string | null;
  mode: "converse" | "ask" | "notify";
  text: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, sender_key TEXT, sender_address TEXT,
  thread_id TEXT, line_phone TEXT, mode TEXT NOT NULL, text TEXT, state TEXT NOT NULL,
  reply TEXT, reason TEXT, denials TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS transitions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, state TEXT NOT NULL,
  at TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS sends (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, kind TEXT NOT NULL,
  thread_id TEXT NOT NULL, text TEXT NOT NULL, attempted_at TEXT NOT NULL, confirmed_at TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  sender_key TEXT NOT NULL, day TEXT NOT NULL, session_id TEXT NOT NULL, started INTEGER NOT NULL,
  PRIMARY KEY (sender_key, day));
CREATE TABLE IF NOT EXISTS threads (
  sender_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, line_phone TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const now = () => new Date().toISOString();

export class Store {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.db.exec(SCHEMA);
  }

  /** Writes a new message in state `received`. Returns false for an id already seen. */
  receive(m: NewMessage): boolean {
    const at = now();
    const res = this.db
      .query(
        `INSERT OR IGNORE INTO messages (id, source, sender_key, sender_address, thread_id, line_phone,
         mode, text, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)`,
      )
      .run(m.id, m.source, m.senderKey, m.senderAddress, m.threadId, m.linePhone, m.mode, m.text, at, at);
    if (res.changes === 0) return false;
    this.log(m.id, "received", null, at);
    return true;
  }

  setState(id: string, state: State, fields: { reply?: string; reason?: string; denials?: unknown[]; text?: null } = {}) {
    const at = now();
    const sets = ["state = ?", "updated_at = ?"];
    const vals: (string | null)[] = [state, at];
    if (fields.reply !== undefined) sets.push("reply = ?"), vals.push(fields.reply);
    if (fields.reason !== undefined) sets.push("reason = ?"), vals.push(fields.reason);
    if (fields.denials !== undefined) sets.push("denials = ?"), vals.push(JSON.stringify(fields.denials));
    if (fields.text === null) sets.push("text = NULL");
    this.db.query(`UPDATE messages SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    this.log(id, state, fields.reason ?? null, at);
  }

  private log(id: string, state: State, detail: string | null, at: string) {
    this.db.query("INSERT INTO transitions (message_id, state, at, detail) VALUES (?, ?, ?, ?)").run(id, state, at, detail);
  }

  get(id: string): MessageRow | null {
    return this.db.query("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | null;
  }

  /** True when a door notification with this exact text already went to this sender since `sinceIso`. */
  notifiedSince(senderKey: string, text: string, sinceIso: string): boolean {
    return !!this.db
      .query("SELECT 1 FROM messages WHERE source = 'door' AND mode = 'notify' AND sender_key = ? AND reply = ? AND created_at >= ?")
      .get(senderKey, text, sinceIso);
  }

  open(): MessageRow[] {
    return this.db
      .query(`SELECT * FROM messages WHERE state IN (${OPEN_STATES.map(() => "?").join(",")}) ORDER BY created_at, rowid`)
      .all(...OPEN_STATES) as MessageRow[];
  }

  transitions(id: string): { state: State; at: string; detail: string | null }[] {
    return this.db.query("SELECT state, at, detail FROM transitions WHERE message_id = ? ORDER BY seq").all(id) as any;
  }

  recordSendAttempt(messageId: string, kind: "reply" | "alert" | "apology", threadId: string, text: string): number {
    const res = this.db
      .query("INSERT INTO sends (message_id, kind, thread_id, text, attempted_at) VALUES (?, ?, ?, ?, ?)")
      .run(messageId, kind, threadId, text, now());
    return Number(res.lastInsertRowid);
  }

  confirmSend(seq: number) {
    this.db.query("UPDATE sends SET confirmed_at = ? WHERE seq = ?").run(now(), seq);
  }

  sends(messageId?: string): { message_id: string; kind: string; thread_id: string; text: string; confirmed_at: string | null }[] {
    return (messageId
      ? this.db.query("SELECT * FROM sends WHERE message_id = ? ORDER BY seq").all(messageId)
      : this.db.query("SELECT * FROM sends ORDER BY seq").all()) as any;
  }

  session(senderKey: string, day: string): { session_id: string; started: number } {
    const row = this.db.query("SELECT session_id, started FROM sessions WHERE sender_key = ? AND day = ?").get(senderKey, day) as any;
    if (row) return row;
    const id = crypto.randomUUID();
    this.db.query("INSERT INTO sessions (sender_key, day, session_id, started) VALUES (?, ?, ?, 0)").run(senderKey, day, id);
    return { session_id: id, started: 0 };
  }

  markSessionStarted(senderKey: string, day: string) {
    this.db.query("UPDATE sessions SET started = 1 WHERE sender_key = ? AND day = ?").run(senderKey, day);
  }

  /** Gives the day a new conversation id, for when a run died before it could say whether the old one was used. */
  rotateSession(senderKey: string, day: string) {
    this.db.query("UPDATE sessions SET session_id = ?, started = 0 WHERE sender_key = ? AND day = ?").run(crypto.randomUUID(), senderKey, day);
  }

  rememberThread(senderKey: string, threadId: string, linePhone: string | null) {
    this.db
      .query(
        `INSERT INTO threads (sender_key, thread_id, line_phone, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(sender_key) DO UPDATE SET thread_id = excluded.thread_id, line_phone = excluded.line_phone, updated_at = excluded.updated_at`,
      )
      .run(senderKey, threadId, linePhone, now());
  }

  thread(senderKey: string): { thread_id: string; line_phone: string | null } | null {
    return this.db.query("SELECT thread_id, line_phone FROM threads WHERE sender_key = ?").get(senderKey) as any;
  }

  halted(): string | null {
    const row = this.db.query("SELECT value FROM meta WHERE key = 'halted'").get() as { value: string } | null;
    return row?.value ?? null;
  }

  halt(reason: string) {
    this.db.query("INSERT INTO meta (key, value) VALUES ('halted', ?) ON CONFLICT(key) DO NOTHING").run(`${now()} ${reason}`);
  }

  clearHalt() {
    this.db.query("DELETE FROM meta WHERE key = 'halted'").run();
  }
}
