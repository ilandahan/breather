#!/usr/bin/env node
// Behavior check for the status line's left segment and its safety signals:
// the countdown is labeled by what binds it (rest / meeting / lunch / end of
// day), the arrow names the next planned point, body cues count down on
// attended time, and the account side colors what matters. Runs the real
// statusline.mjs, clock.mjs and mark.mjs against an injected home (HOME and
// USERPROFILE both point at a temp dir), never the real ~/.claude. Pure
// helpers in presence.mjs are also called directly with an explicit `now`,
// so the time-of-day branches are asserted at every hour.
//
// Run: node scripts/test-statusline.mjs   (also part of npm test)

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks");
const STATUSLINE = join(HOOKS, "statusline.mjs");
const MARK = join(HOOKS, "mark.mjs");
const CLOCK = join(HOOKS, "clock.mjs");
const { cueState, minutesToClock, usageRunsOut, endMinutesLeft, nextAnchor, restTarget, stretchMinutes, attendedMinutes, dayKey } = await import(pathToFileURL(join(HOOKS, "presence.mjs")).href);

const ANSI = /\x1b\[\d+m/g;
const RED = "\x1b[31m", AMBER = "\x1b[33m", GREY = "\x1b[90m";
const colored = (code, text) => new RegExp(`${code.replace("[", "\\[")}${text}`);
const visible = s => s.replace(ANSI, "").trimEnd().length; // console.log adds the newline

const hhmm = d => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
// A clock time `m` minutes from now, or null if that would cross midnight or
// the 04:00 breather-day boundary (plan times belong to the breather day, so a
// 05:43 anchor read at 01:43 is yesterday's, i.e. "in the past").
const inMinutes = m => {
  const now = new Date(), d = new Date(now.getTime() + m * 60000);
  const sameDate = d.getDate() === now.getDate();
  const crossesDayStart = (now.getHours() < 4) !== (d.getHours() < 4);
  return sameDate && !crossesDayStart ? hhmm(d) : null;
};
const at = d => new Date(new Date().setHours(...d.split(":").map(Number), 0, 0));

// A fake breather home holding one day of presence. `segments` are
// [minutesAgoStart, minutesAgoEnd] pairs; default is one live segment of
// `workedMin` minutes ending now.
function fakeHome({ plan = {}, workedMin = 30, segments, cues = {}, liveSessions = 0 } = {}) {
  const home = mkdtempSync(join(tmpdir(), "breather-sl-"));
  const dir = join(home, ".claude", "state", "breather");
  mkdirSync(join(dir, "live"), { recursive: true });
  const now = Date.now();
  for (let i = 0; i < liveSessions; i++) {
    writeFileSync(join(dir, "live", `s${i}.json`), JSON.stringify({ sid: `s${i}`, started: now, lastHuman: now, lastWork: now }));
  }
  // the same LOCAL Y-M-D presence.mjs writes; toISOString() here would disagree
  // with the hook wherever the UTC date differs from the local one, which is a
  // suite that passes in the afternoon and fails after midnight
  const d = new Date(now);
  if (d.getHours() < 4) d.setDate(d.getDate() - 1);
  const segs = (segments || [[workedMin, 0]]).map(([a, b]) => [now - a * 60000, now - b * 60000]);
  writeFileSync(join(dir, "presence.json"), JSON.stringify({
    day: dayKey(d),
    segments: segs,
    plan: { lunch: null, end: null, anchors: [], ...plan },
    cues,
    askedPlan: true, lastOffer: 0, snoozeUntil: 0, windows: {}
  }));
  return { home, dir, env: { ...process.env, HOME: home, USERPROFILE: home } };
}

// Renders the status line. `cols: null` leaves COLUMNS unset (unknown width).
function render(opts = {}) {
  const { stdin = {}, cols = 120, raw = false, ...homeOpts } = opts;
  const { home, dir, env } = fakeHome(homeOpts);
  // the status line reads state; its one legitimate write is quota.json
  const stateDir = () => Object.fromEntries(readdirSync(dir, { recursive: true }).filter(f => !f.startsWith("quota.json")).map(f => {
    const p = join(dir, f);
    return [f, statSync(p).isDirectory() ? "<dir>" : readFileSync(p, "utf8")];
  }));
  const before = stateDir();
  try {
    const { COLUMNS, ...envWithoutCols } = env;
    const runEnv = cols === null ? envWithoutCols : { ...env, COLUMNS: String(cols) };
    const out = execFileSync(process.execPath, [STATUSLINE], { env: runEnv, input: JSON.stringify(stdin), encoding: "utf8" });
    assert.deepEqual(stateDir(), before, "statusline.mjs changed state other than quota.json");
    return raw ? out : out.replace(ANSI, "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function mark(homeOpts, ...args) {
  return markSeq(homeOpts, [args]);
}

// Several mark.mjs commands against ONE fake home, in order. Returns each
// command's stdout, the final presence, the final recurring rules, and the
// names of the files left in the state dir.
function markSeq(homeOpts, commands) {
  const { home, dir, env } = fakeHome(homeOpts);
  try {
    const outs = commands.map(args => execFileSync(process.execPath, [MARK, ...args], { env, encoding: "utf8" }));
    const read = f => existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), "utf8")) : null;
    return { out: outs[0], outs, presence: read("presence.json"), recurring: read("recurring.json"), files: readdirSync(dir).sort() };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function clockLine(homeOpts) {
  const { home, dir, env } = fakeHome(homeOpts);
  try {
    // cwd is the fake home so pipelineActive() never reads this repo's real .aid;
    // the dry-run flag is a belt-and-braces guard against a real popup should a
    // future case set askedPlan:false — the suite never exercises notify.mjs
    const out = execFileSync(process.execPath, [CLOCK], {
      env: { ...env, BREATHER_NOTIFY_DRYRUN: "1" }, input: JSON.stringify({ session_id: "t", cwd: home }), encoding: "utf8"
    });
    return { out, presence: JSON.parse(readFileSync(join(dir, "presence.json"), "utf8")) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// Every skip must be caused by the wall clock (a plan time that would cross
// midnight or the 04:00 day boundary, or the daylight window). Any other
// reason a check did not run is a failure, asserted at the bottom.
let ran = 0, skipped = 0, clockSkipped = 0, defined = 0, SKIPPABLE = 0; // SKIPPABLE: checks carrying a plan-time offset
// `cause` is what lets the bottom-of-file guard tell a clock skip from a
// disabled check: only "clock" counts toward clockSkipped.
const skip = (name, why, cause = "other") => { defined++; skipped++; if (cause === "clock") clockSkipped++; console.log(`  - ${name} (skipped: ${why})`); };
function check(name, offsets, fn) {
  if (offsets.length) SKIPPABLE++;
  const times = offsets.map(inMinutes);
  if (times.some(t => t === null)) { skip(name, "the plan time would cross midnight or the 04:00 day boundary", "clock"); return; }
  defined++; fn(...times); ran++; console.log(`  ✓ ${name}`);
}

console.log("statusline behavior");

// --- countdown label and arrow -------------------------------------------

check("meeting binding: label says meeting, arrow names it too", [25], t => {
  const out = render({ plan: { anchors: [t] } });
  assert.match(out, /\bmeeting 2[45]m\b/, out);
  assert.match(out, new RegExp(`→ meeting ${t}`), out);
});

check("lunch binding: label says lunch", [25], t => {
  assert.match(render({ plan: { lunch: t } }), /\blunch 2[45]m\b/);
});

check("end binding: label says end of day", [25], t => {
  assert.match(render({ plan: { end: t } }), /\bend of day 2[45]m\b/);
});

check("rest binding: label stays rest, arrow names the next anchor", [240], t => {
  const out = render({ plan: { anchors: [t] } });
  assert.match(out, /\brest \d/, out);
  assert.match(out, new RegExp(`→ meeting ${t}`), out);
});

check("rest binding with lunch next: arrow says lunch", [240], t => {
  assert.match(render({ plan: { lunch: t } }), new RegExp(`→ lunch ${t}`));
});

check("no plan: rest, no arrow", [], () => {
  const out = render({});
  assert.match(out, /\brest \d/, out);
  assert.doesNotMatch(out, /→/, out);
});

// --- over: past the declared end of day ------------------------------------

check("end of day passed: red 'over' replaces the rest countdown", [-25], t => {
  const out = render({ plan: { end: t }, raw: true });
  assert.match(out, colored(RED, "over 2[456]m"), out);
  assert.doesNotMatch(out.replace(ANSI, ""), /\brest\b/, out);
});

check("before 04:00, yesterday's 23:00 end reads as past, a 01:30 end as future", [], () => {
  assert.equal(minutesToClock("23:00", at("00:30")), -90);
  assert.equal(minutesToClock("01:30", at("00:30")), 60);
  assert.equal(minutesToClock("23:00", at("22:00")), 60);
});

// --- no break: continuous presence ------------------------------------------

check("no break: silent at 89m, amber from 90m, red from 150m", [], () => {
  assert.doesNotMatch(render({ segments: [[89, 0]] }), /no break/);
  assert.match(render({ segments: [[90, 0]], raw: true }), colored(AMBER, "no break 1h30"));
  assert.match(render({ segments: [[149, 0]], raw: true }), colored(AMBER, "no break 2h29"));
  assert.match(render({ segments: [[150, 0]], raw: true }), colored(RED, "no break 2h30"));
});

check("a 20m+ gap ended the stretch: a stale long segment is not a stretch", [], () => {
  // 100m worked, ended 100m ago: without the gap rule this would read 'no break 1h40' right after a break
  assert.doesNotMatch(render({ segments: [[200, 100]] }), /no break/);
  const t = Date.now();
  assert.equal(stretchMinutes({ segments: [[t - 200 * 60000, t - 100 * 60000]] }, t), 0);
  assert.equal(stretchMinutes({ segments: [[t - 200 * 60000, t - 5 * 60000]] }, t), 195); // still live: within 20m
  assert.equal(stretchMinutes({ segments: [[t - 200 * 60000, t - 19 * 60000]] }, t), 181); // 19m ago: still the same stretch
  assert.equal(stretchMinutes({ segments: [[t - 200 * 60000, t - 20 * 60000]] }, t), 0);   // 20m ago: the gap that ends it
  // and a short live segment after the gap counts only itself
  assert.doesNotMatch(render({ segments: [[150, 50], [20, 0]] }), /no break/);
});

// --- body cues: countdown on attended minutes -------------------------------

check("a fresh session (no attended minute) renders just the word", [], () => {
  assert.equal(render({ segments: [] }).trim(), "breather");
});

check("the due instant: 45 -> water now + stand 15m, 20 -> eyes now, 60 -> stand now", [], () => {
  const at45 = render({ workedMin: 45 });
  assert.match(at45, /\bwater now\b/, at45);
  assert.match(at45, /\bstand 15m\b/, at45);
  assert.match(render({ workedMin: 20 }), /\beyes now\b/);
  assert.match(render({ workedMin: 60 }), /\bstand now\b/);
  const now = Date.now();
  const s = { segments: [[now - 45 * 60000, now]], cues: {} };
  assert.deepEqual(cueState(s, at("09:00")), [
    { name: "water", left: 0, due: true }, { name: "stand", left: 15, due: false }, { name: "eyes", left: 0, due: true }
  ]);
});

check("30 attended minutes: water 15m, stand 30m, eyes 15m", [], () => {
  const out = render({ workedMin: 30 });
  assert.match(out, /\bwater 15m\b/, out);
  assert.match(out, /\bstand 30m\b/, out);
  assert.match(out, /\beyes 15m\b/, out);
});

check("47 attended minutes: water now (amber), stand 13m, eyes now", [], () => {
  // `left` is clamped to 0 while due (raw value would be -2 here)
  const t = Date.now();
  assert.deepEqual(cueState({ segments: [[t - 47 * 60000, t]], cues: {} }, at("09:00")), [
    { name: "water", left: 0, due: true }, { name: "stand", left: 13, due: false }, { name: "eyes", left: 0, due: true }
  ]);
  const out = render({ workedMin: 47, raw: true });
  assert.match(out, colored(AMBER, "water now"), out);
  assert.match(out, colored(GREY, "stand 13m"), out); // a cue not yet due is grey: colour only when it matters
  assert.match(out, colored(AMBER, "eyes now"), out);
});

check("52 attended minutes: water cycled back to 43m on its own", [], () => {
  // 45m interval + 5m due window = 50m cycle; at 52 the countdown has restarted
  assert.match(render({ workedMin: 52 }), /\bwater 43m\b/);
});

check("a countdown of exactly 60 reads 'stand 60m' on both surfaces, never 'stand 1h00'", [], () => {
  // right after `did stand` (or a post-break reset) stand sits at its full interval; the clock line says stand:60m
  const out = render({ workedMin: 30, cues: { stand: 30 } });
  assert.match(out, /\bstand 60m\b/, out);
  assert.doesNotMatch(out, /1h00/, out);
  const now = Date.now();
  assert.equal(cueState({ segments: [[now - 30 * 60000, now]], cues: { stand: 30 } }, at("09:00")).find(c => c.name === "stand").left, 60);
  assert.match(clockLine({ workedMin: 30, cues: { stand: 30 } }).out, /stand:60m/);
});

check("an ack restarts the countdown from that point; a mark beyond attended time means a full interval", [], () => {
  assert.match(render({ workedMin: 47, cues: { water: 40 } }), /\bwater 38m\b/);
  assert.match(render({ workedMin: 30, cues: { water: 100 } }), /\bwater 45m\b/); // never longer than the interval
});

check("mark.mjs did water records the attended minutes", [], () => {
  const { out, presence } = mark({ workedMin: 30 }, "did", "water");
  assert.equal(out.trim(), "did: water");
  assert.equal(presence.cues.water, 30);
  // acking one cue leaves every other mark alone — daylight included
  const seq = markSeq({ workedMin: 30, cues: { stand: 10 } }, [["did", "daylight"], ["did", "water"]]);
  assert.deepEqual(seq.presence.cues, { stand: 10, daylight: true, water: 30 });
});

check("mark.mjs did daylight records true; unknown and prototype names are refused", [], () => {
  assert.equal(mark({}, "did", "daylight").presence.cues.daylight, true);
  for (const bad of ["coffee", "__proto__", "toString", "constructor", undefined]) {
    // refused for the right reason: the usage line, not some unrelated crash
    assert.throws(() => mark({}, "did", ...(bad === undefined ? [] : [bad])),
      e => /usage: did <water\|stand\|eyes\|daylight>/.test(e.stdout || ""), `accepted did ${bad}`);
  }
});

check("mark.mjs break ends the stretch and restarts the cues, without moving worked", [], () => {
  // the break the gap rule cannot see: away 12 minutes, so no_break kept climbing
  const segments = [[100, 0]];
  assert.match(render({ segments, raw: true }), colored(AMBER, "no break 1h40"));

  const { out, presence } = mark({ segments, cues: { stand: 10, daylight: true } }, "break");
  assert.equal(out.trim(), "break recorded");
  assert.equal(stretchMinutes(presence), 0, "the stretch must end where the break was taken");
  assert.equal(attendedMinutes(presence), 100, "a break does not undo the hours already worked");
  assert.deepEqual(
    Object.fromEntries(cueState(presence).map(c => [c.name, c.left])),
    { water: 45, stand: 60, eyes: 20 },
    "every interval cue starts over"
  );
  assert.equal(presence.cues.daylight, true, "daylight is once a day and survives the break");
  assert.ok(presence.lastOffer > 0, "breather must not offer a break to someone who just took one");
});

check("a garbage cue mark cannot poison the countdown", [], () => {
  // a hand-edited or half-written presence.json must not render `water NaNm` all day
  for (const bad of ["x", null, {}, [], true, NaN]) {
    const out = render({ workedMin: 30, cues: { water: bad } });
    assert.match(out, /\bwater 15m\b/, `cues.water = ${JSON.stringify(bad)} -> ${out}`);
    assert.doesNotMatch(out, /NaN/, out);
  }
});

check("mark.mjs ack takes a session id, not a path: `..` cannot escape the state dir", [], () => {
  for (const bad of ["../../../pwned", "..", "a/b", "a\\b", "a.b", ""]) {
    assert.throws(() => mark({}, "ack", bad),
      e => /usage: ack <session-id>/.test(e.stdout || ""), `accepted ack ${JSON.stringify(bad)}`);
  }
  // the legitimate shape still works, and writes exactly one file
  const r = mark({}, "ack", "sess-01_A");
  assert.equal(r.out.trim(), "acknowledged");
  assert.ok(r.files.includes("sess-01_A.ack"), r.files.join(","));
});

check("the breather day is keyed on the local date, so it rolls once, at 04:00", [], () => {
  // a UTC key rolls again at UTC midnight; east of Greenwich that is BEFORE 04:00
  // local, which used to reset the day (and every cue mark) an hour early
  const day = (y, m, d, h, min = 0) => dayKey(new Date(y, m - 1, d, h, min));
  assert.equal(day(2026, 9, 3, 0, 30), "2026-09-02", "00:30 still belongs to the day that started at 04:00 on the 2nd");
  assert.equal(day(2026, 9, 3, 3, 59), "2026-09-02");
  assert.equal(day(2026, 9, 3, 4, 0), "2026-09-03", "the one rollover is at 04:00 local");
  assert.equal(day(2026, 9, 3, 23, 59), "2026-09-03");
  assert.equal(day(2026, 1, 1, 2, 0), "2025-12-31", "and it walks back over a year boundary");
});

check("a new segment after a real break resets water/stand/eyes, keeps daylight", [], () => {
  // clock.mjs beats on every prompt; the last segment ended 90m ago, so this beat opens a new one
  const { presence } = clockLine({ segments: [[130, 90]], cues: { water: 10, daylight: true } });
  assert.deepEqual(presence.cues, { water: 40, stand: 40, eyes: 40, daylight: true });
});

check("clock line carries cues= and no_break= in the same words", [], () => {
  // one live 97-minute segment: water 97%50=47 -> now, stand 97%65=32 -> 28m, eyes 97%25=22 -> now
  const { out } = clockLine({ segments: [[97, 0]] });
  const h = new Date().getHours();
  // anchored: daylight is the last cue word inside its window and absent outside
  assert.match(out, h >= 10 && h < 16 ? /cues=water:now,stand:28m,eyes:now,daylight:pending(?=[ "\\])/ : /cues=water:now,stand:28m,eyes:now(?=[ "\\])/, out);
  assert.match(out, /no_break=1h37m/, out);
  // the clock line's threshold is the status line's threshold
  assert.match(clockLine({ segments: [[90, 0]] }).out, /no_break=1h30m/);
  assert.doesNotMatch(clockLine({ segments: [[89, 0]] }).out, /no_break/);
  // no_break is the current stretch, not the day's total
  const multi = clockLine({ segments: [[300, 200], [95, 0]] });
  assert.match(multi.out, /worked=3h15m/, multi.out);
  assert.match(multi.out, /no_break=1h35m/, multi.out);
});

check("daylight: pending 10:00-16:00, late from 14:00, absent after, gone once acked", [], () => {
  const s = { segments: [], cues: {} };
  const daylight = (state, when) => cueState(state, at(when)).find(c => c.name === "daylight");
  assert.equal(daylight(s, "09:59"), undefined);
  assert.deepEqual(daylight(s, "10:00"), { name: "daylight", pending: true, late: false });
  assert.deepEqual(daylight(s, "13:59"), { name: "daylight", pending: true, late: false });
  assert.deepEqual(daylight(s, "14:00"), { name: "daylight", pending: true, late: true });
  assert.deepEqual(daylight(s, "14:30"), { name: "daylight", pending: true, late: true });
  assert.equal(daylight(s, "16:00"), undefined);
  assert.equal(daylight({ segments: [], cues: { daylight: true } }, "12:00"), undefined);
});

{
  const h = new Date().getHours();
  if (h >= 10 && h < 16) {
    check("daylight renders now (inside the window), grey before 14:00 and amber after", [], () => {
      assert.match(render({ raw: true }), colored(h >= 14 ? AMBER : GREY, "daylight"));
      assert.doesNotMatch(render({ cues: { daylight: true } }), /\bdaylight\b/);
      // trim order: a pending daylight outlives every cue not yet due (30 attended: none due)
      const stdin = { context_window: { used_percentage: 88 }, rate_limits: { five_hour: { used_percentage: 80, resets_at: Math.round((Date.now() + 120 * 60000) / 1000) } } };
      const only = render({ workedMin: 30, stdin, cols: 86 });
      assert.ok(visible(only) <= 86, only);
      assert.match(only, /\bdaylight\b/, only);
      assert.doesNotMatch(only, /water|stand|eyes/, only);
    });
  } else {
    skip("daylight renders now", `now is ${h}:xx, outside 10:00-16:00`, "clock");
  }
}

// --- width -------------------------------------------------------------------

check("90 columns: everything that fits stays (all cues here); 60 columns: no cues, no 'no break'", [], () => {
  const mid = render({ segments: [[97, 0]], cols: 90, raw: true });
  assert.ok(visible(mid) <= 90, mid);
  assert.match(mid.replace(ANSI, ""), /water now.*stand 28m.*eyes now/, mid);
  const narrow = render({ segments: [[97, 0]], cols: 60 });
  assert.doesNotMatch(narrow, /water|stand|eyes|no break/, narrow);
});

const heavyStdin = {
  model: { display_name: "Fable 5.1" },
  context_window: { used_percentage: 88 },
  rate_limits: {
    five_hour: { used_percentage: 80, resets_at: Math.round((Date.now() + 120 * 60000) / 1000) },
    seven_day: { used_percentage: 65 }
  }
};

check("known width: the row fits, cues drop before the countdown and no break", [], () => {
  const lean = render({ segments: [[97, 0]], cols: 120, raw: true });
  assert.ok(visible(lean) <= 120, `${visible(lean)} > 120: ${lean}`);
  // head order: countdown, no break, then the cues in CUES order
  assert.match(lean.replace(ANSI, ""), /rest 1h23 .*no break 1h37.*water now.*stand 28m.*eyes now/, lean);

  // medium payload: the bars and the model name go, every cue stays
  const mediumStdin = { model: { display_name: "Fable 5.1" }, context_window: { used_percentage: 40 },
    rate_limits: { five_hour: { used_percentage: 46, resets_at: Math.round((Date.now() + 130 * 60000) / 1000) } } };
  const medium = render({ segments: [[97, 0]], stdin: mediumStdin, cols: 120, raw: true });
  const mid = medium.replace(ANSI, "");
  assert.ok(visible(medium) <= 120, `${visible(medium)} > 120: ${mid}`);
  assert.doesNotMatch(mid, /[▓░]|Fable 5\.1/, mid);      // cosmetic parts went first
  assert.match(mid, /water now.*eyes now/, mid);          // due cues stay (stand/daylight depend on the hour)

  // heavy payload: bars and model go, then the cue furthest from due; due cues stay
  const heavy = render({ segments: [[97, 0]], stdin: heavyStdin, cols: 120, raw: true });
  const text = heavy.replace(ANSI, "");
  assert.ok(visible(heavy) <= 120, `${visible(heavy)} > 120: ${text}`);
  assert.match(text, /\brest 1h23\b/, text);
  assert.match(text, /no break 1h37/, text);
  assert.doesNotMatch(text, /Fable 5\.1|\bstand\b/, text);
  assert.match(text, /water now.*eyes now/, text);
});

check("known width: the row fits at every width, every band, sessions and billing modes included", [], () => {
  // never skips: the busy home takes a forward anchor when the clock allows one, a
  // past anchor otherwise (filtered out, so the label is `rest`), or none at all
  const forward = inMinutes(25), anchor = forward ?? inMinutes(-25);
  const busyLabel = forward ? /meeting 2[45]m/ : /rest \d/;
  const resets_at = Math.round((Date.now() + 120 * 60000) / 1000);
  const payloads = {
    subscription: { model: { display_name: "Claude Opus 4.5" }, context_window: { used_percentage: 88 },
      rate_limits: { five_hour: { used_percentage: 80, resets_at }, seven_day: { used_percentage: 65 }, spend_limit: { used_percentage: 75 } } },
    api: { model: { display_name: "Claude Opus 4.5" }, context_window: { used_percentage: 88 }, cost: { total_cost_usd: 12.34 } },
    extra: { model: { display_name: "Claude Opus 4.5" }, context_window: { used_percentage: 88 },
      rate_limits: { five_hour: { used_percentage: 100, resets_at }, seven_day: { used_percentage: 65 } } }
  };
  const homes = { plain: { segments: [[97, 0]] }, busy: { segments: [[97, 0]], plan: { anchors: anchor ? [anchor] : [] }, liveSessions: 3 } };
  const h = new Date().getHours();
  // a note, not a skip: the grid runs in full, its wide rows are just one cue shorter outside the daylight window
  if (h < 10 || h >= 16) console.log(`    (width grid: now is ${h}:xx, daylight not pending, wide rows one cue shorter than at midday)`);
  const SIGNALS = ["water", "stand", "eyes", "daylight", "no break", "out ~", "resets", "sessions", "week", "spend", "→", "▓", "Claude Opus 4.5", "~$"];
  const cueWords = text => new Set(SIGNALS.filter(s => text.includes(s)));
  for (const [hName, home] of Object.entries(homes)) {
    for (const [pName, stdin] of Object.entries(payloads)) {
      let shownBefore = new Set();
      // every column across the narrow boundary for the busiest row, a sample elsewhere
      const widths = hName === "busy" && pName === "api"
        ? Array.from({ length: 80 }, (_, i) => 51 + i)
        : [60, 70, 74, 75, 76, 80, 90, 100, 104, 108, 110, 112, 116, 120, 140];
      for (const cols of widths) {
        const out = render({ ...home, stdin, cols, raw: true });
        const text = out.replace(ANSI, "");
        const where = `${hName}/${pName}@${cols}: ${text}`;
        assert.ok(visible(out) <= cols, `${visible(out)} > ${cols} — ${where}`);
        // monotonic: a wider terminal never shows fewer signals than a narrower one
        const shown = cueWords(text);
        for (const w of shownBefore) assert.ok(shown.has(w), `"${w}" shown at a narrower width but not here — ${where}`);
        shownBefore = shown;
        // what never goes: the countdown and the account word
        assert.match(text, hName === "plain" ? /rest 1h23/ : busyLabel, where);
        assert.match(text, pName === "subscription" ? /usage 80%/ : pName === "api" ? /api billing/ : /extra usage/, where);
        if (cols < 75) {
          // narrow band contract: the bare countdown and the bare account state, nothing else
          assert.doesNotMatch(text, /out ~|resets|context|no break|water|stand|eyes|daylight|sessions|→/, where);
        } else {
          assert.match(text, /context 88%/, where);
        }
      }
    }
  }
});

check("unknown width (unset, non-numeric, zero, negative): nothing is trimmed to a guessed 120", [], () => {
  for (const cols of [null, "abc", "0", "-5"]) {
    const out = render({ segments: [[97, 0]], stdin: heavyStdin, cols });
    assert.ok(visible(out) > 120, `COLUMNS=${cols}: ${out}`);
    assert.match(out, /\bstand 28m\b/, `COLUMNS=${cols}: ${out}`);
    assert.match(out, /▓/, `COLUMNS=${cols}: ${out}`);
  }
});

// --- account side ---------------------------------------------------------------

check("context colour: grey to 69, amber from 70, red from 85", [], () => {
  const ctx = pct => render({ stdin: { context_window: { used_percentage: pct } }, raw: true });
  assert.match(ctx(90), colored(RED, "context 90%"));
  assert.match(ctx(85), colored(RED, "context 85%"));
  assert.match(ctx(84), colored(AMBER, "context 84%"));
  assert.match(ctx(75), colored(AMBER, "context 75%"));
  assert.match(ctx(70), colored(AMBER, "context 70%"));
  assert.match(ctx(69), colored(GREY, "context 69%"));
  assert.match(ctx(40), colored(GREY, "context 40%"));
  // the host sends floats; context is floored, so 84.9 is still amber and 69.9 still grey
  assert.match(ctx(84.9), colored(AMBER, "context 84%"));
  assert.match(ctx(69.9), colored(GREY, "context 69%"));
});

check("the countdown switches from 'rest' to 'over' the first minute past the declared end", [], () => {
  assert.equal(endMinutesLeft({ plan: { end: "18:00" } }, at("17:59")), 1);
  assert.equal(endMinutesLeft({ plan: { end: "18:00" } }, at("18:00")), 0);
  assert.equal(endMinutesLeft({ plan: { end: "18:00" } }, at("18:01")), -1);
});

check("rest binding against a far anchor, at a fixed clock (no wall-clock skip)", [], () => {
  const plan = { anchors: ["14:00"], lunch: null, end: null };
  assert.deepEqual(nextAnchor({ plan }, at("10:00")), { at: "14:00", kind: "meeting", in: 240 });
  const tenAm = at("10:00").getTime();
  const rested = { segments: [[tenAm - 30 * 60000, tenAm]], plan, cues: {} };
  assert.deepEqual(restTarget(rested, at("10:00")), { in: 150, kind: "rest" });       // ladder binds: 180 - 30
  const tired = { segments: [[tenAm - 170 * 60000, tenAm]], plan, cues: {} };
  assert.deepEqual(restTarget(tired, at("10:00")), { in: 10, kind: "rest" });         // 10m of ladder left still beats a 4h anchor
  const soon = { segments: [[tenAm - 30 * 60000, tenAm]], plan: { anchors: ["10:05"], lunch: null, end: null }, cues: {} };
  assert.deepEqual(restTarget(soon, at("10:00")), { at: "10:05", kind: "meeting", in: 5 }); // the anchor binds
});

check("usageRunsOut: 80% with 2h left -> 45m; slow pace, early window, no reset -> null", [], () => {
  assert.equal(usageRunsOut(80, 120), 45);        // (100-80) * 180 / 80
  assert.equal(usageRunsOut(20, 120), null);      // 720m to full, only 120m left: it resets first
  assert.equal(usageRunsOut(40, 30), null);       // 405m to full, only 30m left: it resets first
  assert.equal(usageRunsOut(80, 285), null);      // 15m elapsed: too early to call a pace
  assert.equal(usageRunsOut(80, null), null);
  assert.equal(usageRunsOut(100, 120), null);     // already out: billingMode says so, not a projection
  assert.equal(usageRunsOut(80, 270), 8);         // exactly 30 elapsed counts as a pace: (100-80)*30/80 = 7.5
  assert.equal(usageRunsOut(80, 271), null);      // 29 elapsed: not yet
  assert.equal(usageRunsOut(29, 270), 73);        // no percentage floor: a fast early burn projects
  assert.equal(usageRunsOut(50, 150), null);      // the tie: full exactly at the reset -> it resets first
  assert.equal(usageRunsOut(51, 150), 144);       // one point faster and it runs out
});

check("usage 80% with 2h left: 'out ~' names the projected time, amber", [], () => {
  const resets_at = Math.round((Date.now() + 120 * 60000) / 1000);
  const out = render({ stdin: { rate_limits: { five_hour: { used_percentage: 80, resets_at } } }, raw: true });
  const expected = [44, 45, 46].map(m => hhmm(new Date(Date.now() + m * 60000)));
  const shown = /out ~(\d\d:\d\d)/.exec(out.replace(ANSI, ""))?.[1];
  assert.ok(expected.includes(shown), `out ~${shown} not in ${expected}: ${out}`);
  assert.match(out, colored(AMBER, "out ~"), out);
});

check("usage 40% with 30m left: no projection", [], () => {
  const resets_at = Math.round((Date.now() + 30 * 60000) / 1000);
  const out = render({ stdin: { rate_limits: { five_hour: { used_percentage: 40, resets_at } } } });
  assert.doesNotMatch(out, /out ~/, out);
});

// --- mark.mjs: the commands Claude runs for the user ----------------------------

check("mark.mjs plan: lunch/end record clock times only; anchors merge, anchors-set replaces", [], () => {
  assert.equal(mark({}, "lunch", "13:00").presence.plan.lunch, "13:00");
  assert.equal(mark({}, "lunch", "noon").presence.plan.lunch, null);
  assert.equal(mark({}, "end", "18:30").presence.plan.end, "18:30");
  const merged = mark({ plan: { anchors: ["11:00"] } }, "anchors", "15:30,09:00,11:00");
  assert.deepEqual(merged.presence.plan.anchors, ["09:00", "11:00", "15:30"]);
  assert.equal(merged.out.trim(), "anchors: 09:00 11:00 15:30");
  const replaced = mark({ plan: { anchors: ["11:00"] } }, "anchors-set", "16:00");
  assert.deepEqual(replaced.presence.plan.anchors, ["16:00"]);
  assert.equal(replaced.out.trim(), "anchors: 16:00");
});

check("mark.mjs recur: set writes the rule and seeds today, list shows it, clear removes it", [], () => {
  const r = markSeq({}, [["recur", "set", "*", "end", "18:30"], ["recur", "set", "sun-thu", "anchors", "12:00"], ["recur", "list"], ["recur", "clear", "sun-thu"], ["recur", "clear"]]);
  assert.equal(r.outs[0].trim(), "recur * end: 18:30");
  assert.equal(r.outs[1].trim(), "recur sun,mon,tue,wed,thu anchors: 12:00");
  const listed = JSON.parse(r.outs[2]);
  assert.deepEqual(listed["*"], { end: "18:30" });
  assert.deepEqual(listed.mon, { anchors: ["12:00"] });
  assert.equal(r.presence.plan.end, "18:30");           // applied to today
  assert.deepEqual(r.recurring, {});                    // cleared at the end
  assert.equal(r.outs[4].trim(), "cleared all");
  assert.throws(() => mark({}, "recur", "set", "someday", "end", "18:30"), e => /usage: recur set/.test(e.stdout || ""));
  assert.throws(() => mark({}, "recur", "clear", "someday"), e => /bad days: someday/.test(e.stdout || ""));
});

check("mark.mjs offer/snooze/skip/ack/sessionend touch exactly what they say", [], () => {
  const before = Date.now();
  const r = markSeq({}, [["offer"], ["snooze", "45"], ["snooze", "nope"], ["skip"], ["ack", "abc123"], ["sessionend"]]);
  assert.ok(r.presence.lastOffer >= before, "offer records lastOffer");
  assert.ok(r.presence.snoozeUntil >= before + 59 * 60000, "a bad snooze value falls back to 60m (the last snooze wins)");
  assert.equal(r.presence.askedPlan, true);
  assert.ok(r.files.includes("abc123.ack"), r.files.join(","));
  assert.deepEqual(r.outs.map(o => o.trim()), ["offer recorded", "snoozed 45m", "snoozed 60m", "plan skipped for today", "acknowledged", "session dropped"]);
});

check("a lock left behind by a crash is broken, not waited on forever", [], () => {
  // withLock() breaks a lock older than 2s. The age must come from the lock's own
  // mtime: `now - now` (the old bug) is always 0, so a stale .lock survived every
  // later call and each one fell through to an UNLOCKED write.
  const { home, dir, env } = fakeHome({ workedMin: 30 });
  try {
    const lock = join(dir, ".lock");
    mkdirSync(lock);
    const old = new Date(Date.now() - 60000);
    utimesSync(lock, old, old);
    execFileSync(process.execPath, [MARK, "did", "water"], { env, encoding: "utf8" });
    assert.equal(existsSync(lock), false, "the stale lock is still there, so it was never broken");
    assert.equal(JSON.parse(readFileSync(join(dir, "presence.json"), "utf8")).cues.water, 30);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

check("mark.mjs with no command prints usage", [], () => {
  const usage = mark({}).out;
  assert.match(usage, /^usage: mark\.mjs ack <id>/);
  assert.match(usage, /\| did <water\|stand\|eyes\|daylight> \|/); // the new command is discoverable
});

check("trim order: cues go before 'no break' when both cannot fit", [], () => {
  // 80 columns, one live 97m segment, usage + context on the right: the ladder
  // reaches the due cues and stops before the stretch
  const stdin = { context_window: { used_percentage: 88 }, rate_limits: { five_hour: { used_percentage: 80, resets_at: Math.round((Date.now() + 120 * 60000) / 1000) } } };
  const out = render({ segments: [[97, 0]], stdin, cols: 80 });
  assert.ok(visible(out) <= 80, out);
  assert.match(out, /no break 1h37/, out);
  assert.doesNotMatch(out, /water|stand|eyes|daylight/, out);
  // and the adjacent rung: due cues go before the usage projection
  const mid = render({ segments: [[97, 0]], stdin, cols: 88 });
  assert.ok(visible(mid) <= 88, mid);
  assert.match(mid, /out ~\d\d:\d\d/, mid);
  assert.doesNotMatch(mid, /water|stand|eyes|daylight/, mid);
  // among cues not yet due, the one furthest from due goes first: at 30 attended
  // (water 15m, stand 30m, eyes 15m) stand must be the first to go
  // daylight is acked in these two fixtures so the budget holds only interval cues at any hour
  const two = render({ workedMin: 30, cues: { daylight: true }, stdin, cols: 86 });
  assert.ok(visible(two) <= 86, two);
  assert.match(two, /eyes 15m/, two);
  assert.doesNotMatch(two, /stand 30m/, two);
  // and the width where exactly one of them goes: the furthest (stand 30m), never the nearer two
  const one = render({ workedMin: 30, cues: { daylight: true }, stdin, cols: 94 });
  assert.ok(visible(one) <= 94, one);
  assert.match(one, /water 15m/, one);
  assert.match(one, /eyes 15m/, one);
  assert.doesNotMatch(one, /stand 30m/, one);
});

check("over renders in the first minute past the end", [-1], t => {
  const out = render({ plan: { end: t }, raw: true });
  assert.match(out, colored(RED, "over [12]m"), out);
  assert.doesNotMatch(out.replace(ANSI, ""), /\brest\b/, out);
});

// silence is not confirmation: every skip must be a wall-clock skip, and only
// the checks that carry a plan-time offset (plus the one daylight render) may
// ever skip — the budget is counted, not tuned
assert.equal(skipped - clockSkipped, 0, `${skipped - clockSkipped} check(s) skipped for a reason other than the clock`);
// The ceiling is every check that CAN skip: the offset-bearing ones plus the single
// daylight render. Counted, not observed — a budget set to the worst window seen so
// far turns red the day someone adds one more plan-time check.
assert.ok(ran >= defined - (SKIPPABLE + 1), `only ${ran} of ${defined} checks ran (${skipped} skipped, ${SKIPPABLE + 1} may)`);
console.log(`\n${ran} passed${skipped ? `, ${skipped} skipped` : ""}`);
