import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// This file reproduces the exact broken setup from the player report:
// a no-chat game build, a world with real dynamic properties, and a SECOND
// copy of the AI Bot behavior pack active alongside this one.

const stubs = new Map([
  ["@minecraft/server", "#stub/bedrock"],
  ["@minecraft/server-ui", "#stub/bedrock-ui"]
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (stubs.has(specifier)) return nextResolve(stubs.get(specifier), context);
    return nextResolve(specifier, context);
  }
});

const bedrock = await import("#stub/bedrock");
bedrock.setChatAvailable(false);
bedrock.enableWorldProperties();

const main = await import("../behavior_packs/autonomous_ai_bot/scripts/main.js");

function heartbeats() {
  return bedrock.world.getDynamicPropertyIds().filter((id) => id.startsWith("aibot:hb:"));
}

test("a second running copy of the pack is detected and the player is told how to fix it", () => {
  const guard = main.__duplicateGuardForTests();
  // A second instance's heartbeat, id ordered after ours so THIS instance is
  // the one that warns (the deterministic single-warner rule).
  const otherId = `${guard.instanceId}zzz`;
  bedrock.world.setDynamicProperty(`aibot:hb:${otherId}`, JSON.stringify({ v: "1.2.0", at: Date.now() }));

  const player = bedrock.addPlayer("Warned");
  bedrock.world.afterEvents.playerSpawn.fire({ player, initialSpawn: true });
  bedrock.advance(20);

  const text = player.sentMessages.join("\n");
  assert.match(text, /Two copies of the AI Bot script are running/);
  assert.match(text, /v1\.2\.0/);
  assert.match(text, /deactivate the older/i);
  assert.match(globalThis.__aibotController.infoText(), /Duplicate packs: DETECTED/);

  // The same player is warned once, not on every sweep.
  const messagesBefore = player.sentMessages.length;
  guard.sweep();
  assert.equal(player.sentMessages.length, messagesBefore);
});

test("heartbeats from copies that are no longer running are cleaned up", () => {
  bedrock.world.setDynamicProperty("aibot:hb:old-dead-copy", JSON.stringify({ v: "1.0.0", at: Date.now() - 10 * 60 * 1000 }));
  const guard = main.__duplicateGuardForTests();
  const other = guard.sweep();
  assert.equal(bedrock.world.getDynamicProperty("aibot:hb:old-dead-copy"), undefined, "stale heartbeat must be reclaimed");
  assert.ok(!other || other.id !== "old-dead-copy", "a dead copy must not be reported as running");
  // Our own heartbeat exists and stays.
  assert.ok(heartbeats().some((id) => id.endsWith(guard.instanceId)));
});

test("create adopts an existing same-named companion instead of spawning a duplicate", () => {
  const player = bedrock.addPlayer("Guarded");
  // A bot the other pack copy spawned: present in the world, but never
  // registered with this controller (its entityLoad event never reached us).
  const existing = bedrock.world.getDimension("overworld").spawnEntity("aibot:companion", { x: 3, y: 64, z: 3 });
  existing.setDynamicProperty("aibot:name", "Unique");
  existing.setDynamicProperty("aibot:owner_id", player.id);
  existing.setDynamicProperty("aibot:owner_name", player.name);
  existing.nameTag = "Unique";

  const result = globalThis.__aibotController.create(player, "Unique");
  assert.equal(result.created, false);
  assert.equal(result.agent?.name, "Unique");
  const sameName = bedrock.world.getDimension("overworld")
    .getEntities({ type: "aibot:companion" })
    .filter((entity) => entity.getDynamicProperty("aibot:name") === "Unique");
  assert.equal(sameName.length, 1, "no second entity with the same name may be spawned");
  assert.match(player.sentMessages.join("\n"), /already at your side/);
});

test("the join message warns about the two-banner symptom of double-imported packs", () => {
  const player = bedrock.addPlayer("Fresh");
  bedrock.world.afterEvents.playerSpawn.fire({ player, initialSpawn: true });
  bedrock.advance(80);

  const text = player.sentMessages.join("\n");
  assert.match(text, /Script loaded \(chat: §cunavailable§r\)/);
  assert.match(text, /Seeing two "\[AI Bot …\] Script loaded" banners/);
  assert.match(text, /deactivate the older AI Bot behavior pack/);
  assert.match(text, /Auto-summoned/);
  assert.doesNotMatch(text, /Type §e!aibot create Steve/);
});
