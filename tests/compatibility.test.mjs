import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFile } from "node:fs/promises";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@minecraft/server") return nextResolve("#stub/bedrock", context);
  return nextResolve(specifier, context);
} });

const bedrock = await import("#stub/bedrock");
const { findLocalRoute, moveEntityTowards } = await import("../behavior_packs/autonomous_ai_bot/scripts/core/navigation.js");
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
