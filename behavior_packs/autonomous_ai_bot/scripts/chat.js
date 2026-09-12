import { parseBotCommand, parseIntent } from "./core/intent-parser.js";
import { showControlPanel, showCreateBot } from "./ui/control-panel.js";

function help(player) {
  player.sendMessage([
    "§bAI Bot commands§r",
    "!aibot create <name> — create and own a bot",
    "!aibot panel — open status, tasks, inventory and settings",
    "!aibot status | inventory | follow | stop | return | cancel | protect | resume",
    "Natural language also works: Steve, get me 32 oak logs.",
    "Commands are disabled by default."
  ].join("\n"));
}

export async function handleChat(player, message, controller) {
  const command = parseBotCommand(message);
  if (command) {
    switch (command.command) {
      case "help": help(player); return true;
      case "create": controller.create(player, command.args.join(" ") || "Steve"); return true;
      case "spawn": controller.create(player, command.args.join(" ") || "Steve"); return true;
      case "list": player.sendMessage(controller.names().join(", ") || "No AI bots are loaded."); return true;
      case "panel": await showControlPanel(player, controller); return true;
      case "status": player.sendMessage(controller.status(player, command.args.join(" "))); return true;
      case "inventory": player.sendMessage(controller.inventory(player, command.args.join(" "))); return true;
      case "follow": {
        const agent = controller.forPlayer(player, command.args.join(" "));
        if (agent) agent.follow(); else player.sendMessage("§eNo bot is assigned to you.");
        return true;
      }
      case "stop": {
        const agent = controller.forPlayer(player, command.args.join(" "));
        if (agent) agent.stop(); else player.sendMessage("§eNo bot is assigned to you.");
        return true;
      }
      case "return": {
        const agent = controller.forPlayer(player, command.args.join(" "));
        if (agent) agent.returnHome(); else player.sendMessage("§eNo bot is assigned to you.");
        return true;
      }
      case "protect": {
        const agent = controller.forPlayer(player, command.args.join(" "));
        if (agent) agent.protect(); else player.sendMessage("§eNo bot is assigned to you.");
        return true;
      }
      case "cancel": {
        const agent = controller.forPlayer(player, command.args.join(" "));
        if (agent) agent.cancel(); else player.sendMessage("§eNo bot is assigned to you.");
        return true;
      }
      case "resume": {
        const agent = controller.forPlayer(player, command.args.join(" "));
        if (agent) agent.resume(); else player.sendMessage("§eNo bot is assigned to you.");
        return true;
      }
      case "allow": {
        const agent = controller.forPlayer(player);
        if (!agent || agent.ownerId !== player.id) { player.sendMessage("§cPermission denied."); return true; }
        agent.updateConfig({ commandsEnabled: command.args[0] === "on" });
        player.sendMessage(`Named commands are now ${agent.config.commandsEnabled ? "ON" : "OFF"}. Allowlist still applies.`);
        return true;
      }
      case "debug": {
        const agent = controller.forPlayer(player);
        if (agent) { agent.updateConfig({ debug: command.args[0] === "on" }); player.sendMessage(`Debug mode ${agent.config.debug ? "ON" : "OFF"}.`); }
        return true;
      }
      case "command": player.sendMessage(controller.runNamedCommand(player, command.args[0], command.args.slice(1))); return true;
      default: help(player); return true;
    }
  }

  const intent = parseIntent(message, controller.names());
  if (!intent) return false;
  const agent = controller.byName(intent.bot);
  if (!agent || (agent.config.ownerOnly && agent.ownerId !== player.id && agent.ownerName !== player.name)) {
    player.sendMessage("§cThat bot only accepts instructions from its owner.");
    return true;
  }
  switch (intent.type) {
    case "follow": agent.follow(); break;
    case "stop": agent.stop(); break;
    case "return": agent.returnHome(); agent.notify("Coming back."); break;
    case "protect": agent.protect(); break;
    case "cancel": agent.cancel(); break;
    case "resume": agent.resume(); break;
    case "inventory": player.sendMessage(agent.inventoryText()); break;
    case "status": player.sendMessage(agent.statusText()); break;
    case "collect": agent.createCollectTask(intent.block, intent.count, intent.goal); break;
    case "build": player.sendMessage("§eBuilding is intentionally not auto-created from chat yet; use an explicit validated build plan."); break;
    default: player.sendMessage(`Try "${agent.name}, follow me", "${agent.name}, get me 20 iron", or "!aibot panel".`);
  }
  return true;
}

export { showCreateBot };
