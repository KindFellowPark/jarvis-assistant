# Sample household

Everything in this folder is fictional. It stands in for the household's real folders so the
code, the settings and the live tests have something to point at. `src/config.ts` reads it unless
`JARVIS_HOUSEHOLD` and `JARVIS_NOTES_VAULT` point somewhere else.

- `household/appointments/` and `household/travel/` are folders a run may read.
- `household/travel/skill/` holds instructions for planning sessions. A run is denied it.
- `household/health/` and `household/finance/` stand in for private folders. A run is denied both.
- `notes/Inbox/` and `notes/Lists/` are the notes vault folders a run may read. A run may also add
  a line to a list. `notes/Ideas/` is denied.
