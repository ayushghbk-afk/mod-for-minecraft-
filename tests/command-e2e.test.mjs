import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// Map the Bedrock-only modules onto the in-memory stub before main.js is loaded.
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
const main = await import("../behavior_packs/autonomous_ai_bot/scripts/main.js");

test("script entry point loads and advertises a version", () => {
  assert.match(main.SCRIPT_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof globalThis.__aibotController, "object");
});

test("!aibot create Steve spawns an owner-bound bot and confirms in chat", () => {
  const player = bedrock.addPlayer("Ayush");
  bedrock.advance(20);

  const replies = bedrock.command(player, "!aibot create Steve");
  assert.equal(replies.length, 1, `expected exactly one reply, got: ${JSON.stringify(replies)}`);
  assert.match(replies[0], /Created Steve/);

  const bots = bedrock.world.getDimension("overworld").getEntities({ type: "aibot:companion" });
  assert.equal(bots.length, 1, "the companion entity must actually exist in the dimension");
  assert.equal(bots[0].getDynamicProperty("aibot:name"), "Steve");
  assert.equal(bots[0].getDynamicProperty("aibot:owner_id"), player.id);
  assert.equal(bots[0].getDynamicProperty("aibot:owner_name"), "Ayush");
  assert.match(bots[0].nameTag, /^Steve\n/);

  assert.deepEqual(globalThis.__aibotController.names(), ["Steve"]);
});

test("the same chat message never creates two bots", () => {
  const player = bedrock.addPlayer("Dup");
  const replies = bedrock.command(player, "!aibot create Dupbot");
  assert.equal(replies.length, 1);
  const second = bedrock.command(player, "!aibot create Dupbot");
  // Re-running create with your own existing bot hands it back instead of
  // scolding the player with "already exists" — that message is what made
  // rejoining players think the mod was broken.
  assert.match(second[0], /already at your side/);
  assert.equal(globalThis.__aibotController.names().filter((name) => name === "Dupbot").length, 1);
});

test("command prefixes tolerate the typos players actually make", () => {
  const player = bedrock.addPlayer("Typo");
  for (const text of ["aibot create Alpha", "!bot create Bravo", "!aibot: create Charlie", "AIBOT CREATE Delta"]) {
    const replies = bedrock.command(player, text);
    assert.match(replies[0] ?? "", /Created/, `${text} should create a bot, got ${JSON.stringify(replies)}`);
  }
  const names = globalThis.__aibotController.names();
  for (const expected of ["Alpha", "Bravo", "Charlie", "Delta"]) assert.ok(names.includes(expected), `${expected} missing from ${names}`);
});

test("an unrelated chat message is ignored, not treated as a command", () => {
  const player = bedrock.addPlayer("Quiet");
  const replies = bedrock.command(player, "bot follow me please");
  assert.deepEqual(replies, []);
});

test("!aibot info proves the script engine is alive and reports the chat binding", () => {
  const player = bedrock.addPlayer("Doc");
  bedrock.command(player, "!aibot create Docbot");
  const replies = bedrock.command(player, "!aibot info");
  assert.match(replies[0], /diagnostics/);
  assert.match(replies[0], /Script: v\d+\.\d+\.\d+/);
  assert.match(replies[0], /Chat event: (before|after)Events\.chatSend/);
  assert.match(replies[0], /Slash commands: /);
  assert.match(replies[0], /Scriptevent bridge: /);
  assert.match(replies[0], /Compass menu event: (before|after)Events\.itemUse/);
  assert.match(replies[0], /Tick loop: running/);
  assert.match(replies[0], /Docbot/);
});

test("!aibot remove frees a bot name so it can be created again", () => {
  const player = bedrock.addPlayer("Rem");
  bedrock.command(player, "!aibot create Rembot");
  assert.match(bedrock.command(player, "!aibot remove Rembot")[0], /Removed Rembot/);
  assert.match(bedrock.command(player, "!aibot create Rembot")[0], /Created Rembot/);
});

test("a failed spawn reports a real reason instead of staying silent", () => {
  bedrock.setEntityRegistered(false);
  try {
    const player = bedrock.addPlayer("Broken");
    const replies = bedrock.command(player, "!aibot create Nobody");
    assert.match(replies[0], /Could not spawn aibot:companion/);
    assert.match(replies[0], /entity definition itself was rejected/);
    assert.match(replies[1], /!aibot info/);
  } finally {
    bedrock.setEntityRegistered(true);
  }
});

test("natural language still reaches the owner-bound bot", () => {
  main.__resetForTests();
  const player = bedrock.addPlayer("Owner");
  bedrock.command(player, "!aibot create Steve");
  const replies = bedrock.command(player, "Steve, follow me");
  assert.match(replies[0], /Following you/);
  const status = bedrock.command(player, "!aibot status");
  assert.match(status[0], /Status: FOLLOWING/);
});

test("custom slash commands register alongside chat and /aibot:create works", () => {
  const registrations = new Map();
  const registry = {
    registerCommand(spec, callback) {
      if (!/^[a-z0-9_]+:[a-z0-9_]+$/.test(String(spec.name))) {
        throw new Error(`Custom command names must be namespaced, got '${spec.name}'`);
      }
      registrations.set(spec.name, { spec, callback });
    }
  };
  bedrock.fireStartup(registry);

  assert.equal(registrations.size, 14, "slash commands must register even when chat also works");
  const player = bedrock.addPlayer("Slasher");
  const result = registrations.get("aibot:create").callback({ sourceEntity: player }, "Slashy");
  assert.equal(result.status, bedrock.CustomCommandStatus.Success);
  bedrock.advance(4);
  assert.match(player.sentMessages.join("\n"), /Created Slashy/);
});

test("the welcome message and auto-summon match a build where chat works", () => {
  const player = bedrock.addPlayer("Greeter");
  bedrock.world.afterEvents.playerSpawn.fire({ player, initialSpawn: true });
  bedrock.advance(80);

  const text = player.sentMessages.join("\n");
  assert.match(text, /Script loaded \(chat: §aok§r\)/);
  assert.match(text, /Type §e!aibot create Steve§r to spawn your bot/);
  assert.match(text, /Auto-summoned AIBot/);
  assert.ok(globalThis.__aibotController.byName("AIBot"), "auto-summon must spawn the bot for real");
});


test("bot takes collect tasks from chat and replies out loud", () => {
  main.__resetForTests();
  const player = bedrock.addPlayer("Talker");
  bedrock.command(player, "!aibot create Steve");
  const replies = bedrock.command(player, "Steve, get me 8 oak logs");
  assert.match(replies.join("\n"), /On it|oak_log|8/);
  const agent = globalThis.__aibotController.byName("Steve");
  assert.ok(agent);
  assert.equal(agent.tasks.current?.kind, "collect");
  assert.equal(agent.tasks.current?.target, 8);
});

test("bot chats back when mentioned with free-form text", () => {
  main.__resetForTests();
  const player = bedrock.addPlayer("Chatter");
  bedrock.command(player, "!aibot create Bob");
  const replies = bedrock.command(player, "Bob, hello there");
  assert.match(replies.join("\n"), /Hey|hello|What do you need/i);
});

test("bot protect command arms defend mode via natural language", () => {
  main.__resetForTests();
  const player = bedrock.addPlayer("Guard");
  bedrock.command(player, "!aibot create Rex");
  const replies = bedrock.command(player, "Rex, protect me");
  assert.match(replies.join("\n"), /Defend/i);
  const agent = globalThis.__aibotController.byName("Rex");
  assert.equal(agent.config.combatMode, "defend_owner");
});
