/**
 * THE SELF-TEST — `/aibot:test` (and `!aibot test`, and a button in the panel).
 *
 * Test mode's error log answers "what just broke?". This answers the question
 * players ask first: "is the bot broken, and which part?". Every check is a
 * real call into the same API the bot depends on, so a failing check is a
 * failure the bot hits too — no guessing from log lines.
 *
 * Design rules, learned the hard way in this pack:
 *  • A check never throws out of this module. Anything that throws is recorded
 *    as a FAIL together with the exact error text, because "the checker
 *    exploded" is itself the diagnosis.
 *  • Anything that might not exist on an older game build is looked up with
 *    `Reflect.get`/`typeof`, so probing for it cannot break the script.
 *  • Every FAIL carries a `fix` line: a check without an action is decoration.
 *  • The only world mutation is one probe entity (spawned, measured, removed
 *    inside this run), and main.js's auto-registration is suppressed while it
 *    exists — otherwise a probe would be adopted as a real bot and show up in
 *    `/aibot:list`.
 */

import { system, world } from "@minecraft/server";
import * as MinecraftServer from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { SCRIPT_VERSION } from "./version.js";
import { describe, sendLines, tryRun } from "./format.js";
import { distance as vectorDistance, findLocalRoute, isSafeCell, routeIsArrival } from "./navigation.js";
import { readBotStatus } from "./status.js";
import { createFetchTransport } from "./ai-provider.js";

const PROBE_NAME = "AIBOT-PROBE";
const GROUPS = Object.freeze({
  loading: "SCRIPT LOADING",
  commands: "COMMANDS & MENUS",
  world: "WORLD & PACK",
  bot: "YOUR BOT",
  movement: "MOVEMENT & MINING",
  ai: "AI PROVIDER"
});
const ICONS = Object.freeze({ pass: "§a✔", fail: "§c✖", warn: "§e▲", skip: "§7—" });

function position(value) {
  if (!value) return "?";
  return `${Math.round(value.x)}, ${Math.round(value.y)}, ${Math.round(value.z)}`;
}

function isValid(entity) {
  return tryRun(() => Boolean(entity && entity.isValid === true), false);
}

/** Collects rows and renders them, so a check can be added without a renderer change. */
class Report {
  constructor(context) {
    this.context = context;
    /** @type {{group:string,id:string,status:string,detail:string,fix:string}[]} */
    this.rows = [];
  }

  add(group, id, status, detail = "", fix = "") {
    const row = { group, id, status, detail: detail ? describe(detail, 300) : "", fix };
    this.rows.push(row);
    // A self-test failure is a real error: put it in the log too, so
    // `/aibot:debug log` lists the same things and they survive a reload.
    if (status === "fail") this.context?.testMode?.error(`self-test:${id}`, row.detail, fix ? { fix } : {});
    return row;
  }

  pass(group, id, detail) { return this.add(group, id, "pass", detail); }
  warn(group, id, detail, fix) { return this.add(group, id, "warn", detail, fix); }
  skip(group, id, detail) { return this.add(group, id, "skip", detail); }
  fail(group, id, detail, fix) { return this.add(group, id, "fail", detail, fix); }

  counts() {
    const tally = { pass: 0, fail: 0, warn: 0, skip: 0 };
    for (const row of this.rows) tally[row.status] = (tally[row.status] || 0) + 1;
    return tally;
  }

  lines() {
    const { player, controller, testMode } = this.context;
    const lines = [`§b━━━ AI BOT SELF-TEST §r§7v${SCRIPT_VERSION} · tick ${tryRun(() => system.currentTick, "?")} · ${this.rows.length} checks§r`];
    let group = "";
    for (const row of this.rows) {
      if (row.group !== group) {
        group = row.group;
        lines.push(`§9── ${GROUPS[group] || group} ──§r`);
      }
      lines.push(`${ICONS[row.status] || "§7?"} §f${row.id}§r${row.detail ? ` §7— ${row.detail}§r` : ""}`);
      if (row.fix && row.status !== "pass") lines.push(`   §e↳ ${row.fix}§r`);
    }
    const tally = this.counts();
    lines.push("");
    lines.push(`§b━━━ RESULT §r§a${tally.pass} pass§r§7 · §c${tally.fail} fail§r§7 · §e${tally.warn} warn§r§7 · §7${tally.skip} skip§r`);
    const failures = this.rows.filter((row) => row.status === "fail");
    if (failures.length) {
      const fatal = failures.some((row) => row.group !== "commands");
      lines.push(failures.length === 1 && !fatal
        ? "§eOnly a command path is missing — the bot itself is fine; use the command named above.§r"
        : `§c${failures.length} broken thing(s) — that is why the bot does nothing. §7Fix in this order:§r`);
      for (const row of failures.slice(0, 5)) lines.push(`§7 • §f${row.id}§7 → §e${row.fix || row.detail || "see above"}§r`);
    } else if (tally.warn) {
      lines.push("§aNothing is broken. §7The yellow lines are degraded features — read them if the bot still misbehaves.§r");
    } else {
      lines.push("§aEverything the bot needs is working. §7If a command produced no reply, it was typed where this build cannot see it: use the exact command shown above, or the compass menu.§r");
    }
    const logged = tryRun(() => testMode?.errorCount?.() || 0, 0);
    lines.push(`§7Error log: §f${logged} error(s)§7 · test mode ${testMode?.enabled ? "§aON§r§7" : "§coff§r§7"} — §e/aibot:debug on §7streams every error as it happens; §e/aibot:debug log §7shows this log§r`);
    if (controller?.diagnostics) {
      lines.push(`§8script v${controller.diagnostics.scriptVersion} · chat: ${controller.diagnostics.chatSource} · slash: ${controller.diagnostics.slashCommands}§r`);
    }
    return lines;
  }

  /**
   * Print from `fromIndex` on. The report is rendered once up front (so it can
   * never be held hostage by the interactive question below) and then again for
   * just the rows that the answer added.
   */
  render(fromIndex = 0) {
    const slice = fromIndex > 0 ? { lines: () => this.rows.slice(fromIndex).flatMap((row) => [
      `${ICONS[row.status] || "§7?"} §f${row.id}§r${row.detail ? ` §7— ${row.detail}§r` : ""}`,
      ...(row.fix && row.status !== "pass" ? [`   §e↳ ${row.fix}§r`] : [])
    ]), count: 0 } : null;
    const lines = slice ? [
      `§b━━━ SELF-TEST: VISUAL CHECK §r§7(tap a button in the dialog you just closed)§r`,
      ...slice.lines()
    ] : this.lines();
    if (this.context.player) sendLines(this.context.player, lines, { maxLines: 140, perMessage: 5, column: 116 });
    else tryRun(() => world.sendMessage(lines.join("\n")));
    return this.rows;
  }
}

/**
 * "The name tag shows but there is no body" and "nothing at all" are the two
 * symptoms a script cannot read off the client. Asking the player one question
 * while a probe entity stands in front of them settles it, and the answer
 * decides between a resource-pack problem and an entity-registration problem.
 */
async function visualProbe(report, { player, probe }) {
  if (!player || !probe) {
    report.skip("world", "visible model", probe ? "no player to ask" : "no probe entity to look at");
    return;
  }
  let response;
  try {
    const form = new ActionFormData()
      .title("SELF-TEST: what do you see?")
      .body(`I spawned a test entity named ${PROBE_NAME} right in front of you.\n\nWhat do you actually see where it stands?`)
      .button("A player-like figure with that name")
      .button("The name tag, but no body")
      .button("Nothing at all")
      .button("Skip this check");
    response = await form.show(player);
  } catch (error) {
    report.warn("world", "visible model", `the dialog could not be shown: ${describe(error)}`, "if forms never open, another UI/screen is in front (chat, pause, inventory) — close it and run /aibot:test again");
    return;
  }
  if (!response || response.canceled || response.selection === 3 || response.selection === undefined) {
    report.skip("world", "visible model", "you closed the dialog, so the model check was skipped");
    return;
  }
  if (response.selection === 0) report.pass("world", "visible model", `you can see ${PROBE_NAME} — behaviour pack and resource pack are both working`);
  else if (response.selection === 1) report.fail("world", "visible model", "the entity exists but has no model (name tag only)", "the RESOURCE pack is not active or the client entity was rejected: Edit World → Add-Ons → activate \"Autonomous AI Bot - Resources\", then reload the world. The bot is really there — /aibot:status finds it");
  else report.fail("world", "visible model", "the entity did not appear in the world at all", "spawn said it worked but you see nothing: the client is rendering a different/stale copy of the pack — re-import the .mcaddon, keep exactly one behaviour + one resource pack active, then FULLY quit to title and re-enter the world");
}

/**
 * Run every check. `only` narrows to one group (used by `/aibot:debug net`),
 * `deep` enables the real network round-trip.
 *
 * @param {{player?: any, controller?: any, testMode?: any, deep?: boolean, only?: string|null}} [options]
 * @returns {Promise<{group:string,id:string,status:string,detail:string,fix:string}[]>} the rows that were checked and rendered
 */
export async function runSelfTest(options = {}) {
  const { player, controller, testMode, deep = false, only = null } = options;
  const report = new Report({ player, controller, testMode });
  const diagnostics = controller?.diagnostics || {};
  const wanted = (group) => !only || only === group || (only === "network" && group === "ai");

  const dimension = tryRun(() => player?.dimension || world.getDimension("overworld"), null);
  const origin = tryRun(() => (player && isValid(player) ? player.location : null), null)
    || tryRun(() => world.getPlayers()[0]?.location, null) || { x: 0, y: 64, z: 0 };
  const owned = tryRun(() => (controller?.forPlayer(player) ? [controller.forPlayer(player)] : controller?.all() || []), []).filter(Boolean);
  const agent = owned[0] || null;
  const bot = agent && isValid(agent.entity) ? agent.entity : null;

  // `probe` is declared outside the try so the finally below can always clean it
  // up: a probe entity left in the world would be adopted as a real bot.
  let probe = null;
  try {
    // ─────────────────────────────────────────────────────────── SCRIPT LOADING
    if (wanted("loading")) {
      report.add("loading", "script loaded", "pass", `v${SCRIPT_VERSION} — this reply is the proof`);

      const missing = ["world", "system", "CommandPermissionLevel", "CustomCommandParamType"]
        .filter((name) => !tryRun(() => Boolean(Reflect.get(MinecraftServer, name)), false));
      if (missing.length) report.warn("loading", "script API", `missing export(s): ${missing.join(", ")}`, "the game is older than the @minecraft/server level this pack declares — update Minecraft or install the pack version for your API level");
      else report.pass("loading", "script API", "every module member this pack needs is present, including the UI module");

      const liveness = testMode?.liveness;
      if (!liveness) report.skip("loading", "tick loop", "no liveness sampler available");
      else if (liveness.aiBeat < 0) report.fail("loading", "tick loop", "the AI loop has never run since the script loaded", "reload the world: the module evaluated but its interval jobs are not firing, so no bot can act");
      else if (liveness.stalled) report.fail("loading", "tick loop", `no AI tick for ${Math.max(0, liveness.tick - liveness.aiBeat)} game ticks (${liveness.tps} tps)`, "reload the world; if it stalls again the AI loop is throwing every tick — read §f/aibot:debug log for the first error");
      else report.pass("loading", "tick loop", `${liveness.tps > 0 ? `${liveness.tps} tps · ` : ""}AI job ${Math.max(0, liveness.tick - liveness.aiBeat)} tick(s) ago · movement job ${liveness.moveBeat < 0 ? "never" : `${Math.max(0, liveness.tick - liveness.moveBeat)} tick(s) ago`}`);
      if (liveness && liveness.moveBeat >= 0 && liveness.tick - liveness.moveBeat > 40) {
        report.fail("loading", "movement job", `the per-tick steering job last ran ${Math.max(0, liveness.tick - liveness.moveBeat)} ticks ago`, "bots are told where to go but nothing drives their velocity, so they never walk — reload the world");
      }

      // Two copies of the pack is the single most common cause of "the bot
      // ignores me", so it gets its own line. The sweep runs every ~15 s, so an
      // un-run sweep is a skip, never a false pass.
      const duplicate = String(diagnostics.duplicate || "");
      if (duplicate.startsWith("DETECTED")) report.fail("loading", "one pack only", duplicate, "Edit World → Add-Ons → deactivate the OLDER \"Autonomous AI Bot\" pack, then reload. Two copies fight over the same bot, each with its own list, which is where \"No bot is assigned to you\" comes from");
      else if (duplicate && !/not checked/i.test(duplicate)) report.pass("loading", "one pack only", duplicate);
      else report.skip("loading", "one pack only", "the second-copy sweep has not run yet (it samples every ~15 s) — run this again after a minute of play, or read the chat banners: two \"[AI Bot …] Script loaded\" lines means two packs are active");
    }

    // ────────────────────────────────────────────────────────── COMMANDS & MENUS
    if (wanted("commands")) {
      const chatSource = String(diagnostics.chatSource || "unbound");
      // Chat being absent is expected on stable 2.x, so it is only a FAILURE when
      // nothing else can reach the pack either. Otherwise it is a warning that
      // names the command form this build does understand.
      const chatNote = "no chat event exists on this build, so \"!aibot …\" typed in chat can never reach the pack — that is Mojang's change, not this pack's bug";
      const chatFix = "use §f/aibot:create Steve§e (a real slash command), the §fcompass menu§e, or §f/scriptevent aibot:cmd create Steve §ewith cheats on";
      const anotherDoor = /\d+\/\d+ registered/.test(String(diagnostics.slashCommands || "")) || String(diagnostics.itemUseSource || "").includes("itemUse");
      if (chatSource.startsWith("NONE")) report.add("commands", "chat commands", anotherDoor ? "warn" : "fail", chatNote, chatFix);
      else report.pass("commands", "chat commands", `bound to ${chatSource}`);

      const slash = String(diagnostics.slashCommands || "");
      const counted = slash.match(/(\d+)\/(\d+)/);
      if (counted && Number(counted[1]) > 0) report.pass("commands", "slash commands", slash.includes("aibot:test") ? slash : `${slash} — /aibot:create, /aibot:test, /aibot:debug …`);
      else if (/not registered/i.test(slash)) report.fail("commands", "slash commands", "registerCommand() refused every command", "the game fired the startup event but rejected the schema — re-import the newest .mcaddon (a stale pack applied to this world is the usual cause)");
      else report.fail("commands", "slash commands", slash || "the startup event has not fired, so no /aibot:* command exists", "reload the world; if /aibot:help still does not autocomplete, the pack applied to this world predates slash commands — re-import the .mcaddon and re-add it");

      report.add("commands", "scriptevent bridge", String(diagnostics.scriptEvent || "").startsWith("available") ? "pass" : "warn",
        diagnostics.scriptEvent || "unbound", "only needed for /scriptevent (requires cheats); the compass menu covers the same actions without them");

      report.add("commands", "compass menu", String(diagnostics.itemUseSource || "").includes("itemUse") ? "pass" : "fail",
        diagnostics.itemUseSource || "not bound", "item-use is how the menu opens with no chat at all; if it is unbound the game is older than this pack's API level");

      report.add("commands", "tap-a-bot menu", String(diagnostics.interactSource || "").includes("playerInteractWithEntity") ? "pass" : "warn",
        diagnostics.interactSource || "not bound", "tapping the bot opens its panel; without it use §f/aibot:panel");
    }

    // ────────────────────────────────────────────────────────────── WORLD & PACK
    if (wanted("world")) {
      if (!dimension) report.fail("world", "dimension", "the script cannot reach any dimension", "reload the world");
      else report.pass("world", "dimension", `${dimension.id || "overworld"} reachable`);

      const canPersist = tryRun(() => typeof world.getDynamicProperty === "function" && typeof world.setDynamicProperty === "function", false);
      if (!canPersist) {
        report.fail("world", "world persistence", "world dynamic properties are unavailable in this host", "bot names, owners, tasks and memory are stored there, so they cannot survive a reload; some locked-down hosts block script world properties");
      } else {
        const written = tryRun(() => {
          world.setDynamicProperty("aibot:selftest", "ok");
          const value = world.getDynamicProperty("aibot:selftest");
          world.setDynamicProperty("aibot:selftest", undefined);
          return value;
        }, "<<throw>>");
        if (written === "ok") report.pass("world", "world persistence", "properties can be written and read back — the error log and bot memory survive reloads");
        else report.fail("world", "world persistence", `wrote "ok", read back ${written === "<<throw>>" ? "an exception" : JSON.stringify(written)}`, "nothing persists between sessions; reload the world and try again — another script owning the same keys can also cause this");
      }

      const EntityTypes = tryRun(() => Reflect.get(MinecraftServer, "EntityTypes"), null);
      const entityType = tryRun(() => (typeof EntityTypes?.get === "function" ? EntityTypes.get("aibot:companion") : null), null);
      if (entityType) report.pass("world", "entity type", "aibot:companion is registered by the game");
      else if (!EntityTypes || typeof EntityTypes.get !== "function") report.skip("world", "entity type", "this build exposes no EntityTypes API — the spawn probe below is the real check");
      else report.fail("world", "entity type", "the game does not know aibot:companion", "entities/companion.json was rejected: re-import AI-Bot-Bedrock-Mobile.mcaddon, keep exactly ONE AI Bot behaviour pack active and reload the world (a format_version the parser does not know silently discards the whole definition)");

      // A real spawn at the player's feet proves the entity JSON parses AND that
      // there is somewhere to stand — the two failure modes behind "no bot".
      if (dimension) {
        let spawnError = null;
        try {
          if (controller?.probe) controller.probe.suppressAutoRegister = true;
          for (let offset = 0; offset <= 2 && !probe; offset += 1) {
            const cell = { x: origin.x + 1.5, y: origin.y + offset, z: origin.z + 0.5 };
            try {
              probe = dimension.spawnEntity("aibot:companion", cell);
              // The entitySpawn event dispatches only after this run returns
              // (end of tick) — by then the boolean flag above is already
              // false again, and the probe used to be adopted as a phantom
              // bot anyway (the "auto-registered …" note logged at the exact
              // self-test tick). Recording the probe's entity id gives
              // main.js a guard that does not depend on dispatch timing.
              if (probe && controller?.probe) controller.probe.probeId = probe.id;
            }
            catch (error) { spawnError = error; }
          }
        } catch (error) {
          spawnError = spawnError || error;
        } finally {
          if (controller?.probe) controller.probe.suppressAutoRegister = false;
        }
        if (probe) {
          tryRun(() => { probe.nameTag = PROBE_NAME; });
          report.pass("world", "spawn probe", `spawned ${probe.typeId} at ${position(probe.location)} (id ${probe.id})`);
          const container = tryRun(() => probe.getComponent("minecraft:inventory")?.container, null);
          if (container?.size) report.pass("world", "bot inventory", `${container.size} slots, ${container.emptySlotsCount ?? "?"} free on a fresh bot`);
          else report.fail("world", "bot inventory", "a freshly spawned entity has no usable inventory component", "collecting and storing depend on it: the minecraft:inventory component in companion.json was rejected, or the entity is still loading — run /aibot:test once more");
        } else {
          report.fail("world", "spawn probe", describe(spawnError || "spawnEntity returned nothing"), "the scripts are running but the game refused the entity — re-import the .mcaddon, leave exactly one behaviour + one resource pack active, then reload the world");
        }
      }

      const floor = tryRun(() => dimension?.getBlock({ x: Math.floor(origin.x), y: Math.floor(origin.y) - 1, z: Math.floor(origin.z) })?.typeId, "<<none>>");
      const far = tryRun(() => dimension?.getBlock({ x: Math.floor(origin.x) + 12, y: Math.floor(origin.y), z: Math.floor(origin.z) })?.typeId, "<<none>>");
      if (!dimension) report.skip("world", "terrain access", "no dimension to read");
      else if (far === "<<none>>") report.fail("world", "terrain access", "getBlock() threw — the script cannot read blocks", "movement and mining are blind without block reads; reload the world and check the pack is applied to this dimension");
      else if (floor === "minecraft:air" || floor === "<<none>>") report.warn("world", "terrain access", `you are standing over air (12 blocks away reads ${far})`, "the chunks around you may still be loading; walk a little and run this again");
      else report.pass("world", "terrain access", `floor ${floor} · 12 blocks away ${far} — chunks are loaded and readable`);

    }

    // ──────────────────────────────────────────────────────────────── YOUR BOT
    if (wanted("bot")) {
      if (!owned.length) {
        const others = tryRun(() => controller?.all() || [], []);
        report.warn("bot", "your bot", `none registered for you${others.length ? ` (${others.map((item) => item.name).join(", ")} exist, owned by someone else)` : ""}`, `create one with §f/aibot:create Steve§e and run /aibot:test again to check it`);
      }
      for (const entry of owned.slice(0, 3)) {
        const entity = entry.entity;
        if (!isValid(entity)) {
          report.fail("bot", `${entry.name}: entity`, "registered, but its entity handle is no longer valid", `it was killed or unloaded: §f/aibot:remove ${entry.name}§e, then §f/aibot:create ${entry.name}`);
          continue;
        }
        const status = tryRun(() => readBotStatus(entity), { state: "?" });
        const owner = tryRun(() => entry.owner(), null);
        const distanceToOwner = owner ? Math.round(vectorDistance(entity.location, owner.location) * 10) / 10 : null;
        const follow = Boolean(entry.runtime?.follow);
        const plan = entry.runtime?.plan;
        const lastAction = entry.runtime?.lastAction;
        const bits = [
          `state ${status.state}`,
          `at ${position(entity.location)}`,
          distanceToOwner === null ? "owner offline" : `${distanceToOwner}m from you`,
          `follow ${follow ? "ON" : "off"}`,
          plan ? `plan "${plan.goal}" step ${(entry.runtime.planIndex || 0) + 1}/${plan.actions?.length || 0}` : "no plan",
          entry.tasks?.current ? `task ${entry.tasks.current.progress}/${entry.tasks.current.target} ${entry.tasks.current.status}` : "no task",
          `health ${Math.ceil(tryRun(() => entity.getComponent("minecraft:health").currentValue, 0))}`
        ];
        if (lastAction) bits.push(`last action ${lastAction.action} → ${lastAction.success ? "ok" : `FAILED: ${lastAction.reason || "no reason given"}`}`);
        if (entry.runtime?.lastValidation) bits.push(`validation ${String(entry.runtime.lastValidation).slice(0, 60)}`);
        const stalledFollow = distanceToOwner !== null && distanceToOwner > 3 && follow && !plan;
        report.add("bot", `${entry.name}`, stalledFollow ? "fail" : "pass", bits.join(" · "),
          stalledFollow ? "it is told to follow but is not executing any movement: see MOVEMENT below — the usual answer is that no walkable path to you exists, or the bot's tick is throwing (§f/aibot:debug log§e)" : "");

        if (owner && distanceToOwner > 2.5) {
          const route = tryRun(() => findLocalRoute(entity.dimension, entity.location, owner.location, { maxNodes: 160, maxRadius: 18 }), null);
          if (!Array.isArray(route)) report.fail("bot", `${entry.name}: route`, "pathfinding threw while routing to you", "unloaded chunks or a dimension the script cannot read; walk to the bot and run this again");
          else if (routeIsArrival(route)) report.pass("bot", `${entry.name}: route`, "already standing next to you");
          else if (route.length === 0) report.fail("bot", `${entry.name}: route`, `no walkable path from the bot to you (${distanceToOwner}m apart)`, "the bot never teleports by design: clear a path or come closer. Walls taller than one block and 2-block drops are the usual blockers");
          else report.pass("bot", `${entry.name}: route`, `${route.length} waypoint(s) to you`);
        }
      }
    }

    // ────────────────────────────────────────────────────────── MOVEMENT & MINING
    if (wanted("movement")) {
      const subject = bot || probe;
      if (!subject) report.skip("movement", "entity APIs", "no bot and no probe entity to measure");
      else {
        // setVelocity was removed in @minecraft/server 2.0.0; the movement loop
        // steers with applyImpulse (the delta of the wanted and the read
        // velocity) there. Either writer is enough — requiring setVelocity
        // made this check fail on the very builds the pack targets.
        const missing = ["getVelocity", "setRotation", "teleport"].filter((name) => tryRun(() => typeof subject[name] !== "function", true));
        const writer = tryRun(() => typeof subject.setVelocity === "function" ? "setVelocity" : typeof subject.applyImpulse === "function" ? "applyImpulse" : "", "");
        if (missing.length || !writer) {
          report.fail("movement", "entity APIs",
            `missing on the entity: ${[...missing, ...(writer ? [] : ["setVelocity/applyImpulse"])].join(", ")}`,
            "the bot cannot be steered on this build: the movement loop needs getVelocity plus setVelocity (API 1.x) or applyImpulse (API 2.x)");
        } else {
          report.pass("movement", "entity APIs", `getVelocity / ${writer} / setRotation / teleport all callable`);
        }
        const ground = tryRun(() => subject.isOnGround, "<<unreadable>>");
        report.add("movement", "ground state", ground === "<<unreadable>>" ? "warn" : "pass", `isOnGround = ${ground}`, "without it the bot cannot decide to jump; stepping is capped and never teleports");
        const standable = tryRun(() => isSafeCell(subject.dimension, subject.location), false);
        report.add("movement", "standable cell", standable ? "pass" : "warn",
          standable ? "the bot stands in an open cell with a solid floor" : "the feet/head cell is NOT standable (buried, in water, or in an unloaded chunk)",
          standable ? "" : "a bot inside blocks cannot path out on its own: §f/aibot:return §ecalls it to you, or §f/aibot:remove §eand re-create it");
      }

      if (!dimension) report.skip("movement", "runCommand (mining)", "no dimension to run on");
      else if (tryRun(() => typeof dimension.runCommand !== "function", true)) {
        report.fail("movement", "runCommand (mining)", "this build exposes no script runCommand", "verified mining (the allowlisted setblock … air destroy) cannot work here; following, drop pickup and combat still do");
      } else {
        const result = tryRun(() => dimension.runCommand("testfor @e[type=minecraft:player,c=1]").successCount, "<<throw>>");
        if (result === "<<throw>>") report.fail("movement", "runCommand (mining)", "the game refused a script command (permissions)", "turn on §fCheats§e for this world (Settings → Cheats). Without it, every script command — mining included — throws, and §f/scriptevent§e cannot be used either; §f/aibot:*§e commands and the compass menu still work");
        else report.pass("movement", "runCommand (mining)", `accepted (matched ${result} player(s)) — mining and /scriptevent are permitted`);
      }
    }

    // ─────────────────────────────────────────────────────────────── AI PROVIDER
    if (wanted("ai")) {
      const config = agent?.config || null;
      if (!config) {
        report.warn("ai", "config", "no bot, so there is no provider config to read", "the AI only plans for a bot that exists — create one, then run this again");
      } else {
        report.add("ai", "config", config.provider === "fallback" ? "warn" : "pass",
          `provider ${config.provider} · model ${config.model || "-"} · endpoint ${config.endpoint ? String(config.endpoint).slice(0, 46) : "-"}`,
          config.provider === "fallback" ? "fallback-only by design: follow, mine, collect, protect still run; nothing is broken" : "");
        const endpointOk = /^https:\/\//i.test(String(config.endpoint || ""));
        report.add("ai", "endpoint", endpointOk ? "pass" : "fail", endpointOk ? "https endpoint is set" : `endpoint is "${config.endpoint || "unset"}"`,
          endpointOk ? "" : "plain http is refused by Bedrock's network stack; use https:// and keep the exact path your proxy expects (AI_PROVIDERS.md)");
      }
      const fetchAvailable = tryRun(() => typeof globalThis.fetch === "function", false);
      report.add("ai", "outbound HTTP", fetchAvailable ? "pass" : "warn",
        fetchAvailable ? "globalThis.fetch exists in this host" : "this build's Script API exposes no fetch, so the pack cannot contact any provider",
        fetchAvailable ? "" : "expected on stable Bedrock mobile — see AI_PROVIDERS.md. It is NOT why following/movement fails; plans simply come from the deterministic fallback");
      if (deep && fetchAvailable) {
        const transport = createFetchTransport();
        const startedAt = Date.now();
        let outcome = null;
        try {
          const response = await transport({
            endpoint: config?.endpoint,
            headers: { "Content-Type": "application/json" },
            body: { model: config?.model, messages: [{ role: "user", content: "ping" }], max_tokens: 8 },
            timeoutMs: 15000
          });
          outcome = { status: "pass", detail: `answered in ${Date.now() - startedAt}ms: ${JSON.stringify(response).slice(0, 150)}` };
        } catch (error) {
          const text = describe(error, 220);
          const fix = /abort|timeout/i.test(text) ? "the endpoint did not answer within 15s — confirm the proxy is running and reachable from the device's network"
            : /401|403/.test(text) ? "the proxy refused the credentials — set the API key in the proxy (AI_PROVIDERS.md); the pack never stores one in the world"
              : /429/.test(text) ? "provider rate limit — raise aiCooldownMs or use a larger quota"
                : /failed to fetch|network|ENOTFOUND|EAI_AGAIN|ERR_.+/.test(text) ? "no route to that host from this device: DNS, firewall or a captive portal; workers.dev is sometimes blocked on mobile data"
                  : "the proxy replied, but not with what the pack needs (see AI_PROVIDERS.md response contract)";
          outcome = { status: "fail", detail: text, fix };
        }
        report.add("ai", "provider round-trip", outcome.status, outcome.detail, outcome.fix || "the reply must be JSON with choices[0].message.content holding the plan");
      } else if (fetchAvailable) {
        report.skip("ai", "provider round-trip", "not contacted — run §f/aibot:test net §7to send a real request to the endpoint");
      }
    }

    // Everything that can be answered without the player is on screen before the
    // one question that cannot: a report you have to wait for is a report that
    // never arrives when the dialog is dismissed by accident.
    report.render();
    if (wanted("world") && player && probe) {
      const before = report.rows.length;
      await visualProbe(report, { player, probe });
      if (report.rows.length > before) report.render(before);
    }
  } finally {
    // Whatever happened above: a probe left in the world would be adopted as a
    // real bot on the next entitySpawn, i.e. the check-up would create the very
    // phantom it is supposed to help diagnose.
    if (probe) tryRun(() => probe.remove());
    // The adoption guard must not outlive the probe it describes.
    if (controller?.probe) controller.probe.probeId = null;
    tryRun(() => testMode?.persist?.({ force: true }));
  }
  return report.rows;
}
