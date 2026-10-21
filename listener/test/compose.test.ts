// Email writing checks. Jarvis can save a draft and send a draft Alex approved, and nothing else:
//   1. a draft is one POST (or PUT, when it replaces one) to /drafts and never a send;
//   2. a send happens only for Alex, only when the last reply from Jarvis carried that draft word
//      for word (addresses, subject, body) and Alex texted back since, and at most MAX_SENDS a run;
//   3. the draft is read back from Gmail before the check, so what Alex read is what goes out;
//   4. blocked addresses and held threads get no draft and no send.
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { lastAsk, shows } from "../src/approval";
import { createDraft, MAX_SENDS, NOT_OWNER, NOT_SHOWN, sendDraft, SHOW_FIRST, type ComposeDeps } from "../src/mail/compose";
import { resetTokenCache } from "../src/mail/gmail";
import { plainText } from "../src/plain";

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const BODY = "Hi Sam,\n\nSomething came up and I have to cancel dinner on Saturday. Sorry for the short notice.\n\nAlex";
const stored = (over: { to?: string; cc?: string; subject?: string; body?: string; parts?: any[] } = {}) => ({
  id: "r-123456789",
  message: {
    payload: {
      mimeType: over.parts ? "multipart/mixed" : "text/plain",
      headers: [
        { name: "To", value: over.to ?? "sam@example.com" },
        ...(over.cc ? [{ name: "Cc", value: over.cc }] : []),
        { name: "Subject", value: over.subject ?? "Saturday dinner" },
      ],
      ...(over.parts ? { parts: over.parts } : { body: { data: b64((over.body ?? BODY).replace(/\n/g, "\r\n")) } }),
    },
  },
});

function fake(opts: { draft?: any; thread?: any[]; sender?: string; approved?: ComposeDeps["approved"] } = {}) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const deps: ComposeDeps = {
    readToken: async () => ({ refresh_token: "r", client_id: "c", client_secret: "s" }),
    sender: opts.sender ?? "alex",
    sends: { n: 0 },
    approved: opts.approved ?? (() => true),
    fetch: async (url, init) => {
      const ok = (body: any) => ({ ok: true, status: 200, json: async () => body });
      if (url.startsWith("https://oauth2.googleapis.com/token")) return ok({ access_token: "a", expires_in: 3600 });
      calls.push({ method: init?.method ?? "GET", url: url.replace(/^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me/, ""), body: init?.body ? JSON.parse(init.body) : undefined });
      if (url.includes("/threads/")) return ok({ id: "aaaaaaaa1", messages: opts.thread });
      if (url.endsWith("/drafts/send")) return ok({ id: "sent1" });
      if (/\/drafts\/[^/?]+\?format=full$/.test(url)) return ok(opts.draft ?? stored());
      if (url.includes("/drafts")) return ok({ id: "r-123456789" });
      return { ok: false, status: 404, json: async () => ({}) };
    },
  };
  return { deps, calls };
}

const raw = (call: { body?: any }) => Buffer.from(call.body.message.raw, "base64url").toString("utf8");
const sentBody = (call: { body?: any }) => Buffer.from(raw(call).split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString("utf8");

beforeEach(() => resetTokenCache());

describe("draft", () => {
  test("saves one draft with the address, subject and text, and sends nothing", async () => {
    const { deps, calls } = fake();
    const out = await createDraft({ to: ["sam@example.com"], subject: "Saturday dinner", body: BODY }, deps);
    expect(out).toEqual({ draft_id: "r-123456789", to: ["sam@example.com"], subject: "Saturday dinner", body: BODY, sent: false, say: SHOW_FIRST });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /drafts"]);
    expect(raw(calls[0]!)).toContain("To: sam@example.com\r\nSubject: Saturday dinner\r\n");
    expect(sentBody(calls[0]!)).toBe(BODY);
  });

  test("markdown marks are taken out, so the draft matches the text Alex will be shown", async () => {
    const { deps, calls } = fake();
    const out = await createDraft({ to: ["sam@example.com"], subject: "List", body: "- **Bring** the tickets\n- Park in lot B" }, deps);
    expect(out.body).toBe("Bring the tickets\nPark in lot B");
    expect(sentBody(calls[0]!)).toBe(out.body);
  });

  test("a subject outside plain ASCII is encoded and the body survives", async () => {
    const { deps, calls } = fake();
    await createDraft({ to: ["sam@example.com"], subject: "Cena el sábado", body: "Nos vemos mañana 🙂" }, deps);
    expect(raw(calls[0]!)).toContain(`Subject: =?UTF-8?B?${Buffer.from("Cena el sábado").toString("base64")}?=`);
    expect(sentBody(calls[0]!)).toBe("Nos vemos mañana 🙂");
  });

  test("replacing a draft is a PUT to that draft, not a second draft", async () => {
    const { deps, calls } = fake();
    await createDraft({ to: ["sam@example.com"], subject: "Saturday dinner", body: "Shorter.", draft_id: "r-123456789" }, deps);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["PUT /drafts/r-123456789"]);
  });

  test("a reply goes on the thread, answers its last message and takes its subject", async () => {
    const thread = [{ payload: { headers: [{ name: "From", value: "Sam <sam@example.com>" }, { name: "Subject", value: "Re: Dinner?" }, { name: "Message-ID", value: "<abc@mail.example.com>" }], mimeType: "text/plain", body: { data: b64("Are we still on?") } } }];
    const { deps, calls } = fake({ thread });
    const out = await createDraft({ to: ["sam@example.com"], body: "Yes, 7 works.", thread_id: "aaaaaaaa1" }, deps);
    expect(out.subject).toBe("Re: Dinner?");
    expect(calls.at(-1)!.body.message.threadId).toBe("aaaaaaaa1");
    expect(raw(calls.at(-1)!)).toContain("In-Reply-To: <abc@mail.example.com>\r\nReferences: <abc@mail.example.com>\r\n");
  });

  test("a held thread gets no reply draft", async () => {
    const thread = [{ payload: { headers: [{ name: "From", value: "Registrar <x@work.example.com>" }, { name: "Subject", value: "Schedule" }], mimeType: "text/plain", body: { data: b64("hello") } } }];
    const { deps, calls } = fake({ thread });
    expect(createDraft({ to: ["sam@example.com"], body: "ok", thread_id: "aaaaaaaa1" }, deps)).rejects.toThrow("does not read or answer");
    await Promise.resolve();
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  test("bad input is refused before any request", async () => {
    const { deps, calls } = fake();
    const long = "x".repeat(2001);
    expect(createDraft({ to: [], subject: "s", body: "b" }, deps)).rejects.toThrow("at least one address");
    expect(createDraft({ to: ["not an address"], subject: "s", body: "b" }, deps)).rejects.toThrow("not an email address");
    expect(createDraft({ to: ["dean@work.example.com"], subject: "s", body: "b" }, deps)).rejects.toThrow("does not write to that address");
    expect(createDraft({ to: Array.from({ length: 11 }, (_, i) => `p${i}@example.com`), subject: "s", body: "b" }, deps)).rejects.toThrow("at most 10");
    expect(createDraft({ to: ["sam@example.com"], subject: "s", body: " " }, deps)).rejects.toThrow("no text");
    expect(createDraft({ to: ["sam@example.com"], subject: "s", body: long }, deps)).rejects.toThrow("at most 2000");
    expect(createDraft({ to: ["sam@example.com"], body: "b" }, deps)).rejects.toThrow("needs a subject");
    expect(createDraft({ to: ["sam@example.com"], subject: "s", body: "b", draft_id: "../send" }, deps)).rejects.toThrow("not a draft id");
    expect(calls.length).toBe(0);
  });
});

describe("send", () => {
  test("an approved draft is read back, checked and sent with one request", async () => {
    const seen: any[] = [];
    const { deps, calls } = fake({ approved: (m) => (seen.push(m), true) });
    expect(await sendDraft({ draft_id: "r-123456789" }, deps)).toEqual({ sent: true, to: ["sam@example.com"], subject: "Saturday dinner" });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /drafts/r-123456789?format=full", "POST /drafts/send"]);
    expect(calls[1]!.body).toEqual({ id: "r-123456789" });
    expect(seen[0].addresses).toEqual(["sam@example.com"]);
    expect(seen[0].subject).toBe("Saturday dinner");
    expect(seen[0].body.replace(/\r/g, "")).toBe(BODY);
  });

  test("a draft Alex has not been shown is not sent", async () => {
    const { deps, calls } = fake({ approved: () => false });
    expect(await sendDraft({ draft_id: "r-123456789" }, deps)).toEqual({ sent: false, needs_go_ahead: true, say: NOT_SHOWN });
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  test("Sam's run cannot send, whatever the texts say", async () => {
    const { deps, calls } = fake({ sender: "sam" });
    expect(await sendDraft({ draft_id: "r-123456789" }, deps)).toEqual({ sent: false, needs_go_ahead: true, say: NOT_OWNER });
    expect(calls.length).toBe(0);
  });

  test("copied recipients have to be shown too", async () => {
    const seen: any[] = [];
    const { deps } = fake({ draft: stored({ cc: "Boss <boss@example.com>" }), approved: (m) => (seen.push(m), false) });
    await sendDraft({ draft_id: "r-123456789" }, deps);
    expect(seen[0].addresses).toEqual(["sam@example.com", "boss@example.com"]);
  });

  test("a draft with attachments, a blocked address or no recipient is refused", async () => {
    const withFile = fake({ draft: stored({ parts: [{ mimeType: "text/plain", body: { data: b64("x") } }, { filename: "a.pdf", mimeType: "application/pdf", body: {} }] }) });
    expect(sendDraft({ draft_id: "r-123456789" }, withFile.deps)).rejects.toThrow("only the plain drafts");
    const blocked = fake({ draft: stored({ to: "dean@work.example.com" }) });
    expect(sendDraft({ draft_id: "r-123456789" }, blocked.deps)).rejects.toThrow("does not write to that address");
    const nobody = fake({ draft: stored({ to: "" }) });
    expect(sendDraft({ draft_id: "r-123456789" }, nobody.deps)).rejects.toThrow("no recipient");
    expect(sendDraft({ draft_id: "../../threads" }, fake().deps)).rejects.toThrow("not a draft id");
    await Promise.resolve();
    for (const f of [withFile, blocked, nobody]) expect(f.calls.some((c) => c.method !== "GET")).toBe(false);
  });

  test(`one run sends at most ${MAX_SENDS} emails`, async () => {
    const { deps, calls } = fake();
    for (let i = 0; i < MAX_SENDS; i++) await sendDraft({ draft_id: "r-123456789" }, deps);
    expect(sendDraft({ draft_id: "r-123456789" }, deps)).rejects.toThrow(`at most ${MAX_SENDS}`);
    expect(calls.filter((c) => c.url === "/drafts/send").length).toBe(MAX_SENDS);
  });

  test("the source can save and send drafts and nothing else", async () => {
    const src = await Bun.file(new URL("../src/mail/compose.ts", import.meta.url)).text();
    for (const word of ["/messages", "/modify", "/trash", "/labels", "batchDelete", '"DELETE"', '"PATCH"', "/settings", "forward"]) expect(src).not.toContain(word);
    expect(src.match(/\/drafts\/send/g)?.length).toBe(1);
  });
});

describe("the check on the texts", () => {
  const mail = { addresses: ["sam@example.com"], subject: "Saturday dinner", body: BODY.replace(/\n/g, "\r\n") };
  const reply = `Here's the note to sam@example.com.\n\nSubject: Saturday dinner\n\n${BODY}\n\nSend it?`;

  test("a reply that carries the whole email counts as shown", () => {
    expect(shows(reply, mail)).toBe(true);
    expect(shows(plainText(reply), mail)).toBe(true);
  });

  test("a changed word, a missing address or a missing subject does not", () => {
    expect(shows(reply.replace("Saturday. Sorry", "Sunday. Sorry"), mail)).toBe(false);
    expect(shows(reply.replace("sam@example.com", "Sam"), mail)).toBe(false);
    expect(shows(reply.replace("Subject: Saturday dinner", ""), { ...mail, subject: "Dinner is off" })).toBe(false);
    expect(shows("I drafted a note to sam@example.com about Saturday dinner. Send it?", mail)).toBe(false);
    expect(shows(reply, { ...mail, addresses: ["sam@example.com", "boss@example.com"] })).toBe(false);
    expect(shows(reply, { ...mail, body: "" })).toBe(false);
  });

  test("the reply must be Jarvis's last one, and the person must have texted since", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-compose-"));
    const path = join(dir, "queue.sqlite");
    const db = new Database(path);
    db.run("CREATE TABLE messages (id TEXT, sender_key TEXT, source TEXT, state TEXT, reply TEXT, created_at TEXT, updated_at TEXT)");
    const now = Date.parse("2026-10-02T20:00:00Z");
    db.run("INSERT INTO messages VALUES ('m1','alex','photon','send_confirmed',?, '2026-10-02T19:00:00Z','2026-10-02T19:00:10Z')", [reply]);
    expect(lastAsk("alex", path, now)).toBeNull(); // nothing in flight: no answer yet
    db.run("INSERT INTO messages VALUES ('m2','alex','photon','queued',NULL,'2026-10-02T19:05:00Z','2026-10-02T19:05:00Z')");
    expect(shows(lastAsk("alex", path, now)!, mail)).toBe(true);
    expect(lastAsk("sam", path, now)).toBeNull();
    db.close();
  });
});
