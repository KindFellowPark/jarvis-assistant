// The morning check: once a day a script asks a run to look at the owner's reminders and calendar
// and to text only when something needs attention. The question goes through the local door like any other script's, so the listener
// keeps the allowlist, the queue and the reply destination. A run started this way cannot change
// the calendar or draft mail (READ_ONLY_DENIED in src/runner.ts), and when it answers
// QUIET_REPLY the listener sends nothing (src/listener.ts).
import { DOOR_PORT, TIME_ZONE } from "../src/config";
import { QUIET_REPLY } from "../src/listener";

export const NUDGE_PROMPT = [
  "This is the morning check. A script sent it, not Alex, and Alex has not asked you anything.",
  "Read data/reminders.md, and list today's and tomorrow's calendar events.",
  "Text Alex only if at least one of these is true: a reminder is due today or in the next two days; a reminder went past due in the last seven days; a reminder names a renewal, a trial ending or a deadline that falls within the next seven days; a reminder and a calendar event land on the same time.",
  "If so, write one short text: what is due today first, then the rest, one line each, eight lines at most, each saying what the reminder says and when. Add a fact from the calendar, the bills file or the mail only when it changes what Alex should do.",
  "Do not ask a question, do not offer to do anything, and do not mention this check. Leave out undated reminders and anything further off than seven days.",
  `If none of those is true, reply with exactly: ${QUIET_REPLY}`,
].join(" ");

/** The check is sent between 6 and 11 in the morning; a Mac that wakes later skips that day. */
export function nudgeHours(zone: string, d = new Date()): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hourCycle: "h23" }).format(d));
  return hour >= 6 && hour < 11;
}

export function nudgeId(zone: string, d = new Date()): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return `nudge:${day}`; // one per day: the door ignores a second post under the same id
}

if (import.meta.main) {
  const stamp = new Date().toISOString();
  if (!nudgeHours(TIME_ZONE)) {
    console.log(`${stamp} outside 6 to 11 AM, skipped`);
  } else {
    try {
      const res = await fetch(`http://127.0.0.1:${DOOR_PORT}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: nudgeId(TIME_ZONE), to: "alex", mode: "ask", text: NUDGE_PROMPT }),
      });
      console.log(`${stamp} ${nudgeId(TIME_ZONE)}: ${((await res.json()) as any).status}`);
    } catch {
      console.log(`${stamp} listener not reachable, no check today`);
    }
  }
}
