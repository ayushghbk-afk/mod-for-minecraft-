import { system, world } from "@minecraft/server";
import { BotController } from "./core/bot-controller.js";
import { handleChat } from "./chat.js";
import { isCommandMessage } from "./core/intent-parser.js";
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
  // Both the before and after itemUse signals exist on current builds, so a
  // single use of the compass must not stack two forms on top of each other.
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

/**
 * Chat is bound to exactly ONE signal so a command can never run twice.
 * `beforeEvents.chatSend` is preferred because it can hide the raw command from
 * chat; `afterEvents.chatSend` is the fallback for builds where the before
 * signal is missing. Both are wrapped: a missing signal must never stop the
 * rest of the pack from loading, because that failure is silent in game.
 */
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

safeSubscribe(world.afterEvents?.entityDie, (event) => {
  if (event.deadEntity?.typeId === "aibot:companion") controller.handleDeath(event.deadEntity);
});

// Interacting with the bot opens its panel. This only fires because the entity
// definition carries `minecraft:interact`; without that component a custom
// entity shows no interact button on touch screens and the event never happens.
safeSubscribe(world.afterEvents?.playerInteractWithEntity, (event) => {
  if (event.target?.typeId !== "aibot:companion") return;
  system.run(() => showControlPanel(event.player, controller).catch((error) => reportFailure(event.player, "Control panel", error)));
});

/**
 * No-chat fallback, which matters on mobile where chat can be awkward, muted or
 * filtered: use (hold) a compass to open the create form or the control panel.
 */
safeSubscribe(world.afterEvents?.playerSpawn, (event) => {
  if (!event.initialSpawn) return;
  system.runTimeout(() => {
    try {
      event.player.sendMessage(`§b[AI Bot v${SCRIPT_VERSION}]§r Script loaded (chat: ${chatSource.startsWith("NONE") ? "§cunavailable§r" : "§aok§r"}).`);
      event.player.sendMessage(`Type §e!aibot create Steve§r to spawn your bot, or §e!aibot help§r. Hold a §fcompass§r and use it for a menu without chat.`);
    } catch { /* player despawned during the delay */ }
  }, 10);
});

system.runTimeout(() => {
  try {
    controller.restore();
    controller.diagnostics.engineStarted = true;
    console.warn(`[aibot] restored ${controller.all().length} bot(s)`);
  } catch (error) { console.error(`[aibot] restore failed: ${error}`); }
}, 1);

controller.diagnostics.tickJob = Boolean(system.runInterval(() => {
  try { controller.tick(); } catch (error) { console.error(`[aibot] tick failed: ${error}`); }
}, 5));

// The controller is exposed only for in-world script debugging; no arbitrary
// code or command execution is exposed to AI responses.
globalThis.__aibotController = controller;

/** Test hook: forget registered bots without touching the live entities. */
export function __resetForTests() { controller.agents.clear(); }
