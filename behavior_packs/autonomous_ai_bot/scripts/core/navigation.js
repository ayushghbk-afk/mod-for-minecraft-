const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air", "minecraft:short_grass", "minecraft:tall_grass", "minecraft:fern", "minecraft:large_fern", "minecraft:snow_layer"]);
const DANGEROUS = new Set(["minecraft:lava", "minecraft:flowing_lava", "minecraft:fire", "minecraft:soul_fire", "minecraft:cactus", "minecraft:magma", "minecraft:campfire", "minecraft:soul_campfire", "minecraft:sweet_berry_bush"]);
const routes = new Map();

function key(p) { return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`; }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
function passable(block) { return Boolean(block) && (AIR.has(block.typeId) || block.typeId.endsWith("_air")); }
function block(dimension, x, y, z) { return dimension.getBlock({ x, y, z }); }

export function isSafeCell(dimension, position) {
  try {
    const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
    const feet = block(dimension, x, y, z);
    const head = block(dimension, x, y + 1, z);
    const floor = block(dimension, x, y - 1, z);
    return passable(feet) && passable(head) && floor && !passable(floor)
      && !DANGEROUS.has(floor.typeId) && !DANGEROUS.has(feet.typeId);
  } catch (error) {
    return false; // Usually an unloaded chunk or a world-height boundary.
  }
}

function neighbours(dimension, node) {
  const result = [];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const dy of [0, 1, -1]) {
      const next = { x: node.x + dx, y: node.y + dy, z: node.z + dz };
      if (isSafeCell(dimension, next)) { result.push(next); break; }
    }
  }
  return result;
}

/** Bounded local A*; it never loads chunks and is capped for mobile performance. */
export function findLocalRoute(dimension, start, target, maxNodes = 160) {
  const origin = { x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) };
  const goal = { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z) };
  const open = [{ node: origin, score: distance(origin, goal) }];
  const parents = new Map();
  const costs = new Map([[key(origin), 0]]);
  let best = origin;
  for (let visited = 0; open.length && visited < maxNodes; visited += 1) {
    open.sort((a, b) => a.score - b.score);
    const current = open.shift().node;
    if (distance(current, goal) < distance(best, goal)) best = current;
    if (Math.hypot(current.x - goal.x, current.z - goal.z) <= 1 && Math.abs(current.y - goal.y) <= 1) { best = current; break; }
    for (const next of neighbours(dimension, current)) {
      if (Math.hypot(next.x - origin.x, next.z - origin.z) > 10) continue;
      const nextKey = key(next);
      const cost = (costs.get(key(current)) || 0) + 1 + Math.abs(next.y - current.y) * 0.35;
      if (cost >= (costs.get(nextKey) ?? Infinity)) continue;
      costs.set(nextKey, cost);
      parents.set(nextKey, current);
      open.push({ node: next, score: cost + distance(next, goal) });
    }
  }
  if (key(best) === key(origin)) return [];
  const path = [];
  for (let cursor = best; key(cursor) !== key(origin) && path.length < 24;) {
    path.unshift({ x: cursor.x + 0.5, y: cursor.y, z: cursor.z + 0.5 });
    cursor = parents.get(key(cursor));
    if (!cursor) return [];
  }
  return path;
}

function routeState(entity, target) {
  const targetKey = key(target);
  let state = routes.get(entity.id);
  if (!state || state.targetKey !== targetKey || state.route.length === 0 || Date.now() - state.plannedAt > 2500) {
    state = { targetKey, route: findLocalRoute(entity.dimension, entity.location, target), plannedAt: Date.now(), failures: state?.failures || 0, last: entity.location, lastProgressAt: Date.now() };
    routes.set(entity.id, state);
  }
  return state;
}

function genuineStuck(state, location) {
  const moved = distance(state.last, location);
  if (moved > 0.18) state.lastProgressAt = Date.now();
  state.last = { ...location };
  return Date.now() - state.lastProgressAt > 5000;
}

function recover(entity, target, state) {
  state.failures += 1;
  state.route = findLocalRoute(entity.dimension, entity.location, target, 240);
  state.plannedAt = Date.now();
  if (state.route.length || state.failures < 3) return false;
  // Teleport is deliberately restricted to recovery after 3 failed replans and
  // 5 seconds without movement, never normal locomotion.
  for (const candidate of neighbours(entity.dimension, { x: Math.floor(entity.location.x), y: Math.floor(entity.location.y), z: Math.floor(entity.location.z) })) {
    try {
      entity.teleport({ x: candidate.x + 0.5, y: candidate.y, z: candidate.z + 0.5 }, { dimension: entity.dimension, facingLocation: target, keepVelocity: false });
      state.failures = 0; state.lastProgressAt = Date.now();
      return true;
    } catch (error) { /* Try another verified-safe recovery cell. */ }
  }
  return false;
}

/** Physics movement with local A* waypoints. Teleport is recovery-only. */
export function moveEntityTowards(entity, target, options = {}) {
  if (!target || !entity?.location) return { success: false, reason: "No movement target." };
  const totalDistance = distance(entity.location, target);
  if (totalDistance <= (options.stopDistance ?? 1.8)) {
    routes.delete(entity.id);
    try { entity.clearVelocity(); } catch (error) { /* Entity may be unloading. */ }
    return { success: true, arrived: true, distance: totalDistance };
  }
  const state = routeState(entity, target);
  if (genuineStuck(state, entity.location)) {
    const recovered = recover(entity, target, state);
    return { success: recovered || state.route.length > 0, arrived: false, recovering: true, distance: totalDistance, reason: recovered ? "Recovered from a genuine navigation stall." : "Replanning after navigation stall." };
  }
  let waypoint = state.route[0];
  while (waypoint && distance(entity.location, waypoint) < 0.8) { state.route.shift(); waypoint = state.route[0]; }
  waypoint ||= target;
  const dx = waypoint.x - entity.location.x, dz = waypoint.z - entity.location.z;
  const horizontal = Math.hypot(dx, dz) || 1;
  const speed = Math.min(0.16, Math.max(0.06, Number(options.speed ?? 0.12)));
  try {
    entity.clearVelocity();
    entity.applyImpulse({ x: (dx / horizontal) * speed, y: waypoint.y > entity.location.y + 0.35 ? 0.34 : 0, z: (dz / horizontal) * speed });
    return { success: true, arrived: false, distance: totalDistance, waypoint };
  } catch (error) {
    return { success: false, reason: `Physics movement failed: ${String(error).slice(0, 120)}`, distance: totalDistance };
  }
}

export class StuckDetector {
  constructor() { this.last = null; this.lastProgressAt = Date.now(); this.attempts = 0; }
  update(location, target) {
    const now = Date.now();
    const moved = this.last ? distance(location, this.last) : 999;
    const targetDistance = target ? distance(target, location) : 0;
    if (moved > 0.18) { this.lastProgressAt = now; this.attempts = 0; }
    this.last = { ...location };
    const stuck = Boolean(target && targetDistance > 2 && now - this.lastProgressAt > 5000);
    if (stuck) this.attempts += 1;
    return { stuck, attempts: this.attempts, targetDistance };
  }
  reset() { this.last = null; this.lastProgressAt = Date.now(); this.attempts = 0; }
}
