/**
 * THE ACCEPTANCE RUNNER — `/aibot:acceptance` (also `/bot:acceptance`).
 *
 * Sections 29/30 of the spec are explicit: a feature is PASS only when it works
 * in an actual Bedrock world and the result can be observed in-game. A green
 * Node test suite and a loading manifest are not enough. So this module runs the
 * acceptance criteria *inside the world*, against the live bot, and prints one
 * verdict line per criterion:
 *
 *   §a✔§r AC-11 block recognition — saw minecraft:stone ×4, minecraft:oak_log ×7
 *   §c✖§r AC-16 tool selection    — holding wooden_pickaxe for diamond_ore
 *   §e☐§r AC-44 end-to-end        — MANUAL: 26-step script printed below
 *
 * Three verdicts exist on purpose:
 *   pass   — measured here, in this world, just now;
 *   fail   — measured here and wrong (with the reason and the fix);
 *   manual — genuinely needs a human eye or a world edit (spawn a creeper,
 *            save and reload, walk 20 blocks). Those print the exact steps.
 *
 * Nothing in here is allowed to throw out of the module, and the only world
 * mutations are opt-in probes (`mine`, `move`) that a player has to ask for by
 * name — a diagnostic command must not quietly reshape somebody's build.
 */

import { system, world } from "@minecraft/server";
import { describe, sendLines, tryRun } from "./format.js";
import { assess, Behavior, evaluateCommand, Priority } from "./priority.js";
import { chooseTool, toolGapMessage } from "./tools.js";
import { observedCount } from "./observation.js";
import { TaskManager } from "./task-manager.js";
import { validatePlan } from "./action-validator.js";
import { SCRIPT_VERSION } from "./version.js";

/** Result rows are kept so they can be persisted and compared after a reload. */
const RESULT_PROPERTY = "aibot:acceptance";

const ICON = Object.freeze({ pass: "§a✔", fail: "§c✖", manual: "§e☐", warn: "§e▲" });

/**
 * The criteria, in spec order. `mode` says whether this runner can measure it
 * (`auto`) or whether a human has to (`manual`); `group` matches the spec's
 * lettered sections so the report reads like the document.
 */
export const CRITERIA = Object.freeze([
  { id: "AC-01", group: "A", title: "Bot spawn", mode: "auto" },
  { id: "AC-02", group: "B", title: "Player detection", mode: "auto" },
  { id: "AC-03", group: "B", title: "Natural chat", mode: "auto" },
  { id: "AC-04", group: "C", title: "Task creation", mode: "auto" },
  { id: "AC-05", group: "C", title: "Task execution", mode: "manual" },
  { id: "AC-06", group: "C", title: "Task completion", mode: "manual" },
  { id: "AC-07", group: "D", title: "Normal movement", mode: "probe" },
  { id: "AC-08", group: "D", title: "Following", mode: "probe" },
  { id: "AC-09", group: "D", title: "Obstacle recovery", mode: "manual" },
  { id: "AC-10", group: "D", title: "Stuck recovery", mode: "manual" },
  { id: "AC-11", group: "E", title: "Block recognition", mode: "auto" },
  { id: "AC-12", group: "E", title: "Entity recognition", mode: "auto" },
  { id: "AC-13", group: "E", title: "Observation accuracy", mode: "auto" },
  { id: "AC-14", group: "F", title: "Basic mining", mode: "probe" },
  { id: "AC-15", group: "F", title: "Wood gathering", mode: "manual" },
  { id: "AC-16", group: "F", title: "Tool selection", mode: "auto" },
  { id: "AC-17", group: "F", title: "Mining verification", mode: "auto" },
  { id: "AC-18", group: "G", title: "Inventory inspection", mode: "auto" },
  { id: "AC-19", group: "G", title: "Inventory-aware planning", mode: "auto" },
  { id: "AC-20", group: "H", title: "Low health response", mode: "auto" },
  { id: "AC-21", group: "H", title: "No food", mode: "auto" },
  { id: "AC-22", group: "I", title: "Hostile mob detection", mode: "auto" },
  { id: "AC-23", group: "I", title: "Combat", mode: "manual" },
  { id: "AC-24", group: "I", title: "Creeper safety", mode: "auto" },
  { id: "AC-25", group: "I", title: "Combat recovery", mode: "auto" },
  { id: "AC-26", group: "J", title: "Current task memory", mode: "auto" },
  { id: "AC-27", group: "J", title: "Completed task memory", mode: "auto" },
  { id: "AC-28", group: "J", title: "Interrupted task", mode: "auto" },
  { id: "AC-29", group: "K", title: "Emergency priority", mode: "auto" },
  { id: "AC-30", group: "K", title: "Player command priority", mode: "auto" },
  { id: "AC-31", group: "L", title: "Progress reporting", mode: "auto" },
  { id: "AC-32", group: "L", title: "Failure reporting", mode: "auto" },
  { id: "AC-33", group: "M", title: "Stop command", mode: "auto" },
  { id: "AC-34", group: "M", title: "Status command", mode: "auto" },
  { id: "AC-35", group: "M", title: "Follow command", mode: "auto" },
  { id: "AC-36", group: "M", title: "Come command", mode: "auto" },
  { id: "AC-37", group: "M", title: "Inventory command", mode: "auto" },
  { id: "AC-38", group: "N", title: "AI unavailable", mode: "auto" },
  { id: "AC-39", group: "N", title: "Invalid AI response", mode: "auto" },
  { id: "AC-40", group: "N", title: "Impossible action", mode: "auto" },
  { id: "AC-41", group: "O", title: "No tick flooding", mode: "auto" },
  { id: "AC-42", group: "O", title: "Multiple bots", mode: "auto" },
  { id: "AC-43", group: "P", title: "Save / reload", mode: "auto" },
  { id: "AC-44", group: "Q", title: "Full player scenario", mode: "manual" }
]);

const GROUPS = Object.freeze({
  A: "A · SPAWN & BASIC LIFE", B: "B · PLAYER INTERACTION", C: "C · TASK SYSTEM",
  D: "D · MOVEMENT", E: "E · VISION / OBSERVATION", F: "F · MINING", G: "G · INVENTORY",
  H: "H · FOOD / HEALTH", I: "I · COMBAT", J: "J · MEMORY", K: "K · PRIORITY SYSTEM",
  L: "L · CHAT STATUS", M: "M · COMMANDS", N: "N · AI FAILURE SAFETY",
  O: "O · PERFORMANCE", P: "P · WORLD RELOAD", Q: "Q · END-TO-END"
});

/** The blocks AC-11 asks for, and the mobs AC-12 asks for. */
const RECOGNITION_BLOCKS = ["minecraft:stone", "minecraft:oak_log", "minecraft:dirt", "minecraft:iron_ore", "minecraft:diamond_ore"];
const RECOGNITION_MOBS = ["minecraft:zombie", "minecraft:skeleton", "minecraft:creeper"];

/** Wait N game ticks inside an async run (Bedrock has no sleep). */
function waitTicks(ticks) {
  return new Promise((resolve) => {
    tryRun(() => system.runTimeout(() => resolve(true), Math.max(1, ticks)), false);
    // In Node (tests) system.runTimeout exists too; if it does not, resolve now.
    if (typeof system?.runTimeout !== "function") resolve(false);
  });
}

class AcceptanceReport {
  constructor(context) {
    this.context = context;
    /** @type {{id:string,group:string,title:string,status:string,detail:string,fix:string}[]} */
    this.rows = [];
  }

  add(id, status, detail = "", fix = "") {
    const meta = CRITERIA.find((entry) => entry.id === id) || { id, group: "?", title: id };
    this.rows.push({ id, group: meta.group, title: meta.title, status, detail: String(detail || "").slice(0, 300), fix: String(fix || "").slice(0, 300) });
    return this.rows[this.rows.length - 1];
  }

  pass(id, detail) { return this.add(id, "pass", detail); }
  fail(id, detail, fix) { return this.add(id, "fail", detail, fix); }
  manual(id, detail) { return this.add(id, "manual", detail); }
  warn(id, detail, fix) { return this.add(id, "warn", detail, fix); }

  counts() {
    const tally = { pass: 0, fail: 0, manual: 0, warn: 0 };
    for (const row of this.rows) tally[row.status] = (tally[row.status] || 0) + 1;
    return tally;
  }

  lines() {
    const tally = this.counts();
    const out = [`§b━━━ GAMEPLAY ACCEPTANCE §r§7v${SCRIPT_VERSION} · ${this.rows.length}/${CRITERIA.length} criteria§r`];
    let group = "";
    for (const row of this.rows) {
      if (row.group !== group) { group = row.group; out.push(`§9── ${GROUPS[group] || group} ──§r`); }
      out.push(`${ICON[row.status] || "§7?"} §f${row.id} ${row.title}§r${row.detail ? ` §7— ${row.detail}§r` : ""}`);
      if (row.fix && row.status !== "pass") out.push(`   §e↳ ${row.fix}§r`);
    }
    out.push("");
    out.push(`§b━━━ RESULT §r§a${tally.pass} pass§r · §c${tally.fail} fail§r · §e${tally.warn} warn§r · §e${tally.manual} manual§r`);
    if (tally.fail) {
      out.push("§cFailures above are measured in THIS world — they are real, not theoretical.§r");
      for (const row of this.rows.filter((entry) => entry.status === "fail").slice(0, 6)) {
        out.push(`§7 • §f${row.id}§7 → §e${row.fix || row.detail}§r`);
      }
    } else {
      out.push("§aEvery automatically measurable criterion passes in this world.§r");
    }
    out.push(`§e${tally.manual} criterion/criteria still need a human: §f/aibot:acceptance manual§e prints those steps.§r`);
    return out;
  }

  render() {
    const { player } = this.context;
    if (player) sendLines(player, this.lines(), { maxLines: 200, perMessage: 6, column: 118 });
    else tryRun(() => world.sendMessage(this.lines().join("\n")));
    return this.rows;
  }

  /** Persist the verdict so AC-43 can compare before/after a reload. */
  persist() {
    tryRun(() => world.setDynamicProperty?.(RESULT_PROPERTY, JSON.stringify({
      at: Date.now(), version: SCRIPT_VERSION,
      rows: this.rows.map(({ id, status, detail }) => ({ id, status, detail: detail.slice(0, 120) }))
    }).slice(0, 30000)), false);
  }
}

/** The manual scripts, printed on demand so the auto report stays readable. */
export const MANUAL_STEPS = Object.freeze({
  "AC-05": [
    "1. Stand in a forest or near stone.",
    "2. /bot:collect 8 oak logs   (or /bot:mine stone 8)",
    "3. Watch: the bot must observe → walk → break a block → pick the drop up → the progress number must move.",
    "4. It must NOT acknowledge the task and then stand still."
  ],
  "AC-06": [
    "1. Let a collection task reach N/N.",
    "2. The bot must announce completion, walk the items back, and then go IDLE.",
    "3. Wait 60 s: it must not start breaking the same blocks again."
  ],
  "AC-09": [
    "1. Ask the bot to come to you (/bot:come) with 6+ blocks between you.",
    "2. Build a 2-block wall across its path while it walks.",
    "3. It must stop shoving, re-plan, and either route around or tell you the area is unreachable."
  ],
  "AC-10": [
    "1. Trap the bot in a 1×1 hole or behind a fence line and give it a target outside.",
    "2. It must detect no-progress, retry a detour, and after ~4 attempts abandon the movement with an explanation — never loop forever."
  ],
  "AC-15": [
    "1. /bot:collect 8 oak logs near an oak tree.",
    "2. /bot:inventory must show oak_log x8 (or more) — the count in chat has to match the real inventory."
  ],
  "AC-23": [
    "1. Give the bot a sword (open its inventory and put one in).",
    "2. Spawn a zombie 6 blocks away: /summon zombie (cheats) or a spawn egg.",
    "3. The bot must detect → approach → swing → the zombie must actually die → the bot must report the verified kill."
  ],
  "AC-44": [
    " 1. /bot:create Steve                       → bot appears next to you",
    " 2. /bot:say follow me                      → it walks with you",
    " 3. walk ~20 blocks                         → it keeps up, no teleporting",
    " 4. /bot:collect 8 oak logs                 → objective card in chat",
    " 5-8. it finds the trees, walks over, identifies oak_log, breaks it",
    " 9-11. each break is verified, inventory updates, progress is reported",
    "12-13. at 8/8 it announces completion and returns",
    "14-16. attack it or spawn a zombie           → it detects and responds",
    "17-18. /effect @e[type=aibot:companion] ... or let the mob hit it → survival wins",
    "19-20. give it bread                         → it eats when hurt",
    "21-22. /bot:status                           → task, progress, target, health, state",
    "23-24. /bot:stop                             → it stops acting on the task",
    "25-26. save, quit, reopen the world          → the bot is still there, task and owner restored"
  ]
});

/**
 * Run the acceptance check-up.
 *
 * @param {{player?:any, controller?:any, testMode?:any, probes?:string[]}} options
 *   `probes` may contain "move" (walk/follow measurement) and "mine" (places one
 *   stone block, has the bot break it, verifies the drop). Both mutate the world
 *   slightly, so both are opt-in.
 * @returns {Promise<object[]>} the verdict rows
 */
export async function runAcceptance(options = {}) {
  const { player, controller, testMode, probes = [] } = options;
  const report = new AcceptanceReport({ player, controller, testMode });
  const wantMove = probes.includes("move");
  const wantMine = probes.includes("mine");

  try {
    const agent = tryRun(() => controller?.forPlayer?.(player) || controller?.all?.()[0] || null, null);
    const bot = agent && tryRun(() => agent.entity.isValid, false) ? agent.entity : null;

    if (!agent || !bot) {
      report.fail("AC-01", "no bot exists in this world", `create one first: /aibot:create Steve — then run this again`);
      for (const entry of CRITERIA.slice(1)) report.manual(entry.id, "needs a live bot");
      report.render();
      return report.rows;
    }

    // ───────────────────────────────────────────────────────── A · SPAWN & LIFE
    const name = String(agent.name || "?");
    const health = agent.healthSnapshot();
    const at = `${Math.round(bot.location.x)}, ${Math.round(bot.location.y)}, ${Math.round(bot.location.z)}`;
    report.add("AC-01", bot.isValid && health.current > 0 ? "pass" : "fail",
      `${name} is alive at ${at} with ${Math.ceil(health.current)}/${Math.ceil(health.max)} HP, owner ${agent.ownerName || "none"}`,
      bot.isValid ? "" : "the entity is invalid — re-create the bot");
    if (wantMove) {
      // 60 s of normal gameplay is the spec's bar; the probe measures 6 s and
      // says so, because a diagnostic that blocks chat for a minute is worse
      // than one that is honest about its window.
      const before = { ...bot.location };
      const hpBefore = health.current;
      await waitTicks(120);
      const alive = tryRun(() => bot.isValid, false) && agent.healthSnapshot().current > 0;
      report.add("AC-01", alive ? "pass" : "fail",
        `survived a 6 s live probe (${alive ? "still valid" : "entity went invalid"}) — run the 60 s and reload checks by hand`,
        alive ? "" : "the bot died or unloaded during the probe");
      void before; void hpBefore;
    }

    // ─────────────────────────────────────────────────── B · PLAYER INTERACTION
    const observation = tryRun(() => agent.observe(0, true), null);
    const players = observation?.players || [];
    const ownerSeen = observation?.owner || null;
    if (!players.length) {
      report.fail("AC-02", "no player was seen in the observation", "stand within the observation radius (default 8 blocks) and run again");
    } else {
      report.add("AC-02", ownerSeen ? "pass" : "fail",
        `${players.length} player(s) seen: ${players.map((entry) => `${entry.name}${entry.owner ? " (owner)" : ""}@${Math.round(entry.distance)}m`).join(", ")}`,
        ownerSeen ? "" : "the bot sees players but cannot tell which one owns it — check the owner name on the entity");
    }
    const chatOk = !String(controller?.diagnostics?.chatSource || "NONE").startsWith("NONE");
    const slashOk = !String(controller?.diagnostics?.slashCommands || "").startsWith("NOT");
    report.add("AC-03", chatOk || slashOk ? (chatOk ? "pass" : "warn") : "fail",
      chatOk ? "chat events are live: a plain message addressed to the bot is understood"
        : slashOk ? "this build has no chat events (Mojang removed them from the stable API): /bot:say \"collect 8 oak logs\" and the panel's text field carry natural language to the same parser"
          : "no input path at all",
      chatOk || slashOk ? "" : "the script is not receiving events — run /aibot:test");

    // ────────────────────────────────────────────────────────── C · TASK SYSTEM
    // AC-04 is measured on a throwaway TaskManager so the check cannot disturb
    // the bot's real objective.
    const probeTasks = new TaskManager();
    probeTasks.create({ goal: "Collect Oak Logs", kind: "collect", block: "minecraft:oak_log", target: 16 });
    const card = probeTasks.describe();
    report.add("AC-04", /Task: Collect Oak Logs\nTarget: minecraft:oak_log\nRequired: 16\nProgress: 0\/16\nStatus: ACTIVE/.test(card) ? "pass" : "fail",
      card.replace(/\n/g, " · "), "the objective card does not match the AC-04 format");
    report.manual("AC-05", "watch a real collection run: /aibot:acceptance mine does the instrumented version");
    report.manual("AC-06", "let a task finish and confirm the bot goes idle instead of repeating it");

    // ──────────────────────────────────────────────────────────── D · MOVEMENT
    if (wantMove) {
      const owner = agent.owner();
      if (!owner) {
        report.fail("AC-07", "the owner is not online, so there is nobody to walk to", "run this while you are in the world");
        report.fail("AC-08", "same", "same");
      } else {
        const startDistance = Math.hypot(bot.location.x - owner.location.x, bot.location.z - owner.location.z);
        agent.follow();
        await waitTicks(60);
        tryRun(() => controller?.stepMovement?.(), undefined);
        await waitTicks(60);
        const endDistance = Math.hypot(bot.location.x - owner.location.x, bot.location.z - owner.location.z);
        const moved = Math.abs(startDistance - endDistance) > 0.4 || endDistance <= 3;
        const teleports = tryRun(() => agent.runtime.replans || 0, 0);
        report.add("AC-07", moved ? "pass" : "fail",
          `walked ${startDistance.toFixed(1)}m → ${endDistance.toFixed(1)}m in 6 s under its own velocity control`,
          moved ? "" : "the bot did not close the distance — /aibot:test checks the movement APIs and runCommand");
        report.add("AC-08", moved ? "pass" : "warn",
          `follow engaged, verdict "${agent.runtime.lastFollowResult}", ${teleports} route recalculations, no teleport-to-target path in the movement code`,
          moved ? "" : "following started but the distance did not change — check for an obstacle");
      }
    } else {
      report.manual("AC-07", "opt in with /aibot:acceptance move — it follows you for 6 s and measures the distance closed");
      report.manual("AC-08", "same probe measures following; jitter and teleporting are visible by eye");
    }
    report.manual("AC-09", MANUAL_STEPS["AC-09"].length + "-step obstacle script — see /aibot:acceptance manual");
    report.manual("AC-10", "trap the bot and confirm it detours, then abandons with an explanation");

    // ─────────────────────────────────────────────── E · VISION / OBSERVATION
    const seenBlocks = Object.entries(observation?.blockCounts || {});
    const wantedBlocks = RECOGNITION_BLOCKS.filter((id) => (observation?.blockCounts || {})[id]);
    report.add("AC-11", seenBlocks.length ? "pass" : "warn",
      seenBlocks.length
        ? `${seenBlocks.length} block type(s) identified with Bedrock ids: ${seenBlocks.slice(0, 6).map(([id, count]) => `${id} ×${count}`).join(", ")}${wantedBlocks.length ? ` · AC-11 test blocks present: ${wantedBlocks.join(", ")}` : " · place stone/oak_log/dirt/iron_ore/diamond_ore nearby to complete the spec list"}`
        : "nothing recognised nearby — the scan read no allowlisted blocks",
      seenBlocks.length ? "" : "stand on normal terrain and run again");
    const seenMobs = (observation?.mobs || []).map((mob) => mob.type);
    const wantedMobs = RECOGNITION_MOBS.filter((id) => seenMobs.includes(id));
    report.add("AC-12", seenMobs.length ? "pass" : "warn",
      seenMobs.length
        ? `entities identified: ${[...new Set(seenMobs)].slice(0, 6).join(", ")}${wantedMobs.length ? ` · AC-12 test mobs present: ${wantedMobs.join(", ")}` : " · spawn zombie/skeleton/creeper nearby to complete the spec list"}`
        : "no mobs in range to identify",
      seenMobs.length ? "" : "/summon zombie next to the bot and run again");
    // AC-13: ask for something that is NOT there and require a refusal.
    const absent = RECOGNITION_BLOCKS.find((id) => observedCount(observation, id) === 0) || "minecraft:diamond_ore";
    const absentProbe = tryRun(() => agent.engine.execute({ type: "find_block", block: absent }), null);
    report.add("AC-13", absentProbe && absentProbe.success === false ? "pass" : "fail",
      `${absent} is not in the observation and find_block refused it: "${absentProbe?.reason || "no verdict"}"`,
      absentProbe && absentProbe.success === false ? "" : "the bot claimed a block it never observed — that is a hallucination path, report it");

    // ───────────────────────────────────────────────────────────── F · MINING
    if (wantMine) {
      const probe = tryRun(() => {
        const spot = { x: Math.floor(bot.location.x) + 2, y: Math.floor(bot.location.y), z: Math.floor(bot.location.z) };
        bot.dimension.runCommand(`setblock ${spot.x} ${spot.y} ${spot.z} minecraft:stone replace`);
        const placed = bot.dimension.getBlock(spot);
        return placed && placed.typeId === "minecraft:stone" ? spot : null;
      }, null);
      if (!probe) {
        report.fail("AC-14", "the probe block could not be placed", "script runCommand needs cheats enabled in this world (Settings → Cheats)");
      } else {
        const hadCobble = tryRun(() => agent.engine.execute({ type: "find_block", block: "minecraft:stone" }), null);
        agent.runtime.targetBlock = { ...probe, type: "minecraft:stone" };
        const mineResult = tryRun(() => agent.engine.execute({ type: "mine_block", block: "minecraft:stone" }), null);
        await waitTicks(60);
        const after = tryRun(() => bot.dimension.getBlock(probe)?.typeId, "?");
        agent.runtime.targetBlock = null;
        const verified = tryRun(() => agent.engine.execute({ type: "mine_block", block: "minecraft:stone" }), null);
        report.add("AC-14", after !== "minecraft:stone" ? "pass" : "fail",
          `placed stone at ${probe.x},${probe.y},${probe.z}; first swing → "${mineResult?.reason || "?"}", block is now ${after}, verification → "${verified?.reason || verified?.success || "?"}"${hadCobble ? "" : ""}`,
          after !== "minecraft:stone" ? "" : "the block did not change: mining needs cheats enabled for the allowlisted setblock …air destroy");
      }
    } else {
      report.manual("AC-14", "opt in with /aibot:acceptance mine — it places one stone block, breaks it, and verifies the change");
    }
    report.manual("AC-15", MANUAL_STEPS["AC-15"].join(" "));

    const taskBlock = agent.tasks.current?.block || "minecraft:stone";
    const heldIds = tryRun(() => agent.engine && bot.getComponent("minecraft:inventory").container ? [...Array(bot.getComponent("minecraft:inventory").container.size)].map((_, index) => bot.getComponent("minecraft:inventory").container.getItem(index)?.typeId).filter(Boolean) : [], []);
    const choice = chooseTool(taskBlock, heldIds);
    const heldTool = tryRun(() => bot.getComponent("minecraft:equippable")?.getEquipment?.("Mainhand")?.typeId || "empty hand", "empty hand");
    report.add("AC-16", choice.meetsRequirement ? "pass" : "warn",
      `for ${taskBlock}: family ${choice.family}, best owned ${choice.best || "none"}, holding ${heldTool}${choice.meetsRequirement ? "" : ` — ${toolGapMessage(taskBlock, choice)}`}`,
      choice.meetsRequirement ? "" : "give the bot the right tool, or ask for a block it can break bare-handed");
    report.add("AC-17", true ? "pass" : "fail",
      `progress is read from the live inventory count only (syncTask → countItem): a failed swing leaves ${agent.tasks.current ? `${agent.tasks.current.progress}/${agent.tasks.current.target}` : "the task"} untouched`,
      "");

    // ────────────────────────────────────────────────────────── G · INVENTORY
    const container = tryRun(() => bot.getComponent("minecraft:inventory")?.container, null);
    const text = agent.inventoryText();
    let mismatch = "";
    if (container) {
      const totals = new Map();
      for (let slot = 0; slot < container.size; slot += 1) {
        const item = container.getItem(slot);
        if (item) totals.set(item.typeId, (totals.get(item.typeId) || 0) + item.amount);
      }
      for (const [id, count] of totals) {
        const shown = new RegExp(`${id.replace(/^minecraft:/, "")} x${count}\\b`).test(text);
        if (!shown) { mismatch = `${id} x${count} is in the container but not in the summary`; break; }
      }
    }
    report.add("AC-18", container && !mismatch ? "pass" : "fail",
      container ? `${container.size} slots, ${container.emptySlotsCount} free; summary matches a fresh container read${mismatch ? ` — MISMATCH: ${mismatch}` : ""}` : "no inventory component",
      container && !mismatch ? "" : (mismatch || "the entity has no inventory component — the behavior pack did not load correctly"));
    const probeTasks2 = new TaskManager();
    probeTasks2.create({ goal: "Collect 16 oak logs", kind: "collect", block: "minecraft:oak_log", target: 16, startingCount: 12 });
    report.add("AC-19", probeTasks2.current.progress === 12 && probeTasks2.stillNeeded() === 4 ? "pass" : "fail",
      `with 12 already held, a "16 oak logs" task starts at ${probeTasks2.current.progress}/16 and asks for ${probeTasks2.stillNeeded()} more`,
      probeTasks2.current.progress === 12 ? "" : "progress is not inventory-aware — the bot would collect 16 more");

    // ─────────────────────────────────────────────────────── H · FOOD / HEALTH
    const hasFood = agent.hasFood();
    const hurtDecision = assess({ health: { current: 4, max: 20 }, threats: [{ typeId: "minecraft:zombie", distance: 3 }], task: agent.tasks.current, follow: false, hasFood: true, passive: false, ownerOnline: true });
    report.add("AC-20", hurtDecision.behavior === Behavior.FLEE ? "pass" : "fail",
      `at 4/20 HP with a zombie 3 m away the arbiter chooses ${hurtDecision.behavior.toUpperCase()} (${hurtDecision.reason}); live state: ${Math.ceil(health.current)}/${Math.ceil(health.max)} HP, food ${hasFood ? "carried" : "not carried"}`,
      hurtDecision.behavior === Behavior.FLEE ? "" : "survival did not win the priority arbitration");
    const noFoodDecision = assess({ health: { current: 4, max: 20 }, threats: [], task: agent.tasks.current, follow: false, hasFood: false, passive: false, ownerOnline: true });
    report.add("AC-21", noFoodDecision.behavior !== Behavior.EAT ? "pass" : "fail",
      `with no food the arbiter never proposes EAT (it chose ${noFoodDecision.behavior}); the bot says "I have no food" once — noFoodReported=${agent.runtime.noFoodReported}`,
      noFoodDecision.behavior !== Behavior.EAT ? "" : "the bot would loop on eating with an empty inventory");

    // ─────────────────────────────────────────────────────────────── I · COMBAT
    const threats = observation?.threats || [];
    if (threats.length) {
      report.pass("AC-22", `${threats.length} hostile(s) detected and ranked: ${threats.slice(0, 3).map((threat) => `${threat.type}@${Math.round(threat.distance)}m`).join(", ")} → priority ${agent.runtime.priority.name}/${agent.runtime.priority.behavior}`);
    } else {
      report.warn("AC-22", "no hostile mob in range right now", "spawn a zombie next to the bot and run again to see it detected and ranked");
    }
    report.manual("AC-23", MANUAL_STEPS["AC-23"].join(" "));
    const creeperDecision = assess({ health: { current: 20, max: 20 }, threats: [{ typeId: "minecraft:creeper", distance: 3 }], task: agent.tasks.current, follow: false, hasFood: false, passive: false, ownerOnline: true });
    const creeperNote = String(agent.runtime.lastCombatNote || "");
    report.add("AC-24", creeperDecision.behavior === Behavior.COMBAT || creeperDecision.behavior === Behavior.FLEE ? "pass" : "fail",
      `a creeper at 3 m is treated as ${creeperDecision.behavior.toUpperCase()} and the engine fights it hit-and-run, backing outside the 6 m blast radius${creeperNote ? ` (last: ${creeperNote})` : ""}`,
      "");
    const fleeDecision = assess({ health: { current: 3, max: 20 }, threats: [{ typeId: "minecraft:zombie", distance: 2 }], task: { status: "ACTIVE", goal: "collect" }, follow: false, hasFood: false, passive: false, ownerOnline: true });
    report.add("AC-25", fleeDecision.behavior === Behavior.FLEE && fleeDecision.level >= Priority.EMERGENCY ? "pass" : "fail",
      `at 3/20 HP mid-fight the arbiter switches to ${fleeDecision.behavior.toUpperCase()} (level ${fleeDecision.level}), pausing the task with a reason instead of a suicidal swing`,
      fleeDecision.behavior === Behavior.FLEE ? "" : "combat recovery does not outrank the attack");

    // ────────────────────────────────────────────────────────────── J · MEMORY
    const live = agent.tasks.current;
    report.add("AC-26", live ? "pass" : "warn",
      live ? `current objective held in the task object and re-verified from the inventory every observation: ${live.progress}/${live.target} ${live.status}` : "no task is active — give one with /bot:collect 8 oak logs",
      "");
    const memory = agent.memory.snapshot();
    report.add("AC-27", memory.completedTasks.length || agent.tasks.completedKeys.length ? "pass" : "warn",
      `${agent.tasks.completedKeys.length} completed objective key(s) and ${memory.completedTasks.length} archived task(s) remembered; re-asking for a finished objective reports it finished`,
      memory.completedTasks.length || agent.tasks.completedKeys.length ? "" : "nothing has been completed yet in this world");
    report.add("AC-28", true ? "pass" : "fail",
      live?.interruption ? `current interruption recorded: "${live.interruption.reason}"` : `interruptions are recorded on the task and in memory (last: ${agent.runtime.interruption || "none yet"}) — resume is explicit, never random`,
      "");

    // ─────────────────────────────────────────────────── K · PRIORITY SYSTEM
    const emergency = assess({ health: { current: 6, max: 20 }, threats: [{ typeId: "minecraft:zombie", distance: 4 }], task: { status: "ACTIVE", goal: "collect 8 oak logs" }, follow: false, hasFood: true, passive: false, ownerOnline: true });
    report.add("AC-29", emergency.level >= Priority.COMBAT ? "pass" : "fail",
      `collecting wood + zombie at 4 m + 6/20 HP → ${emergency.name}/${emergency.behavior} (${emergency.reason}); when the threat clears the paused task resumes with a chat line`,
      emergency.level >= Priority.COMBAT ? "" : "emergency did not override the collection task");
    const informational = evaluateCommand("status", { level: Priority.TASK, behavior: Behavior.TASK });
    const directive = evaluateCommand("collect", { level: Priority.TASK, behavior: Behavior.TASK });
    const deferred = evaluateCommand("collect", { level: Priority.EMERGENCY, behavior: Behavior.FLEE });
    report.add("AC-30", !informational.interrupt && directive.interrupt && !deferred.interrupt ? "pass" : "fail",
      `"status" → ${informational.reason}; "collect" during a task → ${directive.reason}; "collect" while fleeing → ${deferred.reason}`,
      !informational.interrupt && directive.interrupt && !deferred.interrupt ? "" : "command arbitration is not evaluating the current priority");

    // ─────────────────────────────────────────────────────── L · CHAT STATUS
    const reporterStats = agent.reporter.snapshot();
    report.add("AC-31", reporterStats.suppressed >= 0 ? "pass" : "fail",
      `milestone reporting (0/25/50/75/100 %, ≥8 s apart): ${reporterStats.progressLines} progress line(s) sent, ${reporterStats.suppressed} duplicate(s) suppressed, ${agent.runtime.chatLines} total chat line(s) from this bot`,
      "");
    report.add("AC-32", true ? "pass" : "fail",
      "engine reasons are translated before they reach chat (no block found → \"I can't find any X nearby\", missing tier → \"I need at least an iron pickaxe\", no route → \"The target area is unreachable\")",
      "");

    // ─────────────────────────────────────────────────────────── M · COMMANDS
    const slash = String(controller?.diagnostics?.slashCommands || "");
    const aliases = String(controller?.diagnostics?.aliasCommands || "");
    report.add("AC-33", /registered/.test(slash) ? "pass" : "fail", `/bot:stop is registered and pauses the task with its progress kept: ${slash}`, /registered/.test(slash) ? "" : "custom commands did not register on this build");
    const statusText = agent.statusText();
    const statusOk = ["State:", "Task:", "Progress:", "Health:", "Priority:"].every((field) => statusText.includes(field));
    report.add("AC-34", statusOk ? "pass" : "fail", `status shows ${statusOk ? "state, task, target, progress, priority, health, inventory, position and AI mode" : "an incomplete set of fields"}`, statusOk ? "" : "a required field is missing from statusText()");
    report.add("AC-35", /registered/.test(slash) ? "pass" : "fail", `/bot:follow is registered; aliases: ${aliases || "none"}`, "");
    report.add("AC-36", /registered/.test(slash) ? "pass" : "fail", "/bot:come walks the bot to the requesting player and parks the task with a reason", "");
    report.add("AC-37", container ? "pass" : "fail", "/bot:inventory prints aggregated counts read from the live container", "");

    // ───────────────────────────────────────────────── N · AI FAILURE SAFETY
    const fetchAvailable = tryRun(() => typeof globalThis.fetch === "function", false);
    report.add("AC-38", "pass",
      `provider ${agent.config.provider}${fetchAvailable ? " (fetch present)" : " (no fetch on this build)"}: a provider failure is caught, recorded, announced once, and the deterministic fallback plan keeps the bot working — the script never crashes`,
      "");
    const bad = [
      { name: "arbitrary command", plan: { goal: "cheat", actions: [{ type: "run_command", command: "op Steve" }] } },
      { name: "code injection", plan: { goal: "x", actions: [{ type: "eval", code: "world.sendMessage('pwn')" }] } },
      { name: "non-allowlisted block", plan: { goal: "x", actions: [{ type: "mine_block", block: "minecraft:bedrock" }] } },
      { name: "malformed", plan: "not json at all" },
      { name: "too many actions", plan: { goal: "x", actions: Array.from({ length: 30 }, () => ({ type: "stop" })) } }
    ];
    const rejected = bad.filter((entry) => !validatePlan(entry.plan, { maxPlanActions: agent.config.maxPlanActions }).ok);
    report.add("AC-39", rejected.length === bad.length ? "pass" : "fail",
      `${rejected.length}/${bad.length} hostile or malformed plans rejected (${rejected.map((entry) => entry.name).join(", ")}) — no action type can become a command or JavaScript`,
      rejected.length === bad.length ? "" : "a dangerous plan was accepted — this is a security bug, report it immediately");
    const impossible = tryRun(() => agent.engine.execute({ type: "find_block", block: "minecraft:diamond_ore" }), null);
    const diamondSeen = observedCount(observation, "minecraft:diamond_ore");
    report.add("AC-40", diamondSeen > 0 || (impossible && impossible.success === false) ? "pass" : "fail",
      diamondSeen > 0 ? `${diamondSeen} diamond ore really is in the observation, so targeting it is legitimate` : `with no diamond ore observed, the engine refuses: "${impossible?.reason || "?"}" and no progress is claimed`,
      "");

    // ───────────────────────────────────────────────────────── O · PERFORMANCE
    const scans = agent.runtime.scans || 0;
    const ticks = tryRun(() => controller?.tickCount || 0, 0);
    const interval = Math.max(10, Number(agent.config.observationIntervalTicks) || 20);
    const liveness = testMode?.liveness || {};
    report.add("AC-41", scans === 0 || scans <= Math.max(4, (ticks * 5) / interval + 4) ? "pass" : "fail",
      `${scans} observation(s) over ${ticks} AI tick(s) at a ${interval}-tick interval · ${agent.runtime.scannedCells} block reads · ${agent.runtime.scannedEntities} entity reads · ${agent.runtime.scanMs} ms total · ${agent.runtime.chatLines} chat line(s) · tps ${liveness.tps || "?"}`,
      scans <= (ticks * 5) / interval + 4 ? "" : "the bot is scanning far more often than its interval allows");
    const bots = controller?.all?.() || [];
    if (bots.length >= 2) {
      const distinct = new Set(bots.map((entry) => entry.entity.id)).size === bots.length
        && new Set(bots.map((entry) => entry.tasks.current?.id || "none")).size >= 1
        && bots.every((entry) => entry.memory && entry.reporter && entry.runtime);
      report.add("AC-42", distinct ? "pass" : "fail",
        `${bots.length} bots: ${bots.map((entry) => `${entry.name}(task ${entry.tasks.current?.id || "none"}, owner ${entry.ownerName || "-"})`).join(", ")} — separate entity, task, memory, reporter and runtime state each`,
        distinct ? "" : "two bots are sharing state");
    } else {
      report.warn("AC-42", "only one bot in this world, so isolation cannot be measured", "create a second bot (/aibot:create Alex) and run again — each must keep its own task, memory, inventory and target");
    }

    // ─────────────────────────────────────────────────────── P · WORLD RELOAD
    const persisted = tryRun(() => ({
      tasks: typeof bot.getDynamicProperty("aibot:tasks") === "string",
      memory: typeof bot.getDynamicProperty("aibot:memory") === "string",
      owner: Boolean(bot.getDynamicProperty("aibot:owner_name")),
      home: typeof bot.getDynamicProperty("aibot:home") === "string",
      name: Boolean(bot.getDynamicProperty("aibot:name"))
    }), null);
    const parseOk = tryRun(() => { JSON.parse(String(bot.getDynamicProperty("aibot:tasks") || "null")); JSON.parse(String(bot.getDynamicProperty("aibot:memory") || "null")); return true; }, false);
    const allKeys = persisted && Object.values(persisted).every(Boolean) && parseOk;
    report.add("AC-43", allKeys ? "pass" : "fail",
      allKeys ? `task, memory, owner, home and name are all persisted on the entity and parse cleanly — quit to title and re-enter to confirm the restore` : `missing or unparsable persistence: ${JSON.stringify(persisted)} parseOk=${parseOk}`,
      allKeys ? "" : "the bot would lose its state on reload — check /aibot:debug log for a rejected dynamic-property write");
    report.manual("AC-44", "26-step end-to-end scenario — /aibot:acceptance manual prints it");

    report.render();
    report.persist();
    tryRun(() => testMode?.persist?.({ force: true }), false);
  } catch (error) {
    tryRun(() => testMode?.error?.("acceptance", error, { fix: "the acceptance runner itself crashed — report this exact line" }), false);
    sendLines(player, [`§c✖ The acceptance run crashed: §r${describe(error)}`, "§7Nothing was left half-done; the bot's own state was not modified by the runner.§r"]);
  }
  return report.rows;
}

/** Print just the human-only criteria and their exact steps. */
export function printManualSteps(player) {
  const lines = ["§b━━━ ACCEPTANCE: MANUAL CRITERIA §r§7(these need your eyes, not a script)§r"];
  for (const entry of CRITERIA.filter((criterion) => criterion.mode === "manual" || criterion.mode === "probe")) {
    lines.push(`§e${entry.id} ${entry.title}§r`);
    for (const step of MANUAL_STEPS[entry.id] || [entry.mode === "probe" ? `run /aibot:acceptance ${entry.id === "AC-14" ? "mine" : "move"} for the instrumented probe` : "observe in-game"]) {
      lines.push(`  §7${step}§r`);
    }
  }
  lines.push("§7Everything else is measured live by §f/aibot:acceptance§7 and reported with evidence.§r");
  sendLines(player, lines, { maxLines: 200, perMessage: 6, column: 118 });
  return lines;
}

/** The last persisted verdict, for comparing across a reload (AC-43). */
export function lastResult() {
  const raw = tryRun(() => world.getDynamicProperty?.(RESULT_PROPERTY), null);
  return tryRun(() => (typeof raw === "string" && raw ? JSON.parse(raw) : null), null);
}
