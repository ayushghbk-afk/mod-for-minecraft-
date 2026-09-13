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
/** Per-entity steering state owned by the player-like movement controller. */
const moveState = new Map();
/** Last published walk-animation factor, so the synced property is not re-written every tick. */
const animState = new Map();

// --- Player-like movement tuning (blocks/tick at 20 tps) ---
// A real player's input is a constant horizontal velocity, so the bot now
// steers velocity the same way instead of taking raw impulses:
//   walk ≈ 0.215 (≈4.3 m/s, vanilla player walk),
//   sprint ≈ 0.279 (≈5.6 m/s, vanilla player sprint),
//   jump impulse 0.42 (vanilla player jump rise).
const WALK_SPEED = 0.215;
const SPRINT_SPEED = 0.279;
const JUMP_VELOCITY = 0.42;
/** Horizontal damping per tick while easing to a stop (player braking feel). */
const STOP_FRICTION = 0.6;
/** Steering states older than this are treated as "release the keys". */
const STEERING_TIMEOUT_MS = 1500;
/** Velocity lerp factor per tick toward the travel direction (turning feel). */
const TURN_RATE = 0.45;

/**
 * Write an entity's full velocity on any API level.
 *
 * `Entity.setVelocity` was removed from the stable Script API in
 * @minecraft/server 2.0.0 (Bedrock 1.21.20+): velocity can be *read* but only
 * *deltas* may be applied, through `applyImpulse`. This pack declares 2.9.0,
 * so on every build it can load on, the old call throws "not a function" —
 * and because every write below sits in a catch that assumed an unloading
 * entity, the bot was steered every tick, failed every tick, and simply stood
 * still forever while the movement job kept "running" (the /aibot:test line
 * "missing on the entity: setVelocity"). On 2.x we therefore read the current
 * velocity (getVelocity is still there) and apply the difference as an
 * impulse; older builds that still expose setVelocity keep using it directly.
 *
 * @param {{getVelocity?: () => any, setVelocity?: (v: any) => void, applyImpulse?: (v: any) => void}} entity
 * @param {{x:number,y:number,z:number}} vel the velocity just read from the entity
 * @param {{x:number,y:number,z:number}} target the velocity the entity should have
 */
function writeVelocity(entity, vel, target) {
  if (typeof entity.setVelocity === "function") {
    entity.setVelocity(target);
    return;
  }
  if (typeof entity.applyImpulse === "function") {
    entity.applyImpulse({ x: target.x - vel.x, y: target.y - vel.y, z: target.z - vel.z });
    return;
  }
  throw new Error("this build exposes neither setVelocity nor applyImpulse");
}

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
  let reached = false;

  for (let visited = 0; open.length && visited < maxNodes; visited += 1) {
    const current = pop();
    const h = heuristic(current, goalCell);
    if (h < bestScore) { best = current; bestScore = h; }
    if (Math.hypot(current.x - goalCell.x, current.z - goalCell.z) <= 1.05 && Math.abs(current.y - goalCell.y) <= 1) {
      best = current;
      reached = true;
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
  if (!reached) {
    // Distinguish "the goal is far away" from "the goal is blocked":
    //  • goal OUTSIDE the search region → a partial route toward the best
    //    cell is the intended long-range follow behaviour (re-plan as the bot
    //    closes the distance);
    //  • goal INSIDE the search region but not reached → no route exists.
    //    Returning a partial route used to send the bot to the cell in front
    //    of the wall, where it shoved, "got stuck", and the recovery loop
    //    teleported it around its own feet.
    const goalInRegion = Math.hypot(goalCell.x - origin.x, goalCell.z - origin.z) <= maxRadius
      && Math.abs(goalCell.y - origin.y) <= 12;
    if (goalInRegion) return [];
  }
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
  // An empty route is NOT automatically stale — it means one of two things:
  //   • the bot walked through every waypoint (route consumed; the target is
  //     still far away but reachable) → re-route promptly, or
  //   • A* found no route at all (target unreachable) → re-check at a calm
  //     1.5 s cadence, or immediately when the target moved, so the bot
  //     resumes the moment a path opens without re-running the full search on
  //     every planning call (that storm was the old bug: a full A* every
  //     5-tick while following at range, plus a second full search every
  //     3.5 s from the stuck recovery).
  const targetMoved = !state?.lastTarget || distance(state.lastTarget, target) > 2;
  const stale =
    !state ||
    state.targetKey !== targetKey ||
    (!state.noRoute && state.route.length === 0) ||
    (state.noRoute ? targetMoved || Date.now() - state.plannedAt > 1500 : Date.now() - state.plannedAt > 2200);
  if (stale) {
    const route = findLocalRoute(entity.dimension, entity.location, target, options);
    state = {
      targetKey,
      route,
      noRoute: route.length === 0,
      lastTarget: { x: target.x, y: target.y, z: target.z },
      plannedAt: Date.now(),
      failures: state?.failures || 0,
      last: state?.last || { ...entity.location },
      lastProgressAt: state?.lastProgressAt || Date.now()
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
  state.noRoute = state.route.length === 0;
  if (state.noRoute || state.failures < 2) return false;
  // Teleport is recovery-only after repeated failed replans with no movement —
  // and only when a REAL route exists but the bot is stuck on it. When no
  // route exists at all the target is unreachable: teleporting the bot between
  // neighbouring cells cannot change that, it just made it teleport in place
  // forever (the reported "bot glitches around" bug on an unreachable target).
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
export function setMoveAnim(entity, factor, force = false) {
  const value = Math.max(0, Math.min(1, Number(factor) || 0));
  const prev = animState.get(entity.id)?.factor;
  if (!force && prev !== undefined && Math.abs(prev - value) < 0.05) return;
  animState.set(entity.id, { factor: value, at: Date.now() });
  try {
    if (typeof entity.setProperty === "function") entity.setProperty("aibot:move_speed", value);
  } catch { /* property may be missing on older packs still loaded */ }
  try {
    entity.setDynamicProperty("aibot:move_speed", value);
  } catch { /* entity unloading */ }
}

export function clearRoute(entityId) {
  routes.delete(entityId);
  moveState.delete(entityId);
  animState.delete(entityId);
}

/**
 * Ease the bot to a stop (arrival, /aibot:stop, idle, out-of-range combat).
 * The per-tick step decelerates the horizontal velocity like a player releasing
 * the movement keys instead of zeroing it instantly.
 */
export function stopEntity(entity) {
  if (!entity?.id) return;
  moveState.set(entity.id, {
    dirX: 0, dirZ: 0, speed: 0, needJump: false,
    stopping: true, updatedAt: Date.now()
  });
}

/**
 * One tick of player-like velocity control (driven every game tick from the
 * controller, see main.js):
 *  - horizontal velocity lerps toward the travel direction, so the bot
 *    accelerates, turns and eases like a player with held keys — never
 *    teleports its velocity;
 *  - the vertical velocity is preserved, so gravity, falls and landings are
 *    natural; there is no artificial hopping;
 *  - a jump impulse (vanilla player jump speed) is applied only while a
 *    step-up is pending AND the bot is on the ground;
 *  - stale steering (the AI stopped issuing movement) decelerates the bot to a
 *    smooth stop and clears the walk animation.
 */
export function applyPlayerStep(entity) {
  if (!entity?.id) return;
  const state = moveState.get(entity.id);
  if (!state) return;
  if (!state.stopping && Date.now() - state.updatedAt > STEERING_TIMEOUT_MS) state.stopping = true;
  let vel;
  try { vel = entity.getVelocity ? entity.getVelocity() : { x: 0, y: 0, z: 0 }; } catch { return; }
  try {
    if (state.stopping) {
      const horizontal = Math.hypot(vel.x, vel.z);
      if (horizontal < 0.01) {
        try { writeVelocity(entity, vel, { x: 0, y: vel.y, z: 0 }); } catch { /* unloading */ }
        setMoveAnim(entity, 0, true);
        routes.delete(entity.id);
        moveState.delete(entity.id);
        return;
      }
      try {
        writeVelocity(entity, vel, { x: vel.x * STOP_FRICTION, y: vel.y, z: vel.z * STOP_FRICTION });
      } catch { /* unloading */ }
      setMoveAnim(entity, Math.min(1, horizontal / 0.24));
      return;
    }
    const onGround = entity.isOnGround !== false;
    const y = state.needJump && onGround ? JUMP_VELOCITY : vel.y;
    const x = vel.x + (state.dirX * state.speed - vel.x) * TURN_RATE;
    const z = vel.z + (state.dirZ * state.speed - vel.z) * TURN_RATE;
    try {
      writeVelocity(entity, vel, { x, y, z });
    } catch {
      setMoveAnim(entity, 0, true);
      return;
    }
    setMoveAnim(entity, Math.min(1, state.speed / 0.24));
  } catch { /* entity unloading */ }
}

/**
 * Refresh the per-entity steering state for the next waypoint and take an
 * immediate step. The 1-tick `applyPlayerStep` loop keeps the velocity under
 * control in between calls, so this no longer injects raw impulses (which
 * made the bot overshoot player speed and hop every half second).
 *
 * `options.speed` is the constant horizontal speed in blocks/tick —
 * WALK_SPEED for normal walking, SPRINT_SPEED to keep up with a player.
 * Teleport is recovery-only (see recover()).
 */
export function moveEntityTowards(entity, target, options = {}) {
  if (!target || !entity?.location) {
    stopEntity(entity);
    return { success: false, reason: "No movement target." };
  }
  const stopDistance = options.stopDistance ?? 1.8;
  const totalDistance = distance(entity.location, target);
  if (totalDistance <= stopDistance) {
    routes.delete(entity.id);
    stopEntity(entity);
    return { success: true, arrived: true, distance: totalDistance };
  }

  const state = routeState(entity, target, {
    maxNodes: options.maxNodes ?? 420,
    maxRadius: options.maxRadius ?? 28
  });

  // A* found no walkable path at all. Ease to a stop and report the verdict
  // instead of shoving into the obstacle: routeState() re-checks as soon as
  // the target moves and at least every 1.5 s, so the bot resumes the moment
  // a path opens. (Steering blindly at the wall — plus the old in-place
  // teleports — is what made an unreachable target look like a broken bot.)
  if (state.noRoute) {
    stopEntity(entity);
    setMoveAnim(entity, 0, true);
    return {
      success: false,
      arrived: false,
      unreachable: true,
      distance: totalDistance,
      reason: "No walkable path to the target."
    };
  }

  if (genuineStuck(state, entity.location)) {
    const recovered = recover(entity, target, state);
    setMoveAnim(entity, recovered ? 0.6 : 0.2);
    return {
      success: recovered || state.route.length > 0,
      arrived: false,
      recovering: true,
      distance: totalDistance,
      reason: recovered
        ? "Recovered from a genuine navigation stall."
        : state.noRoute
          ? "No walkable path to the target."
          : "Replanning after navigation stall."
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

  // Constant player-like speed (blocks/tick), never above sprint.
  const base = Number(options.speed ?? WALK_SPEED);
  const speed = Math.min(SPRINT_SPEED, Math.max(0.08, base));
  // A genuine step-up only; flat walking adds no vertical velocity.
  const needJump = dy > 0.35;

  faceTowards(entity, waypoint);
  moveState.set(entity.id, {
    dirX: dx / horizontal,
    dirZ: dz / horizontal,
    speed,
    needJump,
    stopping: false,
    updatedAt: Date.now()
  });
  applyPlayerStep(entity);
  setMoveAnim(entity, Math.min(1, speed / 0.24));
  return { success: true, arrived: false, distance: totalDistance, waypoint, moving: true };
}

/** Named speed presets so call sites stay readable. */
export const MOVEMENT_SPEEDS = Object.freeze({ walk: WALK_SPEED, sprint: SPRINT_SPEED });

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
