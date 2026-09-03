#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, updatePresence, dropSession, readRecurring, writeRecurring, recurringFor, DAY_NAMES, CUES, attendedMinutes } from "./presence.mjs";

const [action, arg, arg2, arg3] = process.argv.slice(2);
const current = existsSync(join(ROOT, "current")) ? readFileSync(join(ROOT, "current"), "utf8").trim() : null;
const isClock = v => /^\d{1,2}:\d{2}$/.test(v || "");
const clockList = v => (v || "").split(",").map(x => x.trim()).filter(isClock);

// "*" | "sun,tue" | "sun-thu" -> ["sun","tue"] / ["sun","mon","tue","wed","thu"]
function parseDays(spec) {
  if (spec === "*") return ["*"];
  const range = /^([a-z]{3})-([a-z]{3})$/.exec(spec || "");
  if (range) {
    const a = DAY_NAMES.indexOf(range[1]), b = DAY_NAMES.indexOf(range[2]);
    if (a === -1 || b === -1) return null;
    const out = [];
    for (let i = a; ; i = (i + 1) % 7) { out.push(DAY_NAMES[i]); if (i === b) break; }
    return out;
  }
  const days = (spec || "").split(",").map(x => x.trim());
  return days.length && days.every(d => DAY_NAMES.includes(d)) ? days : null;
}

switch (action) {
  case "ack": {
    // the id becomes a filename, so it is an allowlist, not a sanitize: a session
    // id is [\w-] and nothing else, and `ack ../../../x` must not write outside ROOT
    const id = arg || current;
    if (!/^[\w-]+$/.test(id || "")) {
      console.log("usage: ack <session-id>   (letters, digits, _ and - only)");
      process.exit(1);
    }
    writeFileSync(join(ROOT, `${id}.ack`), String(Date.now()));
    console.log("acknowledged");
    break;
  }

  case "lunch":
    updatePresence(s => { s.askedPlan = true; s.plan.lunch = isClock(arg) ? arg : null; return s; });
    console.log(`lunch: ${isClock(arg) ? arg : "none"}`);
    break;

  case "end":
    updatePresence(s => { s.askedPlan = true; s.plan.end = isClock(arg) ? arg : null; return s; });
    console.log(`end: ${isClock(arg) ? arg : "none"}`);
    break;

  case "anchors": {
    // merges — a recurring seed or an earlier recording must survive a new one
    const list = clockList(arg);
    const out = updatePresence(s => {
      s.askedPlan = true;
      s.plan.anchors = [...new Set([...(s.plan.anchors || []), ...list])].sort();
      return s;
    });
    console.log(`anchors: ${out.plan.anchors.join(" ") || "none"}`);
    break;
  }

  case "anchors-set": {
    const list = clockList(arg);
    updatePresence(s => { s.askedPlan = true; s.plan.anchors = list; return s; });
    console.log(`anchors: ${list.join(" ") || "none"}`);
    break;
  }

  case "recur": {
    const sub = arg;
    if (sub === "list") {
      console.log(JSON.stringify(readRecurring(), null, 2));
      break;
    }
    if (sub === "clear") {
      const days = arg2 ? parseDays(arg2) : null;
      if (arg2 && !days) { console.log(`bad days: ${arg2}`); process.exit(1); }
      const r = readRecurring();
      if (days) for (const d of days) delete r[d];
      writeRecurring(days ? r : {});
      console.log(days ? `cleared: ${days.join(" ")}` : "cleared all");
      break;
    }
    if (sub === "set") {
      const days = parseDays(arg2);
      const [field, value] = [arg3, process.argv[6]];
      if (!days || !["anchors", "lunch", "end"].includes(field)) {
        console.log("usage: recur set <*|sun-thu|sun,mon> <anchors|lunch|end> <HH:MM[,HH:MM]|none>");
        process.exit(1);
      }
      const r = readRecurring();
      for (const d of days) {
        r[d] = r[d] || {};
        if (field === "anchors") r[d].anchors = value === "none" ? [] : clockList(value);
        else r[d][field] = value === "none" ? null : (isClock(value) ? value : null);
      }
      writeRecurring(r);
      // apply to today too, if today matches: merge anchors, fill lunch/end only if unset
      const today = recurringFor();
      updatePresence(s => {
        s.plan.anchors = [...new Set([...(s.plan.anchors || []), ...today.anchors])].sort();
        if (!s.plan.lunch && today.lunch) s.plan.lunch = today.lunch;
        if (!s.plan.end && today.end) s.plan.end = today.end;
        return s;
      });
      console.log(`recur ${days.join(",")} ${field}: ${value}`);
      break;
    }
    console.log("usage: recur set <days> <field> <value> | recur list | recur clear [days]");
    break;
  }

  case "did": {
    // the user acked a body cue: restart its countdown from now (daylight is once a day)
    // hasOwn, not `in`: "__proto__" or "toString" must not pass as a cue name
    if (!Object.hasOwn(CUES, arg || "") && arg !== "daylight") {
      console.log(`usage: did <${[...Object.keys(CUES), "daylight"].join("|")}>`);
      process.exit(1);
    }
    updatePresence(s => {
      s.cues = { ...s.cues, [arg]: arg === "daylight" ? true : attendedMinutes(s) };
      return s;
    });
    console.log(`did: ${arg}`);
    break;
  }

  case "skip":
    updatePresence(s => { s.askedPlan = true; return s; });
    console.log("plan skipped for today");
    break;

  case "offer":
    updatePresence(s => { s.lastOffer = Date.now(); return s; });
    console.log("offer recorded");
    break;

  case "snooze": {
    const mins = Number(arg) > 0 ? Number(arg) : 60;
    updatePresence(s => { s.snoozeUntil = Date.now() + mins * 60000; return s; });
    console.log(`snoozed ${mins}m`);
    break;
  }

  case "resumed": {
    const dir = join(process.cwd(), ".aid", "handoff");
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter(f => f.endsWith(".md")).sort();
      if (files.length) appendFileSync(join(ROOT, "consumed"), files[files.length - 1] + "\n");
    }
    console.log("handoff consumed");
    break;
  }

  case "sessionend":
    if (current) dropSession(current);
    console.log("session dropped");
    break;

  default:
    console.log("usage: mark.mjs ack <id> | lunch HH:MM | end HH:MM | anchors HH:MM,HH:MM (merges) | anchors-set HH:MM,HH:MM (replaces) | recur set <days> <field> <value> | recur list | recur clear [days] | did <water|stand|eyes|daylight> | skip | offer | snooze <min> | resumed | sessionend");
}
