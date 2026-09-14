import { parseBotCommand, parseIntent } from "./core/intent-parser.js";
import { handleIntent, runPlayerWords } from "./core/conversation.js";
import { showControlPanel, showCreateBot, showTalk } from "./ui/control-panel.js";
import { SCRIPT_VERSION } from "./core/version.js";
import { chatAvailable, commandHint, noBotMessage, talkHint } from "./core/hints.js";

function help(player, controller) {
  const lines = [
    "§bAI Bot commands§r §8(v" + SCRIPT_VERSION + ")",
    `§e${commandHint(controller, "create Steve")}§r — create your bot`,
    "§e/aibot:create Steve§r — §fslash command§r, works on every current build (no cheats needed)",
    "§e!aibot create Steve§r — chat form, only on builds where chat events exist",
    "§e/aibot:panel§r §8(or §e!aibot panel§8§r) — status, tasks, inventory and settings",
    "§e/aibot:follow | stop | return | protect | cancel | resume§r",
    "§e/aibot:status | inventory | list | info§r, §e/aibot:remove <name>§r",
    "§bTalk to it — this is chat on this build:§r",
    `  §e${commandHint(controller, "talk how are you")}§r — it answers with live status`,
    `  §e${commandHint(controller, "talk get me 32 oak logs")}§r — a real, verified task`,
    `  §e${commandHint(controller, "talk protect me")}§r · §e${commandHint(controller, "talk pick up items")}§r`,
    `  §7Or hold a §fcompass§r → §fTalk to <name>§r — a text box, no commands needed§r`,
    chatAvailable(controller) ? "  §7On this build you can also just say §fSteve, how are you§7 in chat.§r" : "  §7Typing in the game's chat box reaches nobody: Mojang removed the chat script events.§r",
    "§e/aibot:debug on§r — test mode: every error the pack catches is printed here, live",
    "§e/aibot:debug log§r — the captured errors (§e/aibot:debug clear§r empties them)",
    "§e/aibot:test§r — check-up of chat, commands, entity, model, movement, mining and persistence",
    "No chat on your build? Hold a §fcompass§r and use it — the menu needs no commands.",
    "Server commands stay disabled by default (§e!aibot allow on§r)."
  ];
  if (chatAvailable(controller)) {
    lines.push("§7Seeing two \"[AI Bot …] Script loaded\" banners? Two copies of this pack are active —§r");
    lines.push("§7deactivate the older AI Bot behavior pack in this world's settings, then reload the world.§r");
  }
  player.sendMessage(lines.join("\n"));
}

/**
 * `!aibot debug <bot>` historically toggled the per-bot debug dump. Test mode
 * owns the `debug` verb now, so the old spelling is still reachable as
 * `!aibot debug bot on|off` when a caller wants only the bot's own dump.
 */
function legacyPerBotDebug(player, controller, args) {
  if (args[0] !== "bot") return false;
  const agent = controller.forPlayer(player);
  if (!agent) { player.sendMessage("No bot is assigned to you."); return true; }
  agent.updateConfig({ debug: args[1] !== "off" });
  player.sendMessage(`Per-bot debug dump ${agent.config.debug ? "ON" : "OFF"} — state, target, plan and validation every 5 s.`);
  return true;
}

function reportCreate(player, result, name) {
  if (result?.created || result?.reclaimed) return true;
  const reason = result?.reason || `${name} could not be created.`;
  player.sendMessage(`§c[AI Bot] ${reason}§r`);
  if (!result?.agent) player.sendMessage("§eRun §f/aibot:test§e — it checks the entity, the packs, the events and the tick loop, and prints what is broken. If this message never appears, the script is not loading: re-import the .mcaddon and re-activate the behavior pack on this world.§r");
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
      // --- TEST MODE: the switch that makes every hidden error visible ---
      case "debug":
      case "testmode": {
        // The harness owns this verb; it degrades to the old per-bot dump when
        // a host somehow has no test mode (SILENT_TEST.handle() returns false).
        const handled = await controller.test.handle(player, command.args[0] || "status", command.args.slice(1), controller);
        if (!handled) legacyPerBotDebug(player, controller, command.args);
        return true;
      }
      case "test":
      case "selftest":
      case "self-test": {
        const handled = await controller.test.handle(player, "test", command.args, controller);
        if (!handled) player.sendMessage("§cTest mode is not loaded on this build, so the check-up is unavailable. §e/aibot:info §eshows what the script can see.");
        return true;
      }
      case "errors":
      case "errorlog": {
        const handled = controller.test.handle(player, "log", command.args, controller);
        if (!handled) player.sendMessage("§cNo error log is available on this build.");
        return true;
      }
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
      case "return":
      case "come": {
        // AC-36: "come" walks the bot to whoever asked; "return" is the same
        // trip with the owner as the destination. Both keep the task paused with
        // a reason instead of dropping it (AC-28).
        const agent = controller.forPlayer(player, command.command === "come" ? "" : command.args.join(" "));
        if (!agent) { player.sendMessage(noBotMessage(controller)); return true; }
        if (command.command === "come") agent.comeTo(player); else agent.returnHome();
        return true;
      }
      case "mine": {
        // AC-14: /bot mine stone [count] — real blocks, verified, with the tool
        // check done up front so an impossible request is refused in words.
        player.sendMessage(controller.mine(player, command.args));
        return true;
      }
      case "collect":
      case "gather":
      case "get": {
        // AC-04/AC-15: the same task the natural-language order creates.
        player.sendMessage(controller.collect(player, command.args));
        return true;
      }
      case "task":
      case "tasks":
      case "objective": {
        // AC-04: show the objective card (task / target / required / progress).
        player.sendMessage(controller.task(player, command.args.join(" ")));
        return true;
      }
      case "eat":
      case "food": {
        // AC-21: one attempt, one honest answer — no retry loop.
        const agent = controller.forPlayer(player);
        if (!agent) { player.sendMessage(noBotMessage(controller)); return true; }
        agent.eatOnDemand(player);
        return true;
      }
      case "acceptance":
      case "ac": {
        // AC-01..AC-45: run the in-world acceptance check-up.
        const handled = await controller.test.handle(player, "acceptance", command.args, controller);
        if (!handled) player.sendMessage("§cThe acceptance runner is not loaded on this build.§r");
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
      case "command": player.sendMessage(controller.runNamedCommand(player, command.args[0], command.args.slice(1))); return true;
      case "talk":
      case "say":
      case "tell":
      case "chat":
      case "ask": {
        // AC-03/AC-45 on a build with no chat events: this is how a player
        // *talks* to the bot. The words go through the exact same parser as a
        // chat mention, so "/bot:talk get me 16 oak logs" creates the task and
        // "/bot:talk how are you" gets a grounded spoken answer. With no words
        // at all it opens the text form — a chat box, on any build.
        await talkToBot(player, command.args.join(" "), controller);
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

  await handleIntent(player, intent, agent, controller);
  return true;
}

/**
 * The single "player typed something at their bot" entry point.
 *
 * Used by `/aibot:talk`, `/aibot:say`, the panel's Talk form and (with the words
 * already parsed out of the sentence) by chat mentions. Kept here rather than in
 * `core/conversation.js` because opening the Talk form is a UI decision, and the
 * panel imports that core module itself.
 *
 * @param {any} player
 * @param {string} words
 * @param {any} controller
 * @returns {Promise<boolean>} whether a bot was there to hear it
 */
export async function talkToBot(player, words, controller) {
  const agent = controller.forPlayer(player);
  if (!agent) { player.sendMessage(noBotMessage(controller)); return false; }
  const text = String(words || "").trim();
  if (!text) { await showTalk(player, agent); return true; }
  await runPlayerWords(player, text, agent, controller);
  return true;
}

export { showCreateBot, reportCreate };
