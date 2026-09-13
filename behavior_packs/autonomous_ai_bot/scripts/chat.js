import { parseBotCommand, parseIntent } from "./core/intent-parser.js";
import { showControlPanel, showCreateBot } from "./ui/control-panel.js";
import { SCRIPT_VERSION } from "./core/version.js";
import { chatAvailable, commandHint, noBotMessage } from "./core/hints.js";
import { pickupNearbyItems } from "./core/inventory.js";

function help(player, controller) {
  const lines = [
    "§bAI Bot commands§r §8(v" + SCRIPT_VERSION + ")",
    `§e${commandHint(controller, "create Steve")}§r — create your bot`,
    "§e/aibot:create Steve§r — §fslash command§r, works on every current build (no cheats needed)",
    "§e!aibot create Steve§r — chat form, only on builds where chat events exist",
    "§e/aibot:panel§r §8(or §e!aibot panel§8§r) — status, tasks, inventory and settings",
    "§e/aibot:follow | stop | return | protect | cancel | resume§r",
    "§e/aibot:status | inventory | list | info§r, §e/aibot:remove <name>§r",
    "Talk to the bot by name — it takes tasks and chats back:",
    "  §fSteve, get me 32 oak logs§r · §fSteve, protect me§r · §fSteve, follow me§r",
    "  §fSteve, pick up items§r · §fSteve, eat§r · §fSteve, hi§r",
    "No chat on your build? Hold a §fcompass§r and use it — the menu needs no commands.",
    "Server commands stay disabled by default (§e!aibot allow on§r)."
  ];
  if (chatAvailable(controller)) {
    lines.push("§7Seeing two \"[AI Bot …] Script loaded\" banners? Two copies of this pack are active —§r");
    lines.push("§7deactivate the older AI Bot behavior pack in this world's settings, then reload the world.§r");
  }
  player.sendMessage(lines.join("\n"));
}

function reportCreate(player, result, name) {
  if (result?.created || result?.reclaimed) return true;
  const reason = result?.reason || `${name} could not be created.`;
  player.sendMessage(`§c[AI Bot] ${reason}§r`);
  if (!result?.agent) player.sendMessage("§eDiagnostics: §f/aibot:info§e (or §f!aibot info§e). If this message never appears, the script is not loading — re-import the .mcaddon and re-activate the behavior pack on this world.§r");
  return false;
}

export async function handleChat(player, message, controller) {
  const command = parseBotCommand(message);
  if (command) {
    switch (command.command) {
      case "help": help(player, controller); return true;
      case "create":
      case "spawn":
      case "new": {
        const name = command.args.join(" ") || "Steve";
        reportCreate(player, controller.create(player, name), name);
        return true;
      }
      case "list": player.sendMessage(controller.names().join(", ") || noBotMessage(controller)); return true;
      case "info":
      case "diag":
      case "diagnostics":
      case "doctor": player.sendMessage(controller.infoText()); return true;
      case "remove":
      case "despawn":
      case "delete": player.sendMessage(controller.removeByName(player, command.args.join(" "))); return true;
      case "panel": await showControlPanel(player, controller); return true;
      case "status": player.sendMessage(controller.status(player, command.args.join(" "))); return true;
      case "inventory": player.sendMessage(controller.inventory(player, command.args.join(" "))); return true;
      case "follow": {
        const agent = controller.forPlayer(player, command.args.join(" "));
        if (agent) agent.follow(); else player.sendMessage(noBotMessage(controller));
        return true;
      }
      case "stop": {
        const agent = controller.forPlayer(player, command.args.join(" "));
        if (agent) agent.stop(); else player.sendMessage(noBotMessage(controller));
        return true;
      }
      case "return": {
        const agent = controller.forPlayer(player, command.args.join(" "));
        if (agent) agent.returnHome(); else player.sendMessage(noBotMessage(controller));
        return true;
      }
      case "protect": {
        const agent = controller.forPlayer(player, command.args.join(" "));
        if (agent) agent.protect(); else player.sendMessage(noBotMessage(controller));
        return true;
      }
      case "cancel": {
        const agent = controller.forPlayer(player, command.args.join(" "));
        if (agent) agent.cancel(); else player.sendMessage(noBotMessage(controller));
        return true;
      }
      case "resume": {
        const agent = controller.forPlayer(player, command.args.join(" "));
        if (agent) agent.resume(); else player.sendMessage(noBotMessage(controller));
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
      case "say":
      case "tell":
      case "chat": {
        // !aibot say hello  — force a spoken reply from your bot
        const agent = controller.forPlayer(player);
        if (!agent) { player.sendMessage(noBotMessage(controller)); return true; }
        await agent.chatWith(player, command.args.join(" ") || "hi");
        return true;
      }
      default:
        player.sendMessage(`§eUnknown AI Bot command "§f${command.command}§e".§r`);
        help(player, controller);
        return true;
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
    case "return": agent.returnHome(); break;
    case "protect": agent.protect(); break;
    case "cancel": agent.cancel(); break;
    case "resume": agent.resume(); break;
    case "inventory": player.sendMessage(agent.inventoryText()); break;
    case "status": player.sendMessage(agent.statusText()); break;
    case "collect":
      agent.createCollectTask(intent.block, intent.count, intent.goal);
      break;
    case "pickup": {
      // Immediate vacuum + short collect plan so chat "pick up items" works.
      const result = pickupNearbyItems(agent.entity, 6);
      if (result.picked > 0) agent.say(`Picked up ${result.picked} stack(s).`, player);
      else {
        agent.runtime.plan = {
          goal: "Pick up nearby items",
          thought: "Player asked to loot drops.",
          actions: [{ type: "collect_item", count: 1 }]
        };
        agent.runtime.planIndex = 0;
        agent.say("Looking for dropped items nearby.", player);
      }
      break;
    }
    case "eat": {
      agent.engine.execute({ type: "eat_food" });
      agent.say("Eating if I have food.", player);
      break;
    }
    case "use_item": {
      agent.useHeldItem(intent.item);
      break;
    }
    case "build":
      agent.say("Building from chat is not auto-created yet — use a validated build plan.", player);
      break;
    case "chat":
      await agent.chatWith(player, intent.text || message);
      break;
    default:
      await agent.chatWith(player, intent.text || message);
  }
  return true;
}

export { showCreateBot, reportCreate };
