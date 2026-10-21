// Writing mail from the owner's Gmail: save a draft, and send a draft the owner approved. These are
// the only Gmail writes Jarvis has. A send goes through only when Jarvis's last text to the owner
// carried that draft word for word (recipients, subject, body) and the owner has texted back since;
// the check is on the texts in ../approval.ts and reads the draft back from Gmail, so what was read
// is what goes out. Sam can ask for a draft; only Alex's reply can send one.
import { approvedSend } from "../approval";
import { plainText } from "../plain";
import { gate } from "./gate";
import { accessToken, findPart, gateThread, get, header, realDeps as readDeps, type MailDeps } from "./gmail";

// The signed-in account's own mailbox ("me"), joined so the path reads the same as Google's docs.
const API = ["https://gmail.googleapis.com/gmail/v1", "users", "me"].join("/");
export const MAX_RECIPIENTS = 10;
export const MAX_SUBJECT_CHARS = 150;
export const MAX_BODY_CHARS = 2000; // the whole email has to fit in the text the owner approves
export const MAX_SENDS = 3; // per run; each run starts its own tool server
export const SENDS_FOR = "alex"; // the only person whose reply can send mail from this account

export const SHOW_FIRST =
  "Drafted, not sent. Reply with who it goes to (each email address), the subject and the full text of the email, word for word, and ask once, in one short line, whether to send it. When Alex says yes, call send with this draft_id without asking again.";
export const NOT_SHOWN =
  "Not sent: Alex has not been shown this exact draft yet. Reply with who it goes to (each email address), the subject and the full text of the email, word for word, and ask once whether to send it.";
export const NOT_OWNER = "Not sent: only Alex can approve an email from this account. The draft is saved in the Gmail drafts.";

export interface ComposeDeps extends MailDeps {
  sender: string | undefined; // who this run is answering
  sends: { n: number }; // sent so far by this run
  approved: (mail: { addresses: string[]; subject: string; body: string }) => boolean;
}

export const realDeps: ComposeDeps = { ...readDeps, sender: process.env.JARVIS_SENDER, sends: { n: 0 }, approved: approvedSend };

async function write(deps: MailDeps, method: "POST" | "PUT", path: string, body: unknown): Promise<any> {
  const res = await deps.fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken(deps)}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gmail write failed (${res.status})`);
  return res.json();
}

const ADDRESS = /^[^\s<>,"@]+@[^\s<>,"@]+\.[^\s<>,"@]+$/;
const DRAFT_ID = /^[A-Za-z0-9_-]{5,64}$/;
const found = (s: string): string[] => s.match(/[^\s<>,"]+@[^\s<>,"]+/g) ?? [];

function recipients(to: unknown): string[] {
  const list = (Array.isArray(to) ? to : String(to ?? "").split(/[,;]/)).map((a) => String(a).trim()).filter(Boolean);
  if (!list.length) throw new Error("an email needs at least one address to go to");
  if (list.length > MAX_RECIPIENTS) throw new Error(`Jarvis writes to at most ${MAX_RECIPIENTS} people at once`);
  for (const a of list) if (!ADDRESS.test(a)) throw new Error(`"${a}" is not an email address`);
  if (gate({ addresses: list, text: "" }).held) throw new Error("Jarvis does not write to that address");
  return [...new Set(list)];
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const encoded = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

const unencoded = (s: string) => s.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, d) => Buffer.from(d, "base64").toString("utf8"));

function mime(to: string[], subject: string, body: string, replyTo?: string): string {
  const lines = [
    `To: ${to.join(", ")}`,
    `Subject: ${encoded(subject)}`,
    ...(replyTo ? [`In-Reply-To: ${replyTo}`, `References: ${replyTo}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(body).replace(/.{76}/g, "$&\r\n"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

export interface DraftOut {
  draft_id: string;
  to: string[];
  subject: string;
  body: string;
  sent: false;
  say: string;
}

/**
 * Save a draft in the owner's Gmail. `thread_id` makes it a reply on that thread; `draft_id` replaces
 * an earlier draft instead of adding another. Nothing is sent.
 */
export async function createDraft(
  input: { to: unknown; subject?: unknown; body: unknown; thread_id?: unknown; draft_id?: unknown },
  deps: ComposeDeps = realDeps,
): Promise<DraftOut> {
  const to = recipients(input.to);
  const body = plainText(String(input.body ?? "").replace(/\r/g, "")).trim();
  if (!body) throw new Error("the email has no text");
  if (body.length > MAX_BODY_CHARS) throw new Error(`Jarvis drafts at most ${MAX_BODY_CHARS} characters, so the whole email fits in the text the owner approves`);
  let subject = String(input.subject ?? "").replace(/\s+/g, " ").trim();
  if (subject.length > MAX_SUBJECT_CHARS) throw new Error(`the subject is over ${MAX_SUBJECT_CHARS} characters`);
  const replaces = input.draft_id === undefined ? undefined : String(input.draft_id);
  if (replaces !== undefined && !DRAFT_ID.test(replaces)) throw new Error("not a draft id");

  let threadId: string | undefined;
  let replyTo: string | undefined;
  if (input.thread_id !== undefined) {
    threadId = String(input.thread_id);
    if (!/^[0-9a-f]{8,32}$/i.test(threadId)) throw new Error("not a thread id");
    const thread = await get(deps, `/threads/${threadId}?format=full`);
    if (gateThread(thread).held) throw new Error("Jarvis does not read or answer that kind of mail");
    const last = thread.messages[thread.messages.length - 1];
    replyTo = header(last, "Message-ID") || undefined;
    if (!subject) subject = `Re: ${header(last, "Subject").replace(/^(re:\s*)+/i, "")}`;
  }
  if (!subject) throw new Error("the email needs a subject");

  const message = { raw: mime(to, subject, body, replyTo), ...(threadId ? { threadId } : {}) };
  const saved = replaces ? await write(deps, "PUT", `/drafts/${replaces}`, { message }) : await write(deps, "POST", "/drafts", { message });
  return { draft_id: saved.id, to, subject, body, sent: false, say: SHOW_FIRST };
}

export type SendOut = { sent: true; to: string[]; subject: string } | { sent: false; needs_go_ahead: true; say: string };

/** Send a saved draft, once the owner has read that exact draft in a text and answered it. */
export async function sendDraft(input: { draft_id: unknown }, deps: ComposeDeps = realDeps): Promise<SendOut> {
  const id = String(input.draft_id ?? "");
  if (!DRAFT_ID.test(id)) throw new Error("not a draft id");
  if (deps.sender !== SENDS_FOR) return { sent: false, needs_go_ahead: true, say: NOT_OWNER };
  if (deps.sends.n >= MAX_SENDS) throw new Error(`Jarvis sends at most ${MAX_SENDS} emails in one turn`);

  // The draft is read back from Gmail, so the check is on what will actually go out.
  const draft = await get(deps, `/drafts/${id}?format=full`);
  const msg = draft.message;
  if (msg?.payload?.mimeType !== "text/plain" || msg.payload.parts?.length) throw new Error("Jarvis sends only the plain drafts it wrote");
  const to = found(header(msg, "To"));
  const addresses = [...to, ...found(header(msg, "Cc")), ...found(header(msg, "Bcc"))];
  if (!to.length || addresses.length > MAX_RECIPIENTS) throw new Error("that draft has no recipient Jarvis can send to");
  if (gate({ addresses, text: "" }).held) throw new Error("Jarvis does not write to that address");
  const subject = unencoded(header(msg, "Subject"));
  const body = findPart(msg.payload, "text/plain");
  if (!deps.approved({ addresses, subject, body })) return { sent: false, needs_go_ahead: true, say: NOT_SHOWN };

  await write(deps, "POST", "/drafts/send", { id });
  deps.sends.n++;
  return { sent: true, to, subject };
}
