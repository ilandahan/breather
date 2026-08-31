# Install

Everything is in `install.mjs` — the skill, the five hooks, the status line, and a safe merge into `settings.json`. Node 18 or newer, nothing else.

## The one-liner

**Inside Claude Code or Claude Desktop** — just say it:

```
install breather: run node install.mjs from this folder
```

**Anywhere:**

```
npx breather
```

**From a clone:**

```
node install.mjs
```

**From a URL, once you've published it** (any raw file host works):

```
curl -fsSL https://raw.githubusercontent.com/ilandahan/breather/main/install.mjs | node -
```

PowerShell:

```
iwr -useb https://raw.githubusercontent.com/ilandahan/breather/main/install.mjs -OutFile $env:TEMP\sb.mjs; node $env:TEMP\sb.mjs
```

Then restart Claude Code.

## Flags

| Flag | What it does |
|---|---|
| `--dry-run` | Prints every change, writes nothing. Run this first. |
| `--force` | Replaces an existing `statusLine` instead of leaving it alone. |
| `--uninstall` | Removes the hooks, the statusLine entry, and the files. Leaves your state. |

`CLAUDE_HOME=/some/path node install.mjs` installs against a different home — useful for testing before touching your real config.

## What it does to settings.json

It backs the file up first, to `settings.json.bak-<timestamp>`, every time.

**It merges, it does not overwrite.** Existing hooks on other events, existing hooks on the same events, permissions, and every other setting survive untouched. Verified against a config carrying a `PostToolUse` prettier hook and a permissions block.

**Re-running is idempotent.** It strips its own previous entries before adding them back, so installing five times leaves exactly one group per event.

**Your status line is safe by default.** If `statusLine` is already set to something that isn't ours, the installer says so and leaves it. Use `--force` to replace it — the old value is in the backup either way. If you'd rather keep your own, lift `restSegment`, `usageSegment` and `billingSegment` out of `statusline.mjs` into your script; they only need `presence.mjs` alongside.

If `settings.json` is not valid JSON, the installer stops and says so rather than guessing.

## Verify

```
node ~/.claude/hooks/breather/notify.mjs "Claude" "test"
```

```
echo '{"model":{"display_name":"Opus"},"context_window":{"used_percentage":31}}' | node ~/.claude/hooks/breather/statusline.mjs
```

```
echo '{"session_id":"test","cwd":"."}' | node ~/.claude/hooks/breather/clock.mjs
```

Then `/hooks` should list one entry under each of `SessionStart`, `UserPromptSubmit`, `PostToolBatch` and `SessionEnd`. Start a session and ask Claude to repeat the `[breather]` line back verbatim — if it can't, the hook isn't firing.

To force a zone for testing:

```
node -e "import('$HOME/.claude/hooks/breather/presence.mjs').then(m=>m.updatePresence(s=>{s.segments=[[Date.now()-320*60000,Date.now()]];s.lastOffer=0;s.snoozeUntil=0;return s}))"
```

## It replaces a usage status line

The status line shows five-hour and seven-day subscription usage alongside the rest indicator, so it stands in for the usage-tracking status lines most people already run. Seven-day and spend appear only above 60% and 70% respectively — below that they are noise.

A red `extra usage` appears once the five-hour window hits 100% and usage credits start paying, and a red `api billing ~$1.23` appears when there are no rate limits but cost is accruing. Neither renders in the normal case — they exist to light up when what you are paying with changes.

`rate_limits` appears only for Claude.ai Pro and Max subscribers (or behind a spend-limit gateway) and only after the first API response of a session. With an API key the usage segments simply don't render, and everything else works unchanged.

## Things that will bite

**A project-level `statusLine` overrides the global one.** With many project folders, check none of them define their own, or the segment vanishes there without warning.

**A custom status line hides most footer keyboard hints**, including `esc to interrupt`. It renders in its own row above the footer badges, which stay.

**System notifications share the status line row**, on the right. On a narrow terminal they truncate your output — which is why every segment is left-aligned and collapses via `COLUMNS`.

**Workspace trust gates the status line.** Until you accept the trust dialog for the folder it stays blank, and `claude --debug` logs `Status line command skipped: workspace trust not accepted`.

**Windows:** the installer writes forward-slash paths into `settings.json` deliberately. Claude Code routes hook commands through Git Bash when it's installed, and Git Bash consumes unquoted backslashes as escapes — a backslash path fails with no visible error. Also, if your shell profile prints anything unconditionally, that output is prepended to a hook's stdout and the JSON from `clock.mjs` silently stops parsing; wrap profile output in an interactive check.

The notification uses a PowerShell MessageBox, which opens a dialog rather than a toast and can appear behind your terminal. Swap in BurntToast in `notify.mjs` if you'd rather have a real toast.

## Tuning

| What | Where |
|---|---|
| Zone thresholds | `ZONES` in `presence.mjs` |
| Idle gap that splits presence (20m) | `GAP_MS` in `presence.mjs` |
| Dead-session TTL (5m) | `DEAD_MS` in `presence.mjs` |
| Day rollover (04:00) | `DAY_START_HOUR` in `presence.mjs` |
| Night window | `isNight()` in `presence.mjs` |
| Offer cooldown (60m) | `cooldownMinutes()` in `presence.mjs` |
| How early an anchor triggers (15m / 45m) | `zoneOf()` in `presence.mjs` |
| Lunch and evening notification windows | `activity.mjs` |
| Quota display thresholds (60% / 70%) | `quotaSegment()` in `statusline.mjs` |
| Quota staleness window (15m) | `readQuota()` in `presence.mjs` |
| Bar, colors, segments, width tiers | `statusline.mjs` |

After editing any of these, re-run `node install.mjs` from the source folder to push the change, or edit the installed copy in `~/.claude/hooks/breather/` directly.
