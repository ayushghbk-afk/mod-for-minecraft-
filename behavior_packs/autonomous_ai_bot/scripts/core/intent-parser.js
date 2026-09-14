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

export function materialToBlock(value) {
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

/**
 * "16 oak logs" / "a stack of stone" / "some wood" → { block, count }.
 *
 * Shared by the verb form ("get me …") and the bare request ("i need …") so
 * quantities written the way a player speaks them — a stack, a couple — are
 * understood instead of being read as the material name.
 */
const COUNT_WORDS = Object.freeze({ "a stack": 64, stack: 64, "half a stack": 32, "a couple": 2, couple: 2, "a few": 3, few: 3, some: 1, a: 1, an: 1, the: 1, of: 1 });

/** Words that mean the sentence is conversation, not an order for materials. */
const ASK_GUARD = /\b(help|know|go|talk|say|sleep|eat|fight|do|be|have|leave|stay|come|follow|stop|wait|see|play|understand|why|how|what)\b/;

function countAndMaterial(phrase) {
  let rest = String(phrase || "").toLowerCase().replace(/[.,!?]/g, " ").replace(/\s+/g, " ").trim();
  let count = null;
  const digits = rest.match(/^(\d{1,3})\s+(.*)$/);
  if (digits) { count = Math.max(1, Math.min(64, Number(digits[1]))); rest = digits[2]; }
  if (count === null) {
    for (const key of ["half a stack", "a stack", "a couple", "a few", "stack", "couple", "few"]) {
      if (rest.startsWith(`${key} `) || rest === key) {
        count = COUNT_WORDS[key];
        rest = rest.slice(key.length).replace(/^\s*(of\s+)?/, "").trim();
        break;
      }
    }
  }
  if (count === null && /^(some|a|an|the)\s+/.test(rest)) {
    count = 1;
    rest = rest.replace(/^(some|a|an|the)\s+/, "").trim();
  }
  if (!rest) return null;
  const block = materialToBlock(rest);
  if (!/^minecraft:[a-z0-9_]+$/.test(block)) return null;
  return { block, count: count ?? 1 };
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
  if (/\b(follow|come with me|with me|heel)\b/.test(text)) return { bot, type: "follow" };
  // AC-07/AC-36: "come here" walks the bot to the player once; it is not the
  // same standing order as "follow me" (which keeps re-targeting the player).
  if (/^come\b|\bcome (here|to me|over|back)\b|\b(return|go home|get back here)\b/.test(text)) return { bot, type: "come" };
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

  const request = text.match(/\b(get|collect|find|mine|gather|fetch|bring|grab|chop|cut|dig|stock up on)\s+(?:me\s+)?(.+)/);
  if (request) {
    const verb = request[1];
    const parsed = countAndMaterial(request[2]);
    if (parsed) {
      // "mine 8 stone" and "/aibot:mine stone 8" must create the same kind of
      // task, or the same words mean different things depending on how they
      // arrived (AC-03/AC-04).
      const kind = ["mine", "dig", "chop", "cut"].includes(verb) ? "mine" : "collect";
      const goal = `${kind === "mine" ? "Mine" : "Collect"} ${parsed.count} ${parsed.block.replace("minecraft:", "")}`;
      return { bot, type: kind, block: parsed.block, count: parsed.count, goal };
    }
  }
  // "I need 10 stone", "i want some oak logs" — a request with the verb left out.
  // The guard keeps plain conversation ("i want to know…", "i need help") out of
  // the task path: it only matches when the rest really names a material.
  const asked = text.match(/\b(?:i\s+)?(?:need|want|would like)\s+(?:to\s+)?(.+)/);
  if (asked && !ASK_GUARD.test(asked[1])) {
    const parsed = countAndMaterial(asked[1]);
    if (parsed) return { bot, type: "collect", block: parsed.block, count: parsed.count, goal: `Collect ${parsed.count} ${parsed.block.replace("minecraft:", "")}` };
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

/**
 * Parse "<count> <material>" (in either order, with or without the count) out
 * of a command argument list or a free-text order.
 *
 *   "16 oak logs"  → { block: "minecraft:oak_log", count: 16 }
 *   "stone"        → { block: "minecraft:stone",   count: null }
 *   "mine 8 stone" → { block: "minecraft:stone",   count: 8, verb: "mine" }
 *
 * Shared by the chat intents and the /bot:* slash commands so both spellings
 * produce the same task (AC-04, AC-14, AC-15).
 *
 * @param {string|string[]} input
 * @returns {{block:string, count:number|null, verb:string, phrase:string}}
 */
export function parseItemRequest(input) {
  const text = (Array.isArray(input) ? input.join(" ") : String(input || "")).toLowerCase().replace(/[.,!?]/g, " ").replace(/\s+/g, " ").trim();
  const verbs = ["collect", "gather", "get", "fetch", "bring", "mine", "chop", "cut", "dig", "find"];
  const tokens = text.split(" ").filter(Boolean);
  const verb = tokens.find((token) => verbs.includes(token)) || "";
  const countToken = tokens.find((token) => /^\d+$/.test(token));
  const count = countToken ? Math.max(1, Math.min(64, Number(countToken))) : null;
  const phrase = tokens
    .filter((token) => token !== verb && token !== countToken)
    .filter((token) => !["me", "some", "the", "of", "for", "please", "blocks", "block", "items", "item", "logs", "log"].includes(token) || /log/.test(token))
    .join(" ")
    .trim();
  // "oak logs" → oak_log: materialToBlock already knows the plural aliases, so
  // only the trailing "s" of an unknown word has to be handled here.
  const candidate = phrase || text;
  const block = materialToBlock(candidate.replace(/\bs$/g, ""));
  return { block, count, verb, phrase: candidate };
}

/**
 * Parse an order that arrives WITHOUT the bot's name in it — which is how every
 * supported input path other than chat works (/bot:say "collect 16 oak logs",
 * the panel's text field, /scriptevent). The name is prepended so the exact same
 * intent parser answers all of them; AC-03 must not depend on the transport.
 *
 * @param {string} text the player's words
 * @param {string} botName the bot that should treat them as an order
 */
export function parseOrder(text, botName) {
  const words = String(text || "").trim();
  if (!words) return null;
  return parseIntent(`${botName}, ${words}`, [botName]);
}
