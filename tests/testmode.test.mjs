import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

/**
 * TEST MODE and the in-world self-test.
 *
 * These tests exist because the bug reports this pack keeps receiving are not
 * "the code is wrong" but "nothing happens and nothing is printed". Both
 * features are therefore pinned from both sides: errors must be *captured*
 * even when nobody asked, they must *reach chat* when test mode is on, they
 * must not *flood* chat when they repeat every tick, they must *survive* a
 * reload, and the check-up must turn a broken build into a list of named
 * failures with fixes instead of a shrug.
 */

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
// World dynamic properties are what makes the log survive a reload, so this
// file opts into the "real device" side of the stub.
bedrock.enableWorldProperties();

const main = await import("../behavior_packs/autonomous_ai_bot/scripts/main.js");
const { TestMode } = await import("../behavior_packs/autonomous_ai_bot/scripts/core/testmode.js");
const selftest = await import("../behavior_packs/autonomous_ai_bot/scripts/core/selftest.js");

const controller = () => globalThis.__aibotController;
const harness = () => main.__testModeForTests();

/** Fresh world, fresh player, fresh bot — and the harness never spams a stale log. */
function fresh(name = "Tester") {
  main.__resetForTests();
  harness().clear();
  harness().setEnabled(false, { announce: false });
  const player = bedrock.addPlayer(name);
  bedrock.advance(2);
  return player;
}

test("the harness is attached to the controller and starts out quiet", () => {
  const player = fresh("Quiet");
  bedrock.world.afterEvents.playerSpawn.fire({ player, initialSpawn: true });
  bedrock.advance(80);
  assert.equal(controller().test, harness(), "main.js must wire the harness into the controller");
  assert.equal(harness().enabled, false);
  assert.equal(harness().errorCount(), 0);
  // The join message must advertise the check-up, since that is the thing that
  // answers "it's not working" without a console — spelled in whichever form
  // this build can actually execute.
  const text = player.sentMessages.join("\n");
  assert.match(text, /!aibot test/, "a build with chat must be pointed at the chat form");
  assert.match(text, /!aibot debug on/);
  assert.match(main.welcomeLines(false, true).join("\n"), /\/aibot:test/, "a chat-less build must be pointed at the slash form");
  assert.match(main.welcomeLines(false, false).join("\n"), /compass/, "with neither, the menu is the only way in");
});

test("errors are always recorded, but only echoed into chat while test mode is on", () => {
  const player = fresh("Record");
  const seen = () => player.sentMessages.filter((line) => line.includes("▶ [TEST]")).length;

  harness().error("probe", new Error("silent failure"));
  assert.equal(seen(), 0, "a recorded error must not interrupt a player who did not ask for it");
  assert.match(harness().logLines(5).join("\n"), /silent failure/, "…but it must be readable afterwards");

  player.sentMessages.length = 0;
  harness().setEnabled(true, { origin: player });
  harness().error("probe", new Error("loud failure"));
  assert.equal(seen(), 1, "with test mode on, the error must reach chat");
  assert.match(player.sentMessages.join("\n"), /§c▶ \[TEST\] §fprobe/, "the line must be tagged and colour-coded as an error");
  assert.match(player.sentMessages.join("\n"), /TEST MODE ON/, "turning it on must be acknowledged in chat");
  assert.match(player.sentMessages.join("\n"), /loud failure/);
});

test("an error thrown every tick is folded into ×N instead of flooding chat", () => {
  const player = fresh("Flood");
  harness().setEnabled(true, { announce: false });
  player.sentMessages.length = 0;
  for (let index = 0; index < 25; index += 1) harness().error("every tick", new Error("repeating failure"));

  const echoes = player.sentMessages.filter((line) => line.includes("[TEST]"));
  assert.equal(echoes.length, 1, `25 identical errors must produce one chat line, got ${echoes.length}`);
  assert.match(harness().logLines(5).join("\n"), /×25/, "the log must show how often it actually happened");
  assert.ok(harness().stats.folded >= 24);
});

test("the spawn error a player cannot explain from chat lands in the log with the game's own words", () => {
  bedrock.setEntityRegistered(false);
  try {
    const player = fresh("SpawnBroken");
    harness().setEnabled(true, { announce: false });
    player.sentMessages.length = 0;
    bedrock.command(player, "!aibot create Ghost");
    const text = player.sentMessages.join("\n");
    assert.match(text, /\[TEST\] §fspawn bot/, "test mode must echo the raw spawn failure");
    assert.match(text, /Unknown entity type 'aibot:companion'/, "the game's own message is the diagnosis");
    assert.match(text, /Could not spawn aibot:companion/, "and the friendly summary still has to arrive");
  } finally {
    bedrock.setEntityRegistered(true);
  }
});

test("/aibot:debug on also turns on the per-bot debug dump, and off turns both off", () => {
  const player = fresh("Toggle");
  bedrock.command(player, "!aibot create Togglebot");
  harness().handle(player, "on", [], controller());
  assert.equal(harness().enabled, true);
  assert.equal(controller().byName("Togglebot").config.debug, true, "!aibot debug on must not silently do half the job");
  harness().handle(player, "off", [], controller());
  assert.equal(harness().enabled, false);
  assert.equal(controller().byName("Togglebot").config.debug, false);
});

test("the test mode flag and the error log survive a world reload", () => {
  const player = fresh("Persist");
  harness().setEnabled(true, { origin: player });
  harness().error("before reload", new Error("this must survive"), { context: "kept for the next session" });
  harness().persist({ force: true });
  assert.match(String(bedrock.world.getDynamicProperty("aibot:testlog")), /this must survive/);
  assert.equal(bedrock.world.getDynamicProperty("aibot:testmode"), true);

  // A new instance is what the game creates when the world is re-entered.
  const restored = new TestMode({ diagnostics: {} });
  assert.equal(restored.enabled, true, "test mode must still be on after a reload");
  assert.match(restored.logLines(5).join("\n"), /this must survive/);

  restored.clear();
  assert.equal(bedrock.world.getDynamicProperty("aibot:testlog"), undefined, "clearing must not leave a stale log in the world");
});

test("/aibot:debug log and /aibot:debug clear answer through the slash command path", () => {
  const registrations = new Map();
  const registry = {
    registerCommand(spec, callback) {
      if (!/^[a-z0-9_]+:[a-z0-9_]+$/.test(String(spec.name))) throw new Error(`not namespaced: ${spec.name}`);
      registrations.set(spec.name, callback);
    }
  };
  bedrock.fireStartup(registry);
  const player = fresh("Slashed");

  harness().error("slash probe", new Error("captured through the registry"));
  const callback = registrations.get("aibot:debug");
  assert.ok(callback, "the debug command must be registered");
  player.sentMessages.length = 0;
  callback({ sourceEntity: player }, "log");
  bedrock.advance(4);
  assert.match(player.sentMessages.join("\n"), /AI BOT ERROR LOG/);
  assert.match(player.sentMessages.join("\n"), /captured through the registry/);

  player.sentMessages.length = 0;
  callback({ sourceEntity: player }, "clear");
  bedrock.advance(4);
  assert.equal(harness().entries.length, 0);
  assert.match(player.sentMessages.join("\n"), /Error log cleared/);
});

test("the scriptevent bridge can turn test mode on where chat does not exist", () => {
  const player = fresh("Evented");
  bedrock.system.afterEvents.scriptEventReceive.fire({ id: "aibot:debug", message: "on", sourceEntity: player });
  bedrock.advance(4);
  assert.equal(harness().enabled, true, "no chat events and no custom commands must still leave a way in");
  assert.match(player.sentMessages.join("\n"), /TEST MODE ON/);
  harness().setEnabled(false, { announce: false });
});

test("a bot whose tick throws is reported, kept separate from the healthy ones, and announced once", () => {
  const player = fresh("Isolate");
  harness().setEnabled(true, { announce: false });
  bedrock.command(player, "!aibot create Broken");
  bedrock.command(player, "!aibot create Healthy");
  const broken = controller().byName("Broken");
  const healthy = controller().byName("Healthy");
  player.sentMessages.length = 0;

  let healthyTicks = 0;
  healthy.tick = () => { healthyTicks += 1; return true; };
  broken.tick = () => { throw new Error("agent exploded"); };

  // 20 runs of the 5-tick AI loop: enough to cross the "tell the owner once"
  // threshold (12 consecutive failures) several times over.
  for (let index = 0; index < 13; index += 1) controller().tick();

  assert.equal(healthyTicks, 13, `a throwing agent must not stop the others (healthy ticks: ${healthyTicks})`);
  assert.ok(controller().byName("Broken"), "a failing agent stays registered — dropping it would make the bot vanish");
  const text = player.sentMessages.join("\n");
  assert.match(text, /\[TEST\] §fbot tick/, "the failure must be echoed while test mode is on");
  assert.match(text, /agent exploded/);
  const complaints = player.sentMessages.filter((line) => /keeps failing every tick/.test(line)).length;
  assert.equal(complaints, 1, `the owner must be told once, not every tick (got ${complaints})`);
});

test("an engine failure during following is visible instead of vanishing", () => {
  const player = fresh("FollowFail");
  bedrock.command(player, "!aibot create Walker");
  const agent = controller().byName("Walker");
  agent.follow();
  agent.engine.execute = () => { throw new Error("engine on fire"); };
  player.sentMessages.length = 0;
  controller().tick();
  assert.match(agent.runtime.lastFollowResult, /engine threw/, "the follow step's verdict must be recorded on the agent");
  assert.match(harness().logLines(5).join("\n"), /engine on fire/);
});

test("liveness is measured: a stalled AI loop is a failure, not a silence", () => {
  const player = fresh("Stalled");
  harness().setEnabled(true, { announce: false });
  for (let index = 0; index < 6; index += 1) { bedrock.advance(5); controller().tick(); }
  assert.equal(harness().liveness.stalled, false, "a healthy loop must not be reported as stalled");
  assert.ok(harness().liveness.aiBeat >= 0);

  assert.ok(harness().flushJob, "the harness must run its own flush/liveness job");

  // The sampler's job is to notice silence while the game keeps ticking, so the
  // test rewinds the last beat rather than freezing the loop.
  bedrock.advance(600);
  harness().liveness.aiBeat = bedrock.system.currentTick - 500;
  harness().liveness.moveBeat = bedrock.system.currentTick - 500;
  harness().sampleLiveness();
  assert.equal(harness().liveness.stalled, true, "an AI loop that stopped beating must be reported");
  assert.equal(harness().liveness.movementStalled, true);
  const text = harness().logLines(8).join("\n");
  assert.match(text, /tick loop stalled/);
  assert.match(text, /movement loop stalled/);
  // …and it is loud even with test mode off, because "bot frozen" is otherwise
  // indistinguishable from "mod not installed".
  assert.ok(bedrock.world.getPlayers().length > 0);
});

/** A controller stand-in describing a build where nothing the pack needs works. */
function brokenController() {
  return {
    diagnostics: {
      scriptVersion: "0.0.0",
      chatSource: "NONE — chat commands are unavailable on this game build",
      slashCommands: "NOT registered",
      scriptEvent: "unavailable (needs a cheats-enabled world)",
      itemUseSource: "none — holding and using a compass cannot open the menu on this build",
      interactSource: "unavailable — tapping the bot will not open a panel; use /aibot:panel",
      duplicate: "DETECTED — v1.2.0 is running alongside this v2.3.0"
    },
    probe: { suppressAutoRegister: false },
    forPlayer: () => null,
    all: () => []
  };
}

test("the self-test turns a broken build into named failures with fixes", async () => {
  const player = fresh("Diagnose");
  const harnessCopy = new TestMode(brokenController());
  harnessCopy.clear();
  const rows = await selftest.runSelfTest({ player, controller: brokenController(), testMode: harnessCopy });
  const byId = new Map(rows.map((row) => [row.id, row]));

  assert.equal(byId.get("chat commands").status, "fail");
  assert.match(byId.get("chat commands").fix, /\/aibot:create/, "the fix must name something this build can actually run");
  assert.equal(byId.get("slash commands").status, "fail");
  assert.equal(byId.get("tick loop").status, "fail");
  assert.equal(byId.get("one pack only").status, "fail");
  assert.match(byId.get("one pack only").fix, /deactivate the OLDER/i);
  assert.match(byId.get("compass menu").detail, /cannot open the menu/);
  // …while the things that DO work are stated as working, so the player can
  // see the boundary of the breakage.
  assert.equal(byId.get("entity type").status, "pass");
  assert.equal(byId.get("spawn probe").status, "pass");
  assert.equal(byId.get("bot inventory").status, "pass");
  assert.equal(byId.get("movement step") === undefined, true, "only real checks are printed");

  // Every failure is written into the error log too, so it is still there later.
  assert.match(harnessCopy.logLines(20).join("\n"), /self-test:slash commands/);
  assert.match(harnessCopy.logLines(20).join("\n"), /self-test:tick loop/);
});

test("a crash inside the check-up still removes the probe entity it spawned", async () => {
  const player = fresh("Crashy");
  bedrock.command(player, "!aibot create Crashbot");
  // Force a failure in the LAST group (an http endpoint fails the https check), so
  // the throw happens strictly after the probe entity has been spawned. That is
  // the case the `finally` block exists for.
  const agent = controller().byName("Crashbot");
  agent.updateConfig({ endpoint: "http://insecure.example/v1" });
  const harnessCopy = new TestMode(controller());
  harnessCopy.setEnabled(false, { announce: false });
  const record = harnessCopy.error.bind(harnessCopy);
  harnessCopy.error = (where, problem, options) => {
    if (String(where).includes("endpoint")) throw new Error("log write refused");
    return record(where, problem, options);
  };

  const dimension = bedrock.world.getDimension("overworld");
  const before = dimension.getEntities({ type: "aibot:companion" }).length;
  await assert.rejects(() => selftest.runSelfTest({ player, controller: controller(), testMode: harnessCopy }), /log write refused/);
  const leftovers = dimension.getEntities({ type: "aibot:companion" }).filter((entity) => entity.nameTag === "AIBOT-PROBE");
  assert.deepEqual(leftovers, [], "a probe left behind would be adopted as a real bot by entitySpawn");
  assert.equal(dimension.getEntities({ type: "aibot:companion" }).length, before, "the check-up must leave the entity list exactly as it found it");
});

test("debug bot on is the per-bot state dump, not a harness toggle", async () => {
  const player = fresh("Router");
  bedrock.command(player, "!aibot create Routed");
  const harnessCopy = new TestMode(controller());
  const before = harnessCopy.enabled;
  assert.equal(harnessCopy.handle(player, "bot", ["on"], controller()), false, "must fall through to the per-bot debug handler");
  assert.equal(harnessCopy.enabled, before, "and must not flip test mode while doing it");

  // And through the real front door: chat.js has to fall through to the per-bot
  // dump. `handleChat` awaits the harness, so its continuation lands one
  // microtask later — flush it before reading the result.
  const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); bedrock.advance(2); };
  bedrock.command(player, "!aibot debug bot on");
  await settle();
  assert.equal(controller().byName("Routed").config.debug, true, "!aibot debug bot on must enable that bot's own debug output");
  bedrock.command(player, "!aibot debug bot off");
  await settle();
  assert.equal(controller().byName("Routed").config.debug, false);
});

test("the self-test report is chunked, capped and never one unreadable wall", async () => {
  const player = fresh("Readable");
  player.sentMessages.length = 0;
  const quiet = new TestMode(brokenController());
  quiet.setEnabled(false, { announce: false });
  await selftest.runSelfTest({ player, controller: brokenController(), testMode: quiet });
  const messages = player.sentMessages.filter((line) => line.includes("SELF-TEST") || line.includes("──") || line.includes("✔") || line.includes("✖"));
  assert.ok(messages.length > 1, "a 20-line report must be split into several chat messages");
  for (const message of messages) {
    assert.ok(message.length < 900, `chat message too long (${message.length}); it would be truncated by the game`);
    assert.ok(message.split("\n").length <= 6, "at most a screenful of lines per message");
  }
  const all = player.sentMessages.join("\n");
  assert.match(all, /RESULT/);
  assert.match(all, /Fix in this order/, "failures must come with an ordered fix list");
  assert.match(all, /\/aibot:create Steve/, "the chat fix must name a command that works on this build");
});

test("the self-test reports the entity registration failure the same way the game does", async () => {
  bedrock.setEntityRegistered(false);
  try {
    const player = fresh("EntityMissing");
    const harnessCopy = new TestMode(controller());
    harnessCopy.setEnabled(false, { announce: false });
    const rows = await selftest.runSelfTest({ player, controller: controller(), testMode: harnessCopy });
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.equal(byId.get("entity type").status, "fail");
    assert.match(byId.get("entity type").fix, /format_version|re-import/i);
    assert.equal(byId.get("spawn probe").status, "fail");
    assert.match(byId.get("spawn probe").detail, /Unknown entity type/, "the game's own wording must be quoted, not paraphrased");
  } finally {
    bedrock.setEntityRegistered(true);
  }
});

test("a healthy world passes, and the probe entity is never adopted as a bot", async () => {
  const player = fresh("Healthy");
  bedrock.command(player, "!aibot create Soundbot");
  for (let index = 0; index < 4; index += 1) { bedrock.advance(5); controller().tick(); }
  const before = controller().names().slice();
  const rows = await selftest.runSelfTest({ player, controller: controller(), testMode: harness() });
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.deepEqual(controller().names(), before, "the probe must not become a bot the player has to remove");
  assert.equal(byId.get("tick loop").status, "pass");
  assert.equal(byId.get("chat commands").status, "pass");
  assert.equal(byId.get("Soundbot").status, "pass");
  const failed = rows.filter((row) => row.status === "fail").map((row) => `${row.group}/${row.id}: ${row.detail}`);
  assert.deepEqual(failed, [], "nothing should fail in a healthy world");
  assert.match(byId.get("visible model").status ? byId.get("visible model").status : "", /^(skip|pass)$/, "the visual question is auto-skipped when no one can answer");
});

test("the network check is opt-in, and reports the endpoint's answer verbatim", async () => {
  const player = fresh("Network");
  bedrock.command(player, "!aibot create AIBot");
  const agent = controller().all().values().next().value;
  agent.updateConfig({ provider: "openai-compatible", endpoint: "https://proxy.invalid/v1/chat", model: "test-model" });

  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => "upstream unavailable" });
  try {
    const rows = await selftest.runSelfTest({ player, controller: controller(), testMode: new TestMode(controller()), deep: true, only: "ai" });
    const roundTrip = rows.find((row) => row.id === "provider round-trip");
    assert.equal(roundTrip.status, "fail");
    assert.match(roundTrip.detail, /HTTP 503/);
    assert.match(roundTrip.detail, /upstream unavailable/);
  } finally {
    globalThis.fetch = original;
  }

  // Without `deep` the pack must not touch the network at all.
  let called = 0;
  globalThis.fetch = async () => { called += 1; return { ok: true, status: 200, text: async () => "{}" }; };
  try {
    await selftest.runSelfTest({ player, controller: controller(), testMode: new TestMode(controller()), only: "ai" });
    assert.equal(called, 0, "the default check-up must not make network requests");
  } finally {
    globalThis.fetch = original;
  }
});

test("/aibot:info reports test mode and the error log alongside the rest", () => {
  const player = fresh("Info");
  harness().setEnabled(true, { announce: false });
  harness().error("info probe", new Error("listed in diagnostics"));
  const text = controller().infoText();
  assert.match(text, /Test mode: ON — new errors appear in chat/);
  assert.match(text, /Error log: 1 error\(s\).*\/aibot:debug log/);
  assert.match(text, /\/aibot:test/);
});
