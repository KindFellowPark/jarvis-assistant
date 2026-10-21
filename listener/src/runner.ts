// One bounded Claude run per message. The run gets a fixed tool list, the sender's settings
// file, at most the mail, calendar, maps, bills and lists servers, no user or project settings, and no way to send anything. Its only
// output that matters is the reply text, which the listener sends.
import { join } from "node:path";
import { BILLS_SERVER, BUN_BIN, CALENDAR_SERVER, CLAUDE_BIN, CLAUDE_TOKEN_SERVICE, LISTS_SERVER, MAIL_SERVER, MAPS_SERVER, MODEL, RUN_TIMEOUT_MS, STATE_DIR, type Sender } from "./config";
import { BillingWatch, runEnv, type Verdict } from "./guard";
import { keychain } from "./keychain";
import { exportReminders } from "../jobs/reminders_export";

export interface RunInput {
  sender: Sender;
  prompt: string;
  sessionId: string;
  resume: boolean;
  persist: boolean;
  /** A run a script started, not a person: it gets no tool that changes anything. */
  readOnly?: boolean;
}

// What a script-started run is denied: every calendar write, both mail writes, the bills add and
// the lists append. A person's text is the only thing that can change the calendar, put a draft
// in the mailbox, add a row to the bill tracker or add a line to a list.
export const READ_ONLY_DENIED = ["mcp__calendar__add", "mcp__calendar__change", "mcp__calendar__remove", "mcp__mail__draft", "mcp__mail__send", "mcp__bills__add", "mcp__lists__append"];

export type RunOutput =
  | { kind: "reply"; text: string; denials: unknown[]; init: InitSummary }
  | { kind: "failed"; reason: string; denials: unknown[]; init: InitSummary | null }
  | { kind: "billing"; reason: string; text: string | null; init: InitSummary | null };

export interface InitSummary {
  apiKeySource: string | undefined;
  model: string | undefined;
  tools: string[];
  mcpServers: unknown[];
  plugins: string[];
}

export type Runner = (input: RunInput) => Promise<RunOutput>;

export interface RealRunnerOptions {
  /** Test only: extra environment for the child, used to prove the billing guard trips. */
  injectEnv?: Record<string, string>;
  /** Test only: replaces the sender's system prompt. */
  systemPrompt?: string;
  timeoutMs?: number;
  /** Test only: replaces the Keychain read of the subscription token. */
  readToken?: () => string;
}

/** The only MCP servers a run can have. --strict-mcp-config shuts out every other one. */
export function mcpConfig(s: Sender): string {
  const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
  // The servers that need a go-ahead are told who they are working for and where the queue is, so they can check
  // the person's go-ahead against the texts themselves (src/approval.ts).
  const env = { JARVIS_SENDER: s.key, JARVIS_STATE_DIR: STATE_DIR };
  if (s.mail) mcpServers.mail = { command: BUN_BIN, args: [MAIL_SERVER], env };
  if (s.calendar) mcpServers.calendar = { command: BUN_BIN, args: [CALENDAR_SERVER], env };
  if (s.maps) mcpServers.maps = { command: BUN_BIN, args: [MAPS_SERVER] };
  // JARVIS_NOTION_API is test only; config.ts ignores it unless it points at this Mac.
  const notion = process.env.JARVIS_NOTION_API;
  if (s.bills) mcpServers.bills = { command: BUN_BIN, args: [BILLS_SERVER], env: notion ? { ...env, JARVIS_NOTION_API: notion } : env };
  // JARVIS_LISTS_DIR is test only; append.ts ignores it unless it points under this Mac's temp dir.
  const lists = process.env.JARVIS_LISTS_DIR;
  if (s.lists) mcpServers.lists = { command: BUN_BIN, args: [LISTS_SERVER], env: lists ? { ...env, JARVIS_LISTS_DIR: lists } : env };
  return JSON.stringify({ mcpServers });
}

export function claudeArgs(input: RunInput, systemPrompt: string): string[] {
  const s = input.sender;
  const args = [
    "-p", input.prompt,
    "--model", MODEL,
    "--restricted",
    "--strict-mcp-config", "--mcp-config", mcpConfig(s),
    "--settings", join(s.runDir, "settings.json"),
    "--tools", s.tools.join(","),
    "--system-prompt", systemPrompt,
    "--permission-prompts", "none",
    "--output-format", "stream-json", "--verbose",
  ];
  if (input.readOnly) args.push("--disallowedTools", ...READ_ONLY_DENIED);
  if (s.addDirs.length) args.push("--add-dir", ...s.addDirs);
  if (!input.persist) args.push("--no-session-persistence");
  else if (input.resume) args.push("--resume", input.sessionId);
  else args.push("--session-id", input.sessionId);
  return args;
}

/**
 * Reads a run's event stream line by line, feeding the billing watch. Shared by the real
 * runner and the replay runner, so a replayed stream exercises the same code as a live one.
 * `kill` is called when the guard trips before the model call.
 */
export async function consumeStream(lines: AsyncIterable<string>, kill: () => void): Promise<RunOutput> {
  const watch = new BillingWatch();
  let init: InitSummary | null = null;
  let result: any = null;
  let early: Verdict | null = null;
  for await (const line of lines) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "system" && ev.subtype === "init") {
      init = {
        apiKeySource: ev.apiKeySource,
        model: ev.model,
        tools: ev.tools ?? [],
        mcpServers: ev.mcp_servers ?? [],
        plugins: (ev.plugins ?? []).map((p: any) => p.name),
      };
    }
    if (ev.type === "result") result = ev;
    const v = watch.observe(ev);
    if (v && !v.ok && v.beforeModelCall) {
      early = v;
      kill();
      break;
    }
  }
  if (early && !early.ok) return { kind: "billing", reason: early.reason, text: null, init };
  // A stream with no init and no result means the process died before any model call (network
  // down, login unreachable), so nothing was billed. It is a failed run, not a billing stop.
  if (!init && !result) return { kind: "failed", reason: "run produced no output", denials: [], init: null };
  const answered = !!result && result.subtype === "success" && !result.is_error;
  const verdict = watch.finish(answered);
  const text = answered ? String(result.result ?? "").trim() : null;
  if (!verdict.ok) return { kind: "billing", reason: verdict.reason, text, init };
  const denials = result?.permission_denials ?? [];
  if (!answered) {
    // An error result carries Claude Code's own message ("Not logged in", a 401), so keep it.
    const why = result?.is_error ? String(result.result ?? result.subtype).slice(0, 200) : result?.subtype;
    return { kind: "failed", reason: result ? `run error: ${why}` : "run ended without a result", denials, init };
  }
  if (!text) return { kind: "failed", reason: "empty reply", denials, init };
  return { kind: "reply", text, denials, init: init! }; // finish() already failed if init was missing
}

async function* splitLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf;
}

export function realRunner(opts: RealRunnerOptions = {}): Runner {
  return async (input) => {
    // A sender whose prompt has not been approved and written yet gets a failed run, not a crash.
    const promptFile = Bun.file(join(input.sender.runDir, "system_prompt.md"));
    if (!opts.systemPrompt && !(await promptFile.exists())) {
      return { kind: "failed", reason: `no system prompt for ${input.sender.key}`, denials: [], init: null };
    }
    const systemPrompt = opts.systemPrompt ?? (await promptFile.text());
    // The token is read at use time and handed only to this child. It is a subscription login,
    // so the billing guard still sees apiKeySource "none"; an API key in the env still outranks it.
    let token: string;
    try {
      token = (opts.readToken ?? (() => keychain(CLAUDE_TOKEN_SERVICE)))();
    } catch (err) {
      return { kind: "failed", reason: `no Claude token: ${String(err)}`, denials: [], init: null };
    }
    // The copy of the owner's open reminders is brought up to date by code before the run reads
    // it. A failed copy never stops a text from being answered.
    try {
      exportReminders(input.sender);
    } catch (err) {
      console.error(`reminders export failed: ${String((err as Error).message)}`);
    }
    const env = { ...runEnv(), CLAUDE_CODE_OAUTH_TOKEN: token, ...(opts.injectEnv ?? {}) };
    const proc = Bun.spawn([CLAUDE_BIN, ...claudeArgs(input, systemPrompt)], {
      cwd: input.sender.runDir,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, opts.timeoutMs ?? RUN_TIMEOUT_MS);
    const stderr = new Response(proc.stderr).text();
    try {
      const out = await consumeStream(splitLines(proc.stdout), () => proc.kill());
      await proc.exited;
      if (timedOut && out.kind !== "billing") return { kind: "failed", reason: "timeout", denials: [], init: out.init };
      // A run that never reached init says why only on stderr ("Session ID ... is already in use").
      if (!out.init && out.kind !== "reply") {
        const said = (await stderr).trim().slice(0, 200);
        if (said) return { ...out, reason: `${out.reason}; claude said: ${said}` };
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Feeds a saved event stream through the same parser and guard. Used by the safety suite. */
export function replayRunner(path: string): Runner {
  return async () => {
    const lines = (await Bun.file(path).text()).split("\n");
    return consumeStream(
      (async function* () {
        yield* lines;
      })(),
      () => {},
    );
  };
}
