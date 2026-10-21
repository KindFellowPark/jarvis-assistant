// Read-only Gmail access for the runs: search threads, read a thread. Every Gmail request
// is a GET; the only POST is the OAuth token refresh. Nothing in this file can send, draft, label,
// archive or delete, and the safety suite fails if such a request ever appears here. Drafting and
// the approved send live in compose.ts.
import { googleSignIn } from "../google";
import { gate } from "./gate";

// The signed-in account's own mailbox ("me"), joined so the path reads the same as Google's docs.
const API = ["https://gmail.googleapis.com/gmail/v1", "users", "me"].join("/");
const MAX_RESULTS = 8;
const MAX_BODY_CHARS = 4000;
export const HELD = "held: Jarvis does not read this kind of mail";

export type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface MailDeps {
  fetch: Fetch;
  readToken: () => Promise<{ refresh_token: string; client_id: string; client_secret: string; token_uri?: string }>;
}

export const realDeps: MailDeps = {
  fetch: (url, init) => fetch(url, init) as any,
  readToken: async () => {
    try {
      return googleSignIn();
    } catch {
      throw new Error("the mail is not connected yet");
    }
  },
};

let cached: { token: string; expires: number } | null = null;

export async function accessToken(deps: MailDeps): Promise<string> {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const t = await deps.readToken();
  const res = await deps.fetch(t.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: t.client_id,
      client_secret: t.client_secret,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Google token refresh failed (${res.status})`);
  const body = await res.json();
  cached = { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3000) * 1000 };
  return cached.token;
}

export function resetTokenCache() {
  cached = null;
}

export async function get(deps: MailDeps, path: string): Promise<any> {
  const res = await deps.fetch(`${API}${path}`, { method: "GET", headers: { Authorization: `Bearer ${await accessToken(deps)}` } });
  if (!res.ok) throw new Error(`Gmail read failed (${res.status})`);
  return res.json();
}

export const header = (msg: any, name: string): string =>
  msg.payload?.headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

function decode(data: string | undefined): string {
  return data ? Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "";
}

export function findPart(part: any, mime: string): string {
  if (!part) return "";
  if (part.mimeType === mime && part.body?.data) return decode(part.body.data);
  for (const p of part.parts ?? []) {
    const found = findPart(p, mime);
    if (found) return found;
  }
  return "";
}

/** Plain text of a message, with links and invisible padding removed so the text stays small. */
export function bodyText(msg: any): string {
  let text = findPart(msg.payload, "text/plain");
  if (!text) {
    text = findPart(msg.payload, "text/html")
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&bull;/g, "•");
  }
  return text
    .replace(/\(?\s*https?:\/\/\S+\s*\)?/g, " ")
    .replace(/[͏­​-‏﻿]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

const addresses = (msgs: any[]): string[] =>
  msgs.flatMap((m) => ["From", "To", "Cc", "Delivered-To"].flatMap((h) => header(m, h).match(/[^\s<>,"]+@[^\s<>,"]+/g) ?? []));

export function gateThread(thread: any) {
  const msgs = thread.messages ?? [];
  return gate({
    addresses: addresses(msgs),
    text: msgs.map((m: any) => `${header(m, "Subject")}\n${m.snippet ?? ""}\n${bodyText(m)}`).join("\n"),
  });
}

export interface ThreadSummary {
  thread_id: string;
  date?: string;
  from?: string;
  subject?: string;
  snippet?: string;
  messages?: number;
  held?: string; // set instead of the fields above when the thread is withheld
}

/** Gmail search. Each hit is read in full so the privacy hold can judge it; a held thread shows only its id. */
export async function searchMail(query: string, deps: MailDeps = realDeps): Promise<ThreadSummary[]> {
  const list = await get(deps, `/threads?maxResults=${MAX_RESULTS}&q=${encodeURIComponent(query)}`);
  const out: ThreadSummary[] = [];
  for (const t of list.threads ?? []) {
    const thread = await get(deps, `/threads/${t.id}?format=full`);
    if (gateThread(thread).held) {
      out.push({ thread_id: t.id, held: HELD });
      continue;
    }
    const last = thread.messages[thread.messages.length - 1];
    out.push({
      thread_id: t.id,
      date: header(last, "Date"),
      from: header(last, "From"),
      subject: header(last, "Subject"),
      snippet: (last.snippet ?? "").slice(0, 200),
      messages: thread.messages.length,
    });
  }
  return out;
}

export interface ThreadText {
  thread_id: string;
  held?: string;
  messages?: { date: string; from: string; to: string; subject: string; body: string }[];
}

export async function readThread(threadId: string, deps: MailDeps = realDeps): Promise<ThreadText> {
  if (!/^[0-9a-f]{8,32}$/i.test(threadId)) throw new Error("not a thread id");
  const thread = await get(deps, `/threads/${threadId}?format=full`);
  if (gateThread(thread).held) return { thread_id: threadId, held: HELD };
  return {
    thread_id: threadId,
    messages: thread.messages.map((m: any) => {
      const body = bodyText(m);
      return {
        date: header(m, "Date"),
        from: header(m, "From"),
        to: header(m, "To"),
        subject: header(m, "Subject"),
        body: body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n[cut at ${MAX_BODY_CHARS} characters]` : body,
      };
    }),
  };
}
