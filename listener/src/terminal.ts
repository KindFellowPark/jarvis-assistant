// A stand-in for iMessage, so the assistant can be tried without a Photon account. Each line typed
// is treated as a text from the first person on the allowlist, and the reply prints below it. It is
// not how Jarvis is used: the real transport is src/photon.ts. Everything after the transport is the
// same code: the queue, the allowlist, the billing guard, the restricted run.
import { SENDERS, type Sender } from "./config";
import type { Inbound, Transport } from "./transport";

export const TERMINAL_THREAD = "terminal";

export function terminalTransport(
  lines: AsyncIterable<string>,
  onMessage: (m: Inbound) => Promise<void>,
  print: (s: string) => void = (s) => console.log(s),
  sender: Sender = SENDERS[0]!,
): Transport & { done: Promise<void> } {
  const done = (async () => {
    for await (const raw of lines) {
      const text = raw.trim();
      if (!text) continue;
      await onMessage({ id: `terminal:${crypto.randomUUID()}`, senderAddress: sender.address, threadId: TERMINAL_THREAD, linePhone: null, kind: "dm", text });
    }
  })();
  return {
    async send(_threadId, _linePhone, text) {
      print(`\nJarvis: ${text}\n`);
    },
    done,
  };
}
