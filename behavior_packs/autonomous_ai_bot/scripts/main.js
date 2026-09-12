import { system, world } from "@minecraft/server";
import { BotController } from "./core/bot-controller.js";
import { handleChat, showCreateBot } from "./chat.js";
import { showControlPanel } from "./ui/control-panel.js";

const controller = new BotController();

function safeSubscribe(signal, callback) {
  try { signal?.subscribe(callback); return Boolean(signal); } catch { return false; }
}

function isBotMention(message) {
  const lower = String(message || "").toLowerCase();
  return controller.names().some((name) => lower.includes(name.toLowerCase()));
}

safeSubscribe(world.beforeEvents?.chatSend || world.afterEvents?.chatSend, (event) => {
  const message = String(event.message || "");
  if (!message.toLowerCase().startsWith("!aibot") && !isBotMention(message)) return;
  if ("cancel" in event) event.cancel = true;
  system.run(() => void handleChat(event.sender, message, controller));
});

safeSubscribe(world.afterEvents?.entityDie, (event) => {
  if (event.deadEntity?.typeId === "aibot:companion") controller.handleDeath(event.deadEntity);
});

safeSubscribe(world.afterEvents?.playerInteractWithEntity, (event) => {
  if (event.target?.typeId !== "aibot:companion") return;
  system.run(() => void showControlPanel(event.player, controller));
});

safeSubscribe(world.afterEvents?.playerSpawn, (event) => {
  if (!event.initialSpawn) return;
  system.runTimeout(() => event.player.sendMessage("§bAI Bot§r ready. Use §e!aibot create Steve§r and §e!aibot help§r."), 10);
});

system.runTimeout(() => controller.restore(), 1);
system.runInterval(() => controller.tick(), 5);

// The controller is exposed only for in-world script debugging; no arbitrary
// code or command execution is exposed to AI responses.
globalThis.__aibotController = controller;
