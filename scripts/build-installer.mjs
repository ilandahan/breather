#!/usr/bin/env node
// Regenerates the PAYLOAD constant in install.mjs from the real source tree.
//
// The installer is a single self-contained file so that the one-liner stays a
// one-liner, but the source it carries lives in the repo as readable files —
// skills/breather/ and hooks/ — and this script is the only thing that couples
// the two. Run it after editing anything under those directories.
//
// ponytail: the installer body is edited in place rather than assembled from a
// separate template. One file to read, one constant to swap.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = join(ROOT, "install.mjs");

// Payload keys are the installer's own address space: "skills/..." lands in
// ~/.claude/skills/breather/, "hooks/..." in ~/.claude/hooks/breather/. The
// repo nests the skill one level deeper (skills/breather/) so that Claude Code
// can load this repo directly as a plugin, so that prefix is stripped here.
const SOURCES = [
  { dir: "skills/breather", keyPrefix: "skills" },
  { dir: "hooks", keyPrefix: "hooks", skip: f => f === "hooks.json" },
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

export function buildPayload() {
  const files = {};
  for (const { dir, keyPrefix, skip } of SOURCES) {
    const base = join(ROOT, dir);
    for (const full of walk(base)) {
      const rel = relative(base, full).split("\\").join("/");
      if (skip?.(rel)) continue;
      files[`${keyPrefix}/${rel}`] = readFileSync(full, "utf8");
    }
  }
  // Stable key order keeps the base64 blob diffable across builds.
  const ordered = {};
  for (const k of Object.keys(files).sort()) ordered[k] = files[k];
  return ordered;
}

export function render(installerText, payload) {
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const line = /^const PAYLOAD = "[A-Za-z0-9+/=]*";$/m;
  if (!line.test(installerText)) {
    throw new Error("install.mjs has no `const PAYLOAD = \"...\";` line to replace");
  }
  return installerText.replace(line, `const PAYLOAD = "${b64}";`);
}

function main() {
  const payload = buildPayload();
  const before = readFileSync(INSTALLER, "utf8");
  const after = render(before, payload);

  // Round-trip: what the installer will decode must equal what was read off disk.
  const decoded = JSON.parse(
    Buffer.from(after.match(/const PAYLOAD = "([A-Za-z0-9+/=]*)";/)[1], "base64").toString("utf8"),
  );
  for (const [k, v] of Object.entries(payload)) {
    if (decoded[k] !== v) throw new Error(`round-trip mismatch on ${k}`);
  }
  if (Object.keys(decoded).length !== Object.keys(payload).length) {
    throw new Error("round-trip dropped or added files");
  }

  if (after === before) {
    console.log(`install.mjs already current (${Object.keys(payload).length} files embedded)`);
    return;
  }
  writeFileSync(INSTALLER, after);
  console.log(`install.mjs rebuilt — ${Object.keys(payload).length} files embedded`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
