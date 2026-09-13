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

/**
 * Empty routes that mean "you are already standing at the goal".
 *
 * An empty waypoint list is ambiguous: it can mean "arrived" or "there is no way
 * there". Conflating the two is what made a bot two blocks from a tree report
 * the tree as unreachable and abandon the task (AC-05/AC-14/AC-15). The flag
 * lives in a WeakSet so `findLocalRoute` keeps returning a plain array.
 */
const arrivedRoutes = new WeakSet();

/** @param {any[]} route @returns {boolean} true when an empty route means "already at the goal" */
export function routeIsArrival(route) {
  return Array.isArray(route) && arrivedRoutes.has(route);
}

function heuristic(a, b) {
  const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y), dz = Math.abs(a.z - b.z);
  return Math.hypot(dx, dz) + dy * 0.55;
}

/**
 * Can the bot swing at this block from where it stands?
 *
 * Survival reach is about 4.5 m measured from the eyes, and the eyes sit 1.62 m
 * above the feet, so a block three up a trunk is perfectly minable from the
 * ground while a block four blocks sideways is not. Everything the pack does
 * around mining — where to walk, when to start swinging, whether to report
 * "unreachable" — has to share one answer to this question (AC-15/AC-32).
 * @param {{x:number,y:number,z:number}} from foot position of the swinger
 * @param {{x:number,y:number,z:number}} block integer block position
 * @returns {boolean}
 */
export function withinSwingReach(from, block) {
  const dx = Number(from.x) - (Number(block.x) + 0.5);
  const dz = Number(from.z) - (Number(block.z) + 0.5);
  const horizontal = Math.hypot(dx, dz);
  const eye = Number(from.y) + 1.62;
  const vertical = Math.abs(eye - (Number(block.y) + 0.5));
  return horizontal <= 2.6 && vertical <= 3.4 && horizontal + vertical <= 4.4;
}

/** "x,y,z" -> { cell, at } — a block does not move, so the answer is reusable. */
/**
 * Is the WHOLE cell within swing range, not just its centre?
 *
 * Movement stops "within 0.8 of the goal", so a cell picked because its exact
 * centre sits 2.6 m from the block lets the bot come to rest at 3.4 m — outside
 * reach — and then report "unreachable" while standing next to the tree it was
 * sent to fell. Testing the centre plus the four 0.8 m extremes guarantees that
 * anywhere the bot stops inside that cell, the swing still lands.
 */
function cellInReach(cell, block) {
  for (const [ox, oz] of [[0, 0], [0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8]]) {
    if (!withinSwingReach({ x: cell.x + 0.5 + ox, y: cell.y, z: cell.z + 0.5 + oz }, block)) return false;
  }
  return true;
}

const reachCells = new Map();

/**
 * Where to STAND in order to reach a block.
 *
 * "Walk to the block I am going to mine" must not mean "walk into the block":
 * a log is solid, so routing at the block itself always ended in "no walkable
 * path". The real goal is the nearest standable cell from which the block is
 * inside the swing envelope (AC-05/AC-14/AC-15).
 * @param {any} dimension
 * @param {{x:number,y:number,z:number}} block
 * @param {{x:number,y:number,z:number}} origin current bot position; the closer side wins
 * @param {number} [radius]
 * @returns {{x:number,y:number,z:number}|null}
 */
export function findReachCell(dimension, block, origin, radius = 3) {
  const cacheKey = `${Math.floor(block.x)},${Math.floor(block.y)},${Math.floor(block.z)}`;
  const cached = reachCells.get(cacheKey);
  if (cached && Date.now() - cached.at < 4000 && isSafeCell(dimension, cached.cell)) return cached.cell;
  let best = null;
  let bestScore = Infinity;
  for (let dy = 0; dy >= -3; dy -= 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        const cell = { x: Math.floor(block.x) + dx, y: Math.floor(block.y) + dy, z: Math.floor(block.z) + dz };
        if (!isSafeCell(dimension, cell)) continue;
        if (!cellInReach(cell, block)) continue;
        // Prefer the side nearest the bot, and the ground over a ledge level
        // with the block.
        const score = heuristic(cell, origin) + Math.abs(dy) * 0.45;
        if (score < bestScore) { best = cell; bestScore = score; }
      }
    }
  }
  if (best) {
    if (reachCells.size > 400) reachCells.clear();
    reachCells.set(cacheKey, { cell: best, at: Date.now() });
  } else reachCells.delete(cacheKey);
  return best;
}

/**
 * Bounded local A* pathfinder.
 * Wider search radius, 8-way movement, jump/drop handling, binary-heap open set.
 * Never loads chunks; capped for mobile performance.
 */
export function findLocalRoute(dimension, start, target, options = {}) {
  const maxNodes = options.maxNodes ?? 420;
  const maxRadius = options.maxRadius ?? 28;
  // How close counts as "there". 1.05 is right for walking to a player or a
  // dropped item; it is far too loose for a mining stance, where being one cell
  // short of the chosen cell is the difference between swinging and reporting
  // "unreachable" (AC-15).
  const tolerance = Number(options.tolerance) > 0 ? Number(options.tolerance) : 1.05;
  const origin = { x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) };
  const goal = { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z) };

  // If the exact goal cell is blocked, aim at the nearest cell the bot can
  // actually STAND in next to it. This is what makes "walk to the block I am
  // going to mine" work: a log two blocks up a trunk is solid, and none of its
  // step-neighbours has a floor, so the old neighbour-only search found nothing
  // and reported "no walkable path" while the bot was standing right under the
  // tree (AC-05/AC-14/AC-15). A small 3-D ring around the goal always has the
  // ground cell beside it.
  let goalCell = goal;
  if (!isSafeCell(dimension, goal)) {
    let best = null, bestD = Infinity;
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dz = -2; dz <= 2; dz += 1) {
        for (let dy = -2; dy <= 2; dy += 1) {
          const cell = { x: goal.x + dx, y: goal.y + dy, z: goal.z + dz };
          if (!isSafeCell(dimension, cell)) continue;
          // Prefer a cell close to the bot, level with (or below) the goal, and
          // never a cell further from the goal than the ring itself.
          const d = heuristic(cell, origin) + Math.abs(dy) * 0.8 + Math.hypot(dx, dz) * 0.35;
          if (d < bestD) { best = cell; bestD = d; }
        }
      }
    }
    if (!best) {
      // Nothing standable beside it — the goal is in the air (a canopy the bot
      // was sent to investigate, a ledge, a floating block). A player walks
      // underneath it, so drop a plumb line and stand there. Without this the
      // bot reported "no walkable path" to a tree it could see (AC-13).
      for (let dy = -1; dy >= -10 && !best; dy -= 1) {
        const cell = { x: goal.x, y: goal.y + dy, z: goal.z };
        if (isSafeCell(dimension, cell)) best = cell;
      }
    }
    if (best) goalCell = best;
  }

  // Standing close enough to the (adjusted) goal is ARRIVAL, not failure.
  // Returning a bare [] here used to be read by the caller as "no walkable path
  // exists", which is how a bot two blocks from a tree reported the tree as
  // unreachable and gave up on the whole task (AC-05/AC-14/AC-15).
  if (Math.hypot(origin.x - goalCell.x, origin.z - goalCell.z) <= tolerance && Math.abs(origin.y - goalCell.y) <= 1) {
    /** @type {any[]} */
    const arrived = [];
    arrivedRoutes.add(arrived);
    return arrived;
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
    if (Math.hypot(current.x - goalCell.x, current.z - goalCell.z) <= tolerance && Math.abs(current.y - goalCell.y) <= 1) {
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
      noRoute: route.length === 0 && !routeIsArrival(route),
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
  // A stuck bot is usually pressed flat against a block edge or wedged in a
  // corner. The unstick is what a PLAYER does — jump and shoulder sideways
  // toward the most promising neighbouring cell. It used to be a teleport to
  // that cell, which broke the pack's central promise (AC-06: it walks, it
  // never teleports) and looked like the bot glitching through walls.
  const origin = { x: Math.floor(entity.location.x), y: Math.floor(entity.location.y), z: Math.floor(entity.location.z) };
  const candidates = neighbours(entity.dimension, origin);
  // Prefer a cell closer to the target.
  candidates.sort((a, b) => distance(a, target) - distance(b, target));
  const best = candidates[0];
  if (!best) return false;
  const dx = best.x + 0.5 - entity.location.x;
  const dz = best.z + 0.5 - entity.location.z;
  const length = Math.hypot(dx, dz) || 1;
  try {
    // applyImpulse both redirects and (on builds where it replaces velocity)
    // cancels the motion that had the bot pressed into the obstacle.
    entity.applyImpulse({ x: (dx / length) * 0.24, y: 0.4, z: (dz / length) * 0.24 });
  } catch { return false; }
  state.failures = 0;
  state.lastProgressAt = Date.now();
  state.unstickAt = Date.now();
  return true;
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
/**
 * The next "carrot" on a long walk — AC-06/AC-08.
 *
 * A* is deliberately bounded (420 nodes, ~28 blocks) so a phone keeps 20 tps.
 * The consequence is that a target 40 blocks away is NOT unreachable, it is
 * simply beyond one search: the bot has to walk it in legs. Without this, every
 * long walk — follow the player across a valley, go back to a remembered tree,
 * search a ring 30 blocks out — answered "no walkable path" and the task died.
 *
 * The carrot is snapped to a 4-block grid so it does not crawl forward every
 * tick: an un-snapped carrot invalidates the route cache continuously and
 * re-runs a full A* five times a second (the storm the cache exists to stop).
 * @param {{x:number,y:number,z:number}} from
 * @param {{x:number,y:number,z:number}} target
 * @param {number} totalDistance
 * @param {number} legDistance
 */
function legTarget(from, target, totalDistance, legDistance) {
  const dx = (target.x - from.x) / (totalDistance || 1);
  const dz = (target.z - from.z) / (totalDistance || 1);
  const snap = (value) => Math.round(value / 4) * 4;
  let x = snap(from.x + dx * legDistance);
  let z = snap(from.z + dz * legDistance);
  // Keep the carrot well ahead of the bot's feet: a 1-block carrot both jitters
  // the steering and reads as "arrived" for a leg that is not the destination.
  if (Math.hypot(x - from.x, z - from.z) < 6) {
    x = from.x + dx * (legDistance + 6);
    z = from.z + dz * (legDistance + 6);
  }
  return { x, y: from.y, z };
}

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

  // Long walks are split into legs the bounded search can actually plan.
  const legDistance = Number(options.legDistance) || 0;
  const aim = legDistance > 0 && totalDistance > legDistance
    ? legTarget(entity.location, target, totalDistance, legDistance)
    : target;

  const state = routeState(entity, aim, {
    maxNodes: options.maxNodes ?? 420,
    maxRadius: options.maxRadius ?? 28,
    tolerance: options.tolerance
  });

  // The goal cell is already under the bot's feet: it has arrived — but only
  // when that goal IS the destination, not an intermediate carrot.
  if (routeIsArrival(state.route) && aim === target) {
    routes.delete(entity.id);
    stopEntity(entity);
    return { success: true, arrived: true, distance: totalDistance, atGoal: true };
  }

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
  waypoint ||= { x: aim.x, y: aim.y, z: aim.z };

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
