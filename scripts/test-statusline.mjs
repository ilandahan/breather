#!/usr/bin/env node
// Behavior check for the status line's left segment: the countdown is labeled
// by what binds it (rest / meeting / lunch / end of day) and the arrow names
// the next planned point. Runs the real statusline.mjs against an injected
// home (HOME and USERPROFILE both point at a temp dir), never the real ~/.claude.
//
// Run: node scripts/test-statusline.mjs   (also part of npm test)

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const STATUSLINE = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "statusline.mjs");

const hhmm = d => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
// A clock time `m` minutes from now, or null if that would cross midnight
// (anchors are same-day clock times; a wrapped one is "in the past").
const inMinutes = m => {
  const d = new Date(Date.now() + m * 60000);
  return d.getDate() === new Date().getDate() ? hhmm(d) : null;
};

function render(plan, workedMin = 30) {
  const home = mkdtempSync(join(tmpdir(), "breather-sl-"));
  try {
    const dir = join(home, ".claude", "state", "breather");
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const d = new Date(now);
    if (d.getHours() < 4) d.setDate(d.getDate() - 1);
    writeFileSync(join(dir, "presence.json"), JSON.stringify({
      day: d.toISOString().slice(0, 10),
      segments: [[now - workedMin * 60000, now]],
      plan: { lunch: null, end: null, anchors: [], ...plan },
      askedPlan: true, lastOffer: 0, snoozeUntil: 0, windows: {}
    }));
    const out = execFileSync(process.execPath, [STATUSLINE], {
      env: { ...process.env, HOME: home, USERPROFILE: home, COLUMNS: "120" },
      input: "{}", encoding: "utf8"
    });
    return out.replace(/\x1b\[\d+m/g, "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

let ran = 0, skipped = 0;
function check(name, offsets, fn) {
  const times = offsets.map(inMinutes);
  if (times.some(t => t === null)) { skipped++; console.log(`  - ${name} (skipped: would cross midnight)`); return; }
  fn(...times); ran++; console.log(`  ✓ ${name}`);
}

console.log("statusline behavior");

check("meeting binding: label says meeting, arrow names it too", [25], at => {
  const out = render({ anchors: [at] });
  assert.match(out, /\bmeeting 2[45]m\b/, out);
  assert.match(out, new RegExp(`→ meeting ${at}`), out);
});

check("lunch binding: label says lunch", [25], at => {
  assert.match(render({ lunch: at }), /\blunch 2[45]m\b/);
});

check("end binding: label says end of day", [25], at => {
  assert.match(render({ end: at }), /\bend of day 2[45]m\b/);
});

check("rest binding: label stays rest, arrow names the next anchor", [240], at => {
  const out = render({ anchors: [at] });
  assert.match(out, /\brest \d/, out);
  assert.match(out, new RegExp(`→ meeting ${at}`), out);
});

check("rest binding with lunch next: arrow says lunch", [240], at => {
  assert.match(render({ lunch: at }), new RegExp(`→ lunch ${at}`));
});

check("no plan: rest, no arrow", [], () => {
  const out = render({});
  assert.match(out, /\brest \d/, out);
  assert.doesNotMatch(out, /→/, out);
});

console.log(`\n${ran} passed${skipped ? `, ${skipped} skipped` : ""}`);
