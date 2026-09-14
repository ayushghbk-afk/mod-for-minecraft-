import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { commandHint, talkHint } from "../core/hints.js";
import { describeTopic } from "../core/chat-brain.js";
import { runPlayerWords } from "../core/conversation.js";

function botFor(controller, player) { return controller.forPlayer(player); }

export async function showControlPanel(player, controller) {
  // forPlayer() re-scans the world before giving up, so reaching this branch
  // with no agent really means "this player controls no bot". Sending them a
  // chat command was a dead end on builds without chat events — the create
  // form works everywhere, no commands or cheats needed.
  const agent = botFor(controller, player);
  if (!agent) {
    player.sendMessage(`§eNo bot is assigned to you yet.§r Create one below, or use §f${commandHint(controller, "create Steve")}§r.`);
    return showCreateBot(player, controller);
  }
  const form = new ActionFormData()
    .title(`AI BOT — ${agent.name}`)
    // Talk is the FIRST button on purpose: on a build without chat events this
    // form is the only place a player can type to their bot, and it is what
    // "chat" means here (AC-45).
    .body(`${agent.statusText()}\n\n§7Talk to ${agent.name} below — on this build, that is chat.§r\n§7Test mode: ${controller.test?.enabled ? "§aON§r§7 — errors are printed in chat" : "§coff§r§7 — use Diagnostics below if something is wrong"}§r`)
    .button(`Talk to ${agent.name}`)
    .button("Tasks")
    .button("Inventory")
    .button("Settings")
    .button("Memory")
    .button("Diagnostics & test mode")
    .button("Close");
  const response = await form.show(player);
  if (response.canceled) return;
  if (response.selection === 0) return showTalk(player, agent);
  if (response.selection === 1) return showTasks(player, agent);
  if (response.selection === 2) return showInventory(player, agent);
  if (response.selection === 3) return showSettings(player, agent);
  if (response.selection === 4) return showMemory(player, agent);
  if (response.selection === 5) return showDiagnostics(player, controller);
}

/**
 * AC-45 — the typed conversation, on every build.
 *
 * A phone on Bedrock 26.x has no chat events and no way to type at a script, so
 * "chat is not working" is literally true until this form exists. What the player
 * types goes through `runPlayerWords()` — the same route `/aibot:talk` and a real
 * chat line take — so an order typed here creates a task and a question gets the
 * same grounded answer a chat line would.
 *
 * The box re-opens with the exchange above it, which is the difference between
 * "a text field" and a conversation. Exported because `/aibot:talk` with no
 * words, a tap on the bot and the compass menu all open this one surface.
 */
export async function showTalk(player, agent, options = {}) {
  const last = agent.runtime.lastChat;
  const lines = [];
  if (last?.asked) lines.push(`§7You: §f${String(last.asked).slice(0, 80)}§r`);
  if (last?.reply) lines.push(`§b${agent.name}:§r ${String(last.reply).split("\n").slice(0, 3).join(" · ").slice(0, 240)}`);
  else if (last?.topic === "orders") lines.push(`§b${agent.name}:§r §7on it — the order is on my task list§r`);
  else lines.push(`§7Say anything: "how are you", "where are you", "any mobs" — or give an order: "get me 16 oak logs", "mine 8 stone", "follow me".§r`);
  if (options.hint) lines.push(`§8${options.hint}§r`);
  // A modal form has no body text, so the transcript is rendered as labels above
  // the box. That is what makes the box read as the middle of a conversation.
  const form = new ModalFormData().title(`Talk to ${agent.name}`);
  for (const line of lines.slice(0, 3)) form.label(line);
  form.textField(`Message or order (§8last: ${describeTopic(last?.topic) || "nothing yet"}§8)`, "e.g. how are you / mine 8 stone", { defaultValue: "" });
  const response = await form.show(player);
  if (response.canceled || !response.formValues) return;
  const words = String(response.formValues[0] || "").trim();
  if (!words) return showControlPanel(player, agent.controller);
  // Same parser and same reply engine as /aibot:talk and a chat mention, so an
  // order typed here really becomes a task (AC-45).
  const route = await runPlayerWords(player, words, agent, agent.controller);
  // Re-open with the exchange in the body: that is what makes it read as a
  // conversation rather than a one-shot dialog.
  const hint = route === "order" ? "Order accepted — /aibot:task shows its progress."
    : route === "query" ? "That is the full report; /aibot:status prints it again any time."
    : "";
  return showTalk(player, agent, { hint });
}

/**
 * The panel is the only interface that works on every build with no chat, no
 * commands and no cheats, so the debug tooling has to be reachable from here
 * too — a player whose chat events are missing cannot type `/aibot:test`.
 */
async function showDiagnostics(player, controller) {
  const test = controller.test;
  const running = Boolean(test && test.enabled);
  const form = new ActionFormData()
    .title("Diagnostics")
    .body(`§7Errors captured: §f${test?.errorCount?.() ?? 0}§7 · warnings §f${test?.warnCount?.() ?? 0}§r\n\n§7Test mode streams every error the pack catches into chat, so a silent failure becomes a line you can read on a phone.\n§7Test mode is ${running ? "§aON" : "§coff"}§r.`)
    .button(running ? "Turn test mode OFF" : "Turn test mode ON")
    .button("Run the full self-test")
    .button("Show the error log")
    .button("Clear the error log")
    .button("Trace bot decisions for 60s")
    .button("Back");
  const response = await form.show(player);
  if (response.canceled || response.selection === 5) return showControlPanel(player, controller);
  if (response.selection === 0) { test?.setEnabled(!running, { origin: player }); return showControlPanel(player, controller); }
  if (response.selection === 1) { await test?.runSelfTest(player, controller); return showControlPanel(player, controller); }
  if (response.selection === 2) { test?.handle(player, "log", [], controller); return showControlPanel(player, controller); }
  if (response.selection === 3) { test?.clear(); player.sendMessage("§aError log cleared."); return showControlPanel(player, controller); }
  if (response.selection === 4) { test?.setWatch(60, player); return showControlPanel(player, controller); }
}

async function showTasks(player, agent) {
  const task = agent.tasks.current;
  const history = agent.tasks.history.slice(-5).map((item) => `${item.status}: ${item.goal} (${item.progress}/${item.target})`).join("\n") || "No completed task history.";
  const form = new ActionFormData().title("Tasks").body(`Current:\n${task ? `${task.status} — ${task.goal}\nProgress ${task.progress}/${task.target}` : "None"}\n\nRecent:\n${history}`).button("Cancel current task").button("Back");
  const response = await form.show(player);
  if (!response.canceled && response.selection === 0) agent.cancel();
  if (!response.canceled && response.selection === 1) return showControlPanel(player, agent.controller);
}

async function showInventory(player, agent) {
  const form = new ActionFormData().title("Inventory").body(agent.inventoryText()).button("Back");
  const response = await form.show(player);
  if (!response.canceled) return showControlPanel(player, agent.controller);
}

async function showMemory(player, agent) {
  const memory = agent.memory.snapshot();
  const body = [
    "Short-term:", ...memory.shortTerm.slice(-8).map((item) => `• ${item.text}`),
    "", "Known locations:", ...memory.locations.slice(-8).map((item) => `• ${item.name}: ${item.position.join(", ")}`),
    "", "Facts:", ...memory.facts.slice(-8).map((item) => `• ${item.text}`)
  ].join("\n");
  const form = new ActionFormData().title("Memory").body(body || "Memory is empty.").button("Back");
  const response = await form.show(player);
  if (!response.canceled) return showControlPanel(player, agent.controller);
}

async function showSettings(player, agent) {
  const config = agent.config;
  const providerIndex = ["fallback", "mideafire", "custom", "openai-compatible"].indexOf(config.provider);
  const combatIndex = ["passive", "defend_owner", "hostile_mobs", "defend_self"].indexOf(config.combatMode);
  const form = new ModalFormData()
    .title(`${agent.name} settings`)
    .dropdown("AI provider (network requires a host bridge)", ["Fallback", "Mideafire", "Custom API", "OpenAI-compatible"], { defaultValueIndex: Math.max(0, providerIndex) })
    .textField("Endpoint", "https://your-proxy.example/v1/plan", { defaultValue: config.endpoint })
    .textField("Model", "model-name", { defaultValue: config.model })
    .textField("Personality", "friendly", { defaultValue: config.personality })
    .dropdown("Combat mode", ["Passive", "Defend owner", "Hostile mobs", "Defend self"], { defaultValueIndex: Math.max(0, combatIndex) })
    .toggle("Allow named server commands", { defaultValue: config.commandsEnabled })
    .toggle("Debug mode", { defaultValue: config.debug });
  const response = await form.show(player);
  if (response.canceled || !response.formValues) return;
  const values = response.formValues;
  agent.updateConfig({
    provider: ["fallback", "mideafire", "custom", "openai-compatible"][Number(values[0])],
    endpoint: String(values[1] || ""), model: String(values[2] || ""), personality: String(values[3] || "friendly").toLowerCase(),
    combatMode: ["passive", "defend_owner", "hostile_mobs", "defend_self"][Number(values[4])],
    commandsEnabled: values[5] === true, debug: values[6] === true
  });
  player.sendMessage("§aAI bot settings saved. No API key was stored in the world.");
  return showControlPanel(player, agent.controller);
}

export async function showCreateBot(player, controller) {
  const form = new ModalFormData()
    .title("Create AI Bot")
    .textField("Bot name", "Steve", { defaultValue: "Steve" })
    .toggle("Start following", { defaultValue: true })
    .toggle("Turn on test mode (shows every error in chat)", { defaultValue: Boolean(controller.test?.enabled) });
  const response = await form.show(player);
  if (response.canceled || !response.formValues) return;
  // Checking this box is the "my bot is not working" path through the menu: the
  // spawn result and any error behind it both arrive in chat.
  if (response.formValues[2] !== undefined) controller.test?.setEnabled(response.formValues[2] === true, { announce: false, origin: player });
  const result = controller.create(player, String(response.formValues[0] || "Steve"));
  if (result?.agent && response.formValues[1]) result.agent.follow();
  if (!result?.created && !result?.reclaimed) await controller.test?.runSelfTest(player, controller);
}
