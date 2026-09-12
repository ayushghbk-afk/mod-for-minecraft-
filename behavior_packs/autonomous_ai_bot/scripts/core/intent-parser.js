const BLOCK_ALIASES = Object.freeze({
  wood: "minecraft:oak_log",
  oak: "minecraft:oak_log",
  "oak logs": "minecraft:oak_log",
  logs: "minecraft:oak_log",
  stone: "minecraft:stone",
  iron: "minecraft:iron_ore",
  "iron ore": "minecraft:iron_ore",
  coal: "minecraft:coal_ore",
  copper: "minecraft:copper_ore",
  gold: "minecraft:gold_ore",
  diamonds: "minecraft:diamond_ore",
  diamond: "minecraft:diamond_ore"
});

function clean(message) {
  return String(message || "").toLowerCase().replace(/[!?.,]/g, " ").replace(/\s+/g, " ").trim();
}

function mentionedBot(message, botNames) {
  const lower = clean(message);
  const name = [...botNames].sort((a, b) => b.length - a.length).find((candidate) => lower.includes(String(candidate).toLowerCase()));
  return name || null;
}

function materialToBlock(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (BLOCK_ALIASES[raw]) return BLOCK_ALIASES[raw];
  const simplified = raw.replace(/\b(the|some|more)\b/g, "").trim();
  if (BLOCK_ALIASES[simplified]) return BLOCK_ALIASES[simplified];
  return raw.includes(":") ? raw : `minecraft:${raw.replace(/\s+/g, "_")}`;
}

export function parseIntent(message, botNames) {
  const bot = mentionedBot(message, botNames);
  if (!bot) return null;
  const text = clean(message).replace(clean(bot), "").trim();
  if (/\b(show|check|what is)\b.*\binventory\b/.test(text)) return { bot, type: "inventory" };
  if (/\b(cancel|forget|abort)\b/.test(text)) return { bot, type: "cancel" };
  if (/\b(resume|continue)\b/.test(text)) return { bot, type: "resume" };
  if (/\b(stop|stay|wait)\b/.test(text)) return { bot, type: "stop" };
  if (/\b(follow|come with me)\b/.test(text)) return { bot, type: "follow" };
  if (/\b(return|come back|go home)\b/.test(text)) return { bot, type: "return" };
  if (/\b(protect|defend|guard)\b/.test(text)) return { bot, type: "protect" };
  if (/\b(what are you doing|status|how much more|progress)\b/.test(text)) return { bot, type: "status" };
  const request = text.match(/\b(?:get|collect|find|mine)\s+(?:me\s+)?(?:(\d+)\s+)?(.+)/);
  if (request) {
    const count = Math.max(1, Math.min(64, Number(request[1] || 1)));
    const block = materialToBlock(request[2]);
    if (block === "minecraft:oak_log" || BLOCK_ALIASES[request[2]]) {
      return { bot, type: "collect", block, count, goal: `Collect ${count} ${block.replace("minecraft:", "")}` };
    }
    if (/^[a-z0-9_]+:[a-z0-9_]+$/.test(block) || /^[a-z0-9_]+$/.test(block)) {
      return { bot, type: "collect", block, count, goal: `Collect ${count} ${block.replace("minecraft:", "")}` };
    }
  }
  if (/\b(build|make)\b/.test(text)) return { bot, type: "build", goal: text };
  return { bot, type: "unknown" };
}

export function parseBotCommand(message) {
  const match = String(message || "").trim().match(/^!aibot\s+([^\s]+)(?:\s+(.+))?$/i);
  if (!match) return null;
  return { command: match[1].toLowerCase(), args: (match[2] || "").trim().split(/\s+/).filter(Boolean) };
}
