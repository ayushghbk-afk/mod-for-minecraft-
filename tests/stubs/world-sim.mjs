/**
 * A SIMULATED BEDROCK WORLD for the gameplay acceptance run.
 *
 * `stubs/bedrock.mjs` models just enough of the Script API to load main.js and
 * push a command through it. That is enough for "does the pack wire up", but the
 * acceptance criteria (AC-01..AC-45) are about *gameplay*: does the bot walk to
 * a tree, break a log, put it in its inventory, notice a zombie, eat when hurt,
 * remember 5/16 after a reload. None of that can be answered by a stub whose
 * `getEntities()` ignores distances and whose world is empty air.
 *
 * So this module upgrades the shared stub into a small but honest world:
 *
 *   • real terrain — grass over dirt over stone, with a y-level the pathfinder
 *     can stand on, so routes, step-ups and "no walkable path" are real verdicts;
 *   • distance-aware entity queries — `getEntities({location, maxDistance, type})`
 *     filters like the game, which is what makes AC-13 (never claim a block or a
 *     mob that is not there) a meaningful test;
 *   • `setblock x y z air destroy` actually removes the block AND spawns the
 *     vanilla drop as an item entity, so mining → verification → pickup →
 *     inventory → task progress is one continuous, observable chain (AC-14..AC-17);
 *   • a tick driver that runs the script's own intervals, so a test can say
 *     "play 600 ticks" and watch the bot live.
 *
 * It is a test harness, not a ship artefact: nothing in behaviour_packs/
 * imports it.
 */

import * as bedrock from "./bedrock.mjs";

const { world, system } = bedrock;

/** Vanilla-ish drops for the blocks the acceptance tests break. */
const DROPS = Object.freeze({
  "minecraft:stone": "minecraft:cobblestone",
  "minecraft:deepslate": "minecraft:cobbled_deepslate",
  "minecraft:cobblestone": "minecraft:cobblestone",
  "minecraft:oak_log": "minecraft:oak_log",
  "minecraft:birch_log": "minecraft:birch_log",
  "minecraft:spruce_log": "minecraft:spruce_log",
  "minecraft:dirt": "minecraft:dirt",
  "minecraft:grass_block": "minecraft:dirt",
  "minecraft:sand": "minecraft:sand",
  "minecraft:gravel": "minecraft:gravel",
  "minecraft:coal_ore": "minecraft:coal",
  "minecraft:iron_ore": "minecraft:raw_iron",
  "minecraft:copper_ore": "minecraft:raw_copper",
  "minecraft:gold_ore": "minecraft:raw_gold",
  "minecraft:redstone_ore": "minecraft:redstone",
  "minecraft:lapis_ore": "minecraft:lapis_lazuli",
  "minecraft:diamond_ore": "minecraft:diamond",
  "minecraft:deepslate_diamond_ore": "minecraft:diamond",
  "minecraft:deepslate_iron_ore": "minecraft:raw_iron",
  "minecraft:oak_leaves": null
});

/** Mobs the tests spawn, with the health a real one has. */
const MOB_HEALTH = Object.freeze({
  "minecraft:zombie": 20, "minecraft:skeleton": 20, "minecraft:creeper": 20,
  "minecraft:spider": 16, "minecraft:cow": 10, "minecraft:pig": 10, "minecraft:sheep": 8
});

export const GROUND_Y = 70;

/** ───────────────────────────────────────────── distance-aware entity queries */

function entityDistance(entity, location) {
  return Math.hypot(entity.location.x - location.x, entity.location.y - location.y, entity.location.z - location.z);
}

/**
 * Patch `Dimension.getEntities` so the filters the production code relies on
 * actually filter. Without this, "no diamond ore within observation range" and
 * "a zombie 3 m away" are indistinguishable from "everything, everywhere".
 */
export function installEntityFilters(DimensionClass) {
  DimensionClass.prototype.getEntities = function getEntities(filter = {}) {
    const all = this.entities.filter((entity) => entity.isValid);
    return all.filter((entity) => {
      if (filter.type && entity.typeId !== filter.type) return false;
      if (filter.excludeTypes?.includes(entity.typeId)) return false;
      if (filter.location && Number.isFinite(filter.maxDistance)) {
        if (entityDistance(entity, filter.location) > filter.maxDistance) return false;
      }
      if (filter.location && Number.isFinite(filter.minDistance)) {
        if (entityDistance(entity, filter.location) < filter.minDistance) return false;
      }
      if (filter.tags?.length && !filter.tags.every((tag) => entity.hasTag(tag))) return false;
      if (filter.families?.length && !(entity.families || []).some((family) => filter.families.includes(family))) return false;
      return true;
    });
  };
  return DimensionClass;
}

/** ───────────────────────────────────────────────────────── terrain & commands */

/**
 * Interpret the two commands the bot actually runs:
 *   setblock X Y Z <id> replace|destroy|keep   — mining and probing
 *   damage @e[...] N entity_attack             — the combat fallback
 * Anything else is recorded and ignored, exactly like a world without cheats
 * would ignore it (the production code treats a thrown command as a failure).
 */
export function installCommandEmulation(DimensionClass, { cheats = true } = {}) {
  DimensionClass.prototype.runCommand = function runCommand(command) {
    const text = String(command || "").trim();
    this.commands.push(text);
    if (!cheats) throw new Error("Commands are not enabled in this world");

    const setblock = text.match(/^setblock\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+([a-z0-9_:]+)\s*(replace|destroy|keep)?/i);
    if (setblock) {
      const [, x, y, z, rawId, mode] = setblock;
      const position = { x: Number(x), y: Number(y), z: Number(z) };
      const id = rawId.includes(":") ? rawId : `minecraft:${rawId}`;
      const existing = this.getBlock(position);
      if (mode === "keep" && existing && existing.typeId !== "minecraft:air") return { successCount: 0 };
      if (mode === "destroy" && existing && existing.typeId !== "minecraft:air") {
        // `destroy` breaks the block and drops its item, which is exactly the
        // chain AC-14..AC-17 need to observe.
        const drop = DROPS[existing.typeId];
        if (drop) spawnItemEntity(this, drop, 1, { x: position.x + 0.5, y: position.y + 0.2, z: position.z + 0.5 });
      }
      this.setBlock(position, id === "minecraft:air" ? "minecraft:air" : id);
      return { successCount: 1 };
    }

    const damage = text.match(/^damage\s+@e\[([^\]]*)\]\s+(\d+(?:\.\d+)?)/i);
    if (damage) {
      const [, selectorText, rawAmount] = damage;
      const amount = Number(rawAmount);
      const read = (key) => {
        const found = selectorText.match(new RegExp(`${key}=([^,\\]]+)`));
        return found ? found[1] : null;
      };
      const at = { x: Number(read("x")), y: Number(read("y")), z: Number(read("z")) };
      const radius = Number(read("r") ?? 2);
      const type = read("type");
      // Honour `type=` and pick the NEAREST match, like `c=1` does. The old
      // emulation took the first entity inside the radius whatever it was, so a
      // bot swinging at a zombie could "damage" the player standing next to it
      // and a combat test proved nothing.
      const candidates = this.entities
        .filter((entity) => entity.isValid && (!type || entity.typeId === type) && entityDistance(entity, at) <= radius)
        .sort((a, b) => entityDistance(a, at) - entityDistance(b, at));
      const target = candidates[0] || null;
      if (target) {
        target.applyDamage(amount);
        if (!target.isValid) {
          // The game fires entityDie when health reaches zero; kill reports and
          // "resume the task after combat" (AC-23/AC-25) depend on it.
          bedrock.world.afterEvents.entityDie?.fire({ deadEntity: target, damagingEntity: null });
        }
      }
      return { successCount: target ? 1 : 0 };
    }

    if (/^testfor|^execute|^tp\b|^summon/.test(text)) return { successCount: 1 };
    return { successCount: 1 };
  };
  return DimensionClass;
}

/** Direct block writes for world building (the game's own `setBlock`). */
export function installBlockWrites(DimensionClass) {
  DimensionClass.prototype.setBlock = function setBlock(location, typeId) {
    const key = DimensionClass.key(location);
    const block = this.blocks.get(key) || this.getBlock(location);
    block.typeId = String(typeId);
    this.blocks.set(key, block);
    return block;
  };
  return DimensionClass;
}

/** Spawn a dropped-item entity the way a broken block does. */
export function spawnItemEntity(dimension, typeId, amount = 1, location = { x: 0, y: GROUND_Y, z: 0 }) {
  const entity = dimension.spawnEntity("minecraft:item", location);
  entity.components.set("minecraft:item", { itemStack: new bedrock.ItemStack(typeId, amount) });
  return entity;
}

/** ───────────────────────────────────────────────────────────── world builder */

/**
 * A flat, walkable plain: grass at GROUND_Y-1… no — grass *is* the floor cell,
 * the bot stands ON it at y = GROUND_Y. Dirt below, stone under that, so a
 * mining probe has something realistic to hit.
 */
export function buildTerrain(dimension, { size = 48, center = { x: 0, z: 0 } } = {}) {
  const half = Math.floor(size / 2);
  for (let x = -half; x <= half; x += 1) {
    for (let z = -half; z <= half; z += 1) {
      dimension.setBlock({ x: center.x + x, y: GROUND_Y - 1, z: center.z + z }, "minecraft:grass_block");
      dimension.setBlock({ x: center.x + x, y: GROUND_Y - 2, z: center.z + z }, "minecraft:dirt");
      dimension.setBlock({ x: center.x + x, y: GROUND_Y - 3, z: center.z + z }, "minecraft:stone");
    }
  }
  return dimension;
}

/** An oak tree: 4–5 logs and a leaf canopy, at (x, z) on the terrain floor. */
export function plantOakTree(dimension, x, z, height = 4) {
  for (let y = 0; y < height; y += 1) dimension.setBlock({ x, y: GROUND_Y + y, z }, "minecraft:oak_log");
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dz = -2; dz <= 2; dz += 1) {
      if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
      dimension.setBlock({ x: x + dx, y: GROUND_Y + height, z: z + dz }, "minecraft:oak_leaves");
      if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) dimension.setBlock({ x: x + dx, y: GROUND_Y + height + 1, z: z + dz }, "minecraft:oak_leaves");
    }
  }
  return { x, z, logs: height };
}

/** A small vein of ore in the stone layer, for the recognition tests. */
export function placeOre(dimension, x, z, id = "minecraft:iron_ore", y = GROUND_Y - 3) {
  dimension.setBlock({ x, y, z }, id);
  return { x, y, z, id };
}

/** A surface block the bot can see and break without digging. */
export function placeSurfaceBlock(dimension, x, z, id = "minecraft:stone", y = GROUND_Y) {
  dimension.setBlock({ x, y, z }, id);
  return { x, y, z, id };
}

/** A 3-high, 5-wide wall across the bot's path (AC-09 obstacle recovery). */
export function buildWall(dimension, z, { fromX = -5, toX = 5, height = 3 } = {}) {
  for (let x = fromX; x <= toX; x += 1) {
    for (let y = 0; y < height; y += 1) dimension.setBlock({ x, y: GROUND_Y + y, z }, "minecraft:cobblestone");
  }
  return { z, fromX, toX, height };
}

/** Spawn a mob with the health a real one has. */
export function spawnMob(dimension, typeId, location, { health } = {}) {
  if (!dimension.getEntityTypesForTest) {
    // The base stub refuses unknown types; teach it the mobs the tests need.
    KNOWN_EXTRA.add(typeId);
  }
  const entity = dimension.spawnEntity(typeId, location);
  const component = entity.getComponent("minecraft:health");
  const max = Number(health ?? MOB_HEALTH[typeId] ?? 20);
  if (component) { component.currentValue = max; component.effectiveMax = max; component.defaultValue = max; }
  entity.families = [typeId.replace("minecraft:", ""), "mob", /zombie|skeleton|creeper|spider/.test(typeId) ? "hostile" : "passive"];
  return entity;
}

/** The base stub only knows a handful of types; tests need the vanilla mobs. */
const KNOWN_EXTRA = new Set();
export function allowEntityType(typeId) { KNOWN_EXTRA.add(typeId); return typeId; }
export function knownExtraTypes() { return KNOWN_EXTRA; }

/** ─────────────────────────────────────────────────────────────────── physics */

const PASSABLE = new Set([
  "minecraft:air", "minecraft:cave_air", "minecraft:void_air", "minecraft:short_grass",
  "minecraft:tall_grass", "minecraft:fern", "minecraft:oak_leaves", "minecraft:torch", "minecraft:snow_layer"
]);

function isSolid(dimension, x, y, z) {
  const block = dimension.getBlock({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) });
  return Boolean(block) && !PASSABLE.has(block.typeId);
}

/** The y a standing entity occupies in this column (top of the highest solid). */
function groundLevel(dimension, x, y, z) {
  for (let step = 0; step < 8; step += 1) {
    if (isSolid(dimension, x, y - step, z)) return Math.floor(y - step) + 1;
  }
  return Math.floor(y);
}

/**
 * Integrate one entity: gravity, horizontal velocity, one-block step-ups and a
 * hard stop at solid cells. This is what turns the script's velocity steering
 * into actual travel in the simulated world — and what makes a wall an obstacle
 * rather than decoration (AC-09).
 */
function physicsFor(entity) {
  const dimension = entity.dimension;
  if (!dimension || entity.removed) return;
  const velocity = entity.velocity || { x: 0, y: 0, z: 0 };

  // Gravity, then the floor.
  velocity.y = Number(velocity.y || 0) - 0.08;
  let nextY = entity.location.y + velocity.y;
  const floorY = groundLevel(dimension, entity.location.x, entity.location.y, entity.location.z);
  entity.grounded = false;
  if (nextY <= floorY) { nextY = floorY; velocity.y = 0; entity.grounded = true; }

  // Horizontal travel with collision + step-up.
  let nextX = entity.location.x + (velocity.x || 0);
  let nextZ = entity.location.z + (velocity.z || 0);
  const feetY = Math.floor(nextY);
  if (isSolid(dimension, nextX, feetY, nextZ) || isSolid(dimension, nextX, feetY + 1, nextZ)) {
    // Try to step up one block, like a player walking onto a slab-height ledge.
    if (!isSolid(dimension, nextX, feetY + 1, nextZ) && !isSolid(dimension, nextX, feetY + 2, nextZ)
      && isSolid(dimension, nextX, feetY, nextZ)) {
      nextY = feetY + 1;
      velocity.y = 0;
      entity.grounded = true;
    } else {
      // Blocked: the entity keeps its position and bleeds the horizontal speed,
      // which is exactly the "shoving a wall" state the stuck detector watches.
      nextX = entity.location.x;
      nextZ = entity.location.z;
      velocity.x *= 0.2;
      velocity.z *= 0.2;
      entity.blockedTicks = (entity.blockedTicks || 0) + 1;
    }
  } else {
    entity.blockedTicks = 0;
  }

  entity.location = { x: nextX, y: nextY, z: nextZ };
  // Ground friction, so a bot that stops steering actually stops.
  if (entity.grounded) { velocity.x *= 0.82; velocity.z *= 0.82; }
  if (Math.abs(velocity.x) < 0.001) velocity.x = 0;
  if (Math.abs(velocity.z) < 0.001) velocity.z = 0;
  entity.velocity = velocity;
}

/** One physics tick for every entity in every dimension. */
export function physicsStep() {
  for (const dimension of world.dimensions.values()) {
    for (const entity of [...dimension.entities]) physicsFor(entity);
  }
}

/** Real applyImpulse semantics: it changes velocity only, physics moves bodies. */
export function installPhysics() {
  const EntityClass = bedrock.Entity;
  EntityClass.prototype.applyImpulse = function applyImpulse(value) {
    const velocity = this.velocity || { x: 0, y: 0, z: 0 };
    this.velocity = { x: velocity.x + value.x, y: velocity.y + value.y, z: velocity.z + value.z };
  };
  EntityClass.prototype.setVelocity = function setVelocity(value) {
    this.velocity = { x: value.x, y: value.y, z: value.z };
  };
  // Count teleports so AC-07/AC-08 can prove the bot walked instead of blinking.
  const originalTeleport = EntityClass.prototype.teleport;
  EntityClass.prototype.teleport = function teleport(location, options = {}) {
    this.teleportCount = (this.teleportCount || 0) + 1;
    this.lastTeleportAt = Date.now();
    return originalTeleport.call(this, location, options);
  };
  return EntityClass;
}

/** ──────────────────────────────────────────────────────────────── tick driver */

/**
 * A simulated clock. Half the bot's guards are time-based — "wait 1.2 s before
 * declaring the block unchanged", "no progress for 4 s means stuck", "do not
 * retry eating within 4 s" — and a Node test burns 1 200 ticks in milliseconds,
 * so with the real clock every one of those windows stays open for the whole
 * run and the bot never times out of anything. Advancing 50 ms per tick (20 tps)
 * makes the guards expire exactly when they would in game.
 */
const REAL_NOW = Date.now;
let simNow = REAL_NOW.call(Date);
let clockInstalled = false;

export function installClock(msPerTick = 50) {
  simNow = REAL_NOW.call(Date);
  if (!clockInstalled) {
    Date.now = () => simNow;
    clockInstalled = true;
  }
  return simNow;
}

export function restoreClock() {
  Date.now = REAL_NOW;
  clockInstalled = false;
}

export function simTime() { return simNow; }

/** Advance only the clock (e.g. to expire a cooldown without playing ticks). */
export function advanceClock(ms) { simNow += Number(ms) || 0; return simNow; }

/**
 * Play N game ticks: the script's intervals run in registration order, the
 * per-tick movement job steers the bot, physics turns that steering into
 * travel, and the clock advances 50 ms per tick.
 */
export function play(ticks = 20, msPerTick = 50) {
  for (let step = 0; step < ticks; step += 1) {
    bedrock.advance(1);
    physicsStep();
    simNow += msPerTick;
  }
  return ticks;
}

/** Play until `predicate` is true or `maxTicks` elapse. Returns ticks played. */
export function playUntil(predicate, maxTicks = 1200, step = 5) {
  let played = 0;
  while (played < maxTicks) {
    play(step);
    played += step;
    if (predicate()) return played;
  }
  return played;
}

/**
 * Simulate a world reload: every script-side registry is thrown away and the
 * bots are re-adopted from the entity dynamic properties, exactly like the
 * restore path in main.js does after a save/quit (AC-43).
 */
export function simulateReload(controller) {
  // The entities keep their dynamic properties (that is what a save does); the
  // script's in-memory agents do not survive.
  controller.agents.clear();
  controller.restore();
  return controller.all();
}

/** Damage an entity the way a mob or a fall would. */
export function damage(entity, amount) {
  const health = entity.getComponent("minecraft:health");
  if (!health) return false;
  health.currentValue = Math.max(0, health.currentValue - Number(amount));
  if (health.currentValue <= 0) entity.removed = true;
  return true;
}

/** Heal an entity back to full (between test phases). */
export function heal(entity) {
  const health = entity.getComponent("minecraft:health");
  if (health) health.currentValue = health.effectiveMax ?? health.defaultValue ?? 20;
  return health?.currentValue ?? 0;
}

/** Give an entity items, the way `/give` or a chest transfer would. */
export function give(entity, typeId, amount = 1) {
  const container = entity.getComponent("minecraft:inventory")?.container;
  if (!container) return false;
  container.addItem(new bedrock.ItemStack(typeId, amount));
  return true;
}

/** Everything the entity is carrying, as id → count. */
export function carrying(entity) {
  const container = entity.getComponent("minecraft:inventory")?.container;
  const totals = new Map();
  if (!container) return totals;
  for (let slot = 0; slot < container.size; slot += 1) {
    const item = container.getItem(slot);
    if (item) totals.set(item.typeId, (totals.get(item.typeId) || 0) + item.amount);
  }
  const held = entity.getComponent("minecraft:equippable")?.getEquipment?.("Mainhand");
  if (held) totals.set(held.typeId, (totals.get(held.typeId) || 0) + (held.amount || 1));
  return totals;
}

/** Distance between two entities (or an entity and a position). */
export function distanceBetween(a, b) {
  const left = a.location || a;
  const right = b.location || b;
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

/** Every chat line a player has received, with formatting codes stripped. */
export function plainChat(player) {
  return (player.sentMessages || []).map((line) => String(line).replace(/§[0-9a-fk-or]/gi, ""));
}

/** The last chat line matching a pattern, or "" — for "did it report X?". */
export function lastChatMatching(player, pattern) {
  const lines = plainChat(player).filter((line) => pattern.test(line));
  return lines.length ? lines[lines.length - 1] : "";
}

/** Count chat lines matching a pattern (AC-31/AC-41 chat-flood evidence). */
export function countChatMatching(player, pattern) {
  return plainChat(player).filter((line) => pattern.test(line)).length;
}

/**
 * Install all of the upgrades on the shared stub and hand back the pieces a
 * test needs. Called once per test file, before main.js is imported.
 */
export function installSimulatedWorld() {
  const DimensionClass = Object.getPrototypeOf(world.getDimension("overworld")).constructor;
  installBlockWrites(DimensionClass);
  installEntityFilters(DimensionClass);
  installCommandEmulation(DimensionClass);
  installPhysics();
  installClock();
  // Teach the stub's spawnEntity about the vanilla mobs the tests summon.
  const originalSpawn = DimensionClass.prototype.spawnEntity;
  DimensionClass.prototype.spawnEntity = function spawnEntity(typeId, location) {
    if (KNOWN_EXTRA.has(typeId)) {
      const entity = new bedrock.Entity(typeId, location, this);
      this.entities.push(entity);
      return entity;
    }
    return originalSpawn.call(this, typeId, location);
  };
  return { world, system, DimensionClass };
}

export { bedrock };
