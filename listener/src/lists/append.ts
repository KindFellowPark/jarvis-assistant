// Appending one line to one list in the notes vault's Lists folder (NOTES_VAULT in config.ts),
// the same files the runs read. A run names the list and the text; code writes the line, dated
// and signed with who texted it, and creates the list when it is missing. No go-ahead round trip:
// a line is trivially reversible and the person texting asked for it. The tool reaches nothing
// outside the Lists folder: a name with a slash or a dot-dot is refused before any path is built.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { NOTES_VAULT, SENDERS, TIME_ZONE } from "../config";

export const LISTS_DIR = join(NOTES_VAULT, "Lists");
export const MAX_APPENDS = 20;
const MAX_NAME = 80;
const MAX_TEXT = 500;

export interface Line {
  list: string; // the list's name, without .md
  text: string; // one line, as the person gave it
}

export interface ListsDeps {
  dir: string; // the Lists folder; a test points this at a folder under the Mac's temp dir
  who: string; // who texted, as the line should name them
  today: () => string; // YYYY-MM-DD in the household's time zone
  appends: { n: number }; // lines added by this server process, which lives for one run
}

/** The test override is honoured only for a folder under this Mac's temp dir, so a stray env var never redirects a real run. */
export function listsDir(override = process.env.JARVIS_LISTS_DIR ?? ""): string {
  const tmp = resolve(tmpdir());
  return override && resolve(override).startsWith(tmp + sep) ? resolve(override) : LISTS_DIR;
}

/** "Alex" or "Sam" from the sender key the server was started with. */
export function whoTexted(key = process.env.JARVIS_SENDER): string {
  const s = SENDERS.find((x) => x.key === key);
  if (!s) throw new Error("the lists tool was started without a sender");
  return s.key.charAt(0).toUpperCase() + s.key.slice(1);
}

export const today = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

export const realDeps = (): ListsDeps => ({ dir: listsDir(), who: whoTexted(), today, appends: { n: 0 } });

/** Checks the fields a run sent, before any path is built. */
export function toLine(input: Record<string, unknown>): Line {
  let list = typeof input.list === "string" ? input.list.replace(/\s+/g, " ").trim() : "";
  if (list.toLowerCase().endsWith(".md")) list = list.slice(0, -3).trim();
  if (!list || list.length > MAX_NAME) throw new Error(`list is the list's name, 1 to ${MAX_NAME} characters`);
  if (/[\/\\]/.test(list) || list.includes("..") || list.startsWith(".")) throw new Error("list is a name, not a path: no slash, no dot-dot, no leading dot");
  if (/[\0-\x1f:*?"<>|]/.test(list)) throw new Error("list has a character a file name cannot carry");
  const text = typeof input.text === "string" ? input.text.replace(/\s+/g, " ").trim() : "";
  if (!text || text.length > MAX_TEXT) throw new Error(`text is one line, 1 to ${MAX_TEXT} characters`);
  return { list, text };
}

/** The path a list name resolves to, refused unless it sits directly inside the Lists folder. */
export function listPath(list: string, dir: string): string {
  const base = resolve(dir);
  const path = resolve(base, `${list}.md`);
  if (path.slice(0, base.length + 1) !== base + sep || path.slice(base.length + 1).includes(sep)) throw new Error("list must be a file directly inside the Lists folder");
  return path;
}

export async function appendLine(input: Record<string, unknown>, deps: ListsDeps = realDeps()) {
  const line = toLine(input);
  const path = listPath(line.list, deps.dir);
  if (deps.appends.n >= MAX_APPENDS) throw new Error(`one text adds at most ${MAX_APPENDS} lines`);
  const written = `${deps.today()} ${deps.who}: ${line.text}`;
  const created = !existsSync(path);
  mkdirSync(deps.dir, { recursive: true });
  // The file ends on a newline before the new line goes on, so a list a phone shortcut left open-ended stays one item per line.
  const tail = created ? "" : readFileSync(path, "utf8").slice(-1);
  appendFileSync(path, `${tail === "" || tail === "\n" ? "" : "\n"}${written}\n`);
  deps.appends.n++;
  return { added: true, list: line.list, created, line: written };
}
