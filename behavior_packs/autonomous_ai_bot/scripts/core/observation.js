/**
 * OBSERVATION — AC-02 (player detection, owner vs. strangers), AC-11 (block
 * recognition), AC-12 (entity recognition), AC-13 (nothing is claimed that was
 * not actually seen) and AC-41 (the scan is bounded and measured).
 *
 * Every decision the bot makes is taken from this snapshot and from nothing
 * else. That is what makes AC-13 testable: if `diamond_ore` is not in
 * `observation.blocks`, no code path can produce "I found diamond", because
 * `find_block` only ever returns a block that this scan actually read out of
 * the dimension.
 *
 * Identifiers are the game's own `typeId` strings — `minecraft:oak_log`,
 * `minecraft:zombie` — never a display name and never a Java Edition id.
 */

import { itemName, readInventory } from "./inventory.js";

const BLOCK_TYPES = new Set([
  "minecraft:oak_log", "minecraft:spruce_log", "minecraft:birch_log", "minecraft:jungle_log", "minecraft:acacia_log", "minecraft:dark_oak_log", "minecraft:mangrove_log", "minecraft:cherry_log",
  "minecraft:stone", "minecraft:cobblestone", "minecraft:deepslate", "minecraft:cobbled_deepslate", "minecraft:dirt", "minecraft:grass_block", "minecraft:sand", "minecraft:gravel",
  "minecraft:coal_ore", "minecraft:deepslate_coal_ore", "minecraft:iron_ore", "minecraft:deepslate_iron_ore", "minecraft:copper_ore", "minecraft:deepslate_copper_ore",
  "minecraft:gold_ore", "minecraft:deepslate_gold_ore", "minecraft:redstone_ore", "minecraft:deepslate_redstone_ore", "minecraft:lapis_ore", "minecraft:deepslate_lapis_ore",
  "minecraft:diamond_ore", "minecraft:deepslate_diamond_ore", "minecraft:crafting_table", "minecraft:chest", "minecraft:trapped_chest", "minecraft:furnace"
]);
const HOSTILE = new Set([
  "minecraft:zombie", "minecraft:husk", "minecraft:drowned", "minecraft:skeleton", "minecraft:stray", "minecraft:bogged",
  "minecraft:creeper", "minecraft:spider", "minecraft:cave_spider", "minecraft:enderman", "minecraft:witch",
  "minecraft:phantom", "minecraft:pillager", "minecraft:vindicator", "minecraft:evoker", "minecraft:vex",
  "minecraft:ravager", "minecraft:slime", "minecraft:magma_cube", "minecraft:blaze", "minecraft:ghast",
  "minecraft:piglin", "minecraft:piglin_brute", "minecraft:hoglin", "minecraft:zoglin", "minecraft:warden",
  "minecraft:guardian", "minecraft:elder_guardian", "minecraft:shulker", "minecraft:silverfish", "minecraft:endermite",
  "minecraft:breeze", "minecraft:wither_skeleton", "minecraft:zombie_villager"
]);
const FRIENDLY = new Set(["minecraft:cow", "minecraft:pig", "minecraft:sheep", "minecraft:chicken", "minecraft:villager", "minecraft:wandering_trader", "minecraft:wolf", "minecraft:cat", "minecraft:horse", "minecraft:donkey", "minecraft:fox", "minecraft:rabbit", "minecraft:bee", "minecraft:axolotl", "minecraft:goat", "minecraft:allay"]);

/**
 * The single hostile-mob classifier. bot-controller and action-engine used to
 * carry their own copies of this list, and the copies had drifted (one knew
 * about wardens, the other did not), which is precisely how "the bot ignored
 * that mob" happens. Everything imports this now.
 */
export function isHostileType(typeId) {
  const id = String(typeId || "");
  return HOSTILE.has(id) || /zombie|husk|drowned|skeleton|stray|bogged|creeper|spider|witch|enderman|phantom|pillager|vindicator|evoker|ravager|slime|magma_cube|blaze|ghast|piglin|hoglin|zoglin|warden|guardian|shulker|vex|silverfish|endermite|breeze/.test(id);
}

export function isCreeperType(typeId) { return /creeper/.test(String(typeId || "")); }

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
    return value ? { current: Math.round(value.currentValue * 10) / 10, max: Math.round((value.effectiveMax ?? value.defaultValue ?? 20) * 10) / 10 } : undefined;
  } catch (error) { return undefined; }
}

function tally(map, id) { map[id] = (map[id] || 0) + 1; }

/**
 * Blocks that cover almost every cell of a normal landscape. They are still
 * observed and reported, but they must not be allowed to crowd out the thing the
 * bot was asked to find: with a flat cap the 64 nearest matches were all grass
 * and dirt under the bot's feet, and an oak tree five blocks away was invisible
 * — which reads in-game as "the bot cannot find any oak logs" while the player is
 * standing in a forest (AC-05, AC-11, AC-15).
 */
const COMMON_GROUND = new Set([
  "minecraft:grass_block", "minecraft:dirt", "minecraft:stone", "minecraft:cobblestone",
  "minecraft:deepslate", "minecraft:cobbled_deepslate", "minecraft:sand", "minecraft:gravel",
  "minecraft:andesite", "minecraft:diorite", "minecraft:granite", "minecraft:netherrack"
]);

/** Everything worth travelling for: resources, ores and useful stations. */
const NOTABLE = (id) => !COMMON_GROUND.has(id);

/**
 * Blocks that are not the objective but *prove* the objective is nearby: an oak
 * canopy means oak logs are under it. They are observed (and reported honestly)
 * so a bot standing in a forest can walk to a tree instead of declaring "I can't
 * find any oak logs" — the single most visible way this pack used to fail AC-15.
 */
const HINT_TYPES = new Set([
  "minecraft:oak_leaves", "minecraft:birch_leaves", "minecraft:spruce_leaves", "minecraft:jungle_leaves",
  "minecraft:acacia_leaves", "minecraft:dark_oak_leaves", "minecraft:mangrove_leaves", "minecraft:cherry_leaves"
]);

/** objective block → the hint blocks that mean "one is over there". */
export const HINT_FOR_BLOCK = Object.freeze({
  "minecraft:oak_log": ["minecraft:oak_leaves"],
  "minecraft:birch_log": ["minecraft:birch_leaves"],
  "minecraft:spruce_log": ["minecraft:spruce_leaves"],
  "minecraft:jungle_log": ["minecraft:jungle_leaves"],
  "minecraft:acacia_log": ["minecraft:acacia_leaves"],
  "minecraft:dark_oak_log": ["minecraft:dark_oak_leaves"],
  "minecraft:mangrove_log": ["minecraft:mangrove_leaves"],
  "minecraft:cherry_log": ["minecraft:cherry_leaves"],
  "minecraft:diamond_ore": ["minecraft:stone", "minecraft:deepslate"],
  "minecraft:iron_ore": ["minecraft:stone", "minecraft:deepslate"],
  "minecraft:coal_ore": ["minecraft:stone", "minecraft:deepslate"],
  "minecraft:copper_ore": ["minecraft:stone", "minecraft:deepslate"],
  "minecraft:gold_ore": ["minecraft:stone", "minecraft:deepslate"],
  "minecraft:redstone_ore": ["minecraft:stone", "minecraft:deepslate"],
  "minecraft:lapis_ore": ["minecraft:stone", "minecraft:deepslate"]
});

/**
 * Two scan shapes, one budget.
 *
 * A filled sphere is the right shape for the ground under the bot's feet (hazards,
 * drops, the block it is about to mine) and hopeless for finding anything: a
 * sphere that reaches 24 blocks costs ~14 000 reads and AC-41 forbids that. So
 * the far field is sampled as SONAR RINGS — circles at trunk and canopy height.
 * They are sparse by design and still reliable, because the things worth walking
 * to are wide: 24 bearings on a 24-block ring are ~6 blocks apart and an oak
 * canopy is 7 across, so a tree in range is essentially always hit.
 *
 * This is what makes "collect oak logs" work in a normal world. With only the
 * sphere, a bot could not see a tree 12 blocks away and reported "no oak log was
 * found" while standing in a forest (AC-05/AC-11/AC-15).
 */
const RING_REACH = 24;

function scanBlocks(bot, radius, budget, wanted = null) {
  const origin = bot.location, dimension = bot.dimension;
  const reach = Math.max(4, Math.min(radius, 8));

  /** Cells the bot stands among: ground, hazards, drops, the block it mines. */
  const core = [];
  /** A dense band at trunk and canopy height: this is what finds a tree. */
  const trunk = [];
  /** Sampled circles further out: cheap range, enough for anything wide. */
  const rings = [];

  for (let y = -2; y <= 3; y += 1) {
    for (let x = -3; x <= 3; x += 1) {
      for (let z = -3; z <= 3; z += 1) {
        const flat = Math.hypot(x, z);
        if (flat > 3) continue;
        core.push(cell(x, y, z, flat));
      }
    }
  }
  // A tree is recognised by its trunk at eye level OR by its canopy four blocks
  // up: every oak trunk has a log at +1 and every oak crown has leaves at +4.
  //
  // This band is enumerated COLUMN-COMPLETE. It used to push all six heights for
  // every column and let a distance+height score cut the list to 250 cells,
  // which bought six heights for the near columns and none at all beyond ~5.9
  // blocks: a trunk 6.4 blocks away was invisible while its own leaves at 4.2
  // were seen, so the bot set off to "investigate the canopy" of the tree it was
  // already standing next to and the order failed (AC-44). Now every column out
  // to `reach` is read at trunk height, and the nearer ones also get canopy and
  // ground — full coverage of the band the bot can actually walk to.
  for (let x = -reach; x <= reach; x += 1) {
    for (let z = -reach; z <= reach; z += 1) {
      const flat = Math.hypot(x, z);
      if (flat > reach || flat <= 3) continue;
      for (const y of (flat <= TRUNK_NEAR ? TRUNK_NEAR_HEIGHTS : TRUNK_FAR_HEIGHTS)) trunk.push(cell(x, y, z, flat));
    }
  }
  for (let ring = reach + 3; ring <= RING_REACH; ring += 3) {
    const bearings = Math.max(16, Math.round(ring * 1.4));
    for (let index = 0; index < bearings; index += 1) {
      const angle = (index / bearings) * Math.PI * 2;
      const x = Math.round(Math.cos(angle) * ring);
      const z = Math.round(Math.sin(angle) * ring);
      const flat = Math.hypot(x, z);
      for (const y of RING_HEIGHTS) rings.push(cell(x, y, z, flat));
    }
  }

  const byScore = (a, b) => a.score - b.score || a.d - b.d;
  core.sort(byScore);
  trunk.sort(byScore);
  rings.sort(byScore);
  // Explicit per-group caps. One shared sort is what broke this scan before:
  // the ground disc under the bot's feet is the cheapest thing to enumerate and
  // the least useful thing to know, so it filled the budget and an oak trunk
  // 5.8 blocks away was never read at all (AC-05/AC-11/AC-15).
  const offsets = [...core.slice(0, 150), ...trunk.slice(0, 350), ...rings.slice(0, 100)];
  offsets.sort(byScore);

  // Bounded on purpose (AC-41): at most `cellCap` block reads per observation,
  // and observations themselves run on `observationIntervalTicks`, never every
  // game tick. The counters go into `budget` so /aibot:info can show the real
  // cost instead of an assumption.
  const cellCap = budget?.cellCap ?? 600;
  /** @type {any[]} */
  const notable = [];
  /** @type {any[]} */
  const common = [];
  for (const offset of offsets.slice(0, cellCap)) {
    try {
      budget.cellsRead += 1;
      const position = { x: Math.floor(origin.x + offset.x), y: Math.floor(origin.y + offset.y), z: Math.floor(origin.z + offset.z) };
      const value = dimension.getBlock(position);
      if (!value) continue;
      const hint = HINT_TYPES.has(value.typeId);
      if (!hint && !BLOCK_TYPES.has(value.typeId)) continue;
      const record = {
        id: value.typeId, type: value.typeId, position: [position.x, position.y, position.z],
        relative: [offset.x, offset.y, offset.z], distance: Math.round(offset.d * 10) / 10,
        direction: direction(origin, position), hint
      };
      // The block the current task wants — and anything that hints at it — is
      // always kept, whatever it is.
      if (hint || NOTABLE(value.typeId) || (wanted && value.typeId === wanted)) notable.push(record);
      else common.push(record);
    } catch (error) { /* Unloaded/out-of-height cells are skipped. */ }
  }
  const byDistance = (a, b) => a.distance - b.distance;
  notable.sort(byDistance);
  common.sort(byDistance);
  // Keep every resource-ish block up to a generous cap, plus a small slice of
  // ground so the snapshot still describes where the bot is standing.
  return [...notable.slice(0, 88), ...common.slice(0, 12)].sort(byDistance).slice(0, 100);
}

/** Trunk height, then canopy height, then the rest: the order a tree is seen. */
const TREE_HEIGHTS = Object.freeze([1, 4, 0, 2, 5, 3]);
/**
 * Trunk-band heights by distance (AC-44). Inside 6 blocks the bot may be about
 * to mine or walk into the column, so it reads trunk, canopy and ground; from 6
 * out to `reach` one trunk-height read per column is enough to know the column
 * exists, and covering EVERY column matters more than covering one column well.
 */
const TRUNK_NEAR = 6;
const TRUNK_NEAR_HEIGHTS = Object.freeze([1, 4, 0]);
const TRUNK_FAR_HEIGHTS = Object.freeze([1]);
/** What the far circles look at: trunks, canopies, then ground and up. */
const RING_HEIGHTS = Object.freeze([1, 4, 2, 0]);
/** Read cost per height, so the useful ones are never crowded out. */
const HEIGHT_PENALTY = Object.freeze({ 1: 0, 4: 0.4, 0: 1.35, 2: 1.35, 5: 1.8, 3: 2.7 });

/** One candidate cell, with the score that decides whether it gets read. */
function cell(x, y, z, flat) {
  const score = flat + (HEIGHT_PENALTY[y] ?? (Math.abs(y - 1) * 1.35 + Math.max(0, -y - 1) * 0.8));
  return { x, y, z, d: Math.hypot(x, y, z), score };
}

function entityRecord(entity, origin, owner) {
  const type = entity.typeId;
  let item;
  if (type === "minecraft:item") {
    try { const stack = entity.getComponent("minecraft:item")?.itemStack; if (stack) item = { id: stack.typeId, name: itemName(stack.typeId), count: stack.amount }; } catch (error) { /* Item despawned. */ }
  }
  const record = {
    id: entity.id, identifier: type, type,
    name: entity.nameTag || type.replace(/^minecraft:/, ""),
    distance: Math.round(distance(origin, entity.location) * 10) / 10,
    direction: direction(origin, entity.location),
    relative: relative(origin, entity.location),
    health: health(entity),
    hostile: isHostileType(type),
    creeper: isCreeperType(type),
    friendly: FRIENDLY.has(type),
    item
  };
  if (type === "minecraft:player") {
    // AC-02: the owner must be distinguishable from any other player nearby,
    // by the stable name as well as the session id (runtime ids change on
    // reload, names do not).
    const id = String(entity.id ?? "");
    const name = String(entity.name ?? record.name ?? "");
    record.isPlayer = true;
    record.owner = Boolean(owner && ((owner.id && id === String(owner.id)) || (owner.name && name === String(owner.name))));
    try { record.gameMode = String(entity.getGameMode()); } catch (error) { /* Optional player detail. */ }
  }
  return record;
}

/**
 * Build one bounded snapshot of the world around the bot.
 *
 * @param {any} bot the companion entity
 * @param {object|null} task current task (echoed back for the planner prompt)
 * @param {any} memory MemoryStore, for prompt context
 * @param {object} config sanitised bot config
 * @param {{id?:string,name?:string}|null} [owner] owner identity for AC-02
 */
export function makeObservation(bot, task, memory, config, owner = null) {
  const started = Date.now();
  const radius = Math.min(12, Math.max(4, Number(config?.observationRadius || 8)));
  // Entities are found by the engine itself, so looking further costs no block
  // reads — and a creeper spotted at 8 blocks is spotted too late to matter
  // (AC-07 protect, AC-24 hit-and-run).
  const entityRadius = Math.min(32, Math.max(radius * 2, 24));
  const origin = bot.location;
  /** Cost counters — surfaced in `observation.scan` and in /aibot:info (AC-41). */
  const budget = { cellsRead: 0, entitiesRead: 0, cellCap: 600, entityCap: 40, ms: 0 };
  let records = [];
  try {
    const seen = bot.dimension.getEntities({ location: origin, maxDistance: entityRadius }).filter((entity) => entity.id !== bot.id);
    budget.entitiesRead = seen.length;
    records = seen.slice(0, budget.entityCap).map((entity) => entityRecord(entity, origin, owner));
  } catch (error) { /* Entity or chunk became unavailable; return a safe empty snapshot. */ }

  const players = records.filter((entity) => entity.type === "minecraft:player");
  const nearbyItems = records.filter((entity) => entity.type === "minecraft:item").map((entity) => ({ ...entity.item, entityId: entity.id, distance: entity.distance, direction: entity.direction, relative: entity.relative }));
  const mobs = records.filter((entity) => entity.type !== "minecraft:player" && entity.type !== "minecraft:item");
  const threats = mobs.filter((entity) => entity.hostile).sort((a, b) => a.distance - b.distance || (b.creeper ? 1 : 0) - (a.creeper ? 1 : 0));
  // The task's target block is always kept, even when it is common ground.
  const blocks = scanBlocks(bot, radius, budget, String(task?.block || ""));

  /** id → count maps. Cheap, and they are what the acceptance check reads. */
  const blockCounts = {};
  for (const block of blocks) tally(blockCounts, block.id);
  const entityCounts = {};
  for (const record of records) tally(entityCounts, record.type);

  budget.ms = Date.now() - started;

  // The owner, resolved from this scan only. `null` when the owner is out of
  // range — which is information in itself ("I can't see you"), not an error.
  const ownerRecord = players.find((player) => player.owner) || null;
  const strangers = players.filter((player) => !player.owner);

  return {
    timestamp: Date.now(), position: [Math.floor(origin.x), Math.floor(origin.y), Math.floor(origin.z)], dimension: bot.dimension.id,
    players, mobs, blocks, nearbyItems,
    danger: threats.some((threat) => threat.distance <= 8), threats,
    owner: ownerRecord ? { id: ownerRecord.id, name: ownerRecord.name, distance: ownerRecord.distance, direction: ownerRecord.direction, relative: ownerRecord.relative } : null,
    strangers: strangers.map((player) => ({ id: player.id, name: player.name, distance: player.distance })),
    nearestPlayer: [...players].sort((a, b) => a.distance - b.distance)[0] || null,
    blockCounts, entityCounts, scan: budget,
    hints: blocks.filter((block) => block.hint).map((block) => ({ id: block.id, position: block.position, distance: block.distance })),
    // The blocks worth REMEMBERING: real resources, not the grass underfoot.
    // Memory stores these so a later "I can't see any oak log" can be answered
    // with "I saw one over there" instead of a random walk (AC-13/AC-32).
    resources: blocks.filter((block) => !block.hint && !COMMON_GROUND.has(block.type))
      .map((block) => ({ id: block.id, position: block.position, distance: block.distance })),
    // Compatibility aliases consumed internally; both contain structured records.
    nearbyBlocks: blocks, nearbyEntities: records,
    inventory: readInventory(bot),
    task: task ? { id: task.id, goal: task.goal, kind: task.kind, status: task.status, progress: task.progress, target: task.target, remaining: task.remaining, targetPosition: task.targetPosition || null, reason: task.reason || "player request" } : null,
    memory: memory?.promptContext(task) || null
  };
}

export function nearestObservedBlock(observation, typeId) { return observation?.blocks?.find((block) => block.type === typeId) || null; }

/**
 * "Did I actually see any of this?" — the reality check AC-13 and AC-40 need.
 * Returns the observed count of a block id, 0 when it was never seen.
 */
export function observedCount(observation, typeId) {
  return Number(observation?.blockCounts?.[String(typeId || "")] || 0);
}

export { HOSTILE, FRIENDLY, BLOCK_TYPES };
