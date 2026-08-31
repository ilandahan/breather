#!/usr/bin/env node
// Behavior check for the installer. Runs the real install.mjs against a
// throwaway CLAUDE_HOME and asserts the promises the README makes:
//
//   1. every source file in the repo lands byte-identical in the install
//   2. the four hook events and the status line are registered
//   3. re-running is idempotent — one entry per event, not two
//   4. unrelated existing hooks and settings survive the merge
//   5. a status line that isn't ours is left alone without --force
//   6. --force replaces it
//   7. --uninstall removes what it added and leaves the rest
//
// The home is injected, never discovered: this test must behave the same on a
// laptop and in CI, so it never reads the real ~/.claude.
//
// Run: npm test

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { buildPayload } from "./build-installer.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = join(ROOT, "install.mjs");

let home;
const run = (...args) =>
  execFileSync(process.execPath, [INSTALLER, ...args], {
    env: { ...process.env, CLAUDE_HOME: home },
    encoding: "utf8",
  });

const settingsPath = () => join(home, ".claude", "settings.json");
const settings = () => JSON.parse(readFileSync(settingsPath(), "utf8"));
const events = ["SessionStart", "UserPromptSubmit", "PostToolBatch", "SessionEnd"];
const ourEntries = (s, event) =>
  (s.hooks?.[event] ?? []).filter(g =>
    (g.hooks ?? []).some(h => String(h.command ?? "").includes("hooks/breather/")),
  );

function fresh() {
  if (home) rmSync(home, { recursive: true, force: true });
  home = mkdtempSync(join(tmpdir(), "breather-test-"));
}

const tests = {
  "installs every repo source file byte-identical"() {
    fresh();
    run();
    const payload = buildPayload();
    for (const [key, expected] of Object.entries(payload)) {
      const dest = key.startsWith("skills/")
        ? join(home, ".claude", "skills", "breather", key.slice("skills/".length))
        : join(home, ".claude", "hooks", "breather", key.slice("hooks/".length));
      assert.ok(existsSync(dest), `${key} was not installed`);
      assert.equal(readFileSync(dest, "utf8"), expected, `${key} differs from repo source`);
    }
  },

  "registers all four hook events and the status line"() {
    fresh();
    run();
    const s = settings();
    for (const event of events) {
      assert.equal(ourEntries(s, event).length, 1, `${event} should have exactly one breather group`);
    }
    assert.match(String(s.statusLine?.command ?? ""), /statusline\.mjs/);
  },

  "re-running is idempotent"() {
    fresh();
    run();
    run();
    run();
    const s = settings();
    for (const event of events) {
      assert.equal(
        ourEntries(s, event).length,
        1,
        `${event} gained a duplicate group after three installs`,
      );
    }
  },

  "preserves unrelated hooks and settings"() {
    fresh();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const prior = {
      permissions: { allow: ["Bash(npm run test)"] },
      hooks: {
        PostToolUse: [
          { matcher: "Write|Edit", hooks: [{ type: "command", command: "prettier --write" }] },
        ],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "my-own-hook.sh" }] }],
      },
    };
    writeFileSync(settingsPath(), JSON.stringify(prior, null, 2));
    run();
    const s = settings();
    assert.deepEqual(s.permissions, prior.permissions, "permissions were not preserved");
    assert.deepEqual(s.hooks.PostToolUse, prior.hooks.PostToolUse, "unrelated event was disturbed");
    assert.ok(
      s.hooks.UserPromptSubmit.some(g =>
        (g.hooks ?? []).some(h => h.command === "my-own-hook.sh"),
      ),
      "an existing hook on a shared event was dropped",
    );
    assert.equal(ourEntries(s, "UserPromptSubmit").length, 1);
  },

  "leaves a foreign status line alone, and --force replaces it"() {
    fresh();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const mine = { type: "command", command: "my-statusline.sh" };
    writeFileSync(settingsPath(), JSON.stringify({ statusLine: mine }, null, 2));

    run();
    assert.deepEqual(settings().statusLine, mine, "a foreign status line was overwritten");

    run("--force");
    assert.match(
      String(settings().statusLine?.command ?? ""),
      /statusline\.mjs/,
      "--force did not replace the status line",
    );
  },

  "--dry-run writes nothing"() {
    fresh();
    run("--dry-run");
    assert.ok(
      !existsSync(join(home, ".claude", "hooks", "breather")),
      "--dry-run created hook files",
    );
  },

  "--uninstall removes its own entries and leaves the rest"() {
    fresh();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const prior = {
      hooks: {
        PostToolUse: [{ hooks: [{ type: "command", command: "prettier --write" }] }],
      },
    };
    writeFileSync(settingsPath(), JSON.stringify(prior, null, 2));
    run();
    run("--uninstall");
    const s = settings();
    for (const event of events) {
      assert.equal(ourEntries(s, event).length, 0, `${event} still carries a breather entry`);
    }
    assert.deepEqual(s.hooks.PostToolUse, prior.hooks.PostToolUse, "uninstall ate an unrelated hook");
    assert.ok(
      !existsSync(join(home, ".claude", "hooks", "breather", "presence.mjs")),
      "uninstall left hook files behind",
    );
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}
if (home) rmSync(home, { recursive: true, force: true });

console.log(`\n${Object.keys(tests).length - failed}/${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
