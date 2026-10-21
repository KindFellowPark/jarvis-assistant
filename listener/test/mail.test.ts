// Mail tool checks. The run can search and read Alex's Gmail and nothing else:
//   1. every Gmail request is a GET, and the only POST is the token refresh;
//   2. a held thread (health, credentials, identity or tax, full financial documents, work
//      scope, blocked domains) returns no subject, sender, snippet or body;
//   3. the server offers exactly four tools, and a real run sees exactly those plus Read, Glob, Grep.
// Drafting and the approved send are checked in compose.test.ts.
import { beforeEach, describe, expect, test } from "bun:test";
import { SENDERS } from "../src/config";
import { gate } from "../src/mail/gate";
import { bodyText, HELD, readThread, resetTokenCache, searchMail, type MailDeps } from "../src/mail/gmail";
import { TOOLS } from "../src/mail/server";
import { mcpConfig, realRunner } from "../src/runner";

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const msg = (over: { from?: string; to?: string; subject?: string; body?: string; html?: string } = {}) => ({
  snippet: (over.body ?? "").slice(0, 50),
  payload: {
    headers: [
      { name: "From", value: over.from ?? "Petstore <service@petstore.example.com>" },
      { name: "To", value: over.to ?? "alex@example.com" },
      { name: "Subject", value: over.subject ?? "Your Autoship order was delivered" },
      { name: "Date", value: "Wed, 23 Sep 2026 13:47:20 -0700" },
    ],
    mimeType: "multipart/alternative",
    parts: over.html
      ? [{ mimeType: "text/html", body: { data: b64(over.html) } }]
      : [{ mimeType: "text/plain", body: { data: b64(over.body ?? "Cat food variety pack, qty 1. Delivered.") } }],
  },
});

function fakeDeps(threads: Record<string, any[]>) {
  const calls: { method: string; url: string }[] = [];
  const deps: MailDeps = {
    readToken: async () => ({ refresh_token: "r", client_id: "c", client_secret: "s" }),
    fetch: async (url, init) => {
      calls.push({ method: init?.method ?? "GET", url });
      const ok = (body: any) => ({ ok: true, status: 200, json: async () => body });
      if (url.startsWith("https://oauth2.googleapis.com/token")) return ok({ access_token: "a", expires_in: 3600 });
      const one = url.match(/\/threads\/([0-9a-f]+)\?format=full$/);
      if (one) return ok({ id: one[1], messages: threads[one[1]!] });
      if (url.includes("/threads?")) return ok({ threads: Object.keys(threads).map((id) => ({ id })) });
      return { ok: false, status: 404, json: async () => ({}) };
    },
  };
  return { deps, calls };
}

beforeEach(() => resetTokenCache());

describe("read-only", () => {
  test("search and read make only GET requests to Gmail, plus one token refresh", async () => {
    const { deps, calls } = fakeDeps({ aaaaaaaa1: [msg()], aaaaaaaa2: [msg()] });
    await searchMail("from:petstore.example.com", deps);
    await readThread("aaaaaaaa1", deps);
    const gmail = calls.filter((c) => c.url.includes("gmail.googleapis.com"));
    expect(gmail.length).toBe(4);
    expect(gmail.every((c) => c.method === "GET")).toBe(true);
    expect(gmail.every((c) => /\/users\/me\/threads(\?|\/[0-9a-f]+\?format=full$)/.test(c.url))).toBe(true);
    const others = calls.filter((c) => !c.url.includes("gmail.googleapis.com"));
    expect(others).toEqual([{ method: "POST", url: "https://oauth2.googleapis.com/token" }]);
  });

  test("the source has no Gmail write endpoint or write method in it", async () => {
    const src = await Bun.file(new URL("../src/mail/gmail.ts", import.meta.url)).text();
    for (const word of ["/send", "/drafts", "/modify", "/trash", "/labels", "batchDelete", '"DELETE"', '"PUT"', '"PATCH"']) expect(src).not.toContain(word);
    expect(src.match(/method: "POST"/g)?.length).toBe(1); // the token refresh
  });

  test("a thread id that is not an id is refused before any request", async () => {
    const { deps, calls } = fakeDeps({});
    expect(readThread("../drafts", deps)).rejects.toThrow("not a thread id");
    expect(calls.length).toBe(0);
  });

  test("the server offers exactly search, read, draft and send", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["search", "read", "draft", "send"]);
  });
});

describe("privacy hold", () => {
  const held: [string, any][] = [
    ["a blocked sender domain", msg({ from: "Clinic <noreply@clinic.example.com>", subject: "Visit summary", body: "See you soon." })],
    ["a work recipient", msg({ to: "alex@work.example.com", body: "Agenda attached." })],
    ["a subdomain of a blocked domain", msg({ from: "x@mail.work.example.com", body: "Reminder." })],
    ["a meeting-notetaker recap", msg({ from: "no-reply@recaps.example.com", subject: "Recap", body: "Key takeaways: budget." })],
    ["health content", msg({ body: "Your lab result is ready to view." })],
    ["a credential", msg({ body: "Your temporary password: hunter2" })],
    ["tax content", msg({ body: "Your W-2 is available for download." })],
    ["a full financial document", msg({ body: "Routing number and account details enclosed." })],
    ["institutional scope", msg({ body: "The purchase order was approved." })],
  ];
  for (const [name, m] of held) {
    test(`${name} is held, with nothing from the thread returned`, async () => {
      const { deps } = fakeDeps({ abcdef012: [m] });
      const found = await searchMail("anything", deps);
      expect(found).toEqual([{ thread_id: "abcdef012", held: HELD }]);
      expect(await readThread("abcdef012", deps)).toEqual({ thread_id: "abcdef012", held: HELD });
    });
  }

  test("one held message holds the whole thread", async () => {
    const { deps } = fakeDeps({ abcdef013: [msg(), msg({ body: "Here is the prescription refill notice." })] });
    expect((await readThread("abcdef013", deps)).messages).toBeUndefined();
  });

  test("ordinary mail is returned", async () => {
    const { deps } = fakeDeps({ abcdef014: [msg()] });
    const [hit] = await searchMail("from:petstore.example.com", deps);
    expect(hit).toMatchObject({ thread_id: "abcdef014", subject: "Your Autoship order was delivered", messages: 1 });
    expect((await readThread("abcdef014", deps)).messages![0]!.body).toContain("Cat food");
  });

  test("a pattern inside a longer word does not hold", () => {
    expect(gate({ addresses: [], text: "the 10990 order shipped" }).held).toBe(false);
    expect(gate({ addresses: ["a@notwork.example.com"], text: "" }).held).toBe(false);
  });
});

describe("body text", () => {
  test("links and invisible padding are stripped, html falls back to text", () => {
    expect(bodyText(msg({ body: "Order total: $33.81 ( https://clicks.example.com/abc )͏͏ ok" }))).toBe("Order total: $33.81 ok");
    expect(bodyText(msg({ html: "<style>p{}</style><p>Delivered&nbsp;today &amp; signed</p>" }))).toBe("Delivered today & signed");
  });
});

describe("what a run can reach", () => {
  const ALEX = SENDERS[0]!;

  test("the run's MCP config names the mail, calendar, maps, bills and lists servers and nothing else", () => {
    expect(Object.keys(JSON.parse(mcpConfig(ALEX)).mcpServers)).toEqual(["mail", "calendar", "maps", "bills", "lists"]);
    expect(JSON.parse(mcpConfig({ ...ALEX, mail: false, calendar: false, maps: false, bills: false, lists: false })).mcpServers).toEqual({});
  });

  // Starts an actual Claude run; skipped unless JARVIS_LIVE=1 (see safety.test.ts).
  test.skipIf(process.env.JARVIS_LIVE !== "1")("[real] a run sees Read, Glob, Grep, four mail tools, four calendar tools, two maps tools, the bills tool and the lists tool, on five MCP servers", async () => {
    const out = await realRunner({ systemPrompt: "Answer briefly." })({
      sender: ALEX, prompt: "Reply with the single word ok", sessionId: crypto.randomUUID(), resume: false, persist: false,
    });
    expect(out.kind).toBe("reply");
    if (out.kind !== "reply") return;
    expect([...out.init.tools].sort()).toEqual(["Glob", "Grep", "Read", "mcp__bills__add", "mcp__calendar__add", "mcp__calendar__change", "mcp__calendar__events", "mcp__calendar__remove", "mcp__lists__append", "mcp__mail__draft", "mcp__mail__read", "mcp__mail__search", "mcp__mail__send", "mcp__maps__drive", "mcp__maps__places"]);
    expect((out.init.mcpServers as { name: string }[]).map((m) => m.name).sort()).toEqual(["bills", "calendar", "lists", "mail", "maps"]);
    expect(out.init.apiKeySource).toBe("none");
  }, 180_000);
});
