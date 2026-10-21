// Google Calendar access for Jarvis's runs: list events, add one, change one, remove one, on the
// primary calendar. Every write sends sendUpdates=none, so nobody is ever notified, and no guest
// is ever added. Events with guests and repeating events can be changed and removed. A removal needs the person's one go-ahead, checked
// on the texts in ../approval.ts, and one run removes at most MAX_REMOVALS events.
import { approved } from "../approval";
import { TIME_ZONE } from "../config";
import { googleSignIn } from "../google";

const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const MAX_EVENTS = 25;
// How much of an event's notes a run sees. A trip's timetable pasted into an event runs past 1,000
// characters; at 600 the run read half of it.
const NOTES_SHOWN = 2000;

export type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface CalendarDeps {
  fetch: Fetch;
  readToken: () => Promise<{ refresh_token: string; client_id: string; client_secret: string }>;
  removals: { n: number }; // removed so far by this run; each run starts its own tool server
  approved: (title: string) => boolean; // the person was asked about this event and texted back
}

export const MAX_REMOVALS = 10;

export const realDeps: CalendarDeps = {
  fetch: (url, init) => fetch(url, init) as any,
  readToken: async () => {
    try {
      return googleSignIn();
    } catch {
      throw new Error("the calendar is not connected yet");
    }
  },
  removals: { n: 0 },
  approved,
};

let cached: { token: string; expires: number } | null = null;

async function accessToken(deps: CalendarDeps): Promise<string> {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const t = await deps.readToken();
  const res = await deps.fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", ...t }).toString(),
  });
  if (!res.ok) throw new Error(`Google token refresh failed (${res.status})`);
  const body = await res.json();
  cached = { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3000) * 1000 };
  return cached.token;
}

export function resetTokenCache() {
  cached = null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function checkDate(name: string, v: unknown): string {
  if (typeof v !== "string" || !DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new Error(`${name} must be a date like 2026-10-06`);
  return v;
}

function checkTime(name: string, v: unknown): string {
  if (typeof v !== "string" || !TIME.test(v)) throw new Error(`${name} must be a 24-hour time like 15:30`);
  return v;
}

const given = (v: unknown) => v !== undefined && v !== "";

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The household time zone's offset on that date, e.g. "-07:00", so daylight saving is right. */
export function offsetOn(date: string, zone = TIME_ZONE): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
    .formatToParts(new Date(`${date}T12:00:00Z`))
    .find((p) => p.type === "timeZoneName")!.value; // "GMT-07:00"
  return part.replace("GMT", "") || "+00:00";
}

export interface EventOut {
  id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location?: string;
  notes?: string;
  repeats?: true; // one occurrence of a repeating series
  has_guests?: true; // other people are on it
  guests?: string[]; // their email addresses, so a note can be written to them; never their names
}

const plain = (html: string) => html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();

// Ids, titles, times, places, notes and guests' email addresses. Guest names and links are never returned.
const guests = (e: any): string[] => (e.attendees ?? []).filter((a: any) => !a.self && !a.resource && a.email).map((a: any) => String(a.email)).slice(0, 20);
const shape = (e: any): EventOut => ({
  id: e.id ?? "",
  title: e.summary ?? "(no title)",
  start: e.start?.dateTime ?? e.start?.date ?? "",
  end: e.end?.dateTime ?? e.end?.date ?? "",
  all_day: !e.start?.dateTime,
  ...(e.location ? { location: e.location } : {}),
  ...(e.description && plain(e.description) ? { notes: plain(e.description).slice(0, NOTES_SHOWN) } : {}),
  ...(e.recurringEventId || e.recurrence ? { repeats: true as const } : {}),
  ...(e.attendees?.length ? { has_guests: true as const } : {}),
  ...(guests(e).length ? { guests: guests(e) } : {}),
});

export async function listEvents(input: { from: unknown; to?: unknown; query?: unknown }, deps: CalendarDeps = realDeps): Promise<EventOut[]> {
  const from = checkDate("from", input.from);
  const to = input.to === undefined || input.to === "" ? from : checkDate("to", input.to);
  if (to < from) throw new Error("to is before from");
  const end = addDays(to, 1);
  const params = new URLSearchParams({
    timeMin: `${from}T00:00:00${offsetOn(from)}`,
    timeMax: `${end}T00:00:00${offsetOn(end)}`,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(MAX_EVENTS),
    timeZone: TIME_ZONE,
  });
  if (typeof input.query === "string" && input.query.trim()) params.set("q", input.query.trim().slice(0, 100));
  const res = await deps.fetch(`${API}?${params}`, { method: "GET", headers: { Authorization: `Bearer ${await accessToken(deps)}` } });
  if (!res.ok) throw new Error(`calendar read failed (${res.status})`);
  return ((await res.json()).items ?? []).map(shape);
}

export interface AddInput {
  title: unknown;
  date: unknown;
  start_time?: unknown; // omitted: an all-day event
  end_time?: unknown; // omitted: one hour after start_time
  end_date?: unknown; // the day it ends, for an event that runs past midnight or over several days
  location?: unknown;
  notes?: unknown;
  repeat?: unknown; // daily, weekly, monthly or yearly, from `date` on
  repeat_until?: unknown; // the last day it may fall on; omitted: it repeats with no end
  alert_minutes?: unknown; // phone alert this many minutes before a timed event; omitted: the calendar's default
}

const REPEATS: Record<string, string> = { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" };
const MAX_ALERT_MINUTES = 40320; // four weeks, Google's limit

/** The RRULE for a repeating event. UNTIL is a date for an all-day event and a UTC instant for a timed one. */
function repeatRule(input: AddInput, date: string, timed: boolean): string | null {
  if (!given(input.repeat)) {
    if (given(input.repeat_until)) throw new Error("repeat_until needs repeat");
    return null;
  }
  const freq = typeof input.repeat === "string" ? REPEATS[input.repeat.trim().toLowerCase()] : undefined;
  if (!freq) throw new Error("repeat must be daily, weekly, monthly or yearly");
  if (!given(input.repeat_until)) return `RRULE:FREQ=${freq}`;
  const until = checkDate("repeat_until", input.repeat_until);
  if (until < date) throw new Error("repeat_until is before date");
  const compact = timed
    ? new Date(`${until}T23:59:59${offsetOn(until)}`).toISOString().replace(/[-:]|\.\d{3}/g, "")
    : until.replace(/-/g, "");
  return `RRULE:FREQ=${freq};UNTIL=${compact}`;
}

export async function addEvent(input: AddInput, deps: CalendarDeps = realDeps): Promise<{ added: boolean; already_there?: true; event: EventOut }> {
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 200) : "";
  if (!title) throw new Error("title is required");
  const date = checkDate("date", input.date);
  const lastDay = input.end_date !== undefined && input.end_date !== "" ? checkDate("end_date", input.end_date) : date;
  if (lastDay < date) throw new Error("end_date is before date");
  const timed = input.start_time !== undefined && input.start_time !== "";
  const rule = repeatRule(input, date, timed);
  let alert: number | null = null;
  if (given(input.alert_minutes)) {
    if (!timed) throw new Error("an alert needs a start_time; an all-day event does not alert");
    if (typeof input.alert_minutes !== "number" || !Number.isInteger(input.alert_minutes) || input.alert_minutes < 0 || input.alert_minutes > MAX_ALERT_MINUTES) {
      throw new Error("alert_minutes must be a whole number of minutes from 0 to 40320");
    }
    alert = input.alert_minutes;
  }
  let start: any, end: any;
  if (timed) {
    const s = checkTime("start_time", input.start_time);
    let endDate = lastDay;
    let e: string;
    if (input.end_time !== undefined && input.end_time !== "") {
      e = checkTime("end_time", input.end_time);
      if (lastDay === date && e <= s) throw new Error("end_time must be after start_time");
    } else if (lastDay > date) {
      throw new Error("give end_time as well when end_date is a later day");
    } else {
      const h = Number(s.slice(0, 2)) + 1;
      if (h === 24) endDate = addDays(date, 1);
      e = `${String(h % 24).padStart(2, "0")}${s.slice(2)}`;
    }
    start = { dateTime: `${date}T${s}:00`, timeZone: TIME_ZONE };
    end = { dateTime: `${endDate}T${e}:00`, timeZone: TIME_ZONE };
  } else {
    start = { date };
    end = { date: addDays(lastDay, 1) };
  }
  // A run restarted after a crash must not add the same event twice.
  const sameDay = await listEvents({ from: date }, deps);
  const wanted = timed ? `${start.dateTime}${offsetOn(date)}` : date;
  const twin = sameDay.find((ev) => ev.title === title && ev.start === wanted);
  if (twin) return { added: false, already_there: true, event: twin };

  const body: Record<string, unknown> = { summary: title, start, end };
  if (typeof input.location === "string" && input.location.trim()) body.location = input.location.trim().slice(0, 300);
  if (typeof input.notes === "string" && input.notes.trim()) body.description = input.notes.trim().slice(0, 1000);
  if (rule) body.recurrence = [rule];
  if (alert !== null) body.reminders = { useDefault: false, overrides: [{ method: "popup", minutes: alert }] };
  const res = await deps.fetch(`${API}?sendUpdates=none`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken(deps)}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`calendar add failed (${res.status})`);
  return { added: true, event: shape(await res.json()) };
}

const ID = /^[A-Za-z0-9_-]{5,1024}$/;

async function fetchEvent(id: string, deps: CalendarDeps): Promise<any> {
  const res = await deps.fetch(`${API}/${id}?${new URLSearchParams({ timeZone: TIME_ZONE })}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${await accessToken(deps)}` },
  });
  if (res.status === 404 || res.status === 410) throw new Error("no event with that id");
  if (!res.ok) throw new Error(`calendar read failed (${res.status})`);
  const raw = await res.json();
  if (raw.status === "cancelled") throw new Error("that event is already removed");
  return raw;
}

/** The event to act on: the one named, or with `series` the whole repeating series it belongs to. */
async function target(idIn: unknown, series: unknown, deps: CalendarDeps): Promise<{ id: string; raw: any }> {
  if (typeof idIn !== "string" || !ID.test(idIn)) throw new Error("id must be an event id from the events tool");
  const raw = await fetchEvent(idIn, deps);
  if (series !== true) return { id: idIn, raw };
  if (!raw.recurringEventId) {
    if (raw.recurrence) return { id: idIn, raw };
    throw new Error("that event does not repeat; leave out series");
  }
  if (!ID.test(raw.recurringEventId)) throw new Error("the series id is not usable");
  return { id: raw.recurringEventId, raw: await fetchEvent(raw.recurringEventId, deps) };
}

// "2026-10-06T15:00" plus minutes, as plain wall-clock arithmetic.
function plusMinutes(local: string, minutes: number): string {
  return new Date(Date.parse(`${local}:00Z`) + minutes * 60_000).toISOString().slice(0, 16);
}

export interface ChangeInput {
  id: unknown;
  series?: unknown; // true: change every occurrence of a repeating event, not only this one
  title?: unknown;
  date?: unknown; // moves the event to this day
  start_time?: unknown;
  end_time?: unknown; // omitted: the event keeps its length
  end_date?: unknown; // the day it ends, when that is not the day it starts
  location?: unknown;
  notes?: unknown;
}

export async function changeEvent(input: ChangeInput, deps: CalendarDeps = realDeps): Promise<{ changed: boolean; before: EventOut; event: EventOut }> {
  // Everything that can be refused from the input alone is refused before any request.
  if (typeof input.id !== "string" || !ID.test(input.id)) throw new Error("id must be an event id from the events tool");
  const body: Record<string, unknown> = {};
  if (given(input.title)) {
    const title = typeof input.title === "string" ? input.title.trim().slice(0, 200) : "";
    if (!title) throw new Error("title cannot be empty");
    body.summary = title;
  }
  if (typeof input.location === "string") body.location = input.location.trim().slice(0, 300);
  if (typeof input.notes === "string") body.description = input.notes.trim().slice(0, 1000);
  const newDate = given(input.date) ? checkDate("date", input.date) : undefined;
  const newStart = given(input.start_time) ? checkTime("start_time", input.start_time) : undefined;
  const newEnd = given(input.end_time) ? checkTime("end_time", input.end_time) : undefined;
  const newEndDate = given(input.end_date) ? checkDate("end_date", input.end_date) : undefined;
  if (newStart && newEnd && !newEndDate && newEnd <= newStart) throw new Error("end_time must be after start_time");
  const moves = !!(newDate || newStart || newEnd || newEndDate);
  if (!moves && !Object.keys(body).length) throw new Error("nothing to change");
  if (input.series === true && (newDate || newEndDate)) throw new Error("a whole series can change its title, times of day, place and notes, not its dates");

  const { id, raw } = await target(input.id, input.series, deps);
  if (moves) {
    const wasTimed = !!raw.start?.dateTime;
    const oldStart: string = wasTimed ? raw.start.dateTime.slice(0, 16) : `${raw.start.date}T00:00`;
    const oldEnd: string = wasTimed ? raw.end.dateTime.slice(0, 16) : `${raw.end.date}T00:00`;
    const length = (Date.parse(`${oldEnd}:00Z`) - Date.parse(`${oldStart}:00Z`)) / 60_000;
    const date = newDate ?? oldStart.slice(0, 10);
    if (newEndDate && newEndDate < date) throw new Error("end_date is before the event's start day");
    if (!wasTimed && !newStart) {
      if (newEnd) throw new Error("give start_time as well to put a time on an all-day event");
      body.start = { date, dateTime: null, timeZone: null };
      body.end = { date: newEndDate ? addDays(newEndDate, 1) : plusMinutes(`${date}T00:00`, length).slice(0, 10), dateTime: null, timeZone: null };
    } else {
      const start = `${date}T${newStart ?? oldStart.slice(11)}`;
      let end: string;
      if (newEnd || newEndDate) {
        // A new end day without a new end time keeps the old end time, where there was one.
        const endTime = newEnd ?? (wasTimed ? oldEnd.slice(11) : undefined);
        if (!endTime) throw new Error("give end_time as well as end_date");
        end = `${newEndDate ?? date}T${endTime}`;
        if (end <= start) throw new Error("the event would end before it starts");
      } else end = plusMinutes(start, wasTimed ? length : 60);
      body.start = { dateTime: `${start}:00`, timeZone: TIME_ZONE, date: null };
      body.end = { dateTime: `${end}:00`, timeZone: TIME_ZONE, date: null };
    }
  }
  const res = await deps.fetch(`${API}/${id}?sendUpdates=none`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${await accessToken(deps)}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`calendar change failed (${res.status})`);
  return { changed: true, before: shape(raw), event: shape(await res.json()) };
}

export const ASK_FIRST =
  "Not removed: the person has not been asked yet. Ask once, in one short line that names each event you will remove by its title, and nothing else. When they answer, remove them all in that turn without asking again.";

export async function removeEvent(
  input: { id: unknown; series?: unknown },
  deps: CalendarDeps = realDeps,
): Promise<{ removed: boolean; needs_go_ahead?: true; say?: string; whole_series?: true; event: EventOut }> {
  if (deps.removals.n >= MAX_REMOVALS) throw new Error(`Jarvis removes at most ${MAX_REMOVALS} events in one turn`);
  const { id, raw } = await target(input.id, input.series, deps);
  const event = shape(raw);
  if (!deps.approved(event.title)) return { removed: false, needs_go_ahead: true, say: ASK_FIRST, event };
  const res = await deps.fetch(`${API}/${id}?sendUpdates=none`, { method: "DELETE", headers: { Authorization: `Bearer ${await accessToken(deps)}` } });
  if (!res.ok && res.status !== 410) throw new Error(`calendar remove failed (${res.status})`);
  deps.removals.n++;
  return { removed: true, ...(input.series === true ? { whole_series: true as const } : {}), event };
}
