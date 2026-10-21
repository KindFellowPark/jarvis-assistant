// Mail watches: the owner names a kind of email they are waiting for, and code texts them when one
// arrives. Each watch in mail_watches.json is a Gmail search plus fixed rules; no model
// reads the mail. Only the sender, subject and Gmail's short snippet are fetched, as metadata,
// so the privacy hold's body checks never come into it. Nothing here replies, labels or marks
// anything read: every Gmail request is a GET through src/mail/gmail.ts.
//
// A text goes through the local door in notify mode under the id mailwatch:<watch>:<message>,
// which the door accepts once, so every run can safely look back over the whole watch window and
// a text held back (quiet hours, listener down, no thread yet) goes out on a later run.
import { DOOR_PORT, TIME_ZONE } from "../src/config";
import { get, header, realDeps, type MailDeps } from "../src/mail/gmail";
import { noticeHours, todayIn } from "./bills_export";
import watchFile from "./mail_watches.json";

export interface Watch {
  id: string;
  about: string; // finishes "Email from <sender> about ..."
  since: string; // ISO time; mail received before it is never reported
  until: string; // YYYY-MM-DD; the watch stops after this day
  query: string; // Gmail search; the job adds -from:me and the since date
  trusted_domains: string[]; // a sender here is a real update
  sender_names?: Record<string, string>; // how to name a sender domain with no display name of its own
  ignore_domains: string[]; // checked first: newsletters and marketing from a trusted company
  must_mention: string[]; // at least one, in the sender, subject or snippet; empty means any
  // How to name each must_mention word in the text; fills "{name}" in about. One watch can then
  // cover many companies and still say which one wrote.
  mention_names?: Record<string, string>;
  // At least one of these too, in the subject or snippet. Keeps a trusted company's own marketing
  // ("Claim your $100 off") out of a watch for one piece of business, and narrows the impersonation check.
  must_also_mention?: string[];
  // Mail that says one of these phrases is routine ("we received your request") and is not
  // texted, unless it also says one of the unless words, which mark a decision or a request.
  routine?: { phrases: string[]; unless: string[] };
  thread_ids: string[]; // any reply on one of these threads is an update
  impersonation?: Impersonation | Impersonation[];
}

export interface Impersonation {
  name: string;
  claims: string[];
  real_domain: string;
}

export interface Mail {
  id: string;
  threadId: string;
  received: number; // ms since epoch (Gmail's internalDate)
  from: string;
  subject: string;
  snippet: string;
}

export type Notice = { id: string; kind: "update" | "impersonation"; text: string };

export const WATCHES = watchFile as Watch[];
const MAX_RESULTS = 50;
const SNIPPET_CHARS = 200;

const addressOf = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
const displayName = (from: string) => (from.includes("<") ? from.replace(/<[^>]*>/, "").replace(/"/g, "").trim() : "");
const domainOf = (from: string) => addressOf(from).split("@").pop() ?? "";
const under = (domain: string, list: string[]) => list.some((d) => domain === d || domain.endsWith(`.${d}`));

function unescape(s: string): string {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

export function active(w: Watch, today: string): boolean {
  return today <= w.until;
}

/** The one place a watch decides: a real update, a claim to be the company from elsewhere, or nothing. */
export function judge(w: Watch, m: Mail): Notice | null {
  if (m.received < Date.parse(w.since)) return null;
  const domain = domainOf(m.from);
  if (under(domain, w.ignore_domains)) return null;
  const subject = m.subject.trim() || "(no subject)";
  const snippet = unescape(m.snippet).replace(/\s+/g, " ").trim();
  const said = snippet.length > SNIPPET_CHARS ? `${snippet.slice(0, SNIPPET_CHARS)}...` : snippet;
  const id = `mailwatch:${w.id}:${m.id}`;
  const hay = `${m.from}\n${m.subject}\n${snippet}`.toLowerCase();
  // A word counts only where a word starts, so "harbor" finds "Harbor" and "harbormutual" but not "sharbor".
  const startsWord = (word: string) => new RegExp(`(?<![a-z0-9])${word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(hay);
  const mentioned = w.must_mention.find(startsWord);
  const mentions = w.must_mention.length === 0 || mentioned !== undefined;
  const body = `${m.subject}\n${snippet}`.toLowerCase();
  const alsoMentions = !w.must_also_mention || w.must_also_mention.some((word) => body.includes(word.toLowerCase()));
  if (w.thread_ids.includes(m.threadId) || (under(domain, w.trusted_domains) && mentions && alsoMentions)) {
    const r = w.routine;
    if (r && r.phrases.some((p) => body.includes(p.toLowerCase())) && !r.unless.some((u) => body.includes(u.toLowerCase()))) return null;
    const named = Object.entries(w.sender_names ?? {}).find(([d]) => under(domain, [d]))?.[1];
    const name = displayName(m.from) || named || addressOf(m.from);
    const about = w.about.replace("{name}", (mentioned && w.mention_names?.[mentioned]) || "it");
    const text = [`Email from ${name} about ${about}: "${subject}".`, said ? `It starts: "${said}"` : ""];
    return { id, kind: "update", text: text.filter(Boolean).join("\n\n") };
  }
  // A sender outside the trusted list that names the company in its own name or the subject.
  // A mention only in the body (a newsletter, a job alert's snippet) is not a claim to be them.
  const claimed = `${m.from}\n${m.subject}`.toLowerCase();
  const imps = w.impersonation === undefined ? [] : Array.isArray(w.impersonation) ? w.impersonation : [w.impersonation];
  const imp = imps.find((i) => !under(domain, [i.real_domain]) && i.claims.some((c) => claimed.includes(c.toLowerCase())));
  if (imp && !under(domain, w.trusted_domains) && alsoMentions) {
    const text = [
      `Possible impersonation, not a real update: an email claiming to be ${imp.name} came from ${addressOf(m.from)}. ${imp.name} says its real mail comes only from @${imp.real_domain}.`,
      `Subject: "${subject}". Don't reply or open its links until you've checked it.`,
    ];
    return { id, kind: "impersonation", text: text.join("\n\n") };
  }
  return null;
}

export function gmailQuery(w: Watch): string {
  return `${w.query} -from:me after:${Math.floor(Date.parse(w.since) / 1000)}`;
}

/** Sender, subject and snippet of every message the watch's search finds. Metadata only. */
export async function fetchMail(w: Watch, deps: MailDeps = realDeps): Promise<{ mail: Mail[]; more: boolean }> {
  const list = await get(deps, `/messages?maxResults=${MAX_RESULTS}&q=${encodeURIComponent(gmailQuery(w))}`);
  const mail: Mail[] = [];
  for (const { id } of list.messages ?? []) {
    const m = await get(deps, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
    mail.push({ id: m.id, threadId: m.threadId, received: Number(m.internalDate), from: header(m, "From"), subject: header(m, "Subject"), snippet: m.snippet ?? "" });
  }
  return { mail, more: Boolean(list.nextPageToken) };
}

export async function postNotice(n: Notice, port = DOOR_PORT): Promise<string> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: n.id, to: "alex", mode: "notify", text: n.text }),
    });
    return ((await res.json()) as any).status;
  } catch {
    return "listener not reachable, will retry next run";
  }
}

if (import.meta.main) {
  // --dry-run prints what would be texted and posts nothing; --since <ISO> moves every watch's
  // start back, to test the rules on mail that has already arrived.
  const dry = process.argv.includes("--dry-run");
  const sinceArg = process.argv[process.argv.indexOf("--since") + 1];
  const since = process.argv.includes("--since") ? sinceArg : null;
  const stamp = new Date().toISOString();
  const today = todayIn(TIME_ZONE);
  const sending = !dry && noticeHours(TIME_ZONE);
  for (const base of WATCHES) {
    const w = since ? { ...base, since } : base;
    if (!active(w, today)) continue;
    try {
      const { mail, more } = await fetchMail(w);
      if (more) console.log(`${stamp} ${w.id}: more than ${MAX_RESULTS} matches; only the newest were judged`);
      const notices = mail.map((m) => judge(w, m)).filter((n): n is Notice => n !== null);
      console.log(`${stamp} ${w.id}: ${mail.length} found, ${notices.length} to report`);
      for (const n of notices) {
        if (dry) console.log(`--- ${n.id} (${n.kind})\n${n.text}`);
        else if (sending) console.log(`${stamp} ${n.id}: ${await postNotice(n)}`);
        else console.log(`${stamp} ${n.id}: held for quiet hours`);
      }
    } catch (err) {
      console.log(`${stamp} ${w.id}: ${(err as Error).message}`);
    }
  }
}
