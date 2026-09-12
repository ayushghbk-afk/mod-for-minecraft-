import { itemName, readInventory } from "./inventory.js";

const BLOCK_TYPES = new Set([
  "minecraft:oak_log", "minecraft:spruce_log", "minecraft:birch_log", "minecraft:jungle_log",
  "minecraft:acacia_log", "minecraft:dark_oak_log", "minecraft:mangrove_log", "minecraft:cherry_log",
  "minecraft:stone", "minecraft:cobblestone", "minecraft:dirt", "minecraft:grass_block",
  "minecraft:coal_ore", "minecraft:iron_ore", "minecraft:copper_ore", "minecraft:gold_ore",
  "minecraft:redstone_ore", "minecraft:lapis_ore", "minecraft:diamond_ore", "minecraft:crafting_table",
  "minecraft:chest", "minecraft:furnace"
]);
const HOSTILE = new Set(["minecraft:zombie", "minecraft:skeleton", "minecraft creeper", "minecraft:spider", "minecraft:enderman", "minecraft:witch", "minecraft:phantom"]);
const PASSIVE = new Set(["minecraft:cow", "minecraft:pig", "minecraft:sheep", "minecraft:chicken", "minecraft:villager"]);

function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
function relative(origin, point) { return [Math.round(point.x - origin.x), Math.round(point.y - origin.y), Math.round(point.z - origin.z)]; }

function scanBlocks(bot, radius) {
  const origin = bot.location;
  const blocks = [];
  const dimension = bot.dimension;
  // Build a bounded nearest-first sample. This avoids a fixed x/z loop that
  // would otherwise inspect only one side of the bot before hitting the cap.
  const offsets = [];
  for (let y = -2; y <= 4; y += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      for (let z = -radius; z <= radius; z += 1) {
        if (Math.abs(x) + Math.abs(z) <= radius + 4) offsets.push({ x, y, z, distance: Math.hypot(x, y, z) });
      }
    }
  }
  offsets.sort((a, b) => a.distance - b.distance);
  for (const offset of offsets.slice(0, 600)) {
    try {
      const block = dimension.getBlock({ x: Math.floor(origin.x + offset.x), y: Math.floor(origin.y + offset.y), z: Math.floor(origin.z + offset.z) });
      if (block && BLOCK_TYPES.has(block.typeId)) {
        blocks.push({ type: block.typeId, distance: Math.round(offset.distance * 10) / 10, relative: [offset.x, offset.y, offset.z] });
        if (blocks.length >= 96) break;
      }
    } catch { /* unloaded chunks and read-only locations are skipped */ }
  }
  return blocks.sort((a, b) => a.distance - b.distance);
}

function entityRecord(entity, origin) {
  const d = distance(origin, entity.location);
  const type = entity.typeId;
  let item;
  if (type === "minecraft:item") {
    try {
      const stack = entity.getComponent("minecraft:item")?.itemStack;
      if (stack) item = { id: stack.typeId, name: itemName(stack.typeId), count: stack.amount };
    } catch { /* ignored */ }
  }
  return {
    type,
    name: entity.nameTag || type.replace(/^minecraft:/, ""),
    distance: Math.round(d * 10) / 10,
    relative: relative(origin, entity.location),
    hostile: HOSTILE.has(type) || type.includes("creeper"),
    passive: PASSIVE.has(type),
    item
  };
}

export function makeObservation(bot, task, memory, config) {
  const radius = Number(config?.observationRadius || 8);
  const origin = bot.location;
  let nearbyEntities = [];
  try {
    nearbyEntities = bot.dimension.getEntities({ location: origin, maxDistance: radius })
      .filter((entity) => entity !== bot)
      .slice(0, 32)
      .map((entity) => entityRecord(entity, origin));
  } catch { /* invalid entity or unavailable chunk */ }
  const threats = nearbyEntities.filter((entity) => entity.hostile).sort((a, b) => a.distance - b.distance);
  return {
    timestamp: Date.now(),
    position: [Math.floor(origin.x), Math.floor(origin.y), Math.floor(origin.z)],
    dimension: bot.dimension.id,
    nearbyBlocks: scanBlocks(bot, Math.min(12, Math.max(4, radius))),
    nearbyEntities,
    threats,
    inventory: readInventory(bot),
    task: task ? { id: task.id, goal: task.goal, status: task.status, progress: task.progress, target: task.target, remaining: task.remaining } : null,
    memory: memory?.promptContext(task) || null
  };
}

export function nearestObservedBlock(observation, typeId) {
  return observation?.nearbyBlocks?.find((block) => block.type === typeId) || null;
}
