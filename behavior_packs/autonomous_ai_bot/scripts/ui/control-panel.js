import { ActionFormData, ModalFormData } from "@minecraft/server-ui";

function botFor(controller, player) { return controller.forPlayer(player); }

export async function showControlPanel(player, controller) {
  const agent = botFor(controller, player);
  if (!agent) { player.sendMessage("§eNo bot is assigned to you. Use §f!aibot create Steve§e."); return; }
  const form = new ActionFormData()
    .title(`AI BOT — ${agent.name}`)
    .body(agent.statusText())
    .button("Tasks")
    .button("Inventory")
    .button("Settings")
    .button("Memory")
    .button("Close");
  const response = await form.show(player);
  if (response.canceled) return;
  if (response.selection === 0) return showTasks(player, agent);
  if (response.selection === 1) return showInventory(player, agent);
  if (response.selection === 2) return showSettings(player, agent);
  if (response.selection === 3) return showMemory(player, agent);
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
    .dropdown("AI provider (network requires a host bridge)", ["Fallback", "Mideafire", "Custom API", "OpenAI-compatible"], Math.max(0, providerIndex))
    .textField("Endpoint", "https://your-proxy.example/v1/plan", config.endpoint)
    .textField("Model", "model-name", config.model)
    .textField("Personality", "friendly", config.personality)
    .dropdown("Combat mode", ["Passive", "Defend owner", "Hostile mobs", "Defend self"], Math.max(0, combatIndex))
    .toggle("Allow named server commands", config.commandsEnabled)
    .toggle("Debug mode", config.debug);
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
  const form = new ModalFormData().title("Create AI Bot").textField("Bot name", "Steve", "Steve").toggle("Start following", true);
  const response = await form.show(player);
  if (response.canceled || !response.formValues) return;
  const result = controller.create(player, String(response.formValues[0] || "Steve"));
  if (result?.agent && response.formValues[1]) result.agent.follow();
}
