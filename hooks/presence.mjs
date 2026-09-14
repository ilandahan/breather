import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export const ROOT = join(homedir(), ".claude", "state", "breather");
export const LIVE = join(ROOT, "live");

const GAP_MS = 20 * 60000;
const DEAD_MS = 5 * 60000;
const DAY_START_HOUR = 4;

export const ZONES = [[90, "quiet"], [180, "alert"], [300, "offer"], [Infinity, "boundary"]];

function ensure() {
  mkdirSync(LIVE, { recursive: true });
}

function dayDate(now = new Date()) {
  const d = new Date(now);
  if (d.getHours() < DAY_START_HOUR) d.setDate(d.getDate() - 1);
  return d;
}

// Local Y-M-D, never toISOString(): the breather day starts at 04:00 LOCAL, and a
// UTC key rolls whenever UTC midnight passes. East of Greenwich that is a second,
// earlier rollover — at UTC+3 the key changed at 03:00 local, so a night session
// lost its day (and every cue mark with it) an hour before the real boundary.
const pad = n => String(n).padStart(2, "0");
export function dayKey(now = new Date()) {
  const d = dayDate(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function readRecurring() {
  const f = join(ROOT, "recurring.json");
  if (!existsSync(f)) return {};
  try {
    const r = JSON.parse(readFileSync(f, "utf8"));
    return r && typeof r === "object" && !Array.isArray(r) ? r : {};
  } catch { return {}; }
}

export function writeRecurring(r) {
  ensure();
  writeFileSync(join(ROOT, "recurring.json"), JSON.stringify(r));
}

// The rule for a given breather-day: "*" as base, the weekday's rule on top.
// lunch/end: day-specific wins; anchors: union of both, sorted.
export function recurringFor(now = new Date()) {
  const r = readRecurring();
  const day = r[DAY_NAMES[dayDate(now).getDay()]] || {};
  const base = r["*"] || {};
  const anchors = [...new Set([...(base.anchors || []), ...(day.anchors || [])])].sort();
  return {
    anchors,
    lunch: day.lunch ?? base.lunch ?? null,
    end: day.end ?? base.end ?? null
  };
}

function withLock(fn) {
  const lock = join(ROOT, ".lock");
  for (let i = 0; i < 20; i++) {
    try {
      mkdirSync(lock);
      try { return fn(); } finally { try { rmSync(lock, { recursive: true }); } catch {} }
    } catch {
      // the LOCK's age, from its own mtime. This used to read
      // `Date.now() - Date.parse(new Date().toISOString())` — now minus now, always
      // 0 — so the breaker never fired: one crash between mkdir and the finally left
      // .lock forever, and every prompt hook after it spun 20x15ms and then wrote
      // unlocked through the fallback below.
      let age = 0;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch {} // gone already: nothing to break
      if (age > 2000) { try { rmSync(lock, { recursive: true }); } catch {} }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  return fn();
}

const BLANK = () => {
  const rec = recurringFor();
  const seeded = rec.anchors.length > 0 || rec.lunch !== null || rec.end !== null;
  return {
    day: dayKey(), segments: [],
    plan: { lunch: rec.lunch, end: rec.end, anchors: rec.anchors },
    recurringSeeded: seeded,
    cues: {},
    askedPlan: false, lastOffer: 0, snoozeUntil: 0, windows: {}
  };
};

export function readPresence() {
  ensure();
  const p = join(ROOT, "presence.json");
  if (!existsSync(p)) return BLANK();
  let s;
  try { s = JSON.parse(readFileSync(p, "utf8")); } catch { return BLANK(); }
  if (s.day !== dayKey()) return BLANK();
  const b = BLANK();
  return { ...b, ...s, plan: { ...b.plan, ...(s.plan || {}) } };
}

function savePresence(s) {
  writeFileSync(join(ROOT, "presence.json"), JSON.stringify(s));
}

export function updatePresence(mutate) {
  return withLock(() => {
    const s = readPresence();
    const out = mutate(s) || s;
    savePresence(out);
    return out;
  });
}

// Body cue intervals in attended minutes, and how long a due cue reads "now"
// before its countdown restarts on its own. Semantics: see cueState() below.
export const CUES = { water: 45, stand: 60, eyes: 20 };
export const DUE_WINDOW = 5;

// Start a new stretch: the current one ends here and every interval cue starts
// over. Daylight is once a day, so its mark stays. Attended minutes are NOT
// touched — the zero-length segment adds nothing, and the day's load is what it
// is whether or not you rested. Two callers, which is why it lives here: a 20m+
// gap detected by beat(), and `mark.mjs break`, which says the same thing out
// loud when the gap was too short to detect.
export function startFreshStretch(s, now = Date.now()) {
  const att = attendedMinutes(s);
  s.cues = { ...s.cues, ...Object.fromEntries(Object.keys(CUES).map(k => [k, att])) };
  s.segments.push([now, now]);
  return s;
}

export function beat(sessionId, kind, cwd) {
  ensure();
  const now = Date.now();
  const path = join(LIVE, `${sessionId}.json`);
  let live = { sid: sessionId, started: now, lastHuman: 0, lastWork: 0, cwd };
  if (existsSync(path)) {
    try { live = { ...live, ...JSON.parse(readFileSync(path, "utf8")) }; } catch {}
  }
  if (cwd) live.cwd = cwd;
  if (kind === "human") live.lastHuman = now; else live.lastWork = now;
  writeFileSync(path, JSON.stringify(live));

  if (kind !== "human") return;

  updatePresence(s => {
    const segs = s.segments;
    const last = segs[segs.length - 1];
    if (last && now - last[1] < GAP_MS) last[1] = now;
    else startFreshStretch(s, now); // a real break (20m+ away)
    return s;
  });
}

// Fire the once-per-day morning popup if nobody has yet. Callable from any
// hook — session-open at a fresh session, clock at the first prompt of a new
// day in a session left open overnight. The flag claim happens INSIDE the
// lock so two simultaneous sessions cannot both fire.
export function maybeNotifyPlan() {
  let fire = false;
  const s = updatePresence(st => {
    if (st.notifiedPlan || st.askedPlan) return st;
    st.notifiedPlan = true;
    fire = true;
    return st;
  });
  if (!fire) return false;
  const seeded = s.recurringSeeded && (s.plan.anchors.length || s.plan.lunch || s.plan.end);
  const body = seeded
    ? "Your recurring plan is loaded. Type into Claude only what's different today."
    : "Type your day plan into Claude: meetings and calls, lunch time, and when you want to finish.";
  try {
    spawn(process.execPath, [join(homedir(), ".claude", "hooks", "breather", "notify.mjs"), "breather", body], { detached: true, stdio: "ignore" }).unref();
  } catch {}
  return true;
}

export function dropSession(sessionId) {
  const path = join(LIVE, `${sessionId}.json`);
  try { unlinkSync(path); } catch {}
}

export function liveSessions() {
  ensure();
  const now = Date.now();
  const out = [];
  for (const f of readdirSync(LIVE)) {
    if (!f.endsWith(".json")) continue;
    try {
      const l = JSON.parse(readFileSync(join(LIVE, f), "utf8"));
      const seen = Math.max(l.lastHuman || 0, l.lastWork || 0, l.started || 0);
      if (now - seen > DEAD_MS) { unlinkSync(join(LIVE, f)); continue; }
      out.push({ ...l, seen, working: now - (l.lastWork || 0) < 90000 });
    } catch {}
  }
  return out;
}

export function attendedMinutes(s = readPresence()) {
  const ms = s.segments.reduce((a, [x, y]) => a + (y - x), 0);
  return Math.round(ms / 60000);
}

export function isNight(now = new Date()) {
  const h = now.getHours();
  return h >= 23 || h < 6;
}

// Body cues, in attended minutes (idle gaps pause them). A due cue reads
// "now" for DUE_WINDOW attended minutes, then its countdown restarts on its
// own — the status line must never nag forever. `mark.mjs did <cue>` restarts
// it earlier. Daylight is the one once-a-day cue: shown inside DAYLIGHT_HOURS
// until acked, never after — a missed one is not something to nag about.
// (CUES and DUE_WINDOW are declared above beat(), which resets them.)
const DAYLIGHT_HOURS = [10, 16];
const DAYLIGHT_LATE_HOUR = 14;

// Continuous presence thresholds for "no break": shown from NO_BREAK_MIN
// minutes (amber), red from NO_BREAK_RED. One place, read by both hooks.
export const NO_BREAK_MIN = 90;
export const NO_BREAK_RED = 150;

// Returns one entry per cue to show. Interval cues: { name, left, due } where
// `left` is minutes until due (0 while due) and `due` is true inside the
// DUE_WINDOW. Daylight, when pending: { name: "daylight", pending: true, late }
// with `late` true from DAYLIGHT_LATE_HOUR. Consumers: statusline.mjs, clock.mjs.
export function cueState(s = readPresence(), now = new Date()) {
  const attended = attendedMinutes(s);
  const marks = s.cues || {};
  const out = Object.entries(CUES).map(([name, every]) => {
    // isFinite, not `|| 0`: a hand-edited or half-written mark ("x", null, {})
    // would otherwise poison the arithmetic and render `water NaNm` all day
    const markedAt = Number.isFinite(marks[name]) ? marks[name] : 0;
    const elapsed = Math.max(0, attended - markedAt);
    const left = every - (elapsed % (every + DUE_WINDOW));
    return { name, left: Math.max(0, left), due: left <= 0 };
  });
  const h = now.getHours();
  if (h >= DAYLIGHT_HOURS[0] && h < DAYLIGHT_HOURS[1] && !marks.daylight) {
    out.push({ name: "daylight", pending: true, late: h >= DAYLIGHT_LATE_HOUR });
  }
  return out;
}

// Minutes of continuous presence in the current stretch: the live segment's
// length, or 0 once a 20m+ gap has ended it. This is "time since the last
// real break", distinct from the day's attended total.
export function stretchMinutes(s = readPresence(), now = Date.now()) {
  const last = s.segments[s.segments.length - 1];
  if (!last || now - last[1] >= GAP_MS) return 0;
  return Math.round((last[1] - last[0]) / 60000);
}

// Minutes from `now` to a plan time. Plan times belong to the breather day
// (which starts at DAY_START_HOUR): before 04:00, yesterday's "23:00" end is
// in the past, not 22 hours ahead — otherwise `over` would never fire in the
// one window where running late matters most.
export function minutesToClock(hhmmStr, now = new Date()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmmStr || "");
  if (!m) return null;
  const target = new Date(now);
  target.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (now.getHours() < DAY_START_HOUR && Number(m[1]) >= DAY_START_HOUR) target.setDate(target.getDate() - 1);
  return Math.round((target - now) / 60000);
}

export function endMinutesLeft(s = readPresence(), now = new Date()) {
  return minutesToClock(s.plan?.end, now);
}

export function nextAnchor(s = readPresence(), now = new Date()) {
  const p = s.plan || {};
  const all = [
    ...(p.anchors || []).map(a => ({ at: a, kind: "meeting" })),
    ...(p.lunch ? [{ at: p.lunch, kind: "lunch" }] : []),
    ...(p.end ? [{ at: p.end, kind: "end" }] : [])
  ];
  const upcoming = all
    .map(a => ({ ...a, in: minutesToClock(a.at, now) }))
    .filter(a => a.in !== null && a.in > 0)
    .sort((x, y) => x.in - y.in);
  return upcoming[0] || null;
}

export function zoneOf(s = readPresence(), now = new Date()) {
  const mins = attendedMinutes(s);
  const end = endMinutesLeft(s, now);
  const anchor = nextAnchor(s, now);
  const soonest = [end, anchor?.in].filter(v => v !== null && v !== undefined);

  if (soonest.length) {
    const left = Math.min(...soonest);
    if (left <= 0) return "boundary";
    if (left <= 15) return "offer";
    if (left <= 45) return "alert";
  }
  if (end !== null && end <= 0) return "boundary";

  let i = ZONES.findIndex(([lim]) => mins < lim);
  if (isNight(now)) i = Math.min(i + 1, ZONES.length - 1);
  return ZONES[i][1];
}

// What binds the countdown: the zone ladder ("rest") or the soonest planned
// point (kind meeting/lunch/end, with its clock time). Ties go to the plan —
// it is the more specific reason to stop.
export function restTarget(s = readPresence(), now = new Date()) {
  const mins = attendedMinutes(s);
  const targets = isNight(now) ? [90, 180] : [180, 300];
  const byZone = targets.find(t => mins < t);
  const anchor = nextAnchor(s, now);
  const end = endMinutesLeft(s, now);

  const candidates = [
    { in: byZone ? byZone - mins : 0, kind: "rest" },
    ...(anchor ? [anchor] : []),
    ...(end !== null ? [{ in: end, kind: "end", at: s.plan.end }] : [])
  ].map(c => ({ ...c, in: Math.max(0, c.in) }));

  return candidates.sort((x, y) => x.in - y.in || (x.kind === "rest") - (y.kind === "rest"))[0];
}

export function restInMinutes(s = readPresence(), now = new Date()) {
  return restTarget(s, now).in;
}

export function cooldownMinutes(s = readPresence()) {
  const snooze = Math.max(0, Math.round((s.snoozeUntil - Date.now()) / 60000));
  const since = s.lastOffer ? Math.round((Date.now() - s.lastOffer) / 60000) : 999;
  return Math.max(snooze, Math.max(0, 60 - since));
}

export function writeQuota(d) {
  ensure();
  const r = d.rate_limits;
  if (!r && !(d.cost?.total_cost_usd > 0)) return;
  const pick = w => (w && w.used_percentage != null) ? { pct: w.used_percentage, resets: w.resets_at } : null;
  const rl = r || {};
  const q = {
    at: Date.now(),
    mode: billingMode(d),
    five: pick(rl.five_hour),
    week: pick(rl.seven_day),
    spend: pick(rl.spend_limit),
    cost: d.cost?.total_cost_usd ?? null
  };
  try { writeFileSync(join(ROOT, "quota.json"), JSON.stringify(q)); } catch {}
}

export function billingMode(d) {
  const five = d?.rate_limits?.five_hour;
  const cost = d?.cost?.total_cost_usd ?? 0;
  if (!d?.rate_limits) return cost > 0 ? "api" : "unknown";
  if (five?.used_percentage != null && five.used_percentage >= 100) return "extra";
  return "plan";
}

export function readQuota() {
  const f = join(ROOT, "quota.json");
  if (!existsSync(f)) return null;
  try {
    const q = JSON.parse(readFileSync(f, "utf8"));
    return Date.now() - q.at > 15 * 60000 ? null : q;
  } catch { return null; }
}

export function minutesUntil(epochSeconds) {
  if (!epochSeconds) return null;
  return Math.max(0, Math.round((epochSeconds * 1000 - Date.now()) / 60000));
}

// Subscription pace: minutes until the five-hour window hits 100% at the
// pace held so far, or null when it will not run out before the reset (or
// when there is too little of the window elapsed to call it a pace). The
// 300-minute window is the plan's shape, an assumption, not something the
// status line observes.
const USAGE_WINDOW_MIN = 300;
const USAGE_PACE_MIN_ELAPSED = 30;
export function usageRunsOut(pct, resetsInMinutes) {
  // at 100% the window is already out — billingMode() says so as `extra usage`.
  // No floor on pct: a fast burn is a fast burn at 20% too; the elapsed floor
  // below is what keeps the first minutes of a window from reading as a pace.
  if (resetsInMinutes === null || resetsInMinutes === undefined || !(pct > 0) || pct >= 100) return null;
  const elapsed = USAGE_WINDOW_MIN - resetsInMinutes;
  if (elapsed < USAGE_PACE_MIN_ELAPSED) return null;
  const untilFull = (100 - pct) * elapsed / pct;
  return untilFull < resetsInMinutes ? Math.round(untilFull) : null;
}

export function pipelineActive(cwd) {
  if (!cwd) return false;
  const dir = join(cwd, ".aid", "pipeline");
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some(d => existsSync(join(dir, d, "active")));
  } catch { return false; }
}

export function hhmm(d = new Date()) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtDuration(mins) {
  const h = Math.floor(mins / 60);
  return h ? `${h}h${String(mins % 60).padStart(2, "0")}m` : `${mins}m`;
}
