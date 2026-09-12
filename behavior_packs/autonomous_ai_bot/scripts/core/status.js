export const BotState = Object.freeze({
  IDLE: "IDLE",
  THINKING: "THINKING",
  FOLLOWING: "FOLLOWING",
  WALKING: "WALKING",
  SEARCHING: "SEARCHING",
  MINING: "MINING",
  COLLECTING: "COLLECTING",
  ATTACKING: "ATTACKING",
  DEFENDING: "DEFENDING",
  EATING: "EATING",
  CRAFTING: "CRAFTING",
  SMELTING: "SMELTING",
  BUILDING: "BUILDING",
  EXPLORING: "EXPLORING",
  RETURNING: "RETURNING",
  SLEEPING: "SLEEPING",
  WAITING: "WAITING",
  STUCK: "STUCK",
  RECOVERING: "RECOVERING",
  FLEEING: "FLEEING",
  ERROR: "ERROR"
});

const ICONS = Object.freeze({
  IDLE: "§7•",
  THINKING: "§b◆",
  FOLLOWING: "§a→",
  WALKING: "§a↗",
  SEARCHING: "§e⌕",
  MINING: "§6⛏",
  COLLECTING: "§d◆",
  ATTACKING: "§c⚔",
  DEFENDING: "§c⚠",
  EATING: "§e♥",
  CRAFTING: "§6▣",
  SMELTING: "§6♨",
  BUILDING: "§6▤",
  EXPLORING: "§a◇",
  RETURNING: "§a←",
  SLEEPING: "§9Z",
  WAITING: "§7…",
  STUCK: "§c!",
  RECOVERING: "§e↻",
  FLEEING: "§c←",
  ERROR: "§c!"
});

function clean(value, fallback = "") {
  return String(value ?? fallback).replace(/[\n\r]/g, " ").slice(0, 80);
}

export function formatStatus(state, details = {}) {
  const label = clean(state, BotState.IDLE);
  const resource = clean(details.block || details.target || "").replace(/^minecraft:/, "").replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  const specific = label === BotState.MINING && resource ? `MINING_${resource.toUpperCase().replace(/ /g, "_")}` : label;
  let line = `${ICONS[label] ?? "§7•"} ${specific.replace(/_/g, " ")}`;
  if (details.block && label !== BotState.MINING) line += `: ${resource}`;
  else if (details.target && label !== BotState.MINING) line += `: ${clean(details.target)}`;
  if (details.progress) line += ` ${clean(details.progress)}`;
  if (details.distance !== undefined) line += ` §8(${Math.round(Number(details.distance))}m)`;
  return line;
}

/** Updates both persistent machine-readable state and the visible name tag. */
export function setBotStatus(entity, state, details = {}) {
  const safeState = Object.values(BotState).includes(state) ? state : BotState.ERROR;
  const payload = { state: safeState, ...details, updatedAt: Date.now() };
  try {
    entity.setDynamicProperty("aibot:state", safeState);
    entity.setDynamicProperty("aibot:status", JSON.stringify(payload));
    for (const old of Object.values(BotState)) {
      if (old !== safeState && entity.hasTag?.(`aibot_state_${old.toLowerCase()}`)) {
        entity.removeTag(`aibot_state_${old.toLowerCase()}`);
      }
    }
    entity.addTag(`aibot_state_${safeState.toLowerCase()}`);
    const baseName = clean(entity.getDynamicProperty("aibot:name") || entity.nameTag || "AI Bot");
    entity.nameTag = `${baseName}\n${formatStatus(safeState, details)}`;
  } catch {
    // The entity may have been removed between a tick and this update.
  }
}

export function readBotStatus(entity) {
  try {
    const raw = entity.getDynamicProperty("aibot:status");
    return raw ? JSON.parse(String(raw)) : { state: BotState.IDLE };
  } catch {
    return { state: BotState.ERROR, reason: "status unavailable" };
  }
}
