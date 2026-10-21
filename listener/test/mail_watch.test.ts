// Mail watch checks (jobs/mail_watch.ts): each watch texts a real update once, flags a claim to be
// the company from another domain, ignores everything else, and reads Gmail by GET only.
// The two watches and every email below are fictional; the shapes are the ones the real watches
// were built against.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { active, fetchMail, gmailQuery, judge, postNotice, WATCHES, type Mail, type Watch } from "../jobs/mail_watch";
import { startDoor } from "../src/door";
import { Listener } from "../src/listener";
import type { MailDeps } from "../src/mail/gmail";
import { Store } from "../src/store";

const watch = (id: string): Watch => WATCHES.find((w) => w.id === id)!;
const claim = watch("insurance-claim");
const refund = watch("store-refund");
const mail = (over: Partial<Mail>): Mail => ({
  id: "m1", threadId: "t1", received: Date.parse("2026-10-25T17:00:00Z"), from: "", subject: "", snippet: "", ...over,
});

describe("watch file", () => {
  test("every watch has an id, dates and a search, and ids are unique", () => {
    expect(new Set(WATCHES.map((w) => w.id)).size).toBe(WATCHES.length);
    for (const w of WATCHES) {
      expect(Number.isNaN(Date.parse(w.since))).toBe(false);
      expect(w.until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(w.query.length).toBeGreaterThan(0);
      expect(w.about.length).toBeGreaterThan(0);
    }
  });

  test("a watch stops after its last day", () => {
    expect(active(claim, "2027-04-30")).toBe(true);
    expect(active(claim, "2027-05-01")).toBe(false);
  });

  test("the search leaves out the owner's own mail and starts at the watch's start", () => {
    expect(gmailQuery(claim)).toEndWith(`-from:me after:${Date.parse(claim.since) / 1000}`);
  });
});

describe("an insurance claim", () => {
  test("a confirmation that the claim was received is routine and not texted", () => {
    expect(judge(claim, mail({ from: "Harbor Mutual <noreply@harbormutual.example.com>", subject: "We received your claim", snippet: "Thanks, Alex. We received your claim for the water damage on Oct 20. Your claim number is HM-000123." }))).toBeNull();
    expect(judge(claim, mail({ from: "Pat Rivera <pat.rivera@harbormutual.example.com>", subject: "Automatic reply: claim HM-000123", snippet: "I am out of the office until Monday." }))).toBeNull();
  });

  test("a confirmation that also asks to schedule an inspection is texted", () => {
    const n = judge(claim, mail({ from: "Harbor Mutual <noreply@harbormutual.example.com>", subject: "We received your claim", snippet: "We received your claim. Please reply to schedule an inspection with your adjuster this week." }));
    expect(n?.kind).toBe("update");
    expect(n?.id).toBe("mailwatch:insurance-claim:m1");
    expect(n?.text).toStartWith('Email from Harbor Mutual about your Harbor Mutual claim: "We received your claim".');
  });

  test("a person writing back about the claim is texted, named by their own display name", () => {
    const n = judge(claim, mail({ from: "Pat Rivera <pat.rivera@harbormutual.example.com>", subject: "Your Harbor Mutual claim: estimate", snippet: "Hi Alex, the estimate is attached. Payment will follow once you sign." }));
    expect(n?.kind).toBe("update");
    expect(n?.text).toStartWith('Email from Pat Rivera about your Harbor Mutual claim: "Your Harbor Mutual claim: estimate".');
  });

  test("a claims portal with no display name is named from the watch's own list", () => {
    const n = judge(claim, mail({ from: "notices@claimsdesk.example.com", subject: "Harbor Mutual claim update", snippet: "Your adjuster has been assigned." }));
    expect(n?.text).toStartWith("Email from ClaimsDesk about your Harbor Mutual claim");
  });

  test("the company's own newsletter and marketing are not reported", () => {
    expect(judge(claim, mail({ from: "Harbor Mutual <hello@news.harbormutual.example.com>", subject: "Your claim questions, answered", snippet: "Five tips for filing a claim" }))).toBeNull();
    expect(judge(claim, mail({ from: "Harbor Mutual <offers@harbormutual.example.com>", subject: "Bundle and save 15%", snippet: "Harbor Mutual home and auto together." }))).toBeNull();
  });

  test("a sender elsewhere that claims to be the company about the claim is flagged, never reported as an update", () => {
    const n = judge(claim, mail({ from: "Harbor Mutual Claims <payout@harbormutual-claims.example.com>", subject: "Your claim payment", snippet: "Please confirm your bank details" }));
    expect(n?.kind).toBe("impersonation");
    expect(n?.text).toContain("payout@harbormutual-claims.example.com");
    expect(n?.text).toContain("@harbormutual.example.com");
    expect(n?.text).not.toContain("bank details");
    const freemail = judge(claim, mail({ from: "Claims Team <claims.team@freemail.example.com>", subject: "Harbor Mutual claim: adjuster visit" }));
    expect(freemail?.kind).toBe("impersonation");
  });

  test("a newsletter naming the company, with no claim words, is ignored", () => {
    expect(judge(claim, mail({ from: "Weekly Digest <news@digest.example.com>", subject: "Harbor Mutual raises rates", snippet: "A big week for insurers" }))).toBeNull();
  });

  test("mail from before the watch started is ignored", () => {
    expect(judge(claim, mail({ received: Date.parse("2026-10-20T22:17:27Z"), from: "Pat Rivera <pat.rivera@harbormutual.example.com>", subject: "Your claim: adjuster visit" }))).toBeNull();
  });
});

describe("a store refund", () => {
  test("any reply on the refund thread is an update, whoever sends it", () => {
    const n = judge(refund, mail({ threadId: "18f0c0ffee000001", from: "Support <help@helpdesk.example.com>", subject: "Re: Refund request for order 4471" }));
    expect(n?.kind).toBe("update");
  });

  test("a refund notice from the payment service is an update; a purchase notice is not", () => {
    expect(judge(refund, mail({ from: "Payments <notices@payments.example.com>", subject: "Your refund from Northwind" }))?.kind).toBe("update");
    expect(judge(refund, mail({ from: "Payments <notices@payments.example.com>", subject: "Your purchase at Northwind" }))).toBeNull();
  });

  test("the store's deals mail is ignored", () => {
    expect(judge(refund, mail({ from: "Northwind <hello@deals.northwind.example.com>", subject: "No-questions refund policy, 30 days" }))).toBeNull();
  });
});

describe("reading Gmail", () => {
  test("only GETs, metadata only, never a body", async () => {
    const calls: { url: string; method?: string }[] = [];
    const deps: MailDeps = {
      readToken: async () => ({ refresh_token: "r", client_id: "c", client_secret: "s" }),
      fetch: async (url, init) => {
        calls.push({ url, method: init?.method });
        if (url.includes("oauth2")) return { ok: true, status: 200, json: async () => ({ access_token: "a", expires_in: 3600 }) };
        if (url.includes("/messages?")) return { ok: true, status: 200, json: async () => ({ messages: [{ id: "x1" }] }) };
        return { ok: true, status: 200, json: async () => ({ id: "x1", threadId: "t", internalDate: "1760000000000", snippet: "hi", payload: { headers: [{ name: "From", value: "a@example.com" }, { name: "Subject", value: "s" }] } }) };
      },
    };
    const { mail: got } = await fetchMail(claim, deps);
    expect(got).toEqual([{ id: "x1", threadId: "t", received: 1760000000000, from: "a@example.com", subject: "s", snippet: "hi" }]);
    const gmail = calls.filter((c) => c.url.includes("gmail.googleapis.com"));
    expect(gmail.every((c) => c.method === "GET")).toBe(true);
    expect(gmail.filter((c) => c.url.includes("/messages/")).every((c) => c.url.includes("format=metadata"))).toBe(true);
  });
});

test("end to end: an email found on every run reaches the owner's thread once, with no Claude run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-mailwatch-"));
  const sent: { threadId: string; text: string }[] = [];
  const store = new Store(join(dir, "queue.sqlite"));
  const listener = new Listener(store, { async send(threadId, _l, text) { sent.push({ threadId, text }); } },
    async () => { throw new Error("a watch notice must not start a Claude run"); }, { async notify() {} }, () => {});
  const door = startDoor(() => listener, 0);
  try {
    const n = judge(claim, mail({ from: "Pat Rivera <pat.rivera@harbormutual.example.com>", subject: "Your claim: adjuster visit" }))!;
    expect(await postNotice(n, door.port)).toBe("no_thread"); // before the owner has ever texted the line
    store.rememberThread("alex", "thread-alex", null);
    expect(await postNotice(n, door.port)).toBe("accepted");
    expect(await postNotice(n, door.port)).toBe("duplicate"); // the next run finds the same email
    expect(sent).toEqual([{ threadId: "thread-alex", text: n.text }]);
  } finally {
    door.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
  expect(await postNotice(judge(claim, mail({ from: "a@harbormutual.example.com", subject: "Harbor Mutual claim payment" }))!, 1)).toContain("will retry next run");
});
