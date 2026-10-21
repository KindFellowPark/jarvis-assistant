// Google Maps access for Jarvis's runs: a drive time with traffic, and a place search. Both are
// read-only lookups; nothing is saved to the Google account. The key is a Maps Platform API key
// in the Keychain, read at use time. Each run starts its own tool server, so the caps below are
// per text: they keep one confused run from spending the month's free allowance.
import { HOME_ADDRESS, TIME_ZONE } from "../config";
import { keychain } from "../keychain";

export const KEY_SERVICE = "google_maps_api_key";
const ROUTES = "https://routes.googleapis.com/directions/v2:computeRoutes";
const PLACES = "https://places.googleapis.com/v1/places:searchText";
export const MAX_ROUTE_CALLS = 12; // requests to Google per run; a drive at a future time uses two
export const MAX_PLACE_CALLS = 6;
const MAX_PLACES = 8;

export type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface MapsDeps {
  fetch: Fetch;
  readKey: () => string;
  now: () => Date;
  used: { routes: number; places: number };
}

export const realDeps: MapsDeps = {
  fetch: (url, init) => fetch(url, init) as any,
  readKey: () => {
    try {
      return keychain(KEY_SERVICE);
    } catch {
      throw new Error("maps is not connected yet");
    }
  },
  now: () => new Date(),
  used: { routes: 0, places: 0 },
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function place(name: string, v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > 200) throw new Error(`${name} must be an address or place name`);
  return /^home$/i.test(v.trim()) ? HOME_ADDRESS : v.trim();
}

/** The instant a Pacific wall-clock date and time names, across daylight saving. */
export function pacificInstant(date: string, time: string): Date {
  const guess = new Date(`${date}T${time}:00Z`);
  const shown = new Date(guess.toLocaleString("en-US", { timeZone: TIME_ZONE }) + " UTC");
  return new Date(guess.getTime() + (guess.getTime() - shown.getTime()));
}

function clock(d: Date): string {
  return d.toLocaleString("en-US", { timeZone: TIME_ZONE, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const minutes = (duration: unknown) => Math.round(parseInt(String(duration ?? "0"), 10) / 60);

const DRIVE_FIELDS = "routes.duration,routes.staticDuration,routes.distanceMeters,routes.description";
const WALK_FIELDS = "routes.duration,routes.distanceMeters,routes.legs.steps.distanceMeters,routes.legs.steps.navigationInstruction.instructions";
const MAX_STEPS = 20;

async function route(body: object, deps: MapsDeps, fields = DRIVE_FIELDS): Promise<any | null> {
  if (deps.used.routes >= MAX_ROUTE_CALLS) throw new Error("too many drive lookups in one turn");
  deps.used.routes++;
  const res = await deps.fetch(ROUTES, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": deps.readKey(),
      "X-Goog-FieldMask": fields,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Google Maps refused the request (${res.status})`);
  return (await res.json()).routes?.[0] ?? null;
}

/**
 * Driving time between two places. With no date and time it is the drive leaving now, on live
 * traffic. With both it is Google's forecast for that departure: the usual figure and a slow-day
 * figure, which is the one to plan around.
 */
export async function drive(args: { from?: unknown; to?: unknown; date?: unknown; time?: unknown; mode?: unknown }, deps: MapsDeps = realDeps) {
  const origin = place("from", args.from);
  const destination = place("to", args.to);
  if (args.mode !== undefined && args.mode !== "" && args.mode !== "drive" && args.mode !== "walk") throw new Error("mode must be drive or walk");
  if (args.mode === "walk") return walk(origin, destination, deps);
  let leave: Date | null = null;
  if (args.date !== undefined || args.time !== undefined) {
    if (typeof args.date !== "string" || !DATE.test(args.date)) throw new Error("date must be a date like 2026-10-06");
    if (typeof args.time !== "string" || !TIME.test(args.time)) throw new Error("time must be a 24-hour time like 15:30");
    leave = pacificInstant(args.date, args.time);
    if (leave.getTime() < deps.now().getTime() - 60_000) throw new Error("that departure time has already passed");
    if (leave.getTime() < deps.now().getTime() + 120_000) leave = null; // "now": Google refuses a time not in the future
  }
  const base = {
    origin: { address: origin },
    destination: { address: destination },
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE_OPTIMAL",
    ...(leave ? { departureTime: leave.toISOString() } : {}),
  };
  const usual = await route(leave ? { ...base, trafficModel: "BEST_GUESS" } : base, deps);
  if (!usual) return { found: false, note: "Google Maps found no driving route between those two places." };
  const slow = leave ? await route({ ...base, trafficModel: "PESSIMISTIC" }, deps) : null;
  const start = leave ?? deps.now();
  const usualMin = minutes(usual.duration);
  const slowMin = slow ? Math.max(minutes(slow.duration), usualMin) : null;
  return {
    found: true,
    from: origin,
    to: destination,
    leaving: leave ? clock(leave) : "now",
    miles: miles(usual.distanceMeters),
    via: usual.description ?? null,
    minutes: usualMin,
    minutes_without_traffic: minutes(usual.staticDuration),
    arrive: clock(new Date(start.getTime() + usualMin * 60_000)),
    ...(slowMin !== null ? { minutes_on_a_slow_day: slowMin, arrive_on_a_slow_day: clock(new Date(start.getTime() + slowMin * 60_000)) } : {}),
  };
}

const miles = (meters: unknown) => Math.round(Number(meters ?? 0) / 160.9344) / 10;

/** Walking time, distance and the turns between two places. Traffic and departure time do not apply. */
async function walk(origin: string, destination: string, deps: MapsDeps) {
  const found = await route({ origin: { address: origin }, destination: { address: destination }, travelMode: "WALK" }, deps, WALK_FIELDS);
  if (!found) return { found: false, note: "Google Maps found no walking route between those two places." };
  const steps: any[] = (found.legs ?? []).flatMap((l: any) => l.steps ?? []);
  return {
    found: true,
    mode: "walk",
    from: origin,
    to: destination,
    miles: miles(found.distanceMeters),
    minutes: minutes(found.duration),
    steps: steps
      .filter((s) => s.navigationInstruction?.instructions)
      .slice(0, MAX_STEPS)
      .map((s) => `${String(s.navigationInstruction.instructions).replace(/\s+/g, " ").trim()} (${Math.round(Number(s.distanceMeters ?? 0) * 3.28084)} ft)`),
  };
}

/** Places matching a search, as Google Maps would list them. */
export async function places(args: { query?: unknown; open_now?: unknown }, deps: MapsDeps = realDeps) {
  if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 200) throw new Error("query must say what to look for and where");
  if (deps.used.places >= MAX_PLACE_CALLS) throw new Error("too many place searches in one turn");
  deps.used.places++;
  const res = await deps.fetch(PLACES, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": deps.readKey(),
      "X-Goog-FieldMask": [
        "places.displayName", "places.formattedAddress", "places.nationalPhoneNumber", "places.rating", "places.userRatingCount",
        "places.priceLevel", "places.businessStatus", "places.currentOpeningHours.openNow", "places.regularOpeningHours.weekdayDescriptions",
        "places.websiteUri", "places.googleMapsUri",
      ].join(","),
    },
    body: JSON.stringify({ textQuery: args.query.trim(), maxResultCount: MAX_PLACES, ...(args.open_now === true ? { openNow: true } : {}) }),
  });
  if (!res.ok) throw new Error(`Google Maps refused the request (${res.status})`);
  const found: any[] = (await res.json()).places ?? [];
  return {
    places: found.slice(0, MAX_PLACES).map((p) => ({
      name: p.displayName?.text ?? null,
      address: p.formattedAddress ?? null,
      phone: p.nationalPhoneNumber ?? null,
      rating: p.rating ?? null,
      reviews: p.userRatingCount ?? null,
      price: typeof p.priceLevel === "string" ? p.priceLevel.replace("PRICE_LEVEL_", "").toLowerCase() : null,
      open_now: p.currentOpeningHours?.openNow ?? null,
      closed_for_good: p.businessStatus === "CLOSED_PERMANENTLY",
      hours: p.regularOpeningHours?.weekdayDescriptions ?? null,
      website: p.websiteUri ?? null,
      map_link: p.googleMapsUri ?? null,
    })),
  };
}
