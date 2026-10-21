import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { exportReminders } from "../jobs/reminders_export";
import { CLAUDE_TOKEN_SERVICE, DOOR_PORT, SENDERS, STATE_DIR } from "./config";
import { startDoor } from "./door";
import { keychain } from "./keychain";
import { Listener } from "./listener";
import { photonTransport } from "./photon";
import { realRunner } from "./runner";
import { Store } from "./store";
import { terminalTransport } from "./terminal";
import { macAlerter, type Transport } from "./transport";

// `--terminal` swaps iMessage for the keyboard (src/terminal.ts). Everything else is unchanged.
const terminal = process.argv.includes("--terminal");

keychain(CLAUDE_TOKEN_SERVICE); // stop here, with the item's name, if the Claude token is missing
mkdirSync(STATE_DIR, { recursive: true });
const store = new Store(join(STATE_DIR, terminal ? "terminal_queue.sqlite" : "queue.sqlite"));
let listener: Listener;
// The door is bound first: a second copy of the listener stops here, before it can connect to
// Photon and answer the same text twice.
startDoor(() => listener, DOOR_PORT);
const transport: Transport = terminal
  ? terminalTransport(console as unknown as AsyncIterable<string>, (m) => listener.ingest(m))
  : await photonTransport((m) => listener.ingest(m));
listener = new Listener(store, transport, realRunner(), macAlerter);
const halted = store.halted();
console.log(halted ? `started halted: ${halted}` : terminal ? "started in terminal mode; type a message" : "started");
// One reminders copy at start, so that a missing Reminders permission shows in the log (and macOS
// asks for it) now and not in the middle of answering a text.
for (const s of SENDERS) {
  try {
    if (exportReminders(s)) console.log(`reminders copy ready for ${s.key}`);
  } catch (err) {
    console.error(`reminders export failed: ${String((err as Error).message)}`);
  }
}
await listener.kick(); // resume anything left open by the last run
