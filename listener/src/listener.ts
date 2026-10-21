// The listener owns everything that has to be reliable: the queue, the sender check, the
// billing guard, and where a reply goes. Claude is called only to write reply text.
import { plainText } from "./plain";
import { ALERT_TO, DOOR_REPEAT_DAYS, senderByAddress, senderByKey, TIME_ZONE } from "./config";
import type { Runner } from "./runner";
import type { MessageRow, Store } from "./store";
import type { Alerter, Inbound, Transport } from "./transport";

export interface DoorMessage {
  id: string;
  to: string; // sender key, e.g. "alex"
  mode: "ask" | "notify"; // ask: Claude writes the text; notify: send as given
  text: string;
}

export const NON_TEXT_REPLY = "I can only read text messages for now.";
// What a script-started run answers when there is nothing worth a text; the listener then sends nothing.
export const QUIET_REPLY = "NOTHING TO SEND";
const isQuiet = (text: string) => text.trim().replace(/[.!"']/g, "").toUpperCase() === QUIET_REPLY;

export function dayKey(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** First line of every prompt, so the run knows the date without a tool. */
export function nowStamp(d = new Date()): string {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(d);
  return `[Now: ${when}]\n[${comingDays(d)}]`;
}

/** The next two weeks with their weekdays, so a run never has to work out which day a date falls on. */
export function comingDays(d = new Date(), n = 14): string {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, weekday: "short", month: "short", day: "numeric" });
  const days = Array.from({ length: n }, (_, i) => fmt.format(new Date(d.getTime() + (i + 1) * 86_400_000)).replace(",", ""));
  return `Coming days: ${days.join(", ")}`;
}

export { plainText } from "./plain";

export class Listener {
  private working: Promise<void> | null = null;

  constructor(
    private store: Store,
    private transport: Transport,
    private runner: Runner,
    private alerter: Alerter,
    private log: (msg: string) => void = (m) => console.log(m),
  ) {}

  /** Entry point for provider messages. */
  async ingest(m: Inbound): Promise<void> {
    const sender = senderByAddress(m.senderAddress);
    const allowed = !!sender && m.kind === "dm";
    const isNew = this.store.receive({
      id: m.id,
      source: "photon",
      senderAddress: m.senderAddress ?? null,
      senderKey: allowed ? sender!.key : null,
      threadId: m.threadId,
      linePhone: m.linePhone,
      mode: "converse",
      text: allowed ? m.text : null, // a stranger's text is never stored
    });
    if (!isNew) return this.log(`duplicate ${m.id} ignored`);
    if (!allowed) {
      this.store.setState(m.id, "dropped", { reason: sender ? "group thread" : "sender not on allowlist" });
      return;
    }
    this.store.rememberThread(sender!.key, m.threadId, m.linePhone);
    this.store.setState(m.id, "queued");
    await this.kick();
  }

  /** Entry point for scripts on this Mac (the local door). */
  async ingestDoor(d: DoorMessage): Promise<"accepted" | "duplicate" | "rejected" | "no_thread"> {
    const sender = senderByKey(d.to);
    if (!sender || !sender.door || !d.id || !d.text || (d.mode !== "ask" && d.mode !== "notify")) return "rejected";
    const thread = this.store.thread(sender.key);
    // Photon only lets the line reply inside a thread the person opened. Until one exists the
    // message is refused without using up its id, so the script can try again later.
    if (!thread) return "no_thread";
    // The same words twice in a week is a script repeating itself ("X is still down"), whatever id it
    // sends under. The person has been told once; the repeat is dropped.
    const weekAgo = new Date(Date.now() - DOOR_REPEAT_DAYS * 86_400_000).toISOString();
    if (d.mode === "notify" && this.store.notifiedSince(sender.key, d.text, weekAgo)) return "duplicate";
    const isNew = this.store.receive({
      id: `door:${d.id}`,
      source: "door",
      senderAddress: null,
      senderKey: sender.key,
      threadId: thread.thread_id,
      linePhone: thread.line_phone,
      mode: d.mode,
      text: d.text,
    });
    if (!isNew) return "duplicate";
    if (d.mode === "notify") this.store.setState(`door:${d.id}`, "model_result", { reply: d.text });
    else this.store.setState(`door:${d.id}`, "queued");
    await this.kick();
    return "accepted";
  }

  /** Works through every open message, one at a time. Safe to call repeatedly. */
  kick(): Promise<void> {
    if (!this.working) {
      this.working = this.drain().finally(() => {
        this.working = null;
      });
    }
    return this.working;
  }

  private async drain() {
    for (;;) {
      const next = this.store.open().find((r) => !(this.store.halted() && (r.state === "queued" || r.state === "received")));
      if (!next) return;
      await this.step(next);
    }
  }

  private async step(row: MessageRow) {
    switch (row.state) {
      case "received":
        // Crashed between receive and the sender check: redo the check from the stored row.
        if (row.sender_key) this.store.setState(row.id, "queued");
        else this.store.setState(row.id, "dropped", { reason: "sender not on allowlist" });
        return;
      case "queued":
        return this.run(row);
      case "model_result":
        return this.send(row);
      case "send_attempted":
        // The process stopped after the send began and before it was confirmed. The provider
        // gives no way to ask whether it went out, so it is not sent again (at most once).
        this.store.setState(row.id, "failed", { reason: "send outcome unknown after restart; not resent" });
        return;
    }
  }

  private async run(row: MessageRow) {
    const sender = senderByKey(row.sender_key!)!;
    if (row.text === null) {
      this.store.setState(row.id, "model_result", { reply: NON_TEXT_REPLY, reason: "non-text message" });
      return;
    }
    // A person's text and a script's question both join the day's conversation, so the owner can
    // answer the morning check with "yes, do that" and the run knows what "that" is. A notify never
    // runs at all.
    const persist = row.mode !== "notify";
    const day = dayKey();
    const session = this.store.session(sender.key, day);
    const fromScript = row.source === "door";
    const out = await this.runner({ sender, prompt: `${nowStamp()}\n\n${row.text}`, sessionId: session.session_id, resume: !!session.started, persist, readOnly: fromScript });
    // Claude Code saves the conversation as soon as a run starts and refuses to start a second one
    // under the same id. So the day counts as started once any run got as far as its init event,
    // whether it then answered, timed out or stayed quiet. A run that died before init leaves the
    // id in an unknown state, so the day gets a new one (2026-10-07: a timed-out morning check
    // left the id used, the next text died at once and the billing guard stopped everything).
    if (persist) {
      if (out.init) this.store.markSessionStarted(sender.key, day);
      else if (out.kind === "billing" || out.kind === "failed") this.store.rotateSession(sender.key, day);
    }
    if (out.kind === "billing") {
      this.store.setState(row.id, out.text ? "model_result" : "failed", {
        reply: out.text ?? undefined,
        reason: `billing guard: ${out.reason}`,
      });
      await this.haltAndAlert(out.reason);
      return;
    }
    if (out.kind === "failed") {
      this.store.setState(row.id, "failed", { reason: out.reason, denials: out.denials });
      await this.trySend(row.id, "apology", row.thread_id, "Jarvis couldn't answer that one. It's logged for Alex to look at.");
      return;
    }
    // A script's question may have no answer worth a text. Only a script-started run can stay
    // quiet; a person who texts always gets a reply.
    if (fromScript && isQuiet(out.text)) {
      this.store.setState(row.id, "dropped", { reason: "script check had nothing to send" });
      return;
    }
    if (out.denials.length) this.log(`permission denials on ${row.id}: ${JSON.stringify(out.denials)}`);
    this.store.setState(row.id, "model_result", { reply: plainText(out.text), denials: out.denials });
  }

  private async send(row: MessageRow) {
    if (!row.thread_id) {
      this.store.setState(row.id, "failed", { reason: "no thread to reply to" });
      return;
    }
    this.store.setState(row.id, "send_attempted");
    const seq = this.store.recordSendAttempt(row.id, "reply", row.thread_id, row.reply!);
    try {
      await this.transport.send(row.thread_id, row.line_phone, row.reply!);
    } catch (err) {
      this.store.setState(row.id, "failed", { reason: `send failed: ${String(err)}` });
      return;
    }
    this.store.confirmSend(seq);
    this.store.setState(row.id, "send_confirmed");
  }

  private async trySend(messageId: string, kind: "alert" | "apology", threadId: string | null, text: string) {
    if (!threadId) return false;
    const seq = this.store.recordSendAttempt(messageId, kind, threadId, text);
    try {
      const line = this.store.thread(ALERT_TO)?.line_phone ?? null;
      await this.transport.send(threadId, line, text);
      this.store.confirmSend(seq);
      return true;
    } catch (err) {
      this.log(`${kind} send failed: ${String(err)}`);
      return false;
    }
  }

  /** Stops all further runs until `unhalt` is run, then tells the owner by text and on the Mac. */
  async haltAndAlert(reason: string) {
    const first = !this.store.halted();
    this.store.halt(reason);
    if (!first) return;
    const body = `Jarvis stopped: a Claude run may be billed at API rates (${reason}). No more runs until you restart it with "bun run unhalt".`;
    this.log(body);
    await this.alerter.notify("Jarvis stopped", body);
    await this.trySend(`alert:${Date.now()}`, "alert", this.store.thread(ALERT_TO)?.thread_id ?? null, body);
  }
}
