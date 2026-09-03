#!/usr/bin/env node
import { readPresence, attendedMinutes, zoneOf, liveSessions, restTarget, nextAnchor, endMinutesLeft, stretchMinutes, cueState, usageRunsOut, isNight, writeQuota, minutesUntil, billingMode, hhmm, NO_BREAK_MIN, NO_BREAK_RED } from "./presence.mjs";

// One word per stopping point, shared by the countdown label and the arrow.
const WORD = { rest: "rest", meeting: "meeting", lunch: "lunch", end: "end of day" };

const G = "\x1b[32m", A = "\x1b[33m", R = "\x1b[31m", D = "\x1b[90m", X = "\x1b[0m";
const ANSI = /\x1b\[\d+m/g;
// The host may not pass COLUMNS; 120 is the assumption when it doesn't. The
// length budget below applies only when the width is actually known —
// trimming to a guessed width would hide signals on a terminal that has room.
const knownWidth = Number(process.env.COLUMNS) > 0; // non-numeric, zero or negative: unknown, not narrow
const cols = knownWidth ? Number(process.env.COLUMNS) : 120;
const NARROW_COLS = 75;

let d = {};
try {
  d = JSON.parse(await new Promise(res => { let s = ""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => res(s || "{}")); }));
} catch {}

writeQuota(d);
// one snapshot of presence and of the live sessions for every segment and
// every trim pass: a beat landing mid-render must not make them disagree
const p = readPresence();
const sessions = liveSessions();

const bar = (pct, w = 10) => {
  const f = Math.max(0, Math.min(w, Math.round(pct / 100 * w)));
  return "▓".repeat(f) + "░".repeat(w - f);
};

const clock = m => {
  if (m == null) return "";
  const h = Math.floor(m / 60);
  return h ? `${h}h${String(m % 60).padStart(2, "0")}` : `${m}m`;
};

// Every segment renders from the option object `o` alone. Which parts of the
// row exist is decided in exactly one place: the initializer below.

function restSegment(o) {
  const worked = attendedMinutes(p);
  if (worked < 1) return "";

  // past the declared end of day: the countdown is over, say by how much
  const end = endMinutesLeft(p);
  if (end !== null && end < 0) return `${R}over ${clock(-end)}${X}`;

  const t = restTarget(p);
  const left = t.in;
  const zone = zoneOf(p);
  const color = zone === "boundary" ? R : zone === "quiet" ? G : A;

  if (left <= 0) return `${color}rest now${X}`;

  const span = Math.max(1, worked + left);
  const pct = Math.round(worked / span * 100);
  const label = WORD[t.kind];
  // The arrow names what comes next, always with its word.
  const a = nextAnchor(p);
  const target = a && o.arrow ? ` ${D}→ ${WORD[a.kind]} ${a.at}${X}` : "";
  const moon = o.moon && isNight() ? ` ${D}☾${X}` : "";
  const meter = o.bar ? ` ${bar(pct)}` : "";
  return `${color}${label} ${clock(left)}${meter}${X}${target}${moon}`;
}

// Continuous presence since the last real break. Silent below NO_BREAK_MIN;
// amber from there, red from NO_BREAK_RED. Distinct from `worked`, the day's total.
function stretchSegment(o) {
  const m = stretchMinutes(p);
  if (!o.stretch || m < NO_BREAK_MIN) return "";
  return `${m >= NO_BREAK_RED ? R : A}no break ${clock(m)}${X}`;
}

// Body cues, in the order cueState() gives them.
function cuesSegment(o) {
  return o.cues.map(c => {
    if (c.name === "daylight") return `${c.late ? A : D}daylight${X}`;
    // minutes, not clock(): a cue never exceeds 60 and clock.mjs says `stand:60m`, so both surfaces read the same
    return c.due ? `${A}${c.name} now${X}` : `${D}${c.name} ${c.left}m${X}`;
  }).join(`${D} · ${X}`);
}

function usageSegment(o) {
  const r = d.rate_limits;
  if (!r) return "";
  const out = [];

  const five = r.five_hour;
  if (five?.used_percentage != null) {
    const pct = Math.round(five.used_percentage);
    const resets = minutesUntil(five.resets_at);
    const c = pct >= 90 ? R : pct >= 70 ? A : G;
    // "~": the projection assumes the pace of the window so far holds
    const runsOut = o.runsOut ? usageRunsOut(pct, resets) : null;
    const outAt = runsOut === null ? "" : ` ${A}out ~${hhmm(new Date(Date.now() + runsOut * 60000))}${X}`;
    const resetsAt = o.resets ? `${D} resets ${clock(resets)}${X}` : "";
    const meter = o.bar ? ` ${bar(pct, 6)}` : "";
    out.push(`${c}usage ${pct}%${meter}${X}${resetsAt}${outAt}`);
  }

  const week = r.seven_day;
  if (o.extras && week?.used_percentage != null && week.used_percentage >= 60) {
    const pct = Math.round(week.used_percentage);
    out.push(`${pct >= 90 ? R : A}week ${pct}%${X}`);
  }

  const spend = r.spend_limit;
  if (o.extras && spend?.used_percentage != null && spend.used_percentage >= 70) {
    const pct = Math.round(spend.used_percentage);
    out.push(`${pct >= 100 ? R : A}spend ${pct}%${X}`);
  }

  return out.join(`${D} · ${X}`);
}

// Money signals are never dropped; under width pressure only the figure goes.
function billingSegment(o) {
  const mode = billingMode(d);
  if (mode === "api") {
    const cost = d.cost?.total_cost_usd;
    return `${R}api billing${X}${cost && o.cost ? `${D} ~$${cost.toFixed(2)}${X}` : ""}`;
  }
  if (mode === "extra") return `${R}extra usage${X}`;
  return "";
}

function sessionsSegment(o) {
  if (!o.sessions || sessions.length < 2) return "";
  const busy = sessions.filter(s => s.working).length;
  return `${D}sessions ${sessions.length}${busy ? ` · active ${busy}` : ""}${X}`;
}

function contextSegment(o) {
  const pct = Math.floor(d.context_window?.used_percentage || 0);
  // auto-compact lands around 95% and drops state silently: warn well before
  const c = pct >= 85 ? R : pct >= 70 ? A : D;
  return (!pct || !o.context) ? "" : `${c}context ${pct}%${X}`;
}

function modelSegment(o) {
  const m = d.model?.display_name;
  return m && o.model ? `${D}${m}${X}` : "";
}

function compose(o) {
  const sep = `${D} · ${X}`;
  const head = [`${D}breather${X}`, restSegment(o), stretchSegment(o), cuesSegment(o), sessionsSegment(o)].filter(Boolean).join(sep);
  const tail = [billingSegment(o), modelSegment(o), usageSegment(o), contextSegment(o)].filter(Boolean).join(sep);
  return [head, tail].filter(Boolean).join(`${D}  │  ${X}`);
}

// One composition, one trim order. Below NARROW_COLS every optional part is
// already off (the bare countdown and the bare account state — the only
// things no trim can remove); at and above it everything starts on and, when
// the width is known, the row is the shortest prefix of the trim order that
// fits. Because the parts and their order never change with width, a wider
// terminal can only show more: what is visible at W is visible at W+1.
// Trim order: the moon, the bars, the model name, cues not yet due (furthest
// first), a pending daylight, the sessions count, week/spend, due cues, the
// usage projection, the reset countdown, the anchor arrow, the api cost
// figure, "no break", and last the context percentage. Never trimmed: the
// countdown word and time, `usage N%`, and a billing warning. Before the
// first attended minute there is no countdown, so no cues either.
const full = cols >= NARROW_COLS;
const allCues = full && attendedMinutes(p) >= 1 ? cueState(p) : [];
const notDue = allCues.filter(c => c.name !== "daylight" && !c.due).sort((a, b) => b.left - a.left);
const daylight = allCues.filter(c => c.name === "daylight");
const due = allCues.filter(c => c.due);
const o = { cues: allCues, moon: full, bar: full, model: full, sessions: full, extras: full, runsOut: full, resets: full, arrow: full, cost: full, stretch: full, context: full };
const dropCue = c => () => { o.cues = o.cues.filter(x => x !== c); };
const trims = [
  () => { o.moon = false; },
  () => { o.bar = false; },
  () => { o.model = false; },
  ...notDue.map(dropCue),
  ...daylight.map(dropCue),
  () => { o.sessions = false; },
  () => { o.extras = false; },
  ...due.map(dropCue),
  () => { o.runsOut = false; },
  () => { o.resets = false; },
  () => { o.arrow = false; },
  () => { o.cost = false; },
  () => { o.stretch = false; },
  () => { o.context = false; }
];
const visible = s => s.replace(ANSI, "").length;
let row = compose(o);
if (knownWidth) {
  for (const trim of trims) {
    if (visible(row) <= cols) break;
    trim();
    row = compose(o);
  }
}
if (row) console.log(row);
