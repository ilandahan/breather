import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from "node:fs";
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

function dayKey(now = new Date()) {
  return dayDate(now).toISOString().slice(0, 10);
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
      const age = existsSync(lock) ? Date.now() - Date.parse(new Date().toISOString()) : 0;
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
    else segs.push([now, now]);
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

export function minutesToClock(hhmmStr, now = new Date()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmmStr || "");
  if (!m) return null;
  const target = new Date(now);
  target.setHours(Number(m[1]), Number(m[2]), 0, 0);
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

export function restInMinutes(s = readPresence(), now = new Date()) {
  const mins = attendedMinutes(s);
  const targets = isNight(now) ? [90, 180] : [180, 300];
  const byZone = targets.find(t => mins < t);
  const anchor = nextAnchor(s, now);
  const end = endMinutesLeft(s, now);

  const candidates = [
    byZone ? byZone - mins : 0,
    anchor?.in,
    end !== null ? Math.max(0, end) : null
  ].filter(v => v !== null && v !== undefined);

  return candidates.length ? Math.max(0, Math.min(...candidates)) : 0;
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
