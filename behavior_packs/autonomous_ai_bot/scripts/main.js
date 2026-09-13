import {
  CommandPermissionLevel,
  CustomCommandParamType,
  CustomCommandStatus,
  system,
  world
} from "@minecraft/server";
import { BotController } from "./core/bot-controller.js";
import { handleChat } from "./chat.js";
import { isCommandMessage, parseBotCommand } from "./core/intent-parser.js";
import { showControlPanel, showCreateBot } from "./ui/control-panel.js";
import { SCRIPT_VERSION } from "./core/version.js";
import { commandHint, talkHint } from "./core/hints.js";

export { SCRIPT_VERSION };

const controller = new BotController();
controller.diagnostics.scriptVersion = SCRIPT_VERSION;

function safeSubscribe(signal, callback) {
  try { signal?.subscribe(callback); return Boolean(signal); } catch { return false; }
}

function reportFailure(player, context, error) {
  const text = String(error?.message || error).slice(0, 220);
  console.error(`[aibot] ${context}: ${error}`);
  try { player?.sendMessage(`§c[AI Bot] ${context} failed:§r ${text}\n§eRun §f/aibot:info§e (or §f!aibot info§e) and check that the game version supports the pack.`); } catch { /* player left */ }
}

function isBotMention(message) {
  const lower = String(message || "").toLowerCase();
  return controller.names().some((name) => lower.includes(name.toLowerCase()));
}

function onChatMessage(player, message, cancelEvent) {
  if (!isCommandMessage(message) && !isBotMention(message)) return;
  if (cancelEvent) { try { cancelEvent(); } catch { /* after-events cannot be cancelled */ } }
  system.run(() => handleChat(player, message, controller).catch((error) => reportFailure(player, "Command", error)));
}

const lastUiOpen = new Map();

function openUiWithItem(player) {
  let held = "";
  try {
    // selectedSlotIndex is the stable @minecraft/server 2.9 property.
    const slot = player.selectedSlotIndex;
    held = player.getComponent("minecraft:inventory")?.container?.getItem(slot)?.typeId || "";
  } catch { held = ""; }
  if (held !== "minecraft:compass") return;
  const now = Date.now();
  if (now - (lastUiOpen.get(player.id) || 0) < 1200) return;
  lastUiOpen.set(player.id, now);
  system.run(() => {
    const task = controller.forPlayer(player)
      ? showControlPanel(player, controller)
      : showCreateBot(player, controller);
    void Promise.resolve(task).catch((error) => reportFailure(player, "Bot menu", error));
  });
}

const itemUseSource = (() => {
  const handler = (event) => { if (event.source?.typeId === "minecraft:player") openUiWithItem(event.source); };
  if (safeSubscribe(world.afterEvents?.itemUse, handler)) return "afterEvents.itemUse";
  if (safeSubscribe(world.beforeEvents?.itemUse, handler)) return "beforeEvents.itemUse";
  return "none";
})();

// --- CHAT HANDLING: Robust single subscription with fallback ---
// We prefer beforeEvents.chatSend because it can hide the command from chat.
// If that signal is missing (older builds), we fall back to afterEvents.chatSend.
// Binding both would double-execute commands, so we bind exactly one.
// This is the most common "bot not working" cause: a missing signal that fails silently.
const chatSource = (() => {
  // chatSend is absent from stable 2.9. Reflective lookup keeps chat support on
  // hosts that explicitly add that signal without importing any beta module.
  const beforeChat = Reflect.get(world.beforeEvents, "chatSend");
  if (safeSubscribe(beforeChat, (event) => {
    onChatMessage(event.sender, String(event.message || ""), () => { event.cancel = true; });
  })) return "beforeEvents.chatSend (host extension; commands hidden)";
  const afterChat = Reflect.get(world.afterEvents, "chatSend");
  if (safeSubscribe(afterChat, (event) => {
    onChatMessage(event.sender, String(event.message || ""), null);
  })) return "afterEvents.chatSend (host extension; commands visible)";
  return "NONE — chat commands are unavailable on this game build";
})();

controller.diagnostics.chatSource = chatSource;
controller.diagnostics.itemUseSource = itemUseSource;
console.warn(`[aibot] script v${SCRIPT_VERSION} loaded; chat: ${chatSource}; compass menu: ${itemUseSource}`);

// --- CUSTOM SLASH COMMANDS (/aibot:create) — the fix for "the command does nothing" ---
// Stable @minecraft/server 2.x (Bedrock 26.x) has NO chat events at all:
// world.beforeEvents.chatSend / world.afterEvents.chatSend were removed in
// 2.0.0 and are still beta-only. Chat commands like "!aibot create Steve"
// therefore never reach this script on current builds — that is what the
// "(chat: unavailable)" note means. The supported replacement is the Custom
// Commands API (stable), registered during the startup event:
//   • command names MUST be namespaced ("aibot:create", not "aibot") — a bare
//     name makes registerCommand() throw and the command silently never exists;
//   • permissionLevel Any + cheatsRequired false lets every player run them,
//     even in worlds without cheats;
//   • the callback runs in read-only mode, so all world changes are queued
//     through system.run();
//   • parameters must use CustomCommandParamType, not string type names.
const SLASH_COMMANDS = Object.freeze({
  create: { description: "Create your AI bot, e.g. /aibot:create Steve", arg: "bot name" },
  help: { description: "Show AI Bot commands" },
  panel: { description: "Open the AI Bot control panel" },
  status: { description: "Show what your AI bot is doing", arg: "bot name" },
  inventory: { description: "Show what your AI bot is carrying", arg: "bot name" },
  list: { description: "List AI bots in this world" },
  info: { description: "AI Bot diagnostics" },
  follow: { description: "Make your AI bot follow you", arg: "bot name" },
  stop: { description: "Stop your AI bot", arg: "bot name" },
  return: { description: "Call your AI bot back to you", arg: "bot name" },
  protect: { description: "Make your AI bot defend you", arg: "bot name" },
  cancel: { description: "Cancel the AI bot's current task", arg: "bot name" },
  resume: { description: "Resume a paused AI bot task", arg: "bot name" },
  remove: { description: "Despawn your AI bot", arg: "bot name" }
});

let slashCommandsReady = false;

try {
  if (system.beforeEvents?.startup) {
    system.beforeEvents.startup.subscribe((event) => {
      const registry = event?.customCommandRegistry;
      if (!registry) return;
      let registered = 0;
      for (const [action, spec] of Object.entries(SLASH_COMMANDS)) {
        const command = {
          name: `aibot:${action}`,
          description: spec.description,
          permissionLevel: CommandPermissionLevel.Any,
          cheatsRequired: false
        };
        if ("arg" in spec && spec.arg) command.optionalParameters = [{ name: "name", type: CustomCommandParamType.String }];
        try {
          registry.registerCommand(command, (origin, name) => {
            const player = origin?.sourceEntity;
            if (!player || player.typeId !== "minecraft:player") {
              return { status: CustomCommandStatus.Failure, message: "Only players can use AI Bot commands." };
            }
            const argText = String(name ?? "").trim();
            system.run(() => {
              handleChat(player, `!aibot ${action}${argText ? ` ${argText}` : ""}`, controller)
                .catch((error) => reportFailure(player, "Slash command", error));
            });
            return { status: CustomCommandStatus.Success };
          });
          registered += 1;
        } catch (error) {
          console.warn(`[aibot] could not register /aibot:${action}: ${error}`);
        }
      }
      slashCommandsReady = registered > 0;
      const total = Object.keys(SLASH_COMMANDS).length;
      controller.diagnostics.slashCommands = registered > 0
        ? `${registered}/${total} registered (/aibot:create, /aibot:help, ...)`
        : "NOT registered";
      console.warn(`[aibot] custom slash commands: ${controller.diagnostics.slashCommands}`);
    });
  }
} catch (error) {
  console.warn(`[aibot] startup event unavailable; /aibot:* slash commands cannot be registered: ${error}`);
}

// --- /scriptevent bridge (extra fallback) ---
// On worlds with cheats enabled, "/scriptevent aibot:cmd create Steve" (or
// "/scriptevent aibot:create Steve") reaches the same handler as chat.
controller.diagnostics.scriptEvent = safeSubscribe(system.afterEvents?.scriptEventReceive, (event) => {
  const id = String(event?.id || "");
  if (!id.startsWith("aibot:")) return;
  const player = event.sourceEntity;
  if (!player || player.typeId !== "minecraft:player") return;
  const args = String(event.message || "").trim().split(/\s+/).filter(Boolean);
  let action = id.slice("aibot:".length);
  if (action === "cmd" || action === "") action = args.shift() || "";
  if (!action) return;
  const text = `!aibot ${[action, ...args].join(" ")}`.trim();
  system.run(() => handleChat(player, text, controller).catch((error) => reportFailure(player, "Scriptevent command", error)));
}) ? "available (/scriptevent aibot:cmd <command> ...)" : "unavailable";

// --- DUPLICATE PACK DETECTION ---
// Importing a newer .mcaddon does NOT remove an older copy whose manifest
// UUIDs differ, and a world can end up with BOTH behavior packs active: every
// event is then handled twice by two independent script instances with two
// separate bot registries. That is what produces doubled "[AI Bot …] loaded"
// banners, two bots with the same name and the infamous "No bot is assigned
// to you" from the copy that did not create the bot. World dynamic properties
// are shared by all scripts in a world, so each instance advertises itself
// with a heartbeat and we can detect — and explain — the overlap. (An old
// copy that predates the heartbeat cannot be seen this way, which is why the
// join message also tells players what two banners mean.)
const INSTANCE_ID = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e12).toString(36)}`;
const HEARTBEAT_PREFIX = "aibot:hb:";
const HEARTBEAT_TTL_MS = 60000;

function writeHeartbeat() {
  try {
    world.setDynamicProperty(`${HEARTBEAT_PREFIX}${INSTANCE_ID}`, JSON.stringify({ v: SCRIPT_VERSION, at: Date.now() }));
  } catch { /* world properties unavailable (early execution or a Node test) */ }
}

function findOtherLiveInstance() {
  try {
    if (typeof world.getDynamicPropertyIds !== "function") return null;
    const now = Date.now();
    let other = null;
    for (const id of world.getDynamicPropertyIds()) {
      if (!id.startsWith(HEARTBEAT_PREFIX) || id === `${HEARTBEAT_PREFIX}${INSTANCE_ID}`) continue;
      let beat = null;
      try { beat = JSON.parse(String(world.getDynamicProperty(id) || "null")); } catch { beat = null; }
      if (!beat || typeof beat.at !== "number" || now - beat.at > HEARTBEAT_TTL_MS) {
        try { world.setDynamicProperty(id, undefined); } catch { /* read-only moment */ }
        continue; // dead instance — reclaim its property
      }
      other = { id: id.slice(HEARTBEAT_PREFIX.length), version: String(beat.v || "unknown"), at: beat.at };
    }
    return other;
  } catch { return null; }
}

const duplicateWarned = new Set();

function warnAboutDuplicate(other) {
  controller.diagnostics.duplicate = `DETECTED — v${other.version} is running alongside this v${SCRIPT_VERSION}`;
  // Exactly one of the two instances warns (deterministic id ordering), so
  // the player gets one clear instruction instead of two overlapping ones.
  if (!(other.id > INSTANCE_ID)) return;
  const lines = [
    `§c⚠ Two copies of the AI Bot script are running in this world§r (this one is v${SCRIPT_VERSION}, the other is v${other.version}).`,
    "§eThat causes doubled messages and §f\"No bot is assigned to you\"§e errors. Fix it:§r",
    "§fWorld Settings → Add-Ons / Behavior Packs → deactivate the older §fAutonomous AI Bot§f pack§r, then save and reload the world."
  ];
  for (const player of world.getPlayers()) {
    if (duplicateWarned.has(player.id)) continue;
    duplicateWarned.add(player.id);
    try { player.sendMessage(lines.join("\n")); } catch { /* player left */ }
  }
}

function sweepDuplicateInstances() {
  writeHeartbeat();
  const other = findOtherLiveInstance();
  if (other) warnAboutDuplicate(other);
  return other;
}

// Dynamic properties cannot be written during early execution, so the first
// heartbeat waits one tick; afterwards the tick loop keeps it fresh.
system.runTimeout(() => { sweepDuplicateInstances(); }, 1);

export function __duplicateGuardForTests() {
  return { instanceId: INSTANCE_ID, sweep: sweepDuplicateInstances, warned: duplicateWarned };
}

safeSubscribe(world.afterEvents?.entityDie, (event) => {
  if (event.deadEntity?.typeId === "aibot:companion") controller.handleDeath(event.deadEntity);
});

function autoRegisterCompanion(entity) {
  try {
    if (!entity || entity.typeId !== "aibot:companion") return;
    const hasOwner = entity.getDynamicProperty("aibot:owner_id");
    if (!hasOwner) {
      try {
        const players = world.getPlayers?.() || [];
        if (players.length) {
          const nearest = players.sort((a,b) => {
            const da = Math.hypot(a.location.x - entity.location.x, a.location.y - entity.location.y, a.location.z - entity.location.z);
            const db = Math.hypot(b.location.x - entity.location.x, b.location.y - entity.location.y, b.location.z - entity.location.z);
            return da-db;
          })[0];
          if (nearest) {
            entity.setDynamicProperty("aibot:owner_id", nearest.id);
            entity.setDynamicProperty("aibot:owner_name", nearest.name);
            entity.setDynamicProperty("aibot:name", entity.getDynamicProperty("aibot:name") || "AIBot");
            entity.setDynamicProperty("aibot:home", JSON.stringify([Math.round(nearest.location.x), Math.round(nearest.location.y), Math.round(nearest.location.z)]));
            entity.nameTag = String(entity.getDynamicProperty("aibot:name") || "AIBot");
          }
        }
      } catch {}
    }
    controller.register(entity);
    console.warn(`[aibot] auto-registered spawned entity ${entity.id}`);
  } catch {}
}

safeSubscribe(world.afterEvents?.entitySpawn, (event) => {
  autoRegisterCompanion(event.entity);
});
safeSubscribe(world.afterEvents?.entityLoad, (event) => {
  autoRegisterCompanion(event.entity);
});

safeSubscribe(world.afterEvents?.playerInteractWithEntity, (event) => {
  if (event.target?.typeId !== "aibot:companion") return;
  system.run(() => showControlPanel(event.player, controller).catch((error) => reportFailure(event.player, "Control panel", error)));
});

// --- AUTO SUMMON LIKE VERITY MOD ---
// When a player creates a world, their initialSpawn fires once. Verity mod spawns a bot automatically
// at that moment. We replicate that behavior: if the player has no bot, auto-create one named Steve/AIBot.

function isRealBedrock() {
  // In Node tests, world.getDynamicProperty is missing. In real Bedrock it exists.
  try { return typeof world.getDynamicProperty === "function" && typeof world.setDynamicProperty === "function"; } catch { return false; }
}

function hasWorldAutoSummonedFlag() {
  if (!isRealBedrock()) return false;
  try { return world.getDynamicProperty("aibot:autoSummoned") === true; } catch { return false; }
}
function setWorldAutoSummonedFlag() {
  if (!isRealBedrock()) return;
  try { world.setDynamicProperty("aibot:autoSummoned", true); } catch {}
}

function tryAutoSummon(player, reason = "initial spawn") {
  try {
    if (!player) return;
    // Safety: entity must still be valid
    try { if (!player.isValid) return; } catch (error) { return; }
    // Don't auto-summon if player already owns a bot
    if (controller.forPlayer(player)) return;
    // Don't spam if world already has many bots
    if (controller.all().length >= 8) return;
    // Choose name: try "AIBot" or "Steve", avoid collision
    let chosenName = "AIBot";
    if (controller.byName(chosenName)) {
      chosenName = "Steve";
      if (controller.byName(chosenName)) {
        chosenName = `${player.name}Bot`.slice(0, 16);
      }
    }
    const result = controller.create(player, chosenName);
    if (result?.created) {
      console.warn(`[aibot] auto-summoned ${chosenName} for ${player.name} (${reason})`);
      try {
        player.sendMessage(`§a[AI Bot] Auto-summoned ${chosenName} for you! §rLike Verity mod, your bot appears when you create a world.`);
        player.sendMessage(`§eUse §f${commandHint(controller, "help")}§e for commands, a §fcompass§e for the menu, or ${talkHint(controller, chosenName)}§e.`);
      } catch {}
      try { result.agent.follow(); } catch {}
      // Mark world as having auto-summoned at least once, so we don't spam on every reload
      // But we still allow per-player summon on initialSpawn even after this flag.
      if (reason === "worldLoadZeroBots") setWorldAutoSummonedFlag();
    } else if (result && !result.agent) {
      // A silent failure here is indistinguishable from "the whole mod is dead".
      console.warn(`[aibot] auto-summon failed for ${player.name}: ${result.reason}`);
      try { player.sendMessage(`§c[AI Bot] Auto-summon failed:§r ${result.reason}`); } catch {}
    }
  } catch (error) {
    console.error(`[aibot] auto summon failed for ${player?.name}: ${error}`);
  }
}

/**
 * What the join message should advertise, given what this game build actually
 * supports. Exported so tests can pin the wording: a welcome message that
 * tells players to type chat commands on a build without chat events is the
 * single most confusing thing this pack used to do.
 */
export function welcomeLines(chatOk, slashOk) {
  const lines = [];
  if (chatOk) {
    lines.push(`Type §e!aibot create Steve§r to spawn your bot, or §e!aibot help§r. Hold a §fcompass§r and use it for a menu without chat.`);
  } else {
    lines.push(`§eChat commands are unavailable on this game build — that is why §f!aibot …§e in chat does nothing.§r`);
    if (slashOk) lines.push(`Run §e/aibot:create Steve§r like any slash command, or hold a §fcompass§r and use it for the menu.`);
    else lines.push(`Hold a §fcompass§r and use it — the menu creates and controls a bot without any commands.`);
    lines.push(`With cheats enabled, §e/scriptevent aibot:cmd create Steve§r also works.`);
  }
  // Two banners with different versions mean two behavior packs are active at
  // once — the root cause of doubled messages and "No bot is assigned to you".
  // An old duplicate cannot be detected from script state, so say it here.
  lines.push(`§7Seeing two "[AI Bot …] Script loaded" banners? Two copies of this pack are active — deactivate the older AI Bot behavior pack in this world's settings.§r`);
  return lines;
}

// Player spawn handler: welcome + auto summon
safeSubscribe(world.afterEvents?.playerSpawn, (event) => {
  if (!event.initialSpawn) return;
  // Delay slightly to let restore complete and world load
  system.runTimeout(() => {
    try {
      const chatOk = !chatSource.startsWith("NONE");
      event.player.sendMessage(`§b[AI Bot v${SCRIPT_VERSION}]§r Script loaded (chat: ${chatOk ? "§aok§r" : "§cunavailable§r"}).`);
      for (const line of welcomeLines(chatOk, slashCommandsReady)) event.player.sendMessage(line);
      // A second copy that was already running shows up here too, so the
      // explanation arrives with the join message instead of up to a minute later.
      sweepDuplicateInstances();
    } catch { /* player despawned during the delay */ }
  }, 10);

  // Auto summon like Verity mod - delay a bit more to ensure restore finished
  system.runTimeout(() => {
    try {
      // Restore may not have finished yet on first ever world load, so call restore again if needed
      if (controller.all().length === 0) {
        try { controller.restore(); } catch {}
      }
      tryAutoSummon(event.player, "initialSpawn");
    } catch {}
  }, 60);
});

// Restore persisted bots on world load
system.runTimeout(() => {
  try {
    controller.restore();
    controller.diagnostics.engineStarted = true;
    console.warn(`[aibot] restored ${controller.all().length} bot(s)`);
    // Verity-like world creation auto summon: if world has zero bots and at least one player online,
    // and we have never auto-summoned before in this world, spawn for the first player.
    // This only runs in real Bedrock (where world dynamic properties exist), not in Node tests.
    if (isRealBedrock() && controller.all().length === 0 && !hasWorldAutoSummonedFlag()) {
      system.runTimeout(() => {
        try {
          const players = world.getPlayers?.() || [];
          if (players.length > 0) {
            tryAutoSummon(players[0], "worldLoadZeroBots");
          }
        } catch {}
      }, 40);
    }
  } catch (error) { console.error(`[aibot] restore failed: ${error}`); }
}, 1);

controller.diagnostics.tickJob = Boolean(system.runInterval(() => {
  try { controller.tick(); } catch (error) { console.error(`[aibot] tick failed: ${error}`); }
  // Heartbeat + duplicate sweep every ~15 s (this interval runs every 5 game
  // ticks and tickCount counts runs, so 60 runs = 300 ticks = 15 s); cheap,
  // and it catches a second copy being activated mid-session.
  if (controller.tickCount % 60 === 0) { try { sweepDuplicateInstances(); } catch { /* never fatal */ } }
}, 5));

// Player-like movement: the AI loop above decides WHERE each bot goes (every
// 5 ticks); this 1-tick job steers the velocity EVERY tick — accelerating,
// turning, jumping on step-ups and easing to a stop exactly like a player
// holding the movement keys. This is what makes the bot walk instead of
// getting shoved by impulses.
controller.diagnostics.movementJob = Boolean(system.runInterval(() => {
  try { controller.stepMovement(); } catch (error) { console.error(`[aibot] movement step failed: ${error}`); }
}, 1));

globalThis.__aibotController = controller;

export function __resetForTests() {
  controller.agents.clear();
  // forPlayer() now re-scans dimensions before reporting "no bot", so a test
  // reset must also clear leftover companion entities — otherwise the rescan
  // resurrects them and the bot-count guard behaves like a crowded world.
  for (const dimensionId of ["overworld", "nether", "the_end"]) {
    try { for (const entity of world.getDimension(dimensionId).getEntities({ type: "aibot:companion" })) entity.remove(); } catch { /* dimension unavailable */ }
  }
}
