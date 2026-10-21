// The terminal stand-in for iMessage (src/terminal.ts): a typed line goes through the same listener,
// queue and allowlist as a text, and the reply prints instead of being sent.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SENDERS } from "../src/config";
import { Listener } from "../src/listener";
import type { RunInput, RunOutput } from "../src/runner";
import { Store } from "../src/store";
import { TERMINAL_THREAD, terminalTransport } from "../src/terminal";

test("each typed line is a text from the first sender, answered in the terminal thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-terminal-"));
  try {
    const store = new Store(join(dir, "queue.sqlite"));
    const calls: RunInput[] = [];
    const runner = async (input: RunInput): Promise<RunOutput> => {
      calls.push(input);
      return { kind: "reply", text: `heard: ${input.prompt.split("\n").pop()}`, denials: [], init: { apiKeySource: "none", model: "x", tools: [], mcpServers: [], plugins: [] } };
    };
    const printed: string[] = [];
    let listener: Listener;
    const lines = (async function* () {
      yield "when do we leave?";
      yield "   ";
      yield "thanks";
    })();
    const transport = terminalTransport(lines, (m) => listener.ingest(m), (s) => printed.push(s.trim()));
    listener = new Listener(store, transport, runner, { async notify() {} }, () => {});
    await transport.done;
    expect(calls.map((c) => c.sender.key)).toEqual([SENDERS[0]!.key, SENDERS[0]!.key]); // the blank line started nothing
    expect(calls[0]!.readOnly).toBe(false);
    expect(printed).toEqual(["Jarvis: heard: when do we leave?", "Jarvis: heard: thanks"]);
    expect(store.thread(SENDERS[0]!.key)!.thread_id).toBe(TERMINAL_THREAD);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
