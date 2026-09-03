#!/usr/bin/env node
// Line coverage of hooks/*.mjs from the real test suite, with no dependency:
// runs `npm test` under NODE_V8_COVERAGE (Node writes raw V8 block coverage for
// the test process AND every hook it spawns), then folds the byte ranges into
// per-line hits. A line counts as covered when any of its bytes ran in any
// process. Hooks the suite never loads appear at 0%, not missing.
//
//   node scripts/coverage.mjs                 # every hook
//   node scripts/coverage.mjs --min 80 a.mjs  # exit 1 if the named files' total is below 80%
//
// Block coverage is coarser than statement coverage: a line that is partly
// executed counts as covered. Good enough to see what the suite never touches.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS = join(ROOT, "hooks");

const args = process.argv.slice(2);
const minAt = args.indexOf("--min");
const min = minAt >= 0 ? Number(args.splice(minAt, 2)[1]) : null;
const only = new Set(args.map(a => basename(a)));

const covDir = mkdtempSync(join(tmpdir(), "breather-cov-"));
try {
  execFileSync("npm", ["test"], { cwd: ROOT, env: { ...process.env, NODE_V8_COVERAGE: covDir }, stdio: "ignore", shell: process.platform === "win32" });
} catch {
  console.error("coverage: npm test failed — coverage of a red suite is not a number worth reading");
  rmSync(covDir, { recursive: true, force: true });
  process.exit(2);
}

// abs path -> Uint8Array of covered bytes
const seen = {};
for (const f of readdirSync(covDir)) {
  const report = JSON.parse(readFileSync(join(covDir, f), "utf8"));
  for (const script of report.result) {
    if (!script.url.startsWith("file:")) continue;
    const p = fileURLToPath(script.url);
    if (resolve(dirname(p)) !== HOOKS || !p.endsWith(".mjs")) continue;
    const size = Buffer.byteLength(readFileSync(p, "utf8"));
    seen[p] ||= new Uint8Array(size);
    const local = new Uint8Array(size);
    for (const fn of script.functions) {
      for (const r of fn.ranges) { // ranges arrive outer-first; inner ones override
        const v = r.count > 0 ? 1 : 0;
        for (let i = r.startOffset; i < Math.min(r.endOffset, size); i++) local[i] = v;
      }
    }
    for (let i = 0; i < size; i++) if (local[i]) seen[p][i] = 1;
  }
}
rmSync(covDir, { recursive: true, force: true });

const isCode = line => {
  const t = line.trim();
  return t && !t.startsWith("//") && !/^[{}()[\];,]*$/.test(t) && !t.startsWith("import ") && !t.startsWith("export {");
};

const rows = [];
for (const name of readdirSync(HOOKS).filter(f => f.endsWith(".mjs")).sort()) {
  if (only.size && !only.has(name)) continue;
  const p = join(HOOKS, name);
  const source = readFileSync(p, "utf8");
  const hits = seen[p] || new Uint8Array(Buffer.byteLength(source));
  let offset = 0, lines = 0, covered = 0;
  for (const line of source.split("\n")) {
    const bytes = Buffer.byteLength(line, "utf8");
    if (isCode(line)) {
      lines++;
      for (let i = offset; i < offset + bytes; i++) if (hits[i]) { covered++; break; }
    }
    offset += bytes + 1;
  }
  rows.push({ name, covered, lines });
}

const total = rows.reduce((a, r) => ({ covered: a.covered + r.covered, lines: a.lines + r.lines }), { covered: 0, lines: 0 });
const pct = r => (100 * r.covered / Math.max(1, r.lines)).toFixed(1);
for (const r of rows) console.log(`${r.name.padEnd(18)} ${String(r.covered).padStart(4)}/${String(r.lines).padEnd(4)} ${pct(r).padStart(5)}%`);
console.log(`${"TOTAL".padEnd(18)} ${String(total.covered).padStart(4)}/${String(total.lines).padEnd(4)} ${pct(total).padStart(5)}%`);
if (min !== null && Number(pct(total)) < min) {
  console.error(`coverage ${pct(total)}% is below the ${min}% minimum`);
  process.exit(1);
}
