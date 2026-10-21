# Jarvis

Jarvis is a household assistant my partner and I text over iMessage. It reads the calendar, the
mail, the bills, our notes and our trip plans, and it can make a short list of careful changes:
add or move a calendar event, save an email draft, add a bill or a list item. I'm Andrew Park, an
executive assistant, so this is an executive assistant for an actual executive assistant. I built
it for my own household.

I designed it and built it by directing Claude Code. I wrote the requirements, made the design
calls and checked the results; Claude Code wrote the code. I did not hand-code it.

Everything in this repository is fictional. The two people in the code are Alex and Sam, the
phone numbers are 555 numbers, every email address is at example.com, and the household folders
under `example/` are invented. The code and tests are the real ones with those details swapped in.

## Why iMessage

I wanted to reach it where I already am. No iMessage ever gets skipped, unlike email and push
notifications. That's the whole reason, that and the ability to reach Jarvis as long as my
computer is home and open.

The cost is in that last sentence. The bridge to iMessage (Photon's iMessage SDK) and everything
behind it run on my MacBook, so Jarvis answers only while that Mac is home, awake and open.

## How it works

One text, start to finish:

| Step | What happens | Code |
|---|---|---|
| 1. Text arrives | Photon hands the message to the listener, a small Bun and TypeScript program | [`photon.ts`](listener/src/photon.ts), [`main.ts`](listener/src/main.ts) |
| 2. Queue | It is written to a SQLite queue under its message id before anything else happens, so a crash or a repeat never answers twice | [`store.ts`](listener/src/store.ts) |
| 3. Allowlist | The sender's number is compared exactly against two numbers. A stranger's text is dropped and never stored; a group thread starts nothing | [`config.ts`](listener/src/config.ts), [`listener.ts`](listener/src/listener.ts) |
| 4. Restricted run | One Claude run starts with a fixed small toolset, only the folders that person is given, and every permission prompt answered "no" | [`runner.ts`](listener/src/runner.ts) |
| 5. Billing check | The run's event stream is read as it arrives. If the run is billed at API rates, everything stops | [`guard.ts`](listener/src/guard.ts) |
| 6. Reply | The listener sends the reply text back to the thread the text came from | [`listener.ts`](listener/src/listener.ts) |

The model only ever writes reply text. It has no tool that sends a message and no way to name a
destination, so it cannot text anyone, and the listener alone decides where a reply goes. The
tests check this directly: a run told to forward a message to another number still answers only
the thread it came from.

Scripts on the same Mac can text me through a local door on `127.0.0.1` that feeds the same
queue. Three use it: an hourly copy of the bill tracker (with renewal reminders 30 and 7 days
out), a 7 AM morning check that texts only when something is due, and a mail watch that texts me
when a reply arrives on something I'm waiting on. No script can text my partner; Jarvis only ever
answers a text my partner sent.

## What a run can reach

Every run gets Read, Glob and Grep, plus five small tool servers written for Jarvis. Nothing else
loads: no other tool servers, no user or project settings, and nothing that runs code.

- **Calendar.** List, add, change and remove events. Every write tells Google `sendUpdates=none`,
  so nobody is ever invited or notified, and the tool has no way to add a guest. One turn removes
  at most ten events. ([`gcal.ts`](listener/src/calendar/gcal.ts))
- **Mail.** Search and read, save a draft, and send a draft. Before any thread reaches the model,
  a privacy hold in code withholds health, passwords and keys, tax and identity documents, full
  financial statements and work mail; the model sees only that the thread is held. A draft goes
  out only after I've read it word for word in a text and said yes, and only my yes counts, not
  my partner's. ([`gate.ts`](listener/src/mail/gate.ts), [`compose.ts`](listener/src/mail/compose.ts))
- **Bills.** The bill tracker lives in Notion. Code copies it every hour to a file the run can
  read, and the run can propose one new row, which is written only after a yes. It can't change
  or remove a row, and one turn adds at most three. ([`bills_export.ts`](listener/jobs/bills_export.ts), [`notion.ts`](listener/src/bills/notion.ts))
- **Lists.** Append one dated, signed line to a list in the notes vault. The list name can't hold
  a slash, a dot-dot or a leading dot, so the tool can't reach outside the Lists folder, and one
  run adds at most 20 lines. ([`append.ts`](listener/src/lists/append.ts))
- **Maps.** Drive time (leaving now, or at a set time with a slow-day figure to plan around), a
  walk with its turns, and a place search. Read-only, capped at 12 route requests and 6 searches
  a run. The word "home" becomes the address in code, so it never sits in a prompt. ([`gmaps.ts`](listener/src/maps/gmaps.ts))

A run started by a script, like the morning check, gets none of the tools that change anything.
Only a person's text can change the calendar, the mail, the bill tracker or a list.

## The go-ahead rule

Three actions need a yes: removing a calendar event, adding a bill, and sending an email. The
check reads the texts themselves, in [`approval.ts`](listener/src/approval.ts). The action goes
through when Jarvis's last reply to that person named the thing (the event's title, the bill and
its amount, or the whole email) and the person has texted back since. It doesn't matter how Jarvis
phrased the question, so one yes is always enough. Jarvis can't approve its own request, because
only a text from the person's phone, sent after the question, counts as the answer. A question
older than 24 hours lapses.

## The billing guard

Personal use should stay on my Claude subscription and never quietly bill at API rates. Each run
streams two facts: which login it used, and whether the request was billed as overage. If the
login is an API key, or the run is billed as overage, or either fact is missing, the listener
stops starting runs, posts a notification on the Mac and texts me. It stays stopped, across
restarts, until I clear it by hand with `bun run unhalt`. Runs sign in with a long-lived
subscription token from the Keychain, and the run's environment is built from an allowlist, so a
stray API key in the shell never reaches it.

## One weekend with it

A concert trip to Los Angeles, in early October 2026. The texts below are a reconstruction: the
wording is invented, the events are what happened.

During the trip:

> **Me:** Move the departure to 1:00
>
> **Jarvis:** Done, you're leaving at 1:00. On a slow day that gets you there around 4:00, which is tight for the 4:45 start.

The move was right and the warning was wrong. 4:45 was the start of a calendar block, and the
show was at 7:00.

> **Me:** What are the set times, and when do we leave the hotel?

It answered from a copy of the agenda pasted into the calendar event three weeks earlier, with a
5:00 parking time. The agenda itself had been revised that day to leave the hotel at 5:15 and
park at 5:30.

> **Me:** Drop a pin where we parked

It had nowhere to write, so it offered to put a note on the calendar instead.

> **Me:** Walking directions from the garage to the stadium?

The maps tool only did driving, so it repeated the agenda's description of the walk.

The next day I read through what went wrong and had Claude Code fix it:

- **Travel folder access.** Runs now read the trip's agenda and plan directly. Where the agenda
  and the calendar disagree on a time, the calendar's own start time wins, because a change made
  by text lands there. A calendar block's start is never taken as a show or check-in time.
- **Walking mode.** The drive tool takes a walk and returns the minutes, the distance and up to
  20 turns.
- **Event notes, 600 to 2,000 characters.** The concert event's notes ran about 1,000 characters,
  so on the day the run had read half of the pasted timetable.
- **A date line.** Every prompt now opens with the next 14 days and their weekdays, after Jarvis
  once called October 6 a Monday.

The parking pin became a calendar note. When asked to remember something for later, such as
where the car is parked, Jarvis now adds it to the calendar at that moment and looks there when
asked.

## How it was built

I wrote what each piece had to do and what it must never do, and Claude Code wrote the code and
the tests. Before the listener went live it had to pass a safety suite with one test per rule: a
stranger's text starts nothing, a repeated message is answered once, a private folder is denied,
a reply goes only to the thread it came from, and an API key or overage billing stops everything.
Each tool after that came with its own tests for what it refuses.

Some changes came from use rather than from the plan:

- A morning check that timed out left its conversation id half-used, so the next text failed and
  the billing guard stopped everything. A run that dies before it starts now gets a fresh id.
- Text messages show markdown literally, so list dashes, heading marks and bold marks are taken
  out of every reply in code instead of trusting the prompt to prevent them.
- A script repeating the same notice under new ids ("the gateway is still down") now texts once
  a week at most.
- The bills tool's test once read the model's wording to see whether it refused a write. The
  model started describing the refusal in its own words, so the test now checks what reached a
  stand-in for Notion.

Google's consent screen for Jarvis's own sign-in points at a short public privacy page,
[KindFellowPark/jarvis-site](https://github.com/KindFellowPark/jarvis-site).

## Run it yourself

You need [Bun](https://bun.sh) 1.4 or later. The tests need no accounts.

```bash
cd listener
bun install
bun test
```

That runs 189 tests. Another 20 are skipped: they start real Claude runs and need Claude Code
installed and signed in. After `bun run setup` (below), `bun run test:live` turns them on.

To try it without an iMessage line, use the terminal stand-in. It treats each line you type as a
text from Alex and prints the reply. Only the transport is swapped; the queue, allowlist, billing
guard and restricted run are the same code.

```bash
bun run setup      # writes runs/alex and runs/sam: settings.json and system_prompt.md
bun run terminal
```

This needs Claude Code at `~/.local/bin/claude` (or `JARVIS_CLAUDE_BIN`) and a token from
`claude setup-token` stored in the macOS Keychain as `claude_code_oauth_token`. The mail,
calendar, bills and maps tools answer "not connected" until their own sign-ins are in the
Keychain (`jarvis_google_*`, `notion_integration_token`, `google_maps_api_key`); `bun
jobs/google_consent.ts` does the Google sign-in. The real iMessage line needs a Photon project
(`jarvis_photon_project_id` and `jarvis_photon_project_secret`) and `bun run start`. The
`launchd/` files keep the listener and the three jobs running on a Mac.

## What's different in this copy

- The real prompts, folders, phone numbers and mail watches are replaced with fictional ones
  (`run_template/`, `example/`, `listener/jobs/mail_watches.json`). The prompts are trimmed
  versions of the real ones.
- The original keeps a hand-written `settings.json` in each run folder. Here `bun run setup`
  writes it from `config.ts`, so the paths fit whatever machine it's cloned to.
- The terminal stand-in is new for this copy.
- The Apple Reminders helper is reduced to its read-only half, and a few household-specific
  exports and one-off scripts are left out.

## What's here

```
listener/src/            the listener: allowlist, queue, runner, billing guard, approval, door
listener/src/calendar/   calendar tools (no invites, no notifications)
listener/src/mail/       mail tools, privacy hold, draft and approved send
listener/src/bills/      add one bill row after a yes
listener/src/lists/      append one line to a list
listener/src/maps/       drive, walk and place lookups
listener/jobs/           scheduled jobs: bills copy, mail watch, morning check, reminders copy
listener/test/           the tests, including the safety suite
run_template/            sample system prompts for the two people
example/                 the fictional household the code points at
launchd/                 the Mac launch agents for the listener and jobs
```

Released under the MIT License.
