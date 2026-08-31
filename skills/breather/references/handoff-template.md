# Handoff — {{date}} {{time}}

Session length: {{elapsed}} · Branch: {{branch}} · Last commit: {{sha}}

## Where we stopped

The exact position. File, function, line. What state the process was in — server running, migration half-applied, three tests failing. Someone opening this repo cold should find the spot in under a minute.

Bad: "Working on the retry logic."
Good: "`fetchToken()` in `auth/client.ts:88` — the retry wrapper is written but not wired into the caller. `npm test auth` fails on two cases, both expected."

## What we tried and rejected

Every dead end, with the reason it died. This is the section that saves the next session an hour. Skipping it means walking the same road again.

- Tried X — failed because Y. Do not retry without Z changing first.
- Considered A — rejected, it breaks B.

If nothing was rejected, write "nothing ruled out yet" rather than deleting the section.

## Open decisions

Genuinely undecided things. Do not resolve them here to make the document look finished. Write the options and what each costs.

- Question: ...
  - Option A — costs ...
  - Option B — costs ...
  - Leaning: ... (or: no lean yet)

## Next step

One sentence. Actionable without thinking. Not a plan, not a list — the single first move.

> Wire the retry wrapper into the `login()` caller in `auth/session.ts`, then rerun `npm test auth`.
