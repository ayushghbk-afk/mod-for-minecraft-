const AIR = new Set([
  "minecraft:air", "minecraft:cave_air", "minecraft:void_air",
  "minecraft:short_grass", "minecraft:tall_grass", "minecraft:fern", "minecraft:large_fern",
  "minecraft:snow_layer", "minecraft:torch", "minecraft:wall_torch", "minecraft:soul_torch",
  "minecraft:redstone_torch", "minecraft:rail", "minecraft:golden_rail", "minecraft:detector_rail",
  "minecraft:activator_rail", "minecraft:carpet", "minecraft:moss_carpet"
]);
const DANGEROUS = new Set([
  "minecraft:lava", "minecraft:flowing_lava", "minecraft:fire", "minecraft:soul_fire",
  "minecraft:cactus", "minecraft:magma", "minecraft:campfire", "minecraft:soul_campfire",
  "minecraft:sweet_berry_bush", "minecraft:wither_rose", "minecraft:powder_snow"
]);
const WATER = new Set(["minecraft:water", "minecraft:flowing_water", "minecraft:bubble_column"]);

const routes = new Map();
const moveState = new Map();

function key(p) { return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`; }
export function distance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
function passable(block) {
  if (!block) return false;
  const id = block.typeId;
  return AIR.has(id) || id.endsWith("_air") || id.endsWith("_carpet") || id.includes("sign") || id.includes("banner");
}
function isWater(block) { return Boolean(block) && WATER.has(block.typeId); }
function block(dimension, x, y, z) {
  try { return dimension.getBlock({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }); }
  catch { return null; }
}

export function isSafeCell(dimension, position) {
  try {
    const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
    const feet = block(dimension, x, y, z);
    const head = block(dimension, x, y + 1, z);
    const floor = block(dimension, x, y - 1, z);
    if (!feet || !head || !floor) return false;
    if (DANGEROUS.has(feet.typeId) || DANGEROUS.has(head.typeId) || DANGEROUS.has(floor.typeId)) return false;
    // Allow standing in shallow water only if floor is solid underneath water surface.
    const feetOk = passable(feet) || isWater(feet);
    const headOk = passable(head);
    const floorOk = !passable(floor) && !isWater(floor);
    return feetOk && headOk && floorOk;
  } catch {
    return false;
  }
}

/** 8-way neighbours with step-up (1) and step-down (1–2). */
function neighbours(dimension, node) {
  const result = [];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (const [dx, dz] of dirs) {
    const diagonal = dx !== 0 && dz !== 0;
    // Prefer flat, then step up, then step down (1 then 2).
    for (const dy of [0, 1, -1, -2]) {
      const next = { x: node.x + dx, y: node.y + dy, z: node.z + dz };
      if (!isSafeCell(dimension, next)) continue;
      // Diagonal must not cut a solid corner.
      if (diagonal) {
        const a = { x: node.x + dx, y: node.y + dy, z: node.z };
        const b = { x: node.x, y: node.y + dy, z: node.z + dz };
        if (!isSafeCell(dimension, a) && !isSafeCell(dimension, b)) continue;
      }
      result.push({ ...next, cost: diagonal ? 1.41 : 1, step: Math.abs(dy) });
      break;
    }
  }
  return result;
}

function heuristic(a, b) {
  const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y), dz = Math.abs(a.z - b.z);
  return Math.hypot(dx, dz) + dy * 0.55;
}

/**
 * Bounded local A* pathfinder.
 * Wider search radius, 8-way movement, jump/drop handling, binary-heap open set.
 * Never loads chunks; capped for mobile performance.
 */
export function findLocalRoute(dimension, start, target, options = {}) {
  const maxNodes = options.maxNodes ?? 420;
  const maxRadius = options.maxRadius ?? 28;
  const origin = { x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) };
  const goal = { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z) };

  // If the exact goal cell is blocked, aim at the nearest safe neighbour of the goal.
  let goalCell = goal;
  if (!isSafeCell(dimension, goal)) {
    let best = null, bestD = Infinity;
    for (const n of neighbours(dimension, goal)) {
      const d = heuristic(n, origin);
      if (d < bestD) { best = n; bestD = d; }
    }
    if (best) goalCell = best;
  }

  const open = [];
  const push = (node, score) => {
    open.push({ node, score });
    let i = open.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (open[p].score <= open[i].score) break;
      const tmp = open[p]; open[p] = open[i]; open[i] = tmp;
      i = p;
    }
  };
  const pop = () => {
    const top = open[0];
    const last = open.pop();
    if (!open.length || !last) return top.node;
    open[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let smallest = i;
      if (l < open.length && open[l].score < open[smallest].score) smallest = l;
      if (r < open.length && open[r].score < open[smallest].score) smallest = r;
      if (smallest === i) break;
      const tmp = open[i]; open[i] = open[smallest]; open[smallest] = tmp;
      i = smallest;
    }
    return top.node;
  };

  push(origin, heuristic(origin, goalCell));
  const parents = new Map();
  const costs = new Map([[key(origin), 0]]);
  let best = origin;
  let bestScore = heuristic(origin, goalCell);

  for (let visited = 0; open.length && visited < maxNodes; visited += 1) {
    const current = pop();
    const h = heuristic(current, goalCell);
    if (h < bestScore) { best = current; bestScore = h; }
    if (Math.hypot(current.x - goalCell.x, current.z - goalCell.z) <= 1.05 && Math.abs(current.y - goalCell.y) <= 1) {
      best = current;
      break;
    }
    for (const next of neighbours(dimension, current)) {
      if (Math.hypot(next.x - origin.x, next.z - origin.z) > maxRadius) continue;
      if (Math.abs(next.y - origin.y) > 12) continue;
      const nextKey = key(next);
      const stepCost = next.cost + (next.step || 0) * 0.4 + (next.y < current.y ? 0.05 : 0);
      const cost = (costs.get(key(current)) || 0) + stepCost;
      if (cost >= (costs.get(nextKey) ?? Infinity)) continue;
      costs.set(nextKey, cost);
      parents.set(nextKey, current);
      push(next, cost + heuristic(next, goalCell));
    }
  }

  if (key(best) === key(origin)) return [];
  const path = [];
  for (let cursor = best; key(cursor) !== key(origin) && path.length < 48;) {
    path.unshift({ x: cursor.x + 0.5, y: cursor.y, z: cursor.z + 0.5 });
    cursor = parents.get(key(cursor));
    if (!cursor) return [];
  }
  return path;
}

function routeState(entity, target, options = {}) {
  const targetKey = key(target);
  let state = routes.get(entity.id);
  const stale = !state || state.targetKey !== targetKey || state.route.length === 0 || Date.now() - state.plannedAt > 2200;
  if (stale) {
    state = {
      targetKey,
      route: findLocalRoute(entity.dimension, entity.location, target, options),
      plannedAt: Date.now(),
      failures: state?.failures || 0,
      last: { ...entity.location },
      lastProgressAt: Date.now()
    };
    routes.set(entity.id, state);
  }
  return state;
}

function genuineStuck(state, location) {
  const moved = distance(state.last, location);
  if (moved > 0.12) state.lastProgressAt = Date.now();
  state.last = { x: location.x, y: location.y, z: location.z };
  return Date.now() - state.lastProgressAt > 3500;
}

function recover(entity, target, state) {
  state.failures += 1;
  state.route = findLocalRoute(entity.dimension, entity.location, target, { maxNodes: 560, maxRadius: 32 });
  state.plannedAt = Date.now();
  if (state.route.length || state.failures < 2) return false;
  // Teleport is recovery-only after repeated failed replans with no movement.
  const origin = { x: Math.floor(entity.location.x), y: Math.floor(entity.location.y), z: Math.floor(entity.location.z) };
  const candidates = neighbours(entity.dimension, origin);
  // Prefer a cell closer to the target.
  candidates.sort((a, b) => distance(a, target) - distance(b, target));
  for (const candidate of candidates) {
    try {
      entity.teleport(
        { x: candidate.x + 0.5, y: candidate.y, z: candidate.z + 0.5 },
        { dimension: entity.dimension, facingLocation: target, keepVelocity: false }
      );
      state.failures = 0;
      state.lastProgressAt = Date.now();
      return true;
    } catch { /* try next */ }
  }
  return false;
}

/** Face the horizontal movement direction so the model looks like it is walking. */
function faceTowards(entity, target) {
  try {
    const dx = target.x - entity.location.x;
    const dz = target.z - entity.location.z;
    if (Math.hypot(dx, dz) < 0.01) return;
    const yaw = Math.atan2(-dx, dz) * (180 / Math.PI);
    if (typeof entity.setRotation === "function") {
      entity.setRotation({ x: 0, y: yaw });
    } else {
      entity.teleport(entity.location, { dimension: entity.dimension, rotation: { x: 0, y: yaw }, keepVelocity: true });
    }
  } catch { /* rotation is best-effort */ }
}

/** Publish a client-synced move factor so the resource pack can drive walk legs. */
export function setMoveAnim(entity, factor) {
  const value = Math.max(0, Math.min(1, Number(factor) || 0));
  try {
    if (typeof entity.setProperty === "function") entity.setProperty("aibot:move_speed", value);
  } catch { /* property may be missing on older packs still loaded */ }
  try {
    entity.setDynamicProperty("aibot:move_speed", value);
  } catch { /* entity unloading */ }
  const prev = moveState.get(entity.id) || { factor: 0 };
  moveState.set(entity.id, { factor: value, at: Date.now(), last: prev });
}

export function clearRoute(entityId) {
  routes.delete(entityId);
  moveState.delete(entityId);
}

/**
 * Physics movement with local A* waypoints.
 * Teleport is recovery-only. Does NOT clear velocity every tick (that kills walk
 * animation and makes movement stutter). Faces the travel direction.
 */
export function moveEntityTowards(entity, target, options = {}) {
  if (!target || !entity?.location) {
    setMoveAnim(entity, 0);
    return { success: false, reason: "No movement target." };
  }
  const stopDistance = options.stopDistance ?? 1.8;
  const totalDistance = distance(entity.location, target);
  if (totalDistance <= stopDistance) {
    routes.delete(entity.id);
    setMoveAnim(entity, 0);
    try { entity.clearVelocity(); } catch { /* unloading */ }
    return { success: true, arrived: true, distance: totalDistance };
  }

  const state = routeState(entity, target, {
    maxNodes: options.maxNodes ?? 420,
    maxRadius: options.maxRadius ?? 28
  });

  if (genuineStuck(state, entity.location)) {
    const recovered = recover(entity, target, state);
    setMoveAnim(entity, recovered ? 0.6 : 0.2);
    return {
      success: recovered || state.route.length > 0,
      arrived: false,
      recovering: true,
      distance: totalDistance,
      reason: recovered ? "Recovered from a genuine navigation stall." : "Replanning after navigation stall."
    };
  }

  let waypoint = state.route[0];
  while (waypoint && distance(entity.location, waypoint) < 0.85) {
    state.route.shift();
    waypoint = state.route[0];
  }
  // If A* found nothing, steer directly — still better than freezing.
  waypoint ||= { x: target.x, y: target.y, z: target.z };

  const dx = waypoint.x - entity.location.x;
  const dy = waypoint.y - entity.location.y;
  const dz = waypoint.z - entity.location.z;
  const horizontal = Math.hypot(dx, dz) || 1;

  // Player-like walk speed. Cap keeps physics stable on mobile.
  const base = Number(options.speed ?? 0.22);
  const speed = Math.min(0.34, Math.max(0.1, base));
  const needJump = dy > 0.4 || (waypoint.y > entity.location.y + 0.35);
  // Small upward impulse for step-ups; avoid constant hopping.
  const jumpY = needJump ? 0.42 : (entity.location.y < waypoint.y - 0.1 ? 0.08 : 0);

  faceTowards(entity, waypoint);
  setMoveAnim(entity, Math.min(1, speed / 0.28));

  try {
    // Dampen existing horizontal velocity instead of zeroing — smoother gait.
    try {
      const vel = entity.getVelocity?.();
      if (vel && typeof entity.applyKnockback !== "function") {
        // Soft reset: counteract only part of residual velocity.
        if (Math.hypot(vel.x, vel.z) > speed * 1.6) entity.clearVelocity();
      }
    } catch { /* optional */ }

    entity.applyImpulse({
      x: (dx / horizontal) * speed,
      y: jumpY,
      z: (dz / horizontal) * speed
    });
    return { success: true, arrived: false, distance: totalDistance, waypoint, moving: true };
  } catch (error) {
    setMoveAnim(entity, 0);
    return { success: false, reason: `Physics movement failed: ${String(error).slice(0, 120)}`, distance: totalDistance };
  }
}

export class StuckDetector {
  constructor() {
    this.last = null;
    this.lastProgressAt = Date.now();
    this.attempts = 0;
  }
  update(location, target) {
    const now = Date.now();
    const moved = this.last ? distance(location, this.last) : 999;
    const targetDistance = target ? distance(target, location) : 0;
    if (moved > 0.12) { this.lastProgressAt = now; this.attempts = 0; }
    this.last = { x: location.x, y: location.y, z: location.z };
    const stuck = Boolean(target && targetDistance > 2 && now - this.lastProgressAt > 4000);
    if (stuck) this.attempts += 1;
    return { stuck, attempts: this.attempts, targetDistance };
  }
  reset() {
    this.last = null;
    this.lastProgressAt = Date.now();
    this.attempts = 0;
  }
}
