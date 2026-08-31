# breather — design record

What this is, why each piece is shaped the way it is, and what we deliberately rejected.

## Purpose

To protect the person using it. Everything below follows from that, including most of what the tool refuses to do.

The failure mode this guards against is not inefficiency. It is a person who cannot find a place to stop, works past the point where the work is any good, and pays for it somewhere else in their life. The tool's job is to make stopping visible and cheap. It is not to make anyone faster.

That purpose also sets the tone, and the tone is load-bearing. A tool that framed itself as watching over the user's wellbeing would be unbearable to work next to. So the values live here, in the README, and in the choices — never in what the tool says out loud. In the session it is quiet, factual, and easy to ignore. Care is in the design, not in the copy.

## The problem

A working session has no natural end. Claude is tuned to answer "what's next?" and there is always an answer. Sessions run into the night, there is no point at which stopping is presented as a legitimate outcome, and stopping is expensive anyway because the context dies with the session.

The skill adds a second valid answer to "what's next?" — *now is a good time to stop* — and makes stopping cheap by writing a handoff.

This is not a productivity tool. It does not measure output, it does not report on hours, and it never argues.

## Architecture

Four layers, deliberately separated:

| Layer | Where | Why there |
|---|---|---|
| Clock and presence | `presence.mjs`, deterministic JS | No judgement involved, and none wanted |
| Ambient state | `statusline.mjs` | Always visible, never interrupts |
| Events | `notify.mjs` → OS notification | Persists until seen; fires when the terminal isn't being watched |
| Wording and judgement | `SKILL.md` | The only part that needs a model |

## Decisions

### Presence, not session duration

Wall-clock session length is the wrong measure. A pipeline that runs three hours overnight is the tool working as intended, not fatigue. A terminal left open since yesterday reports fourteen hours of nothing.

What is measured instead: time since the first prompt, **minus idle gaps over 20 minutes**. Every `UserPromptSubmit` is a presence heartbeat.

Side effect worth keeping: a gap is a break that already happened. Coming back from lunch drops the zone automatically, so the skill stops nudging right after the user did the thing it wanted.

### Presence is global across sessions

Presence belongs to the human, not to a session. An hour in one project plus two in another is three hours of attention, not two separate short sessions.

All sessions write heartbeats to one user-level store (`~/.claude/state/breather/`). Any session reads the aggregate.

Consequences:
- `lastOffer` and `snoozeUntil` are global. Four open sessions must not ask four times.
- The decision reads the whole picture: if Claude has been grinding in another session for twenty minutes, that is a window, not a moment to suggest stopping.

Known limits: machine-scoped, so remote sessions don't count. A crashed session never fires `SessionEnd`, so entries carry a 5-minute TTL rather than trusting cleanup.

### Anchor points, not the clock

An offer that lands mid-bug-hunt is noise, and a skill that produces noise gets uninstalled within a week. Offers wait for a gate passing, tests going green, a commit, or a question resolving with nothing half-written.

The pipeline already knows what a boundary is. We listen; we don't rebuild.

### The day's anchors beat any threshold we invent

Asked once per day, in the first session after 04:00, **after** answering the first prompt. Never before, never blocking. Three questions in one short block:

1. Fixed points today that are anchors anyway — meetings, calls, a school run
2. What time for lunch
3. What time to finish

A meeting at 14:00 is a stronger stopping point than any threshold we compute, because the user is standing up regardless. The skill isn't judging their stamina; it's reading their own calendar back to them. "You said 18:30" is a quote, not an opinion.

A partial answer is a complete answer — record what came, don't chase the rest. Silence is a decline; `skip` marks the day and it is never raised again.

`rest_in` is the minimum of the zone ladder, the next anchor, and the end of day. The status line only draws the `→14:00` target when that anchor is the binding constraint — otherwise the arrow would imply a countdown to the wrong thing.

### Model and context belong to the usage side

The status line splits at a vertical bar: left is about the person, right is about the account. Model name and context percentage are properties of the session's machinery, not of the human, so they sit right.

`ctx` became `context` for the plainest possible reason — the abbreviation had to be explained, which is the definition of a failed label.

### Windows, not interruptions

The reframe that changed the design. The moment Claude starts a long run is a moment the user is about to be idle anyway. There is no interruption to make.

So the check moved earlier — before starting the run, not fifty minutes in — and the wording is about the world, not about the user:

> Running the pipeline now, about twenty minutes. It's 13:35 — go eat, this runs without you.

**No numbers about the user in the sentence.** The clock time is a fact; "you've worked 3h20m" is a meter. One mention per window per day, not per session.

### Two clocks, two words

`rest` and `usage` are unrelated quantities that both look like time, and an unlabelled `3h20m` next to `2h00` is unreadable — is the second one work left or a reset?

So: one word each, used identically in the status line and in the clock line Claude reads, so the user never translates between what Claude says and what they see.

The rest clock also counts **down**, not up. Elapsed-time-so-far is a meter on the person; time-until-the-next-stopping-point is an answer to the question they actually have. It also makes the two segments symmetric in shape, which is what lets the differing labels carry the distinction.

`rest_in` targets the first point where stopping is raised — 180 minutes, or 90 at night — then the boundary at 300 (180 at night), then reads `now`. A declared limit replaces both.

Never combine them in one sentence. "Three hours in and you're at 83%" is a performance report, not a boundary.

### Subscription quota is part of the decision, and part of the pitch

Two reasons it belongs here.

**Adoption.** The most common reason people install a custom status line is watching the five-hour window. A boundary indicator that doesn't show quota competes with something already installed instead of replacing it. Ours shows both.

**Substance.** When the five-hour window is nearly spent, the session ends whether anyone decides it or not. That makes it the least personal boundary we have — it isn't about the user at all, which is exactly the tone we want. It also makes starting a long run at 88% usage an operational mistake worth flagging.

**The guardrail is absolute: quota may support stopping, never continuing.** No "you've only used 40%, plenty left." Headroom is not an instruction, and an approaching reset is not a reason to push. Below the threshold, quota is simply not mentioned.

### Billing mode is visible, not looked up

Three states, derived from what the status line already receives: `plan` inside the subscription's included usage, `extra` once the five-hour window hits 100% and usage credits start paying, `api` when there are no `rate_limits` at all but a cost is accruing.

Only the last two render — in red, on the usage side. In the normal case the indicator is invisible, which is the point: it lights up only when the answer to "what am I paying with right now" has changed.

The API cost figure is shown with a `~` because `cost.total_cost_usd` is computed client-side at list price and the docs say plainly it may differ from the actual bill. It is an order-of-magnitude signal, not an accounting figure. Anything authoritative comes from the Console billing page.

### The status line is also a data source

`rate_limits` reaches the status line's stdin JSON only — hook input doesn't carry it. So `statusline.mjs` caches what it receives to `quota.json` in the shared state, and `clock.mjs` reads it from there.

Consequences: quota is absent from the clock line until the status line has ticked at least once, absent entirely for API-key users, and stale entries over 15 minutes old are discarded rather than trusted. Free refresh comes courtesy of Claude Code re-running the status line when a window reaches its `resets_at`.

### Zones

| zone | attended | behaviour |
|---|---|---|
| quiet | 0–90m | silent |
| alert | 90–180m | one closing line at the next anchor, no options |
| offer | 180–300m | three options at the next anchor |
| boundary | 300m+ | handoff drafted by default, continuing is the explicit choice |

`night` (23:00–06:00) moves everything up one zone. A declared limit overrides the ladder entirely.

## Rejected

**The name `clockout`.** Considered and dropped: clocking out is a timesheet metaphor, and it implies hours owed to someone. That is precisely the framing the whole design bans — no meters, no reports on time worked. A breather is something you take for your own sake.

**A hard gate.** We considered blocking tool use past a threshold, the way the load-order gate works. Rejected: a gate that blocks after five hours teaches the user to bypass it within a week, and then both the tool and the trust in it are gone. The offer works *because* it can be declined.

**`MessageDisplay`.** Considered, then rejected on reading the reference. It is a display filter, not a notification surface: the hook receives batches of rendered lines and replaces them, so anything added is text inside Claude's message in the same style — exactly the thing that gets swallowed. Worse, a long message produces several calls with no way to know which is last, so the line can land mid-paragraph. It also holds each render batch until the hook returns, costs latency on every message forever, doesn't fire on the first chunk, and is bypassed entirely by `--verbose`.

**A subagent for the judgement.** Isolated context means it cannot see the conversation, and the whole judgement depends on the conversation. A `prompt`-type hook on `Stop` is the right shape if the skill body ever grows enough to be worth moving out of context — noted as a future option, not built now.

**`/btw` as the delivery surface.** Right properties, wrong direction: it is user-initiated only. Command hooks cannot trigger slash commands. It remains a good *user-side* interface — `/btw how long have I been here?` reads the injected clock line and vanishes on dismissal — which costs nothing to support.

## Surfaces

| Surface | Role | Rule |
|---|---|---|
| Status line | state | always present, never interrupts, no Hebrew (terminal bidi) |
| OS notification | event | persists until seen — that persistence is the point |
| Line in the reply | offer | one line, blank line above, same shape every time, end of message only |

Consistency of shape beats brightness. After three occurrences the eye catches the shape without reading.

## Open

- Non-convergence detection (a pipeline cycling FIX_CODE for hours without the gate score moving) belongs to the pipeline, not here. Same handoff format, different trigger.
- `subagentStatusLine` exposes `startTime` per task — per-stage elapsed in the agent panel, not built yet.
