// One-time Google sign-in that lets Jarvis read mail, save and send drafts, and read and write
// calendar events. Run by hand, after the OAuth client's id and secret are in the Keychain:
//   bun jobs/google_consent.ts
// It opens Google's consent page in the browser, waits for the answer on this Mac only, and
// stores the refresh token in the Keychain. The token is never printed or written to a file.
import { listEvents } from "../src/calendar/gcal";
import { googleClient, SCOPES, TOKEN_SERVICE } from "../src/google";
import { get, realDeps } from "../src/mail/gmail";
import { TIME_ZONE } from "../src/config";

const PORT = 8791;
const REDIRECT = `http://127.0.0.1:${PORT}`;
const client = googleClient();
const state = crypto.randomUUID();

const code = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no answer from Google after 10 minutes")), 600_000);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.searchParams.get("state") !== state) return new Response("not for this sign-in", { status: 400 });
      const err = url.searchParams.get("error");
      const got = url.searchParams.get("code");
      clearTimeout(timer);
      setTimeout(() => server.stop(), 200);
      if (err || !got) {
        reject(new Error(`Google answered: ${err ?? "no code"}`));
        return new Response("Jarvis was not given access. You can close this tab.");
      }
      resolve(got);
      return new Response("Jarvis can now use the mail and the calendar. You can close this tab.");
    },
  });
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();
  console.log("Opening Google's consent page in your browser. Choose the account whose mail and calendar Jarvis should use, tick every box, then Allow.");
  Bun.spawn(["open", auth.toString()]);
});

const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uri: REDIRECT,
  }).toString(),
});
if (!res.ok) throw new Error(`Google refused the code (${res.status})`);
const answer = await res.json();
const refresh: string = answer.refresh_token ?? "";
const missing = SCOPES.filter((sc) => !String(answer.scope ?? "").split(" ").includes(sc));
if (missing.length) throw new Error(`ABORT: Google did not grant ${missing.join(", ")}; nothing stored. Run again and tick every box.`);
if (refresh.length < 40) throw new Error(`ABORT: Google returned no usable refresh token (${refresh.length} chars); nothing stored`);

// Store: delete, add, then read back and compare lengths, so a silent Keychain failure is caught.
const user = process.env.USER ?? "";
Bun.spawnSync(["security", "delete-generic-password", "-a", user, "-s", TOKEN_SERVICE]);
const add = Bun.spawnSync(["security", "add-generic-password", "-a", user, "-s", TOKEN_SERVICE, "-w", refresh]);
const back = Bun.spawnSync(["security", "find-generic-password", "-s", TOKEN_SERVICE, "-w"]).stdout.toString().trim();
if (add.exitCode !== 0 || back.length !== refresh.length) throw new Error("the token was not stored correctly in the Keychain");
console.log(`stored in Keychain item ${TOKEN_SERVICE}, length ${back.length}`);

const today = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const week = await listEvents({ from: today, to: new Date(Date.parse(`${today}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10) });
console.log(`calendar read works: ${week.length} events in the next 7 days`);
const profile = await get(realDeps, "/profile");
console.log(`mail read works: ${profile.messagesTotal} messages in the mailbox`);
