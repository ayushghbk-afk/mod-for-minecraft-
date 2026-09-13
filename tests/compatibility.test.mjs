import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@minecraft/server") return nextResolve("#stub/bedrock", context);
  return nextResolve(specifier, context);
} });

const bedrock = await import("#stub/bedrock");
const { findLocalRoute, moveEntityTowards, applyPlayerStep, stopEntity, isSafeCell } = await import("../behavior_packs/autonomous_ai_bot/scripts/core/navigation.js");
const { makeObservation } = await import("../behavior_packs/autonomous_ai_bot/scripts/core/observation.js");

function flatWorld(dimension, radius = 12) {
  for (let x = -radius; x <= radius; x += 1) for (let z = -radius; z <= radius; z += 1) {
    const location = { x, y: 63, z };
    dimension.getBlock(location).typeId = "minecraft:stone";
  }
}

test("manifests use stable 2.9/2.1 and the BP owns the RP dependency", async () => {
  const bp = JSON.parse(await readFile("behavior_packs/autonomous_ai_bot/manifest.json"));
  const rp = JSON.parse(await readFile("resource_packs/autonomous_ai_bot/manifest.json"));
  assert.deepEqual(bp.header.min_engine_version, [1, 26, 40]);
  assert.equal(bp.dependencies.find((entry) => entry.module_name === "@minecraft/server").version, "2.9.0");
  assert.equal(bp.dependencies.find((entry) => entry.module_name === "@minecraft/server-ui").version, "2.1.0");
  assert.deepEqual(bp.dependencies.find((entry) => entry.uuid === rp.header.uuid).version, rp.header.version);
  assert.equal(rp.dependencies, undefined);
});

test("local A* routes around a solid obstacle and normal movement never teleports", () => {
  const dimension = new bedrock.Dimension("test");
  flatWorld(dimension);
  dimension.getBlock({ x: 1, y: 64, z: 0 }).typeId = "minecraft:stone";
  dimension.getBlock({ x: 1, y: 65, z: 0 }).typeId = "minecraft:stone";
  const route = findLocalRoute(dimension, { x: 0, y: 64, z: 0 }, { x: 4, y: 64, z: 0 });
  assert.ok(route.length > 0);
  assert.notDeepEqual(route[0], { x: 1.5, y: 64, z: 0.5 }, "route should avoid the blocked cell");
  const entity = new bedrock.Entity("aibot:companion", { x: 0.5, y: 64, z: 0.5 }, dimension);
  let teleports = 0;
  entity.teleport = () => { teleports += 1; };
  const result = moveEntityTowards(entity, { x: 4.5, y: 64, z: 0.5 });
  assert.equal(result.success, true);
  assert.equal(teleports, 0, "teleport is forbidden during ordinary navigation");
  assert.ok(entity.velocity.x !== 0 || entity.velocity.z !== 0);
});

test("observation is structured and classifies the correctly namespaced creeper", () => {
  const dimension = new bedrock.Dimension("overworld");
  flatWorld(dimension, 5);
  const bot = new bedrock.Entity("aibot:companion", { x: 0, y: 64, z: 0 }, dimension);
  dimension.entities.push(bot);
  const player = new bedrock.Player("Owner", { x: 2, y: 64, z: 0 }, dimension);
  dimension.entities.push(player);
  const creeper = new bedrock.Entity("minecraft:creeper", { x: 3, y: 64, z: 0 }, dimension);
  dimension.entities.push(creeper);
  const observation = makeObservation(bot, null, null, { observationRadius: 8 });
  assert.equal(observation.players[0].name, "Owner");
  assert.equal(observation.mobs[0].identifier, "minecraft:creeper");
  assert.equal(observation.mobs[0].hostile, true);
  assert.equal(observation.danger, true);
  assert.ok(Array.isArray(observation.blocks));
  assert.ok(Array.isArray(observation.nearbyItems));
});

test("movement is player-like: constant walk speed, no hopping, smooth stop, step-up jump", () => {
  const dimension = new bedrock.Dimension("test");
  flatWorld(dimension, 12);
  const entity = new bedrock.Entity("aibot:companion", { x: 0.5, y: 64, z: 0.5 }, dimension);

  // Flat ground: horizontal walk velocity only — zero vertical (no hopping).
  const result = moveEntityTowards(entity, { x: 8.5, y: 64, z: 0.5 }, { speed: 0.215, stopDistance: 1.8 });
  assert.equal(result.success, true);
  const v0 = entity.getVelocity();
  assert.equal(v0.y, 0, "flat-ground walking must not inject vertical velocity");
  assert.ok(Math.hypot(v0.x, v0.z) > 0, "the bot must actually be moving");

  // Per-tick steering converges to the player walk speed instead of
  // accumulating raw impulses.
  for (let i = 0; i < 10; i += 1) applyPlayerStep(entity);
  const v1 = entity.getVelocity();
  const speed = Math.hypot(v1.x, v1.z);
  assert.ok(Math.abs(speed - 0.215) < 0.02, `speed ${speed.toFixed(3)} drifted away from player walk speed`);
  assert.equal(v1.y, 0, "gravity is preserved; no artificial lift while walking");

  // Stopping eases the bot to rest — a deceleration, never an instant freeze.
  stopEntity(entity);
  applyPlayerStep(entity);
  assert.ok(Math.hypot(entity.getVelocity().x, entity.getVelocity().z) > 0.05, "stop must decelerate, not zero the velocity");
  for (let i = 0; i < 30; i += 1) applyPlayerStep(entity);
  assert.ok(Math.hypot(entity.getVelocity().x, entity.getVelocity().z) < 0.01, "the bot must come to rest");

  // A 1-block step-up that cannot be walked around triggers exactly the
  // player jump impulse (0.42 blocks/tick, the vanilla player jump rise).
  const climber = new bedrock.Entity("aibot:companion", { x: 0.5, y: 64, z: 0.5 }, dimension);
  for (let z = -3; z <= 3; z += 1) {
    dimension.getBlock({ x: 1, y: 64, z }).typeId = "minecraft:stone";
  }
  moveEntityTowards(climber, { x: 4.5, y: 64, z: 0.5 }, { speed: 0.215, stopDistance: 1.8 });
  assert.ok(climber.getVelocity().y >= 0.4, `step-up must jump like a player (vy=${climber.getVelocity().y})`);
  assert.ok(climber.getVelocity().y <= 0.42, "jump impulse must not exceed the player jump speed");
});

test("spawning only into standing-open cells keeps the bot visible in the world", () => {
  const dimension = new bedrock.Dimension("test");
  flatWorld(dimension, 6);
  const buried = { x: 2, y: 64, z: 0 };
  assert.equal(isSafeCell(dimension, buried), true);
  dimension.getBlock({ x: 2, y: 64, z: 0 }).typeId = "minecraft:stone";
  dimension.getBlock({ x: 2, y: 65, z: 0 }).typeId = "minecraft:stone";
  // A cell with solid stone at feet or head must be rejected as a spawn
  // location — a bot spawned there is swallowed by the terrain (invisible).
  assert.equal(isSafeCell(dimension, buried), false, "a bot spawned inside stone would be invisible");
  assert.equal(isSafeCell(dimension, { x: 2, y: 65, z: 0 }), false, "feet inside stone is not standable");
  // …while the cell standing on top of the column is a valid relocation target.
  assert.equal(isSafeCell(dimension, { x: 2, y: 66, z: 0 }), true);
});

test("client entity render chain is complete (the invisible-bot checklist)", async () => {
  const rp = "resource_packs/autonomous_ai_bot";
  const entity = JSON.parse(await readFile(`${rp}/entity/companion.entity.json`));
  const desc = entity["minecraft:client_entity"].description;
  assert.equal(desc.identifier, "aibot:companion");
  assert.ok(existsSync(`${rp}/textures/entity/ai_bot.png`), "texture file missing — the bot would render without a body");

  // Geometry: identifier matches the client entity and every bone carries an
  // explicit pivot AND rotation — a missing bone rotation is a documented
  // cause of "entity exists in the world but does not render".
  const geo = JSON.parse(await readFile(`${rp}/models/entity/aibot.player.geo.json`));
  const geometry = geo["minecraft:geometry"][0];
  assert.equal(desc.geometry.default, geometry.description.identifier);
  for (const bone of geometry.bones) {
    assert.ok(Array.isArray(bone.pivot) && bone.pivot.length === 3, `bone "${bone.name}" missing pivot`);
    assert.ok(Array.isArray(bone.rotation) && bone.rotation.length === 3, `bone "${bone.name}" missing rotation`);
    if (bone.parent) assert.ok(geometry.bones.some((b) => b.name === bone.parent), `bone "${bone.name}" references unknown parent "${bone.parent}"`);
  }

  // Every animation the client entity names must exist on disk, and the
  // animation controller must only play animations the entity defines.
  const animationNames = new Set();
  for (const file of readdirSync(`${rp}/animations`).filter((f) => f.endsWith(".json"))) {
    for (const name of Object.keys(JSON.parse(readFileSync(`${rp}/animations/${file}`, "utf8")).animations || {})) animationNames.add(name);
  }
  const controllerNames = new Set();
  for (const file of readdirSync(`${rp}/animation_controllers`).filter((f) => f.endsWith(".json"))) {
    for (const name of Object.keys(JSON.parse(readFileSync(`${rp}/animation_controllers/${file}`, "utf8")).animation_controllers || {})) controllerNames.add(name);
  }
  const shortNames = new Set();
  for (const [short, full] of Object.entries(desc.animations || {})) {
    shortNames.add(short);
    if (full.startsWith("animation.")) assert.ok(animationNames.has(full), `missing animation: ${full}`);
    if (full.startsWith("controller.animation.")) assert.ok(controllerNames.has(full), `missing animation controller: ${full}`);
  }
  for (const file of readdirSync(`${rp}/animation_controllers`).filter((f) => f.endsWith(".json"))) {
    const data = JSON.parse(readFileSync(`${rp}/animation_controllers/${file}`, "utf8"));
    for (const controller of Object.values(data.animation_controllers || {})) {
      for (const state of Object.values(controller.states || {})) {
        for (const entry of state.animations || []) {
          const name = typeof entry === "string" ? entry : Object.keys(entry)[0];
          assert.ok(shortNames.has(name), `controller plays an animation the client entity does not define: "${name}"`);
        }
      }
    }
  }

  // The render controller must exist too.
  const renderNames = new Set();
  for (const file of readdirSync(`${rp}/render_controllers`).filter((f) => f.endsWith(".json"))) {
    for (const name of Object.keys(JSON.parse(readFileSync(`${rp}/render_controllers/${file}`, "utf8")).render_controllers || {})) renderNames.add(name);
  }
  for (const rc of desc.render_controllers || []) assert.ok(renderNames.has(rc), `missing render controller: ${rc}`);

  // Molang math.max takes exactly TWO arguments. A three-argument call is an
  // invalid expression inside the client entity scripts, which can make
  // Bedrock drop the whole client entity — the bot then exists but renders
  // nothing. Scan every resource pack JSON file for that mistake.
  const bad = (text) => {
    const found = [];
    const re = /math\.max\s*\(/g;
    let match;
    while ((match = re.exec(text))) {
      let i = match.index + match[0].length;
      let depth = 1;
      let args = 1;
      while (i < text.length && depth > 0) {
        if (text[i] === "(") depth += 1;
        else if (text[i] === ")") depth -= 1;
        else if (text[i] === "," && depth === 1) args += 1;
        i += 1;
      }
      if (args !== 2) found.push(args);
    }
    return found;
  };
  for (const dir of ["entity", "animations", "animation_controllers", "render_controllers", "models/entity"]) {
    for (const file of readdirSync(`${rp}/${dir}`).filter((f) => f.endsWith(".json"))) {
      const text = readFileSync(`${rp}/${dir}/${file}`, "utf8");
      assert.deepEqual(bad(text), [], `math.max with an unsupported argument count in ${dir}/${file}`);
    }
  }
});

test("entity definitions use format versions Bedrock can actually parse", async () => {
  // A format_version the parser does not recognise (e.g. the game version
  // "1.26.40") makes Bedrock drop the definition entirely, so aibot:companion
  // is never registered and spawning reports "not a valid entity type".
  const bpEntity = JSON.parse(await readFile("behavior_packs/autonomous_ai_bot/entities/companion.json"));
  const rpEntity = JSON.parse(await readFile("resource_packs/autonomous_ai_bot/entity/companion.entity.json"));
  const parse = (value) => value.split(".").map(Number);
  const atMost = (actual, max) => {
    for (let i = 0; i < 3; i += 1) {
      if (actual[i] < max[i]) return true;
      if (actual[i] > max[i]) return false;
    }
    return true;
  };
  assert.ok(atMost(parse(bpEntity.format_version), [1, 21, 50]), `behavior entity format_version ${bpEntity.format_version} is not parseable`);
  assert.ok(atMost(parse(rpEntity.format_version), [1, 10, 0]), `client entity format_version ${rpEntity.format_version} is not parseable`);
  assert.equal(bpEntity["minecraft:entity"].description.identifier, "aibot:companion");
  assert.equal(bpEntity["minecraft:entity"].description.is_summonable, true);
  assert.equal(rpEntity["minecraft:client_entity"].description.identifier, "aibot:companion");
});
