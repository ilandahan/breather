#!/usr/bin/env node
// Asserts the plugin manifests describe files that actually exist, so a plugin
// install cannot fail on a path that was renamed. Resolves what the manifests
// declare rather than pinning their current contents — a shape assertion here
// would go green while the plugin was broken.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = p => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); };

const plugin = read(".claude-plugin/plugin.json");
const market = read(".claude-plugin/marketplace.json");

check(typeof plugin.name === "string" && plugin.name.length > 0, "plugin.json: name is required");
check(typeof market.name === "string" && market.name.length > 0, "marketplace.json: name is required");
check(!!market.owner?.name, "marketplace.json: owner.name is required");
check(Array.isArray(market.plugins) && market.plugins.length > 0, "marketplace.json: plugins must be a non-empty array");

for (const entry of market.plugins ?? []) {
  check(!!entry.name, "marketplace.json: every plugin entry needs a name");
  check(!!entry.source, `marketplace.json: plugin ${entry.name} needs a source`);
  if (typeof entry.source === "string" && entry.source.startsWith(".")) {
    check(existsSync(join(ROOT, entry.source)), `marketplace.json: source ${entry.source} does not exist`);
  }
}

// Every skill directory the plugin declares must hold at least one SKILL.md,
// and each SKILL.md must carry the frontmatter Claude Code reads.
for (const decl of [plugin.skills ?? []].flat()) {
  const dir = join(ROOT, decl);
  check(existsSync(dir), `plugin.json: skills path ${decl} does not exist`);
  if (!existsSync(dir)) continue;
  const skills = readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => join(dir, d.name, "SKILL.md"));
  check(skills.length > 0, `plugin.json: ${decl} contains no skill directories`);
  for (const s of skills) {
    check(existsSync(s), `missing ${s}`);
    if (!existsSync(s)) continue;
    const text = readFileSync(s, "utf8");
    check(text.startsWith("---"), `${s}: no frontmatter block`);
    check(/^name:\s*\S/m.test(text), `${s}: frontmatter has no name`);
    check(/^description:\s*\S/m.test(text), `${s}: frontmatter has no description`);
  }
}

// Every hook command must reference a script that is present in the repo.
if (plugin.hooks) {
  const hooksDecl = plugin.hooks;
  const hooks = typeof hooksDecl === "string" ? read(hooksDecl) : hooksDecl;
  if (typeof hooksDecl === "string") {
    check(existsSync(join(ROOT, hooksDecl)), `plugin.json: hooks file ${hooksDecl} does not exist`);
  }
  let commands = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups) {
      for (const h of group.hooks ?? []) {
        commands++;
        const m = String(h.command ?? "").match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"'\s]+)/);
        check(m, `${event}: command does not reference \${CLAUDE_PLUGIN_ROOT} — it will not resolve on install`);
        if (m) check(existsSync(join(ROOT, m[1])), `${event}: hook script ${m[1]} does not exist`);
      }
    }
  }
  check(commands > 0, "hooks declared but no commands found");
}

if (problems.length) {
  for (const p of problems) console.error(`  FAIL ${p}`);
  console.error(`\n${problems.length} manifest problem(s)`);
  process.exit(1);
}
console.log("  ok   plugin and marketplace manifests resolve to real files");
