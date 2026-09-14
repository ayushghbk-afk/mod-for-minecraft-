/**
 * CONVERSATION — one handler for every way a player's words can reach the bot.
 *
 * Android/iOS Bedrock 26.x has no chat events, so the pack exposes three text
 * transports: the `/aibot:talk` (and `/aibot:say`) slash command, the Talk form
 * on the compass/bot panel, and — on hosts that still have them or through
 * `/scriptevent` — real chat lines. They must all behave identically, or
 * "chat works here but not there" becomes its own bug report (AC-03, AC-45).
 *
 * This module owns that single path:
 *   1. a sentence that names a job ("get me 16 oak logs") becomes a real,
 *      verified task through the deterministic engine, and
 *   2. everything else becomes a spoken reply from `core/chat-brain.js`.
 *
 * It is UI-free and chat-free on purpose — `chat.js` and `ui/control-panel.js`
 * both import it, and a cycle between those two would resolve to `undefined`
 * under the Bedrock module loader.
 */

import { parseOrder } from "./intent-parser.js";
import { pickupNearbyItems } from "./inventory.js";

/**
 * Execute one parsed intent. Shared by the chat path, the slash commands and the
 * panel so a player gets identical behaviour whichever transport this build
 * supports.
 *
 * @param {any} player
 * @param {any} intent
 * @param {any} agent
 * @param {any} controller
 */
export async function handleIntent(player, intent, agent, controller) {
  switch (intent.type) {
    case "follow": agent.follow(); break;
    case "stop": agent.stop(); break;
    case "come": agent.comeTo(player); break;
    case "return": agent.returnHome(); break;
    case "protect": agent.protect(); break;
    case "cancel": agent.cancel(); break;
    case "resume": agent.resume(); break;
    // Informational answers are returned as well as printed: the Talk box shows
    // the exchange back to the player, and a card the bot never "said" would
    // make that transcript lie.
    case "inventory": { const card = agent.inventoryText(); player.sendMessage(card); return { kind: "info", topic: "inventory", reply: card }; }
    case "status": { const card = agent.statusText(); player.sendMessage(card); return { kind: "info", topic: "status", reply: card }; }
    case "task": { const card = agent.taskText(); player.sendMessage(card); return { kind: "info", topic: "task", reply: card }; }
    case "mine":
      agent.mineTask(intent.block, intent.count ?? 8, intent.goal);
      break;
    case "collect":
      agent.createCollectTask(intent.block, intent.count, intent.goal);
      break;
    case "pickup": {
      // Immediate vacuum + short collect plan so "pick up items" works.
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
      // AC-20/AC-21: eat when it makes sense, and say so plainly when there is
      // nothing to eat instead of promising a meal that cannot happen.
      agent.eatOnDemand(player);
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
      await agent.chatWith(player, intent.text || "");
      return { kind: "chat" };
    default:
      await agent.chatWith(player, intent.text || "");
      return { kind: "chat" };
  }
  return { kind: "action" };
}

/**
 * Run a line the player typed, without the bot's name in it.
 *
 * @param {any} player
 * @param {string} words the player's words
 * @param {any} agent the bot those words are addressed to
 * @param {any} controller
 * @returns {Promise<"order"|"query"|"chat">} which route the words took
 */
export async function runPlayerWords(player, words, agent, controller) {
  const text = String(words || "").trim();
  const intent = parseOrder(text, agent.name);
  // A sentence that carries a verifiable job becomes that job; everything else
  // is a conversation. The parser is the same one chat mentions use, so
  // "mine 8 stone" typed into the panel and typed in chat do the same thing.
  if (text && intent && intent.type !== "chat") {
    const outcome = await handleIntent(player, intent, agent, controller);
    if (outcome?.kind === "info") {
      agent.noteAnswer(text, outcome.reply, outcome.topic);
      return "query";
    }
    agent.noteOrder(text);
    return "order";
  }
  await agent.chatWith(player, text);
  return "chat";
}
