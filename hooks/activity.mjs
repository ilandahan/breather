#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { beat, readPresence, updatePresence, zoneOf, pipelineActive } from "./presence.mjs";
import { notify } from "./notify.mjs";

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch {}
const id = input.session_id || "unknown";
const cwd = input.cwd || process.cwd();

beat(id, "work", cwd);

if (process.env.CLAUDE_SUBAGENT || input.agent) process.exit(0);

const now = new Date();
const h = now.getHours() + now.getMinutes() / 60;
const p = readPresence();

let win = null;
if (h >= 12.5 && h <= 14.5) win = "lunch";
else if (h >= 18.5 && h < 23) win = "evening";
if (!win || p.windows[win]) process.exit(0);

const zone = zoneOf(p);
const running = pipelineActive(cwd);
if (zone === "quiet" && !running) process.exit(0);

const msg = win === "lunch"
  ? "Claude is working. Good moment to eat."
  : "Still going, and it is getting late. Good moment to stop.";

updatePresence(s => { s.windows[win] = Date.now(); return s; });
notify("Claude", msg);
