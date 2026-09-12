import { itemName, readInventory } from "./inventory.js";

const BLOCK_TYPES = new Set([
  "minecraft:oak_log", "minecraft:spruce_log", "minecraft:birch_log", "minecraft:jungle_log", "minecraft:acacia_log", "minecraft:dark_oak_log", "minecraft:mangrove_log", "minecraft:cherry_log",
  "minecraft:stone", "minecraft:cobblestone", "minecraft:deepslate", "minecraft:cobbled_deepslate", "minecraft:dirt", "minecraft:grass_block", "minecraft:sand", "minecraft:gravel",
  "minecraft:coal_ore", "minecraft:deepslate_coal_ore", "minecraft:iron_ore", "minecraft:deepslate_iron_ore", "minecraft:copper_ore", "minecraft:deepslate_copper_ore",
  "minecraft:gold_ore", "minecraft:deepslate_gold_ore", "minecraft:redstone_ore", "minecraft:deepslate_redstone_ore", "minecraft:lapis_ore", "minecraft:deepslate_lapis_ore",
  "minecraft:diamond_ore", "minecraft:deepslate_diamond_ore", "minecraft:crafting_table", "minecraft:chest", "minecraft:trapped_chest", "minecraft:furnace"
]);
const HOSTILE = new Set(["minecraft:zombie", "minecraft:husk", "minecraft:drowned", "minecraft:skeleton", "minecraft:stray", "minecraft:creeper", "minecraft:spider", "minecraft:cave_spider", "minecraft:enderman", "minecraft:witch", "minecraft:phantom", "minecraft:pillager", "minecraft:vindicator", "minecraft:ravager", "minecraft:slime", "minecraft:magma_cube"]);
const FRIENDLY = new Set(["minecraft:cow", "minecraft:pig", "minecraft:sheep", "minecraft:chicken", "minecraft:villager", "minecraft:wandering_trader", "minecraft:wolf", "minecraft:cat", "minecraft:horse"]);

function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
function relative(origin, point) { return [Math.round(point.x - origin.x), Math.round(point.y - origin.y), Math.round(point.z - origin.z)]; }
function direction(origin, point) {
  const dx = point.x - origin.x, dz = point.z - origin.z;
  const angle = (Math.atan2(-dx, dz) * 180 / Math.PI + 360) % 360;
  const names = ["south", "southwest", "west", "northwest", "north", "northeast", "east", "southeast"];
  return { compass: names[Math.round(angle / 45) % 8], yaw: Math.round(angle), vector: relative(origin, point) };
}
function health(entity) {
  try {
    const value = entity.getComponent("minecraft:health");
    return value ? { current: Math.round(value.currentValue * 10) / 10, max: Math.round(value.effectiveMax * 10) / 10 } : undefined;
  } catch (error) { return undefined; }
}

function scanBlocks(bot, radius) {
  const origin = bot.location, found = [], dimension = bot.dimension, offsets = [];
  for (let y = -3; y <= 4; y += 1) for (let x = -radius; x <= radius; x += 1) for (let z = -radius; z <= radius; z += 1) {
    const d = Math.hypot(x, y, z);
    if (d <= radius) offsets.push({ x, y, z, d });
  }
  offsets.sort((a, b) => a.d - b.d);
  // 360 reads per observation is bounded and practical on mobile. Relevant
  // task scans run once per configured interval, never every game tick.
  for (const offset of offsets.slice(0, 360)) {
    try {
      const position = { x: Math.floor(origin.x + offset.x), y: Math.floor(origin.y + offset.y), z: Math.floor(origin.z + offset.z) };
      const value = dimension.getBlock(position);
      if (value && BLOCK_TYPES.has(value.typeId)) found.push({ id: value.typeId, type: value.typeId, position: [position.x, position.y, position.z], relative: [offset.x, offset.y, offset.z], distance: Math.round(offset.d * 10) / 10, direction: direction(origin, position) });
      if (found.length >= 64) break;
    } catch (error) { /* Unloaded/out-of-height cells are skipped. */ }
  }
  return found.sort((a, b) => a.distance - b.distance);
}

function entityRecord(entity, origin) {
  const type = entity.typeId;
  let item;
  if (type === "minecraft:item") {
    try { const stack = entity.getComponent("minecraft:item")?.itemStack; if (stack) item = { id: stack.typeId, name: itemName(stack.typeId), count: stack.amount }; } catch (error) { /* Item despawned. */ }
  }
  const record = { id: entity.id, identifier: type, type, name: entity.nameTag || type.replace(/^minecraft:/, ""), distance: Math.round(distance(origin, entity.location) * 10) / 10, direction: direction(origin, entity.location), relative: relative(origin, entity.location), health: health(entity), hostile: HOSTILE.has(type), friendly: FRIENDLY.has(type), item };
  if (type === "minecraft:player") {
    try { record.gameMode = String(entity.getGameMode()); } catch (error) { /* Optional player detail. */ }
  }
  return record;
}

export function makeObservation(bot, task, memory, config) {
  const radius = Math.min(12, Math.max(4, Number(config?.observationRadius || 8)));
  const origin = bot.location;
  let records = [];
  try { records = bot.dimension.getEntities({ location: origin, maxDistance: radius }).filter((entity) => entity.id !== bot.id).slice(0, 40).map((entity) => entityRecord(entity, origin)); }
  catch (error) { /* Entity or chunk became unavailable; return a safe empty snapshot. */ }
  const players = records.filter((entity) => entity.type === "minecraft:player");
  const nearbyItems = records.filter((entity) => entity.type === "minecraft:item").map((entity) => ({ ...entity.item, entityId: entity.id, distance: entity.distance, direction: entity.direction, relative: entity.relative }));
  const mobs = records.filter((entity) => entity.type !== "minecraft:player" && entity.type !== "minecraft:item");
  const threats = mobs.filter((entity) => entity.hostile).sort((a, b) => a.distance - b.distance);
  const blocks = scanBlocks(bot, radius);
  return {
    timestamp: Date.now(), position: [Math.floor(origin.x), Math.floor(origin.y), Math.floor(origin.z)], dimension: bot.dimension.id,
    players, mobs, blocks, nearbyItems, danger: threats.some((threat) => threat.distance <= 8), threats,
    // Compatibility aliases consumed internally; both contain structured records.
    nearbyBlocks: blocks, nearbyEntities: records,
    inventory: readInventory(bot),
    task: task ? { id: task.id, goal: task.goal, kind: task.kind, status: task.status, progress: task.progress, target: task.target, remaining: task.remaining, targetPosition: task.targetPosition || null, reason: task.reason || "player request" } : null,
    memory: memory?.promptContext(task) || null
  };
}

export function nearestObservedBlock(observation, typeId) { return observation?.blocks?.find((block) => block.type === typeId) || null; }
export { HOSTILE, FRIENDLY, BLOCK_TYPES };
