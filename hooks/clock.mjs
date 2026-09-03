#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { beat, readPresence, attendedMinutes, zoneOf, cooldownMinutes, liveSessions, restInMinutes, nextAnchor, isNight, pipelineActive, readQuota, minutesUntil, hhmm, fmtDuration, maybeNotifyPlan, cueState, stretchMinutes, NO_BREAK_MIN } from "./presence.mjs";

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch {}
const id = input.session_id || "unknown";
const cwd = input.cwd || process.cwd();

beat(id, "human", cwd);

const p = readPresence();
const others = liveSessions().filter(s => s.sid !== id);
const busy = others.filter(s => s.working).length;
const parts = [
  `worked=${fmtDuration(attendedMinutes(p))}`,
  `rest_in=${restInMinutes(p)}m`,
  `now=${hhmm()}`,
  `zone=${zoneOf(p)}`,
  `night=${isNight() ? "yes" : "no"}`,
  `cooldown=${cooldownMinutes(p)}m`,
  `sessions=${others.length + 1}`,
  `busy=${busy}`
];
const a = nextAnchor(p);
if (a) parts.push(`next_anchor=${a.at}`, `next_anchor_kind=${a.kind}`, `next_anchor_in=${a.in}m`);
if (p.plan?.end) parts.push(`day_ends=${p.plan.end}`);
if (pipelineActive(cwd)) parts.push("pipeline=running");
// same words as the status line, so Claude never translates
parts.push(`cues=${cueState(p).map(c => `${c.name}:${c.name === "daylight" ? "pending" : c.due ? "now" : `${c.left}m`}`).join(",")}`);
const stretch = stretchMinutes(p);
if (stretch >= NO_BREAK_MIN) parts.push(`no_break=${fmtDuration(stretch)}`);

const q = readQuota();
if (q?.mode && q.mode !== "unknown") parts.push(`billing=${q.mode}`);
if (q?.five) {
  parts.push(`usage=${Math.round(q.five.pct)}%`);
  const r = minutesUntil(q.five.resets);
  if (r !== null) parts.push(`usage_resets_in=${r}m`);
}
if (q?.week) parts.push(`usage_week=${Math.round(q.week.pct)}%`);
if (q?.spend) parts.push(`usage_spend=${Math.round(q.spend.pct)}%`);

let ctx = `[breather] ${parts.join(" ")}`;
if (!p.askedPlan) {
  // second trigger for the morning popup: a session left open overnight gets
  // no SessionStart, so its first prompt of the new day fires it from here
  maybeNotifyPlan();
  ctx += "\n[breather] Day plan not set. After fully answering this prompt, ask once, in one short closing block: any fixed points today (meetings, calls)? lunch when? finish when? Record answers: node ~/.claude/hooks/breather/mark.mjs anchors HH:MM,HH:MM (merges) | lunch HH:MM | end HH:MM. A repeating pattern (\"every day…\") is recorded once with: mark.mjs recur set <*|sun-thu> <anchors|lunch|end> <HH:MM>. If you already asked in a previous turn and got no answer, or the user declines, run: node ~/.claude/hooks/breather/mark.mjs skip";
  ctx += "\n[breather] CALENDAR (auto): if any calendar connector is available in this session (Google Calendar / Gmail, Microsoft 365 / Outlook), also fetch TODAY'S events now, record each meeting's start with mark.mjs anchors HH:MM,HH:MM (merges), and tell the user in one line what you recorded. If none is available or it is unauthenticated, say so once and move on — never retry.";
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: ctx
  }
}));
