const BLOCK_ALIASES = Object.freeze({
  wood: "minecraft:oak_log",
  oak: "minecraft:oak_log",
  "oak logs": "minecraft:oak_log",
  "oak log": "minecraft:oak_log",
  logs: "minecraft:oak_log",
  log: "minecraft:oak_log",
  stone: "minecraft:stone",
  cobble: "minecraft:cobblestone",
  cobblestone: "minecraft:cobblestone",
  iron: "minecraft:iron_ore",
  "iron ore": "minecraft:iron_ore",
  coal: "minecraft:coal_ore",
  "coal ore": "minecraft:coal_ore",
  copper: "minecraft:copper_ore",
  "copper ore": "minecraft:copper_ore",
  gold: "minecraft:gold_ore",
  "gold ore": "minecraft:gold_ore",
  diamonds: "minecraft:diamond_ore",
  diamond: "minecraft:diamond_ore",
  "diamond ore": "minecraft:diamond_ore",
  dirt: "minecraft:dirt",
  sand: "minecraft:sand",
  gravel: "minecraft:gravel",
  redstone: "minecraft:redstone_ore",
  lapis: "minecraft:lapis_ore"
});

function clean(message) {
  return String(message || "").toLowerCase().replace(/[!?.,]/g, " ").replace(/\s+/g, " ").trim();
}

function mentionedBot(message, botNames) {
  const lower = clean(message);
  const name = [...botNames].sort((a, b) => b.length - a.length).find((candidate) => {
    const n = String(candidate).toLowerCase();
    // Match "Steve," "Steve " "hey Steve" etc.
    return lower === n || lower.startsWith(`${n} `) || lower.includes(` ${n} `) || lower.includes(` ${n}`) || lower.startsWith(`${n},`) || lower.includes(`${n},`);
  });
  return name || null;
}

function materialToBlock(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (BLOCK_ALIASES[raw]) return BLOCK_ALIASES[raw];
  const simplified = raw.replace(/\b(the|some|more|a|an|of|please|for me|me)\b/g, " ").replace(/\s+/g, " ").trim();
  if (BLOCK_ALIASES[simplified]) return BLOCK_ALIASES[simplified];
  // Try last two words ("oak logs") then last word.
  const parts = simplified.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    const two = `${parts[parts.length - 2]} ${parts[parts.length - 1]}`;
    if (BLOCK_ALIASES[two]) return BLOCK_ALIASES[two];
  }
  if (parts.length >= 1 && BLOCK_ALIASES[parts[parts.length - 1]]) return BLOCK_ALIASES[parts[parts.length - 1]];
  return raw.includes(":") ? raw : `minecraft:${raw.replace(/\s+/g, "_")}`;
}

export function parseIntent(message, botNames) {
  const bot = mentionedBot(message, botNames);
  if (!bot) return null;
  // Strip the bot name (with optional comma) from the message to get the order.
  const raw = String(message || "");
  const nameRe = new RegExp(String(bot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*,?", "i");
  const text = clean(raw.replace(nameRe, " "));
  if (!text) return { bot, type: "chat", text: "hi" };

  if (/\b(show|check|what is|open)\b.*\binventory\b/.test(text) || text === "inventory") return { bot, type: "inventory" };
  if (/\b(cancel|forget|abort)\b/.test(text)) return { bot, type: "cancel" };
  if (/\b(resume|continue)\b/.test(text)) return { bot, type: "resume" };
  if (/\b(stop|stay|wait|halt|freeze)\b/.test(text)) return { bot, type: "stop" };
  if (/\b(follow|come with me|come here|with me)\b/.test(text)) return { bot, type: "follow" };
  if (/\b(return|come back|go home|come to me)\b/.test(text)) return { bot, type: "return" };
  if (/\b(protect|defend|guard|fight for me|kill mobs)\b/.test(text)) return { bot, type: "protect" };
  if (/\b(what are you doing|status|how much more|progress|report)\b/.test(text)) return { bot, type: "status" };
  if (/\b(pick ?up|collect drops|loot|grab (the )?items?)\b/.test(text)) {
    return { bot, type: "pickup", goal: "Pick up nearby dropped items" };
  }
  if (/\b(eat|heal|use food)\b/.test(text)) return { bot, type: "eat" };
  const useMatch = text.match(/\b(?:use|equip|hold|wield)\s+(?:the\s+)?([a-z0-9_ ]+)/);
  if (useMatch) {
    const item = materialToBlock(useMatch[1].trim());
    return { bot, type: "use_item", item, goal: `Use ${item}` };
  }

  const request = text.match(/\b(?:get|collect|find|mine|gather|fetch|bring)\s+(?:me\s+)?(?:(\d+)\s+)?(.+)/);
  if (request) {
    const count = Math.max(1, Math.min(64, Number(request[1] || 1)));
    const block = materialToBlock(request[2]);
    if (/^minecraft:[a-z0-9_]+$/.test(block)) {
      return { bot, type: "collect", block, count, goal: `Collect ${count} ${block.replace("minecraft:", "")}` };
    }
  }
  if (/\b(build|make)\b/.test(text)) return { bot, type: "build", goal: text };

  // Anything else directed at the bot is free-form chat — the bot should reply.
  return { bot, type: "chat", text: raw.replace(nameRe, "").replace(/^[\s,:-]+/, "").trim() || text };
}

/**
 * Accepted spellings, because a chat command that only works when typed
 * perfectly is the most common "the mod is broken" report on mobile:
 *   !aibot create Steve   (documented)
 *   aibot create Steve    (missing prefix)
 *   !bot create Steve     (short alias)
 *   !ai create Steve      (short alias)
 *   !aibot: create Steve  (namespace-style typo)
 * A leading "/" is tolerated in the parser, but note that Bedrock intercepts
 * slash messages as game commands before chat events fire, so "/aibot ..." is
 * answered by the game with "Unknown command", never by this pack.
 */
const BARE_PREFIX = /^(?:aibot|ai[\s_-]?bot)\s*:?\s*/i;
const BANGED_PREFIX = /^[!/#.~]\s*(?:aibot|ai[\s_-]?bot|ai|bot)\s*:?\s*/i;
const COMMAND_PREFIX = new RegExp(`(?:${BARE_PREFIX.source}|${BANGED_PREFIX.source})`, "i");

export function isCommandMessage(message) {
  return COMMAND_PREFIX.test(String(message || "").trim());
}

export function parseBotCommand(message) {
  const text = String(message || "").trim();
  const match = text.match(COMMAND_PREFIX);
  if (!match) return null;
  const rest = text.slice(match[0].length).trim();
  if (!rest) return { command: "help", args: [] }; // just "!aibot" should show help, not be ignored
  const parts = rest.match(/^([^\s]+)(?:\s+(.+))?$/);
  if (!parts) return { command: "help", args: [] };
  return { command: parts[1].toLowerCase(), args: (parts[2] || "").trim().split(/\s+/).filter(Boolean) };
}
