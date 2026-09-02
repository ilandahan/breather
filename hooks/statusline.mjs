#!/usr/bin/env node
import { readPresence, attendedMinutes, zoneOf, liveSessions, restTarget, nextAnchor, isNight, writeQuota, minutesUntil, billingMode } from "./presence.mjs";

// One word per stopping point, shared by the countdown label and the arrow.
const WORD = { rest: "rest", meeting: "meeting", lunch: "lunch", end: "end of day" };

const G = "\x1b[32m", A = "\x1b[33m", R = "\x1b[31m", D = "\x1b[90m", X = "\x1b[0m";
const cols = Number(process.env.COLUMNS || 120);
const wide = cols >= 110, narrow = cols < 75;

let d = {};
try {
  d = JSON.parse(await new Promise(res => { let s = ""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => res(s || "{}")); }));
} catch {}

writeQuota(d);

const bar = (pct, w = 10) => {
  const f = Math.max(0, Math.min(w, Math.round(pct / 100 * w)));
  return "\u2593".repeat(f) + "\u2591".repeat(w - f);
};

const clock = m => {
  if (m == null) return "";
  const h = Math.floor(m / 60);
  return h ? `${h}h${String(m % 60).padStart(2, "0")}` : `${m}m`;
};

function restSegment() {
  const p = readPresence();
  const worked = attendedMinutes(p);
  if (worked < 1) return "";

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
  const target = a ? ` ${D}→ ${WORD[a.kind]} ${a.at}${X}` : "";
  const moon = isNight() ? ` ${D}☾${X}` : "";

  if (narrow) return `${color}${label} ${clock(left)}${X}`;
  if (!wide) return `${color}${label} ${clock(left)}${X}${target}`;
  return `${color}${label} ${clock(left)} ${bar(pct)}${X}${target}${moon}`;
}

function usageSegment() {
  const r = d.rate_limits;
  if (!r) return "";
  const out = [];

  const five = r.five_hour;
  if (five?.used_percentage != null) {
    const pct = Math.round(five.used_percentage);
    const resets = minutesUntil(five.resets_at);
    const c = pct >= 90 ? R : pct >= 70 ? A : G;
    if (narrow) out.push(`${c}usage ${pct}%${X}`);
    else if (!wide) out.push(`${c}usage ${pct}%${X}${D} resets ${clock(resets)}${X}`);
    else out.push(`${c}usage ${pct}% ${bar(pct, 6)}${X}${D} resets ${clock(resets)}${X}`);
  }

  const week = r.seven_day;
  if (week?.used_percentage != null && week.used_percentage >= 60 && !narrow) {
    const pct = Math.round(week.used_percentage);
    out.push(`${pct >= 90 ? R : A}week ${pct}%${X}`);
  }

  const spend = r.spend_limit;
  if (spend?.used_percentage != null && spend.used_percentage >= 70 && !narrow) {
    const pct = Math.round(spend.used_percentage);
    out.push(`${pct >= 100 ? R : A}spend ${pct}%${X}`);
  }

  return out.join(`${D} \u00b7 ${X}`);
}

function billingSegment() {
  const mode = billingMode(d);
  if (mode === "api") {
    const cost = d.cost?.total_cost_usd;
    return `${R}api billing${X}${cost ? `${D} ~$${cost.toFixed(2)}${X}` : ""}`;
  }
  if (mode === "extra") return `${R}extra usage${X}`;
  return "";
}

function sessionsSegment() {
  const all = liveSessions();
  if (all.length < 2 || narrow) return "";
  const busy = all.filter(s => s.working).length;
  return `${D}sessions ${all.length}${busy ? ` \u00b7 active ${busy}` : ""}${X}`;
}

function contextSegment() {
  const pct = Math.floor(d.context_window?.used_percentage || 0);
  return (!pct || narrow) ? "" : `${D}context ${pct}%${X}`;
}

function modelSegment() {
  const m = d.model?.display_name;
  return m && wide ? `${D}${m}${X}` : "";
}

const head = [`${D}breather${X}`, restSegment(), sessionsSegment()].filter(Boolean).join(`${D} \u00b7 ${X}`);
const tail = [billingSegment(), modelSegment(), usageSegment(), contextSegment()].filter(Boolean).join(`${D} \u00b7 ${X}`);
const row = [head, tail].filter(Boolean).join(`${D}  \u2502  ${X}`);
if (row) console.log(row);
