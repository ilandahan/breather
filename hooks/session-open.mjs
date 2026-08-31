#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT, readPresence, beat, attendedMinutes, fmtDuration, maybeNotifyPlan } from "./presence.mjs";

const SKILL = join(homedir(), ".claude", "skills", "breather", "SKILL.md");

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch {}
const id = input.session_id || "unknown";
const cwd = input.cwd || process.cwd();

mkdirSync(ROOT, { recursive: true });
writeFileSync(join(ROOT, "current"), id);
beat(id, "work", cwd);

const out = [];
out.push("# breather is active");
out.push("");
out.push("Read this now, before any other skill or rule. It governs how this session ends.");
out.push("");
out.push(existsSync(SKILL) ? readFileSync(SKILL, "utf8") : `Skill file missing at ${SKILL} — tell the user once, then continue normally.`);
out.push("");
out.push(`Acknowledge before your first file edit: node ~/.claude/hooks/breather/mark.mjs ack ${id}`);

const p = readPresence();
const mins = attendedMinutes(p);
if (mins > 0) out.push(`Attended time already accumulated today across all sessions: ${fmtDuration(mins)}.`);

if (!p.askedPlan && !["compact", "fork"].includes(input.source)) {
  const seeded = p.recurringSeeded && (p.plan.anchors.length || p.plan.lunch || p.plan.end);
  maybeNotifyPlan();
  out.push("");
  const planReadback = [
    p.plan.anchors.length ? `anchors ${p.plan.anchors.join(", ")}` : null,
    p.plan.lunch ? `lunch ${p.plan.lunch}` : null,
    p.plan.end ? `end ${p.plan.end}` : null
  ].filter(Boolean).join(" · ");
  out.push([
    "FIRST SESSION OF THE DAY — set the day's anchors.",
    "",
    seeded
      ? `A recurring plan is already loaded for today: ${planReadback}. Open your FIRST reply by reading it back in one line and asking only what's DIFFERENT today — extra meetings, a changed lunch or finish time. Do not re-ask what the recurring plan already answers.`
      : "Open your FIRST reply with the day setup, before answering their request: one short block — \"Before we start —\" — asking three things together:\n  1. Any fixed points today that are anchors anyway (meetings, calls, a school run)?\n  2. What time do they want to break for lunch?\n  3. What time do they want to finish?",
    "",
    "CALENDAR (auto): if any calendar connector is available in this session (Google Calendar / Gmail, Microsoft 365 / Outlook), fetch TODAY'S events before answering, record each meeting's start time with `node ~/.claude/hooks/breather/mark.mjs anchors HH:MM,HH:MM` (it merges), and tell the user in one line what you recorded. If no connector is available or it is unauthenticated, say so once and move on — never retry, never block the reply on it.",
    "",
    "Then answer their request in the same reply. If their first message already volunteers any of these times, record them and don't ask for what you already have.",
    "",
    "Keep it to three lines. It is an offer to set the day up, not an interrogation — answering none of it is fine.",
    "",
    "Record whatever they give, one command per answer:",
    "  node ~/.claude/hooks/breather/mark.mjs anchors 11:00,15:30   (merges into the day's list)",
    "  node ~/.claude/hooks/breather/mark.mjs anchors-set 11:00     (replaces the whole list)",
    "  node ~/.claude/hooks/breather/mark.mjs lunch 13:00",
    "  node ~/.claude/hooks/breather/mark.mjs end 18:30",
    "",
    "If they describe a REPEATING pattern (\"every day…\", \"on Sundays…\"), record it as recurring instead — it will seed every matching day automatically:",
    "  node ~/.claude/hooks/breather/mark.mjs recur set sun-thu anchors 12:00",
    "  node ~/.claude/hooks/breather/mark.mjs recur set * end 18:30",
    "",
    "If they decline, answer partially, or ignore it: node ~/.claude/hooks/breather/mark.mjs skip — then never raise it again today. A partial answer is a complete answer; do not chase the rest."
  ].join("\n"));
}

const hdir = join(cwd, ".aid", "handoff");
if (existsSync(hdir)) {
  try {
    const files = readdirSync(hdir).filter(f => f.endsWith(".md")).sort();
    const consumedPath = join(ROOT, "consumed");
    const consumed = existsSync(consumedPath) ? readFileSync(consumedPath, "utf8").split("\n") : [];
    const last = files[files.length - 1];
    if (last && !consumed.includes(last)) {
      out.push("");
      out.push(`Unclosed handoff from a previous session: ${join(hdir, last)} — read it and open with its next step in one sentence. Do not replay the whole document.`);
    }
  } catch {}
}

process.stdout.write(out.join("\n"));
