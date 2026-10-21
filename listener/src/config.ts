// Everything a sender is allowed is decided here, in code. The model never sees this file.
//
// Public copy: the two people are the fictional Alex and Sam, their phone numbers are 555 numbers,
// and the household folders point at the fictional sample under example/. Set JARVIS_HOUSEHOLD and
// JARVIS_NOTES_VAULT to point a real install at real folders.
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "../..");
// The household's own files: appointment notes, the travel folder, and folders a run must never read.
export const HOUSEHOLD = process.env.JARVIS_HOUSEHOLD ?? join(ROOT, "example/household");
// The notes vault dictated into from a phone. Runs read its Inbox (one file per dictation) and
// Lists (one file per list). Ideas/ is the owner's own and is not given to a run.
export const NOTES_VAULT = process.env.JARVIS_NOTES_VAULT ?? join(ROOT, "example/notes");
export const NOTES_DIRS = [join(NOTES_VAULT, "Inbox"), join(NOTES_VAULT, "Lists")];
// Folders a run is denied by name, even though no sender is given them.
export const PRIVATE_DIRS = [join(HOUSEHOLD, "health"), join(HOUSEHOLD, "finance")];
export const STATE_DIR = process.env.JARVIS_STATE_DIR ?? join(ROOT, "state");
export const CLAUDE_BIN = process.env.JARVIS_CLAUDE_BIN ?? join(process.env.HOME ?? "", ".local/bin/claude");
export const MODEL = "claude-sonnet-5-5";
// Keychain item holding the long-lived subscription token from `claude setup-token`. Runs sign in
// with it, so Jarvis keeps working when the Mac's ordinary Claude login is logged out.
export const CLAUDE_TOKEN_SERVICE = "claude_code_oauth_token";
export const DOOR_PORT = 8790;
export const RUN_TIMEOUT_MS = 180_000;
export const BUN_BIN = process.env.JARVIS_BUN_BIN ?? process.execPath;
export const MAIL_SERVER = join(ROOT, "listener/src/mail/server.ts");
export const CALENDAR_SERVER = join(ROOT, "listener/src/calendar/server.ts");
export const MAPS_SERVER = join(ROOT, "listener/src/maps/server.ts");
export const BILLS_SERVER = join(ROOT, "listener/src/bills/server.ts");
export const LISTS_SERVER = join(ROOT, "listener/src/lists/server.ts");
// Where Notion is. A test may point this at a fake on this Mac; any other value is ignored, so
// the Notion token is never sent to another host.
const notionOverride = process.env.JARVIS_NOTION_API ?? "";
export const NOTION_API = /^http:\/\/127\.0\.0\.1:\d+$/.test(notionOverride) ? notionOverride : "https://api.notion.com";
export const TIME_ZONE = "America/Los_Angeles";
// What the maps tools use when a run says "home". Kept here so it never has to sit in a prompt.
export const HOME_ADDRESS = "123 Main St, Anytown, CA";

export type SenderKey = "alex" | "sam";

export interface Sender {
  key: SenderKey;
  address: string; // E.164, compared exactly
  runDir: string; // cwd of the run; holds settings.json and system_prompt.md
  addDirs: string[]; // the only folders the run's file tools can reach
  tools: string[]; // built-in tools the run gets; nothing that runs code
  mail: boolean; // whether the run gets the four mail tools: search, read, draft, approved send (src/mail/server.ts)
  calendar: boolean; // whether the run gets the four calendar tools (src/calendar/server.ts)
  maps: boolean; // whether the run gets the two maps lookups: drive or walk time, and place search (src/maps/server.ts)
  bills: boolean; // whether the run gets the one bills tool: add a row to the Notion bill tracker after a yes (src/bills/server.ts)
  lists: boolean; // whether the run gets the one lists tool: append a line to a list in the notes vault's Lists folder (src/lists/server.ts)
  door: boolean; // whether scripts on this Mac may text this person (src/door.ts)
  reminders: boolean; // whether the run gets data/reminders.md, a copy of the owner's open Apple Reminders (jobs/reminders_export.ts)
}

export const SENDERS: Sender[] = [
  {
    key: "alex",
    address: "+15555550101",
    runDir: join(ROOT, "runs/alex"),
    // Bills come from runs/alex/data/bills.md, exported hourly from Notion (jobs/bills_export.ts).
    // travel/ is the travel profile and one folder per trip; its skill/ subfolder is instructions
    // for working sessions and is denied in settings.json.
    addDirs: [join(HOUSEHOLD, "appointments"), join(HOUSEHOLD, "travel"), ...NOTES_DIRS],
    tools: ["Read", "Glob", "Grep"],
    mail: true,
    calendar: true,
    maps: true,
    bills: true,
    lists: true,
    door: true,
    reminders: true,
  },
  {
    key: "sam",
    address: "+15555550102",
    runDir: join(ROOT, "runs/sam"),
    // Same tools and folders as Alex. The one difference: no script may text Sam, so Jarvis only
    // ever answers a text Sam sent.
    addDirs: [join(HOUSEHOLD, "appointments"), join(HOUSEHOLD, "travel"), ...NOTES_DIRS],
    tools: ["Read", "Glob", "Grep"],
    mail: true,
    calendar: true,
    maps: true,
    bills: true,
    lists: true,
    door: false,
    reminders: true,
  },
];

// Billing and failure alerts go to this sender's thread.
export const ALERT_TO: SenderKey = "alex";

export function senderByAddress(address: string | undefined): Sender | undefined {
  return SENDERS.find((s) => s.address === address);
}

export function senderByKey(key: string): Sender | undefined {
  return SENDERS.find((s) => s.key === key);
}

/** A door notification whose exact text already went out within this many days is dropped. */
export const DOOR_REPEAT_DAYS = 7;
