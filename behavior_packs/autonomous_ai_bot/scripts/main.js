import { system, world } from "@minecraft/server";
import { BotController } from "./core/bot-controller.js";
import { handleChat } from "./chat.js";
import { isCommandMessage, parseBotCommand } from "./core/intent-parser.js";
import { showControlPanel, showCreateBot } from "./ui/control-panel.js";
import { SCRIPT_VERSION } from "./core/version.js";

export { SCRIPT_VERSION };

const controller = new BotController();
controller.diagnostics.scriptVersion = SCRIPT_VERSION;

function safeSubscribe(signal, callback) {
  try { signal?.subscribe(callback); return Boolean(signal); } catch { return false; }
}

function reportFailure(player, context, error) {
  const text = String(error?.message || error).slice(0, 220);
  console.error(`[aibot] ${context}: ${error}`);
  try { player?.sendMessage(`§c[AI Bot] ${context} failed:§r ${text}\n§eRun §f!aibot info§e and check that the game version supports the pack.`); } catch { /* player left */ }
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
  try { held = player.getComponent("minecraft:inventory")?.container?.getItem(player.selectedSlotIndex ?? 0)?.typeId || ""; } catch { held = ""; }
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
  if (safeSubscribe(world.beforeEvents?.chatSend, (event) => {
    onChatMessage(event.sender, String(event.message || ""), () => { event.cancel = true; });
  })) return "beforeEvents.chatSend (commands are hidden from chat)";
  if (safeSubscribe(world.afterEvents?.chatSend, (event) => {
    onChatMessage(event.sender, String(event.message || ""), null);
  })) return "afterEvents.chatSend (commands stay visible in chat)";
  return "NONE — chat commands are unavailable on this game build";
})();

controller.diagnostics.chatSource = chatSource;
controller.diagnostics.itemUseSource = itemUseSource;
console.warn(`[aibot] script v${SCRIPT_VERSION} loaded; chat: ${chatSource}; compass menu: ${itemUseSource}`);

// --- CUSTOM SLASH COMMAND SUPPORT (/aibot) like Verity ---
// Bedrock 1.21+ supports custom commands via startup event. We register /aibot as a custom command
// so players who type slash instead of ! still get the bot. This fixes the common "command not working" report.
let customCommandRegistered = false;
try {
  if (system.beforeEvents?.startup) {
    system.beforeEvents.startup.subscribe((event) => {
      try {
        const registry = event.customCommandRegistry || event.customCommandRegistry; // compat
        // Try new API: event.customCommandRegistry
        const cmdReg = event.customCommandRegistry || event.customCommandRegistry;
        // Different versions expose it as event.customCommandRegistry or event.customCommandRegistry
        // We attempt to register; if API missing, this will throw and be caught.
        const reg = event.customCommandRegistry || event.customCommandRegistry || event.customCommandRegistry;
        // Actually use the official API if present
        if (event.customCommandRegistry) {
          event.customCommandRegistry.registerCommand(
            {
              name: "aibot",
              description: "AI Bot commands: create, help, panel, status, etc.",
              permissionLevel: 0,
              cheats: "never",
              mandatoryParameters: [],
              optionalParameters: [
                { name: "action", type: "String" },
                { name: "name", type: "String" }
              ]
            },
            (origin, action, name) => {
              const player = origin?.sourceEntity;
              if (!player || player.typeId !== "minecraft:player") {
                return { status: 1, message: "Only players can use AI Bot commands." };
              }
              // Reconstruct chat-like command for existing handler
              const cmdText = `!aibot ${action || ""} ${name || ""}`.trim();
              system.run(() => {
                handleChat(player, cmdText, controller).catch((e) => reportFailure(player, "Slash command", e));
              });
              return { status: 0 };
            }
          );
          customCommandRegistered = true;
          console.warn("[aibot] custom slash command /aibot registered");
        }
      } catch (e) {
        console.warn(`[aibot] custom command registration failed (API may not be available on this version): ${e}`);
      }
    });
  }
} catch { /* startup event not available */ }

// Fallback for older API: try customCommandRegistry via world.beforeEvents? Some builds use system
try {
  // Also try the newer system-based custom command API if available
  if (!customCommandRegistered && world.afterEvents?.customCommand) {
    safeSubscribe(world.afterEvents.customCommand, (event) => {
      try {
        if (event.command !== "aibot") return;
        const player = event.sourceEntity;
        if (!player) return;
        const action = event.parameters?.[0]?.value || "";
        const name = event.parameters?.[1]?.value || "";
        const cmdText = `!aibot ${action} ${name}`.trim();
        system.run(() => handleChat(player, cmdText, controller).catch((e) => reportFailure(player, "Custom command", e)));
      } catch {}
    });
    console.warn("[aibot] subscribed to afterEvents.customCommand for /aibot");
  }
} catch {}

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
    try { if (player.removed) return; } catch {}
    try { if (typeof player.isValid === "function" && !player.isValid()) return; } catch {}
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
        player.sendMessage(`§eUse §f!aibot help §efor commands, §fcompass§e for menu, or say §f\"${chosenName}, follow me\"§e.`);
      } catch {}
      try { result.agent.follow(); } catch {}
      // Mark world as having auto-summoned at least once, so we don't spam on every reload
      // But we still allow per-player summon on initialSpawn even after this flag.
      if (reason === "worldLoadZeroBots") setWorldAutoSummonedFlag();
    }
  } catch (error) {
    console.error(`[aibot] auto summon failed for ${player?.name}: ${error}`);
  }
}

// Player spawn handler: welcome + auto summon
safeSubscribe(world.afterEvents?.playerSpawn, (event) => {
  if (!event.initialSpawn) return;
  // Delay slightly to let restore complete and world load
  system.runTimeout(() => {
    try {
      event.player.sendMessage(`§b[AI Bot v${SCRIPT_VERSION}]§r Script loaded (chat: ${chatSource.startsWith("NONE") ? "§cunavailable§r" : "§aok§r"}).`);
      event.player.sendMessage(`Type §e!aibot create Steve§r to spawn your bot, or §e!aibot help§r. Hold a §fcompass§r and use it for a menu without chat.`);
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
}, 5));

globalThis.__aibotController = controller;

export function __resetForTests() { controller.agents.clear(); }
