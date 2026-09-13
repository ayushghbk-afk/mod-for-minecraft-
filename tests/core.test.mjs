import test from "node:test";
import assert from "node:assert/strict";
import { validateAction, validatePlan, parsePlanText } from "../behavior_packs/autonomous_ai_bot/scripts/core/action-validator.js";
import { MemoryStore } from "../behavior_packs/autonomous_ai_bot/scripts/core/memory.js";
import { TaskManager, TaskStatus } from "../behavior_packs/autonomous_ai_bot/scripts/core/task-manager.js";
import { parseBotCommand, parseIntent } from "../behavior_packs/autonomous_ai_bot/scripts/core/intent-parser.js";
import { sanitiseConfig } from "../behavior_packs/autonomous_ai_bot/scripts/core/config.js";
import { canUseBot } from "../behavior_packs/autonomous_ai_bot/scripts/core/permissions.js";

const position = [0, 64, 0];

test("AI action validator rejects arbitrary commands and unsafe blocks", () => {
  assert.equal(validateAction({ type: "run_command", command: "op Steve" }).ok, false);
  assert.equal(validateAction({ type: "mine_block", block: "minecraft:command_block" }).ok, false);
  assert.equal(validatePlan({ goal: "mine", actions: [{ type: "find_block", block: "oak_log" }, { type: "move_to_target" }] }, { position, maxDistance: 32 }).ok, true);
});

test("AI plan validator bounds positions and action count", () => {
  assert.equal(validateAction({ type: "move_to_target", position: [100, 64, 0] }, { position, maxDistance: 32 }).ok, false);
  assert.equal(validatePlan({ goal: "x", actions: Array.from({ length: 9 }, () => ({ type: "stop" })) }, { maxPlanActions: 8 }).ok, false);
  assert.equal(parsePlanText("```json\n{\"goal\":\"x\",\"actions\":[{\"type\":\"stop\"}]}\n```").ok, true);
});

test("task manager persists progress, pause, resume and completion", () => {
  const tasks = new TaskManager();
  const task = tasks.create({ goal: "Collect 3 oak logs", kind: "collect", block: "minecraft:oak_log", target: 3, startingCount: 2 });
  assert.equal(task.status, TaskStatus.ACTIVE);
  // AC-19: progress is ABSOLUTE. Holding 2 of a required 3 starts at 2/3, so the
  // bot goes out for ONE more log instead of three.
  assert.equal(task.progress, 2);
  assert.equal(task.remaining, 1);
  tasks.syncCount(3); assert.equal(tasks.current.progress, 3);
  assert.equal(tasks.current.status, TaskStatus.COMPLETED, "reaching the required count completes the task");
  // AC-17: a count that did not change never moves progress backwards or forwards.
  const second = new TaskManager();
  second.create({ goal: "Collect 16 oak logs", kind: "collect", block: "minecraft:oak_log", target: 16, startingCount: 5 });
  assert.equal(second.current.progress, 5);
  second.syncCount(5);
  assert.equal(second.current.progress, 5, "a failed mine must not increment progress");
  second.pause("zombie"); assert.equal(second.current.status, TaskStatus.PAUSED);
  second.resume(); second.syncCount(20);
  assert.equal(second.current.status, TaskStatus.COMPLETED);
  assert.equal(second.current.progress, 16, "progress is capped at the requirement");
  assert.equal(second.current.remaining, 0);
});

test("a task already satisfied by the inventory completes instead of collecting more", () => {
  const tasks = new TaskManager();
  const task = tasks.create({ goal: "Collect 16 oak logs", kind: "collect", block: "minecraft:oak_log", target: 16, startingCount: 16 });
  assert.equal(task.status, TaskStatus.COMPLETED);
  assert.equal(task.alreadySatisfied, true);
  assert.equal(tasks.stillNeeded(), 0);
  // AC-27: the completed objective is remembered, so re-asking does not silently
  // recreate the same finished task.
  assert.equal(tasks.hasCompleted(task.key), true);
  assert.equal(tasks.isRepeatOfCompleted({ kind: "collect", block: "minecraft:oak_log", target: 16 }), true);
});

test("the task card is the AC-04 objective format", () => {
  const tasks = new TaskManager();
  tasks.create({ goal: "Collect Oak Logs", kind: "collect", block: "minecraft:oak_log", target: 16 });
  assert.equal(tasks.describe(), [
    "Task: Collect Oak Logs",
    "Target: minecraft:oak_log",
    "Required: 16",
    "Progress: 0/16",
    "Status: ACTIVE",
    "Still needed: 16"
  ].join("\n"));
});

test("memory is bounded and emits relevant prompt context", () => {
  const memory = new MemoryStore();
  for (let i = 0; i < 100; i += 1) memory.event(`event-${i}`);
  memory.fact("Home is at 0,64,0");
  assert.equal(memory.snapshot().shortTerm.length, 24);
  assert.equal(memory.promptContext(null).importantFacts[0].text, "Home is at 0,64,0");
});

test("player intent parser understands the MVP instruction", () => {
  const intent = parseIntent("Steve, get me 32 oak logs.", ["Steve"]);
  assert.deepEqual(intent, { bot: "Steve", type: "collect", block: "minecraft:oak_log", count: 32, goal: "Collect 32 oak_log" });
  assert.deepEqual(parseBotCommand("!aibot create Alex"), { command: "create", args: ["Alex"] });
  assert.equal(parseIntent("Steve, protect me", ["Steve"]).type, "protect");
  assert.equal(parseIntent("Steve, pick up items", ["Steve"]).type, "pickup");
  assert.equal(parseIntent("Steve, hi there", ["Steve"]).type, "chat");
  assert.equal(parseIntent("Steve, use iron sword", ["Steve"]).type, "use_item");
});

test("an ownerless bot is nobody's to command, and a returning owner is recognised by name", () => {
  const owner = { id: "runtime-1", name: "Ayush" };
  const stranger = { id: "runtime-2", name: "Someone" };
  assert.equal(canUseBot(stranger, { ownerId: "", ownerName: "" }, {}), false, "no owner recorded → no stranger commands it");
  assert.equal(canUseBot(owner, { ownerId: "", ownerName: "" }, {}), false, "…and not the owner either: it must be re-created or re-bound");
  assert.equal(canUseBot(owner, { ownerId: "stale-from-last-session", ownerName: "Ayush" }, {}), true, "a returning owner matches on the stable name after a reload");
  assert.equal(canUseBot(stranger, { ownerId: "stale-from-last-session", ownerName: "Ayush" }, {}), false, "a stranger does not");
  assert.equal(canUseBot(stranger, { ownerId: "", ownerName: "" }, { ownerOnly: false }), true, "owner-gating switched off is shared by design");
});

test("config sanitisation never persists an API key", () => {
  const config = sanitiseConfig({ provider: "custom", apiKey: "secret", commandsEnabled: true });
  assert.equal("apiKey" in config, false);
  assert.equal(config.commandsEnabled, true);
});

test("pathfinder exports a bounded A* route helper", async () => {
  const nav = await import("../behavior_packs/autonomous_ai_bot/scripts/core/navigation.js");
  assert.equal(typeof nav.findLocalRoute, "function");
  assert.equal(typeof nav.moveEntityTowards, "function");
  assert.equal(typeof nav.setMoveAnim, "function");
  // Player-like movement plumbing: per-tick velocity steering + smooth stop.
  assert.equal(typeof nav.applyPlayerStep, "function");
  assert.equal(typeof nav.stopEntity, "function");
  assert.deepEqual(nav.MOVEMENT_SPEEDS, { walk: 0.215, sprint: 0.279 });
  // Empty/unsafe dimension still returns an array (never throws).
  const fakeDim = { getBlock() { return { typeId: "minecraft:air" }; } };
  const route = nav.findLocalRoute(fakeDim, { x: 0, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }, { maxNodes: 40 });
  assert.ok(Array.isArray(route));
});

test("the movement loop steers by delta impulse on @minecraft/server 2.x builds", async () => {
  const nav = await import("../behavior_packs/autonomous_ai_bot/scripts/core/navigation.js");
  // A flat stone floor below y=64: every cell at y=64 is standable, so a
  // walkable route from (0,64,0) to (4,64,0) exists.
  const dimension = { getBlock({ x, y, z }) { return { typeId: y <= 63 ? "minecraft:stone" : "minecraft:air" }; } };
  /** A 2.x entity: velocity can be read, and only deltas can be applied. */
  const entity = {
    id: "two-x-entity",
    dimension,
    location: { x: 0, y: 64, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    grounded: true,
    getVelocity() { return { ...this.velocity }; },
    applyImpulse(value) {
      this.velocity = { x: this.velocity.x + value.x, y: this.velocity.y + value.y, z: this.velocity.z + value.z };
    },
    setRotation(value) { this.rotation = { ...value }; },
    setDynamicProperty() { /* not under test */ },
    setProperty() { /* not under test */ }
  };
  assert.equal(typeof entity.setVelocity, "undefined", "the fixture must look like a 2.x build, where setVelocity was removed");

  // The whole player-like loop — plan, per-tick steering, smooth stop — has to
  // work through applyImpulse deltas alone. Before writeVelocity() this steered
  // every tick, threw "setVelocity is not a function" every tick, and the bot
  // never moved at all.
  const outcome = nav.moveEntityTowards(entity, { x: 4, y: 64, z: 0 }, { maxNodes: 200 });
  assert.equal(outcome.moving, true, "the movement must be accepted");
  assert.ok(entity.velocity.x > 0, "the first step must already accelerate toward the target");
  for (let tick = 0; tick < 6; tick += 1) nav.applyPlayerStep(entity);
  const speed = Math.hypot(entity.velocity.x, entity.velocity.z);
  assert.ok(Math.abs(speed - nav.MOVEMENT_SPEEDS.walk) < 0.02, `velocity must settle at walking speed (got ${speed.toFixed(3)})`);
  assert.ok(entity.velocity.x > 0.15, `it must be dominantly toward +x (got ${entity.velocity.x.toFixed(3)})`);

  nav.stopEntity(entity);
  for (let tick = 0; tick < 10; tick += 1) nav.applyPlayerStep(entity);
  assert.equal(entity.velocity.x, 0, "the stop must decay the horizontal speed to exactly zero");
  assert.equal(entity.velocity.z, 0);
});
