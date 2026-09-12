const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air", "minecraft:short_grass", "minecraft:tall_grass", "minecraft:fern", "minecraft:large_fern", "minecraft:snow_layer"]);
const DANGEROUS = new Set(["minecraft:lava", "minecraft:flowing_lava", "minecraft:fire", "minecraft:soul_fire", "minecraft:cactus", "minecraft:magma"]);

function horizontalDistance(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }
function passable(block) { return !block || AIR.has(block.typeId) || block.typeId.endsWith("_air"); }

export function isSafeCell(dimension, position) {
  try {
    const feet = dimension.getBlock({ x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) });
    const head = dimension.getBlock({ x: Math.floor(position.x), y: Math.floor(position.y + 1), z: Math.floor(position.z) });
    const floor = dimension.getBlock({ x: Math.floor(position.x), y: Math.floor(position.y - 1), z: Math.floor(position.z) });
    return passable(feet) && passable(head) && floor && !DANGEROUS.has(floor.typeId) && !DANGEROUS.has(feet?.typeId);
  } catch { return false; }
}

function candidateSteps(entity, target, step) {
  const dx = target.x - entity.location.x;
  const dz = target.z - entity.location.z;
  const length = Math.hypot(dx, dz) || 1;
  const forward = { x: entity.location.x + (dx / length) * step, y: entity.location.y, z: entity.location.z + (dz / length) * step };
  const side = { x: entity.location.x - (dz / length) * step, y: entity.location.y, z: entity.location.z + (dx / length) * step };
  const otherSide = { x: entity.location.x + (dz / length) * step, y: entity.location.y, z: entity.location.z - (dx / length) * step };
  return [forward, side, otherSide, { ...forward, y: forward.y + 1 }, { ...forward, y: forward.y - 1 }];
}

export function moveEntityTowards(entity, target, options = {}) {
  if (!target || !entity?.location) return { success: false, reason: "No movement target." };
  const distance = Math.hypot(target.x - entity.location.x, target.y - entity.location.y, target.z - entity.location.z);
  if (distance <= (options.stopDistance ?? 1.8)) return { success: true, arrived: true, distance };
  const step = Math.min(options.speed ?? 0.45, Math.max(0.2, distance));
  for (const candidate of candidateSteps(entity, target, step)) {
    if (!isSafeCell(entity.dimension, candidate)) continue;
    try {
      entity.teleport(candidate, { dimension: entity.dimension, facingLocation: target, keepVelocity: false });
      return { success: true, arrived: false, distance, position: candidate };
    } catch (error) {
      return { success: false, reason: `Teleport movement failed: ${String(error)}`, distance };
    }
  }
  return { success: false, reason: "No safe adjacent step found.", distance };
}

export class StuckDetector {
  constructor() { this.last = null; this.lastProgressAt = Date.now(); this.attempts = 0; }
  update(location, target) {
    const now = Date.now();
    const moved = this.last ? Math.hypot(location.x - this.last.x, location.y - this.last.y, location.z - this.last.z) : 999;
    const targetDistance = target ? Math.hypot(target.x - location.x, target.y - location.y, target.z - location.z) : 0;
    if (moved > 0.12) this.lastProgressAt = now;
    this.last = { x: location.x, y: location.y, z: location.z };
    const stuck = Boolean(target && targetDistance > 2 && now - this.lastProgressAt > 5000);
    if (stuck) this.attempts += 1;
    return { stuck, attempts: this.attempts, targetDistance };
  }
  reset() { this.last = null; this.lastProgressAt = Date.now(); this.attempts = 0; }
}
