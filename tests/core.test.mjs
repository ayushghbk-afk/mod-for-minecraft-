import test from "node:test";
import assert from "node:assert/strict";
import { validateAction, validatePlan, parsePlanText } from "../behavior_packs/autonomous_ai_bot/scripts/core/action-validator.js";
import { MemoryStore } from "../behavior_packs/autonomous_ai_bot/scripts/core/memory.js";
import { TaskManager, TaskStatus } from "../behavior_packs/autonomous_ai_bot/scripts/core/task-manager.js";
import { parseBotCommand, parseIntent } from "../behavior_packs/autonomous_ai_bot/scripts/core/intent-parser.js";
import { sanitiseConfig } from "../behavior_packs/autonomous_ai_bot/scripts/core/config.js";

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
  tasks.syncCount(3); assert.equal(tasks.current.progress, 1);
  tasks.pause("zombie"); assert.equal(tasks.current.status, TaskStatus.PAUSED);
  tasks.resume(); tasks.syncCount(5);
  assert.equal(tasks.current.status, TaskStatus.COMPLETED);
  assert.equal(tasks.current.remaining, 0);
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
  // Empty/unsafe dimension still returns an array (never throws).
  const fakeDim = { getBlock() { return { typeId: "minecraft:air" }; } };
  const route = nav.findLocalRoute(fakeDim, { x: 0, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }, { maxNodes: 40 });
  assert.ok(Array.isArray(route));
});
