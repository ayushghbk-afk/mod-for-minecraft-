/**
 * ACCEPTANCE TESTS — AC-01 … AC-45, exercised rather than asserted.
 *
 * Every criterion below is driven through the same code the game runs: the real
 * `main.js`, the real controller, the real action engine, on top of a simulated
 * Bedrock world (`tests/stubs/world-sim.mjs`) that has terrain, gravity,
 * distance-aware entity queries, `setblock … destroy` drops and a clock that
 * advances 50 ms per tick. Nothing here is satisfied by "it compiles" or "the
 * manifest validates" — a criterion passes only when the bot's behaviour in the
 * simulated world is the behaviour the criterion asks for.
 *
 * Honest limits, recorded here and in ACCEPTANCE.md:
 *   • Rendering, models, sounds and the on-screen forms can only be confirmed in
 *     the game; what is verified here is the data the forms are built from.
 *   • AC-03 "natural chat" needs `world.beforeEvents.chatSend`, which stable
 *     @minecraft/server 2.9.0 does not expose. Both paths are tested: natural
 *     sentences where chat events exist (here), and the `/bot:*` commands that
 *     carry the same intents on builds without them (slash-command.test.mjs).
 *   • A simulation is not a device: AC-41 asserts the measured budgets the pack
 *     keeps (block reads per scan, scans per second), not a phone's frame time.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFile } from "node:fs/promises";

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
const sim = await import("#stub/world-sim");
sim.installSimulatedWorld();

const main = await import("../behavior_packs/autonomous_ai_bot/scripts/main.js");
const { TaskStatus } = await import("../behavior_packs/autonomous_ai_bot/scripts/core/task-manager.js");
const { MOVEMENT_SPEEDS } = await import("../behavior_packs/autonomous_ai_bot/scripts/core/navigation.js");
const { ALLOWED_BLOCKS } = await import("../behavior_packs/autonomous_ai_bot/scripts/core/action-validator.js");
const { chooseTool } = await import("../behavior_packs/autonomous_ai_bot/scripts/core/tools.js");
const { CRITERIA } = await import("../behavior_packs/autonomous_ai_bot/scripts/core/acceptance.js");
const { Priority } = await import("../behavior_packs/autonomous_ai_bot/scripts/core/priority.js");
const { commandHint } = await import("../behavior_packs/autonomous_ai_bot/scripts/core/hints.js");

/** The slash-command registry, filled the way the game fills it at startup. */
function makeRegistry() {
  const registrations = new Map();
  return {
    registrations,
    registerCommand(spec, callback) {
      if (!/^[a-z0-9_]+:[a-z0-9_]+$/.test(String(spec.name))) throw new Error(`Custom command names must be namespaced, got '${spec.name}'`);
      registrations.set(spec.name, { spec, callback });
    }
  };
}
const registry = makeRegistry();
bedrock.fireStartup(registry);

const controller = () => globalThis.__aibotController;

/** Run a registered slash command as `player` and let the script settle. */
function slash(name, player, ...args) {
  const entry = registry.registrations.get(name);
  assert.ok(entry, `${name} must be registered as a custom command`);
  const result = entry.callback({ sourceEntity: player }, ...args);
  sim.play(4);
  return result;
}

/** An empty, flat, walkable world with one player standing at the origin. */
function freshWorld({ size = 48, playerName = "Tester", at = { x: 0, z: 0 } } = {}) {
  const dim = bedrock.world.getDimension("overworld");
  dim.blocks.clear();
  dim.entities.length = 0;
  dim.commands.length = 0;
  for (const agent of controller().all()) controller().remove(agent.entity.id);
  bedrock.world.messages.length = 0;
  sim.buildTerrain(dim, { size });
  const owner = bedrock.addPlayer(playerName, { x: at.x, y: sim.GROUND_Y, z: at.z });
  sim.play(6);
  return { dim, owner };
}

/** Create a bot and count every teleport it ever performs (AC-06 forbids them). */
function spawnBot(owner, name = "Steve") {
  const agent = controller().create(owner, name).agent;
  agent.updateConfig({ provider: "fallback" });
  let teleports = 0;
  const real = agent.entity.teleport.bind(agent.entity);
  agent.entity.teleport = (...args) => { teleports += 1; return real(...args); };
  return { agent, teleports: () => teleports };
}

/** Everything a player (or a chat line) was told, without colour codes. */
function said(player) {
  return sim.plainChat(player).join("\n");
}

/** Force a fresh observation instead of waiting for the interval. */
function look(agent) {
  agent.observe(controller().tickCount, true);
  return agent.observation;
}

function itemCount(agent, typeId) {
  return Number([...sim.carrying(agent.entity).entries()].find(([id]) => id === typeId)?.[1] || 0);
}

test("the pack advertises a version and the in-world acceptance runner knows all 45 criteria", () => {
  assert.match(main.SCRIPT_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(CRITERIA.length, 45, "AC-01..AC-45 must all be runnable in-world");
  assert.deepEqual(CRITERIA.map((entry) => entry.id), Array.from({ length: 45 }, (_, index) => `AC-${String(index + 1).padStart(2, "0")}`));
});

/* ─────────────────────────────── A. existence ─────────────────────────────── */

test("AC-01 bot spawn — a real, owner-bound body appears next to the player", () => {
  const { dim, owner } = freshWorld();
  const { agent, teleports } = spawnBot(owner);

  const bodies = dim.getEntities({ type: "aibot:companion" });
  assert.equal(bodies.length, 1, "the companion entity must exist in the dimension");
  const body = bodies[0];
  assert.equal(body, agent.entity, "the controller must hold the same entity the world holds");
  assert.equal(body.getDynamicProperty("aibot:name"), "Steve");
  assert.equal(body.getDynamicProperty("aibot:owner_id"), owner.id, "the bot belongs to the player who created it");
  assert.match(body.nameTag, /^Steve/, "the name is visible above the body");
  assert.ok(Math.abs(body.location.y - sim.GROUND_Y) < 2, "it spawns standing on the ground");
  assert.ok(sim.distanceBetween(body.location, owner.location) < 8, "it spawns beside its owner");
  assert.match(said(owner), /Created Steve/, "the player is told it happened");
  sim.play(40);
  assert.equal(teleports(), 0, "spawning and idling must not teleport anything");
});

/* ───────────────────────────── B. perception ─────────────────────────────── */

test("AC-02 player detection — owner and strangers are told apart, with distance and direction", () => {
  const { owner } = freshWorld({ size: 64 });
  const { agent } = spawnBot(owner);
  bedrock.addPlayer("Stranger", { x: 12, y: sim.GROUND_Y, z: 9 });

  const seen = look(agent);
  assert.equal(seen.owner?.name, "Tester", "the owner is identified as the owner");
  assert.ok(seen.owner.distance < 10 && seen.owner.distance >= 0, "with a real distance");
  assert.ok(seen.owner.direction?.compass, "and a compass direction the player can act on");
  assert.ok(seen.strangers.some((player) => player.name === "Stranger"), "another player is a stranger, never mistaken for the owner");

  // 20 blocks is beyond the old 8-block bubble and inside the new entity range.
  bedrock.addPlayer("Faraway", { x: 20, y: sim.GROUND_Y, z: 0 });
  assert.ok(look(agent).players.some((player) => player.name === "Faraway"), "a player 20 blocks off is still seen");
});

test("AC-03 natural chat — a plain sentence is understood and answered in kind", () => {
  const { owner } = freshWorld({ size: 64 });
  const { agent, teleports } = spawnBot(owner);
  owner.location = { x: 14, y: sim.GROUND_Y, z: 8 };
  sim.play(5);

  bedrock.command(owner, "Steve, come here");
  sim.play(6);
  assert.ok(agent.runtime.cameTo, '"Steve, come here" must be parsed as a come order');
  assert.match(said(owner), /Coming to you/i, "and answered like a conversation, not a status dump");
  sim.playUntil(() => sim.distanceBetween(agent.entity.location, owner.location) < 4, 900, 5);
  assert.ok(sim.distanceBetween(agent.entity.location, owner.location) < 4, "the sentence produced a real walk, not just a reply");
  assert.equal(teleports(), 0);

  bedrock.command(owner, "Steve, follow me");
  sim.play(10);
  assert.equal(agent.runtime.follow, true, '"follow me" must start following');

  // On the stable 2.9.0 build there are no chat events at all; the same intents
  // travel as slash commands (pinned in slash-command.test.mjs). What must hold
  // on BOTH builds is that the bot only ever suggests a control this build can
  // actually run — which is what core/hints.js decides.
  const hint = commandHint(controller(), "stop");
  assert.match(hint, /stop/i, "the suggested control names the action");
  assert.match(hint, /^!aibot|^\/bot:|^\/aibot:|say /i, `and uses a channel this build supports (got "${hint}")`);
});

/* ──────────────────────────── C. tasks & plans ────────────────────────────── */

test("AC-04 task creation — the player gets an objective card, not just \"ok\"", () => {
  const { dim, owner } = freshWorld();
  const { agent } = spawnBot(owner);
  sim.plantOakTree(dim, 6, 3, 4);

  agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");
  const card = said(owner);
  for (const line of ["Task:", "Target:", "Required:", "Progress:", "Status:", "Still needed:"]) {
    assert.match(card, new RegExp(line.replace(":", ":")), `the card must show ${line}`);
  }
  assert.ok(agent.tasks.current.id, "the task is identifiable");
  assert.equal(agent.tasks.current.target, 4);
  assert.equal(agent.tasks.current.status, TaskStatus.ACTIVE);
  assert.deepEqual(agent.tasks.current.remainingActions?.slice(0, 2), ["find_block", "move_to_target"], "the card comes with a real plan");
});

test("AC-05 task execution — the plan is carried out in the world, step by step", () => {
  const { dim, owner } = freshWorld();
  const { agent, teleports } = spawnBot(owner);
  sim.plantOakTree(dim, 6, 3, 4);
  const start = { ...agent.entity.location };

  agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");
  sim.playUntil(() => (agent.tasks.current?.progress || 0) >= 2, 1200, 5);

  assert.ok((agent.tasks.current?.progress || 0) >= 2, `the bot must actually collect logs (progress ${agent.tasks.current?.progress})`);
  assert.ok(sim.distanceBetween(start, agent.entity.location) > 2, "it walked to the tree instead of working from where it stood");
  assert.ok(dim.commands.some((command) => /^setblock -?\d+ -?\d+ -?\d+ air destroy$/.test(command)), "blocks were broken with the pack's own allowlisted command");
  assert.equal(teleports(), 0, "AC-06: it walked — no teleport was used to fake the trip");
  assert.equal(agent.tasks.current.status, TaskStatus.ACTIVE, "the task is still the task until it is finished");
});

test("AC-06 task completion — the objective is met, reported, and not restarted", () => {
  const { dim, owner } = freshWorld();
  const { agent, teleports } = spawnBot(owner);
  sim.plantOakTree(dim, 6, 3, 4);

  agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");
  sim.playUntil(() => agent.tasks.current?.status === TaskStatus.COMPLETED, 2000, 5);

  assert.equal(agent.tasks.current?.status, TaskStatus.COMPLETED, "the task completes");
  assert.equal(itemCount(agent, "minecraft:oak_log"), 4, "the four logs are really in the inventory");
  assert.match(said(owner), /4\/4/, "completion is reported with the real numbers");
  assert.equal(teleports(), 0, "the whole task ran without a single teleport");

  sim.play(300);
  assert.equal(agent.tasks.current?.status, TaskStatus.COMPLETED, "a finished task is not silently re-run");
  assert.equal(agent.runtime.plan, null, "and no new plan is invented for it");
  assert.ok(itemCount(agent, "minecraft:oak_log") === 4, "the four logs are still in the inventory 15 s later");
  assert.ok(sim.distanceBetween(agent.entity.location, owner.location) < 8, "it brings the work back to the player instead of wandering off");
});

/* ─────────────────────────────── D. movement ──────────────────────────────── */

test("AC-07 movement — it accelerates, walks at player speed and never blinks", () => {
  const { owner } = freshWorld({ size: 64 });
  const { agent, teleports } = spawnBot(owner);
  agent.follow();
  owner.location = { x: 20, y: sim.GROUND_Y, z: 0 };

  const steps = [];
  let previous = { ...agent.entity.location };
  for (let tick = 0; tick < 70; tick += 1) {
    sim.play(1);
    const at = agent.entity.location;
    steps.push(Math.hypot(at.x - previous.x, at.z - previous.z));
    previous = { ...at };
  }
  const fastest = Math.max(...steps);
  assert.ok(fastest > 0.02, "the bot actually travels");
  assert.ok(fastest <= MOVEMENT_SPEEDS.sprint * 1.4, `no single tick may beat a sprinting player (fastest ${fastest.toFixed(3)} b/t)`);
  const easing = steps.slice(0, 4).reduce((a, b) => a + b, 0) / 4;
  const cruising = steps.slice(30, 45).reduce((a, b) => a + b, 0) / 15;
  assert.ok(cruising > easing, "it eases into the walk like held keys, instead of snapping to full speed");
  assert.equal(teleports(), 0, "movement is velocity-based end to end");
});

test("AC-08 following — it keeps up with a walking player and stops at a natural distance", () => {
  const { owner } = freshWorld({ size: 72 });
  const { agent, teleports } = spawnBot(owner);
  agent.follow();

  for (const z of [6, 12, 18, 24]) {
    owner.location = { x: 0, y: sim.GROUND_Y, z };
    sim.play(120);
    const gap = sim.distanceBetween(agent.entity.location, owner.location);
    assert.ok(gap < 8, `after the player walks to z=${z} the bot must be within 8 blocks (was ${gap.toFixed(1)})`);
  }
  sim.play(120);
  const settled = sim.distanceBetween(agent.entity.location, owner.location);
  assert.ok(settled <= 5, `it settles beside the player instead of standing on them (${settled.toFixed(1)})`);
  assert.equal(teleports(), 0, "following never teleports, however far the player runs");
});

test("AC-09 obstacle recovery — a wall with a way round is walked around", () => {
  const { dim, owner } = freshWorld({ size: 72 });
  const { agent, teleports } = spawnBot(owner);
  sim.buildWall(dim, 8, { fromX: -5, toX: 5, height: 4 });
  owner.location = { x: 0, y: sim.GROUND_Y, z: 18 };
  agent.follow();

  sim.playUntil(() => sim.distanceBetween(agent.entity.location, owner.location) < 6, 1800, 10);
  const gap = sim.distanceBetween(agent.entity.location, owner.location);
  assert.ok(gap < 6, `it must find the way round the wall (ended ${gap.toFixed(1)} blocks from the player)`);
  assert.equal(teleports(), 0, "recovery must never teleport through the obstacle");
  assert.ok(agent.runtime.stuck.attempts <= 4, `the recovery ladder stays finite (attempts ${agent.runtime.stuck.attempts})`);
});

test("AC-09 obstacle recovery — a wall with no way round is reported, not silently stood in front of", () => {
  const { dim, owner } = freshWorld({ size: 40 });
  const { agent, teleports } = spawnBot(owner);
  sim.buildWall(dim, 8, { fromX: -20, toX: 20, height: 4 }); // the whole world across
  owner.location = { x: 0, y: sim.GROUND_Y, z: 16 };
  agent.follow();

  sim.play(1200);
  const gap = sim.distanceBetween(agent.entity.location, owner.location);
  assert.ok(gap > 5, "it does not pass through a wall that spans the world");
  assert.match(said(owner), /in my way|can't reach you|stepping around/i, "and it says so instead of standing mute");
  assert.equal(teleports(), 0, "no teleport is used to cheat the obstacle");
  assert.ok(agent.runtime.stuck.attempts <= 5, `the ladder stays finite (attempts ${agent.runtime.stuck.attempts})`);
});

test("AC-10 stuck recovery — an impossible target ends in an honest stop, not an endless loop", () => {
  const { dim, owner } = freshWorld();
  const { agent, teleports } = spawnBot(owner);
  // Enclose one log in a solid box: reachable to see, impossible to stand next to.
  const caged = { x: 5, z: 5 };
  sim.plantOakTree(dim, caged.x, caged.z, 1);
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dz = -2; dz <= 2; dz += 1) {
      for (let y = 0; y <= 4; y += 1) {
        if (dx === 0 && dz === 0 && y < 2) continue; // the log itself
        dim.setBlock({ x: caged.x + dx, y: sim.GROUND_Y + y, z: caged.z + dz }, "minecraft:cobblestone");
      }
    }
  }

  agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");
  sim.playUntil(() => agent.tasks.current?.status === TaskStatus.FAILED, 2400, 10);

  assert.equal(agent.tasks.current?.status, TaskStatus.FAILED, "a target it cannot work on must fail the task instead of looping");
  assert.equal(agent.runtime.plan, null, "and it stops planning");
  assert.equal(itemCount(agent, "minecraft:oak_log"), 0, "no progress was claimed for work it never did");
  assert.match(said(owner), /unreachable|can't find|could not|no oak log/i, "the player is told why in plain words");
  assert.equal(teleports(), 0, "it never teleports to cheat the obstacle");
});

/* ───────────────────────────── E. observation ─────────────────────────────── */

test("AC-11 block recognition — the world's blocks are named with Bedrock ids", () => {
  const { dim, owner } = freshWorld();
  const { agent } = spawnBot(owner);
  sim.plantOakTree(dim, 5, 4, 4);
  sim.placeSurfaceBlock(dim, 3, -3, "minecraft:chest");
  sim.placeOre(dim, 2, 2, "minecraft:coal_ore", sim.GROUND_Y);

  const counts = look(agent).blockCounts;
  assert.ok(counts["minecraft:oak_log"] >= 1, "logs are recognised");
  assert.ok(counts["minecraft:oak_leaves"] >= 1, "and so is the canopy");
  assert.equal(counts["minecraft:chest"], 1, "a placed chest is recognised");
  assert.equal(counts["minecraft:coal_ore"], 1, "a surface ore is recognised");
  assert.equal(counts["minecraft:diamond_ore"], undefined, "it never reports a block that is not there");
  for (const id of Object.keys(counts)) assert.match(id, /^minecraft:[a-z0-9_]+$/, "ids are the game's own, never Java names or display text");
});

test("AC-12 entity recognition — mobs, animals and drops are classified correctly", () => {
  const { dim, owner } = freshWorld();
  const { agent } = spawnBot(owner);
  sim.spawnMob(dim, "minecraft:zombie", { x: 6, y: sim.GROUND_Y, z: 2 });
  sim.spawnMob(dim, "minecraft:cow", { x: -5, y: sim.GROUND_Y, z: 4 });
  dim.spawnItem(new bedrock.ItemStack("minecraft:oak_log", 2), { x: 2, y: sim.GROUND_Y, z: -2 });

  const seen = look(agent);
  assert.ok(seen.threats.some((threat) => threat.type === "minecraft:zombie"), "the zombie is a threat");
  assert.equal(seen.danger, true, "and the world is flagged dangerous");
  assert.ok(seen.mobs.some((mob) => mob.type === "minecraft:cow"), "the cow is seen as a mob, not a threat");
  assert.ok(!seen.threats.some((threat) => threat.type === "minecraft:cow"), "a cow is never a threat");
  const drop = seen.nearbyItems.find((item) => item.id === "minecraft:oak_log");
  assert.ok(drop, "a drop on the ground is recognised");
  assert.equal(drop.count, 2, "with its real stack size");
  assert.match(drop.name, /oak log/i, "and a name a player recognises");
});

test("AC-13 observation accuracy — everything reported exists, and stale sightings are refused", () => {
  const { dim, owner } = freshWorld();
  const { agent } = spawnBot(owner);
  sim.plantOakTree(dim, 4, 2, 4);

  const seen = look(agent);
  assert.ok(seen.blocks.length > 0, "the scan reports blocks");
  for (const block of seen.blocks) {
    const [x, y, z] = block.position;
    const live = dim.getBlock({ x, y, z });
    assert.equal(live.typeId, block.type, `${block.type} at ${x},${y},${z} must really be there`);
  }

  // Break the logs behind the bot's back, then ask it to target one from the
  // snapshot it is holding: it must verify against the world and refuse.
  const before = seen.blocks.filter((block) => block.type === "minecraft:oak_log");
  assert.ok(before.length >= 1);
  for (const block of before) dim.setBlock({ x: block.position[0], y: block.position[1], z: block.position[2] }, "minecraft:air");
  agent.runtime.targetBlock = null;
  const result = agent.engine.execute({ type: "find_block", block: "minecraft:oak_log" });
  assert.equal(result.success, false, "a snapshot is not proof: the block must be re-read from the world");
  assert.equal(agent.runtime.targetBlock, null, "no phantom target is set");
  assert.match(result.reason, /already gone|was found/i);
});

/* ─────────────────────────────── F. mining ────────────────────────────────── */

test("AC-14 basic mining — it breaks a block it can legally break and keeps the drop", () => {
  const { dim, owner } = freshWorld();
  const { agent, teleports } = spawnBot(owner);
  sim.give(agent.entity, "minecraft:wooden_pickaxe", 1);
  sim.placeSurfaceBlock(dim, 3, 2, "minecraft:stone", sim.GROUND_Y);
  sim.placeSurfaceBlock(dim, 3, 3, "minecraft:stone", sim.GROUND_Y);

  agent.mineTask("minecraft:stone", 2, "Mine 2 stone");
  sim.playUntil(() => (agent.tasks.current?.progress || 0) >= 1, 1200, 5);

  assert.ok((agent.tasks.current?.progress || 0) >= 1, `stone must actually be mined (progress ${agent.tasks.current?.progress})`);
  assert.ok(dim.commands.some((command) => /^setblock -?\d+ -?\d+ -?\d+ air destroy$/.test(command)), "the break goes through the allowlisted command");
  const gone = [{ x: 3, z: 2 }, { x: 3, z: 3 }].filter((at) => dim.getBlock({ x: at.x, y: sim.GROUND_Y, z: at.z }).typeId !== "minecraft:stone");
  assert.ok(gone.length >= 1, "at least one stone block is gone from the world");
  assert.ok(itemCount(agent, "minecraft:cobblestone") >= 1, "and its drop was kept, not left on the ground");
  assert.equal(teleports(), 0);
});

test("AC-15 wood gathering — a standing tree becomes four logs in the inventory", () => {
  const { dim, owner } = freshWorld();
  const { agent, teleports } = spawnBot(owner);
  sim.plantOakTree(dim, 6, 4, 4);

  agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");
  sim.playUntil(() => itemCount(agent, "minecraft:oak_log") >= 4, 2000, 5);

  assert.equal(itemCount(agent, "minecraft:oak_log"), 4, "four logs are in the inventory");
  const standing = [0, 1, 2, 3].filter((y) => dim.getBlock({ x: 6, y: sim.GROUND_Y + y, z: 4 }).typeId === "minecraft:oak_log");
  assert.equal(standing.length, 0, `the trunk was actually felled (still standing: ${standing.length})`);
  assert.equal(teleports(), 0, "the whole gather ran on foot");
});

test("AC-16 tool selection — one table decides, and an impossible job is refused in words", () => {
  assert.equal(chooseTool("minecraft:oak_log", []).family, "axe", "wood asks for an axe");
  assert.equal(chooseTool("minecraft:stone", ["minecraft:wooden_pickaxe"]).best, "minecraft:wooden_pickaxe", "the pickaxe it has is chosen");
  assert.equal(chooseTool("minecraft:diamond_ore", ["minecraft:wooden_pickaxe"]).meetsRequirement, false, "a wooden pickaxe cannot drop diamonds");
  assert.equal(chooseTool("minecraft:diamond_ore", ["minecraft:iron_pickaxe"]).meetsRequirement, true, "an iron pickaxe can");

  const { dim, owner } = freshWorld();
  const { agent } = spawnBot(owner);
  const ore = sim.placeOre(dim, 3, 2, "minecraft:iron_ore", sim.GROUND_Y);
  assert.equal(agent.mineTask("minecraft:iron_ore", 1), null, "the request is refused before any plan is made");
  assert.match(said(owner), /pickaxe/i, "and the refusal names the missing tool");
  assert.equal(dim.getBlock(ore).typeId, "minecraft:iron_ore", "the block is untouched — no fake mining");
});

test("AC-17 mining verification — progress follows the world, and one break verifies once", () => {
  const { dim, owner } = freshWorld();
  const { agent } = spawnBot(owner);
  sim.plantOakTree(dim, 4, 3, 4);
  agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");

  sim.playUntil(() => (agent.tasks.current?.progress || 0) >= 2, 1500, 5);
  const task = agent.tasks.current;
  assert.equal(task.progress, itemCount(agent, "minecraft:oak_log"), "progress is the real inventory count, never a hopeful number");

  // The regression this pins: a cell that is already air used to answer
  // "Block change verified" every time the plan came round, inventing progress.
  const broken = [0, 1, 2, 3].map((y) => ({ x: 4, y: sim.GROUND_Y + y, z: 3 }))
    .find((at) => dim.getBlock(at).typeId === "minecraft:air");
  assert.ok(broken, "at least one trunk block is really gone from the world");
  agent.runtime.targetBlock = { ...broken, type: "minecraft:oak_log" };
  agent.runtime.lastMinedKey = `${broken.x},${broken.y},${broken.z}`;
  const first = agent.engine.execute({ type: "mine_block", block: "minecraft:oak_log" });
  const second = agent.engine.execute({ type: "mine_block", block: "minecraft:oak_log" });
  assert.equal(first.success, true, "the verified break is accepted once");
  assert.equal(second.success, false, "the same broken cell must never verify twice");
  assert.equal(agent.runtime.lastMinedKey, "", "the verification is consumed");
});

/* ───────────────────────────── G. inventory ───────────────────────────────── */

test("AC-18 inventory inspection — the bot reports what it is really carrying", () => {
  const { owner } = freshWorld();
  const { agent } = spawnBot(owner);
  assert.match(agent.inventoryText(), /empty|nothing/i, "an empty inventory says so");

  sim.give(agent.entity, "minecraft:oak_log", 7);
  sim.give(agent.entity, "minecraft:bread", 2);
  const text = agent.inventoryText();
  assert.match(text, /oak log/i, "items are named for players");
  assert.match(text, /7/, "with their real counts");
  assert.match(text, /bread/i);
  assert.doesNotMatch(text, /diamond/, "and nothing it does not have");
});

test("AC-19 inventory-aware planning — the requirement is absolute, and satisfied means done", () => {
  const { dim, owner } = freshWorld();
  const { agent } = spawnBot(owner);
  sim.give(agent.entity, "minecraft:oak_log", 4);
  sim.plantOakTree(dim, 6, 3, 4);

  agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");
  assert.match(said(owner), /already have 4\/4/i, "holding the requirement is reported, not re-collected");
  sim.play(40);
  assert.equal(itemCount(agent, "minecraft:oak_log"), 4, "it did not go and fetch four more");

  const second = spawnBot(owner, "Janet");
  sim.give(second.agent.entity, "minecraft:oak_log", 4);
  second.agent.createCollectTask("minecraft:oak_log", 6, "Collect 6 oak_log");
  assert.equal(second.agent.tasks.current.progress, 4, "progress starts at what is already held");
  assert.equal(second.agent.tasks.current.target, 6, "the target is the absolute count asked for");
  assert.match(said(owner), /still needed: 2/i, "and the player is told the real remainder");
});

/* ───────────────────────────── H. survival ────────────────────────────────── */

test("AC-20 low health — with food it eats, and the food really disappears", () => {
  const { owner } = freshWorld();
  const { agent } = spawnBot(owner);
  sim.give(agent.entity, "minecraft:bread", 3);
  sim.damage(agent.entity, 14);
  assert.ok(agent.healthSnapshot().current <= 8, "the bot is genuinely hurt");

  sim.playUntil(() => itemCount(agent, "minecraft:bread") < 3, 600, 5);
  assert.ok(itemCount(agent, "minecraft:bread") < 3, "it ate: the bread count went down");
  assert.match(said(owner), /ate|bread|food|heal/i, "and it says so");
});

test("AC-21 no food — it says so plainly instead of pretending to heal", () => {
  const { owner } = freshWorld();
  const { agent } = spawnBot(owner);
  sim.damage(agent.entity, 14);
  const healthBefore = agent.healthSnapshot().current;

  const verdict = agent.eatOnDemand(owner);
  sim.play(200);

  assert.equal(verdict.success, false, "with nothing edible there is nothing to do");
  assert.match(verdict.reason, /no food/i);
  assert.match(said(owner), /no food/i, "the player is told the exact reason");
  assert.ok(agent.healthSnapshot().current <= healthBefore + 0.001, "health was not invented");
  assert.equal(agent.runtime.noFoodReported, true, "and the gap is remembered, not re-announced every tick");
});

/* ─────────────────────────────── I. combat ────────────────────────────────── */

test("AC-22 hostile detection — a nearby zombie changes what the bot is doing", () => {
  const { dim, owner } = freshWorld();
  const { agent } = spawnBot(owner);
  sim.plantOakTree(dim, 6, 3, 4);
  agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");
  sim.play(40);
  assert.equal(agent.runtime.priority.behavior, "task", "with no threat it works on the task");

  sim.spawnMob(dim, "minecraft:zombie", { x: 3, y: sim.GROUND_Y, z: 3 }, { health: 20 });
  sim.play(20);
  assert.ok(["combat", "flee"].includes(agent.runtime.priority.behavior), `a zombie at 3 blocks outranks the task (behavior: ${agent.runtime.priority.behavior})`);
  assert.ok(look(agent).threats.some((threat) => threat.type === "minecraft:zombie"));
});

test("AC-23 combat — it fights back, the mob really loses health, and the kill is reported", () => {
  const { dim, owner } = freshWorld();
  const { agent, teleports } = spawnBot(owner);
  sim.give(agent.entity, "minecraft:iron_sword", 1);
  const zombie = sim.spawnMob(dim, "minecraft:zombie", { x: 3, y: sim.GROUND_Y, z: 2 }, { health: 8 });

  sim.play(20);
  const healthAfterFirstSwings = zombie.getComponent("minecraft:health").currentValue;
  sim.playUntil(() => !zombie.isValid, 1500, 5);

  assert.ok(healthAfterFirstSwings < 8 || !zombie.isValid, "the bot's attacks actually damage the mob");
  assert.equal(zombie.isValid, false, "the zombie dies");
  assert.ok(!dim.commands.some((command) => /^(give|kill|tp|teleport|gamemode)\b/.test(command)), "it fights with attacks, never with cheat commands");
  assert.match(said(owner), /defeated|killed|✓/, "the kill is reported to the player");
  assert.equal(teleports(), 0, "combat is fought on foot");
});

test("AC-24 creeper safety — it strikes from range and stays out of the blast radius", () => {
  const { dim, owner } = freshWorld({ size: 64 });
  const { agent, teleports } = spawnBot(owner);
  sim.give(agent.entity, "minecraft:iron_sword", 1);
  const creeper = sim.spawnMob(dim, "minecraft:creeper", { x: 5, y: sim.GROUND_Y, z: 0 }, { health: 20 });

  // Hit-and-run, measured per tick: what matters is that it does not PARK inside
  // the ignition radius, and that most of the fight happens outside the blast.
  let closest = Infinity;
  let outsideBlast = 0;
  let insideIgnition = 0;
  let longestInside = 0;
  let run = 0;
  let samples = 0;
  for (let sample = 0; sample < 900 && creeper.isValid; sample += 1) {
    sim.play(1);
    const gap = sim.distanceBetween(agent.entity.location, creeper.location);
    closest = Math.min(closest, gap);
    if (gap >= 6) outsideBlast += 1;
    if (gap < 3.0) { insideIgnition += 1; run += 1; longestInside = Math.max(longestInside, run); } else run = 0;
    samples += 1;
  }
  assert.ok(closest >= 2.4, `it never body-blocks a creeper (closest ${closest.toFixed(1)} blocks)`);
  assert.ok(insideIgnition / samples < 0.15, `it does not stand in the ignition radius (${insideIgnition}/${samples} ticks)`);
  assert.ok(longestInside < 25, `no single visit inside 3 blocks outlasts a creeper fuse (longest ${longestInside} ticks)`);
  assert.ok(outsideBlast / samples > 0.25, `most of the fight is outside the 6-block blast radius (${outsideBlast}/${samples} ticks)`);
  assert.ok(creeper.isValid === false || creeper.getComponent("minecraft:health").currentValue < 20, "and it still fights the thing");
  assert.match(String(agent.runtime.lastCombatNote || ""), /creeper/i, "its own notes say it is fighting a creeper carefully");
  assert.equal(teleports(), 0);
});

test("AC-25 combat recovery — an interrupting fight does not destroy the task", () => {
  const { dim, owner } = freshWorld();
  const { agent } = spawnBot(owner);
  sim.give(agent.entity, "minecraft:iron_sword", 1);
  sim.plantOakTree(dim, 6, 3, 4);
  agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");
  sim.play(20);

  const zombie = sim.spawnMob(dim, "minecraft:zombie", { x: 3, y: sim.GROUND_Y, z: 2 }, { health: 6 });
  sim.play(20);
  assert.notEqual(agent.tasks.current?.status, TaskStatus.FAILED, "a fight must not fail the task");
  sim.playUntil(() => !zombie.isValid, 1500, 5);
  assert.equal(zombie.isValid, false, "the interrupting zombie is dealt with");

  sim.playUntil(() => (agent.tasks.current?.progress || 0) >= 1, 1500, 5);
  assert.ok((agent.tasks.current?.progress || 0) >= 1, "and the task picks up where it left off");
  assert.match(said(owner), /Resuming task/i, "the player is told the task is back on");
});

/* ─────────────────────────────── J. memory ────────────────────────────────── */

test("AC-26 current task memory — the bot can say what it is doing and why", () => {
  const { dim, owner } = freshWorld();
  const { agent } = spawnBot(owner);
  sim.plantOakTree(dim, 6, 3, 4);
  agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");
  sim.play(30);

  const text = agent.taskText();
  assert.match(text, /Collect 4 oak_log/, "the current objective is named");
  assert.match(text, /\d\/4/, "with its real progress");
  assert.ok(agent.memory.data.shortTerm.some((entry) => /Task created/.test(entry.text)), "the task is in working memory");
  assert.ok(agent.memory.data.playerRequests.some((entry) => /Collect 4 oak_log/.test(entry.text)), "and so is the request that caused it");
});

test("AC-27 completed task memory — finished work is remembered and named on a repeat", () => {
  const { dim, owner } = freshWorld();
  const { agent } = spawnBot(owner);
  sim.plantOakTree(dim, 6, 3, 4);
  agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");
  sim.playUntil(() => agent.tasks.current?.status === TaskStatus.COMPLETED, 2000, 5);
  assert.equal(agent.tasks.current?.status, TaskStatus.COMPLETED);

  assert.ok(agent.memory.data.completedTasks.some((entry) => /Collect 4 oak_log/.test(String(entry.goal))), "the finished task is in long-term memory");
  assert.ok(agent.tasks.hasCompleted(agent.tasks.current.key || ""), "and its key is marked complete");

  // The player takes the logs and asks again: the bot remembers doing it.
  for (const slot of agent.entity.getComponent("minecraft:inventory").container.slots) if (slot) slot.amount = 0;
  sim.plantOakTree(dim, -7, -6, 4);
  agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");
  assert.match(said(owner), /Done this one before/i, "a repeated order is acknowledged, not silently re-run");
  assert.equal(agent.tasks.current.status, TaskStatus.ACTIVE, "and it still runs, because the items are gone");
});

test("AC-28 interrupted task — a pause keeps the objective and its progress", () => {
  const { dim, owner } = freshWorld({ size: 64 });
  const { agent } = spawnBot(owner);
  sim.plantOakTree(dim, 6, 3, 4);
  agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");
  sim.playUntil(() => (agent.tasks.current?.progress || 0) >= 1, 1200, 5);
  const progress = agent.tasks.current.progress;
  assert.ok(progress >= 1, "the task got going first");

  agent.follow();
  assert.equal(agent.tasks.current.status, TaskStatus.PAUSED, "a follow order pauses the task instead of deleting it");
  assert.match(agent.tasks.current.interruption?.reason || "", /follow/i, "and records why");
  assert.match(said(owner), /Task paused at \d\/4/, "the player is told where it stopped");

  owner.location = { x: 0, y: sim.GROUND_Y, z: 20 };
  sim.play(120);
  agent.resume();
  sim.playUntil(() => (agent.tasks.current?.progress || 0) > progress || agent.tasks.current?.status === TaskStatus.COMPLETED, 2000, 10);
  assert.equal(agent.tasks.current.status, TaskStatus.ACTIVE, "resume picks the same task up");
  assert.ok(agent.tasks.current.progress >= progress, "no progress was lost while it was paused");
});

/* ────────────────────────────── K. priorities ─────────────────────────────── */

test("AC-29 emergency priority — survival outranks the task the player gave", () => {
  const { dim, owner } = freshWorld();
  const { agent } = spawnBot(owner);
  sim.plantOakTree(dim, 6, 3, 4);
  agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");
  sim.play(30);
  assert.equal(agent.runtime.priority.behavior, "task");

  sim.give(agent.entity, "minecraft:bread", 2);
  sim.damage(agent.entity, 16);
  sim.spawnMob(dim, "minecraft:zombie", { x: 4, y: sim.GROUND_Y, z: 4 }, { health: 20 });
  // One observation cycle: the bot reacts to what it can see, and what it can
  // see is refreshed on the scan interval — not to a mob that spawned 0.2 s ago.
  sim.play(30);
  assert.equal(agent.runtime.priority.behavior, "flee", `hurt and hunted means run, not work (behavior ${agent.runtime.priority.behavior})`);
  const commandsBefore = dim.commands.length;
  sim.play(60);
  assert.ok(agent.runtime.priority.level > Priority.TASK, `the emergency outranks the task (${agent.runtime.priority.level} > ${Priority.TASK})`);
  assert.ok(dim.commands.slice(commandsBefore).every((command) => !command.includes("air destroy")), "it stops breaking blocks while it saves itself");
});

test("AC-30 player command priority — a direct order outranks whatever the bot planned", () => {
  const { dim, owner } = freshWorld({ size: 64 });
  const { agent } = spawnBot(owner);
  sim.plantOakTree(dim, 6, 3, 4);
  agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");
  sim.play(40);
  assert.ok(agent.runtime.plan, "it is busy with its own plan");

  const verdict = agent.evaluatePlayerCommand("come");
  assert.equal(verdict.interrupt, true, "a player order interrupts the plan");
  agent.comeTo(owner);
  assert.match(agent.runtime.plan?.goal || "", /Come to/, "the plan is replaced by the order");
  assert.equal(agent.tasks.current.status, TaskStatus.PAUSED, "the task is parked, not thrown away");

  owner.location = { x: 20, y: sim.GROUND_Y, z: 0 };
  sim.playUntil(() => sim.distanceBetween(agent.entity.location, owner.location) < 4, 900, 5);
  assert.ok(sim.distanceBetween(agent.entity.location, owner.location) < 4, "and the bot actually comes");
});

/* ────────────────────────────── L. reporting ──────────────────────────────── */

test("AC-31 progress reporting — milestones are announced with numbers that are true", () => {
  const { dim, owner } = freshWorld();
  const { agent } = spawnBot(owner);
  sim.plantOakTree(dim, 6, 3, 4);
  agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");

  const claimed = [];
  sim.playUntil(() => {
    for (const line of sim.plainChat(owner)) {
      const found = line.match(/(\d)\/4/);
      if (found) claimed.push({ progress: Number(found[1]), holding: itemCount(agent, "minecraft:oak_log") });
    }
    return agent.tasks.current?.status === TaskStatus.COMPLETED;
  }, 2000, 5);

  assert.equal(agent.tasks.current?.status, TaskStatus.COMPLETED, "the cycle finishes");
  assert.ok(claimed.length >= 2, "progress was reported more than once");
  for (const sample of claimed) {
    assert.ok(sample.progress <= sample.holding + 1, `a reported ${sample.progress}/4 must never exceed what it holds (${sample.holding})`);
  }
  const numbers = claimed.map((sample) => sample.progress);
  assert.equal(Math.max(...numbers), 4, "the final report is the real total");
});

test("AC-32 failure reporting — an impossible job ends in plain, actionable words", () => {
  const { dim, owner } = freshWorld({ size: 96 });
  const { agent, teleports } = spawnBot(owner);
  // A diamond pickaxe, so the tool check passes and the ONLY problem left is
  // that there is no diamond ore in this world at all.
  sim.give(agent.entity, "minecraft:diamond_pickaxe", 1);
  agent.mineTask("minecraft:diamond_ore", 2, "Mine 2 diamond ore");
  assert.ok(agent.tasks.current, "the request is legal, so it is accepted");
  sim.playUntil(() => agent.tasks.current?.status === TaskStatus.FAILED, 8000, 20);
  assert.equal(agent.tasks.current.status, TaskStatus.FAILED, "it gives up instead of searching forever");
  assert.equal(itemCount(agent, "minecraft:diamond"), 0, "and never claims a diamond it did not get");
  assert.equal(teleports(), 0, "the whole search ran on foot");
  const report = said(owner);
  assert.match(report, /can't find|no diamond|could not|need|unreachable/i, "the reason is stated in words a player can act on");
  assert.doesNotMatch(report, /undefined|\[object Object\]|null/, "no raw internals leak into chat");
  assert.ok(agent.memory.data.facts.some((fact) => /diamond/i.test(fact.text)), "the impossibility is recorded as a fact, not forgotten");
});

/* ─────────────────────────── M. player controls ───────────────────────────── */

test("AC-33 /bot:stop — the bot halts, drops its plan and says so", () => {
  const { dim, owner } = freshWorld({ size: 64 });
  const { agent } = spawnBot(owner);
  sim.plantOakTree(dim, 6, 3, 4);
  agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");
  sim.play(40);
  assert.ok(agent.runtime.plan, "it is mid-task");

  const result = slash("bot:stop", owner);
  assert.equal(result.status, bedrock.CustomCommandStatus.Success);
  sim.play(20);
  const speed = Math.hypot(agent.entity.getVelocity().x, agent.entity.getVelocity().z);
  assert.ok(speed < 0.05, `it must come to rest (velocity ${speed.toFixed(3)})`);
  assert.equal(agent.runtime.plan, null, "the plan is dropped");
  assert.equal(agent.runtime.follow, false, "following is off");
  assert.match(said(owner), /stop|Stopped|halt/i);
});

test("AC-34 /bot:status — one command reports health, task, position and load", () => {
  const { dim, owner } = freshWorld();
  const { agent } = spawnBot(owner);
  sim.plantOakTree(dim, 6, 3, 4);
  sim.give(agent.entity, "minecraft:oak_log", 3);
  agent.createCollectTask("minecraft:oak_log", 8, "Collect 8 oak_log");
  sim.play(10);

  slash("bot:status", owner);
  const text = said(owner);
  assert.match(text, /Steve/, "which bot");
  assert.match(text, /HP|health|\d+\s*\/\s*20/i, "how hurt it is");
  assert.match(text, /Collect 8 oak_log|3\/8/, "what it is working on");
  assert.match(text, /oak log/i, "what it is carrying");
  assert.match(text, /follow|task|idle|search|walk/i, "what it is doing right now");
  assert.doesNotMatch(text, /\[object Object\]|undefined/);
});

test("AC-35 /bot:follow — the command starts real following", () => {
  const { owner } = freshWorld({ size: 72 });
  const { agent, teleports } = spawnBot(owner);
  slash("bot:follow", owner);
  assert.equal(agent.runtime.follow, true);
  assert.match(said(owner), /Following you/i);

  owner.location = { x: 16, y: sim.GROUND_Y, z: 12 };
  sim.play(240);
  assert.ok(sim.distanceBetween(agent.entity.location, owner.location) < 6, "it closes the distance on foot");
  assert.equal(teleports(), 0);
});

test("AC-36 /bot:come — the bot walks to the player who called it", () => {
  const { owner } = freshWorld({ size: 72 });
  const { agent, teleports } = spawnBot(owner);
  owner.location = { x: 18, y: sim.GROUND_Y, z: -10 };
  sim.play(5);

  slash("bot:come", owner);
  const before = sim.distanceBetween(agent.entity.location, owner.location);
  sim.playUntil(() => sim.distanceBetween(agent.entity.location, owner.location) < 3.5, 900, 5);

  const after = sim.distanceBetween(agent.entity.location, owner.location);
  assert.ok(after < 3.5, `it must arrive next to the player (was ${before.toFixed(1)}, now ${after.toFixed(1)})`);
  assert.equal(teleports(), 0, "coming over is a walk, never a blink");
});

test("AC-37 /bot:inventory — the player sees the real contents", () => {
  const { owner } = freshWorld();
  const { agent } = spawnBot(owner);
  sim.give(agent.entity, "minecraft:oak_log", 5);
  sim.give(agent.entity, "minecraft:cooked_beef", 2);

  slash("bot:inventory", owner);
  const text = said(owner);
  assert.match(text, /oak log/i, "items are named the way the game names them");
  assert.match(text, /5/, "with their real counts");
  assert.match(text, /cooked beef|steak|beef/i);
  assert.doesNotMatch(text, /diamond/, "it does not invent items");
  assert.doesNotMatch(text, /minecraft:/, "and it does not dump raw ids at the player");
});

/* ─────────────────────── N. AI provider safety net ────────────────────────── */

test("AC-38 AI unavailable — the bot says so once and keeps working on the fallback", async () => {
  const { dim, owner } = freshWorld();
  const { agent } = spawnBot(owner);
  sim.plantOakTree(dim, 6, 3, 4);
  agent.updateConfig({ provider: "custom", endpoint: "http://127.0.0.1:1/plan", model: "test-model" });
  agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");

  for (let round = 0; round < 8; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 12));
    sim.play(60);
  }
  assert.match(String(agent.runtime.lastValidation), /fallback/i, "the deterministic fallback took over");
  assert.match(said(owner), /AI unavailable/i, "the player is told once, in plain words");
  assert.equal(sim.countChatMatching(owner, /AI unavailable/i), 1, "exactly once — not every tick");
  assert.ok((agent.tasks.current?.progress || 0) >= 1, "and the task still made progress without the network");
});

test("AC-39 invalid AI response — a bad plan is rejected, not executed", async () => {
  const { dim, owner } = freshWorld();
  const { agent } = spawnBot(owner);
  sim.plantOakTree(dim, 6, 3, 4);
  const bedrockCell = { x: 2, y: sim.GROUND_Y - 3, z: 2 };
  dim.setBlock(bedrockCell, "minecraft:bedrock");

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            goal: "Collect 4 oak_log",
            thought: "Do it all at once.",
            actions: [
              { type: "mine_block", block: "minecraft:bedrock" },
              { type: "run_command", command: "give @a diamond 64" }
            ]
          })
        }
      }]
    })
  });
  try {
    agent.updateConfig({ provider: "custom", endpoint: "http://example.invalid/plan", model: "test-model" });
    agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");
    for (let round = 0; round < 6; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 12));
      sim.play(60);
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.match(String(agent.runtime.lastValidation), /fallback|reject/i, "the poisoned plan was refused");
  assert.equal(dim.getBlock(bedrockCell).typeId, "minecraft:bedrock", "bedrock was never touched");
  assert.ok(!dim.commands.some((command) => /^give /.test(command)), "and no give command was ever run");
  assert.ok(!agent.runtime.plan?.actions?.some((action) => action.type === "run_command"), "no unvalidated action reached the plan");
});

test("AC-40 impossible action — the allowlist is one list, and it is enforced", async () => {
  const { dim, owner } = freshWorld();
  const { agent } = spawnBot(owner);
  assert.ok(ALLOWED_BLOCKS.has("minecraft:oak_log"), "wood is allowed");
  assert.ok(!ALLOWED_BLOCKS.has("minecraft:bedrock"), "bedrock is not");
  // One list, not two that can drift: the controller's mine allowlist IS the
  // validator's, so a player command can never reach a block an AI plan could not.
  const source = await readFile(new URL("../behavior_packs/autonomous_ai_bot/scripts/core/bot-controller.js", import.meta.url), "utf8");
  assert.match(source, /const ALLOWED_MINE_BLOCKS = ALLOWED_BLOCKS;/, "the mining allowlist must be the validator's list, not a copy");

  const before = dim.commands.length;
  agent.runtime.targetBlock = { x: 0, y: sim.GROUND_Y - 3, z: 0, type: "minecraft:bedrock" };
  const result = agent.engine.execute({ type: "mine_block", block: "minecraft:bedrock" });
  assert.equal(result.success, false, "an impossible block is refused by the engine");
  assert.equal(dim.commands.length, before, "no command was issued for it");

  slash("bot:mine", owner, "bedrock");
  assert.match(said(owner), /can't|cannot|not allowed|no/i, "and the player is told why");
});

/* ─────────────────────────── O. performance ───────────────────────────────── */

test("AC-41 no tick flooding — scans are capped, counted and not run every tick", () => {
  const { dim, owner } = freshWorld({ size: 64 });
  const { agent } = spawnBot(owner);
  sim.plantOakTree(dim, 10, 8, 4);
  agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");

  const stamps = new Set();
  for (let tick = 0; tick < 100; tick += 1) {
    sim.play(1);
    if (agent.observation?.timestamp) stamps.add(agent.observation.timestamp);
  }
  assert.ok(stamps.size <= 14, `5 seconds of game time must not produce 100 scans (got ${stamps.size})`);
  const scan = agent.observation.scan;
  assert.ok(scan.cellsRead <= (scan.cellCap || 600), `block reads stay inside the cap (${scan.cellsRead}/${scan.cellCap})`);
  assert.ok(Number.isFinite(scan.ms) && scan.ms >= 0, "and the cost is measured, not assumed");
  assert.ok(agent.observation.blocks.length > 0, "the capped scan still finds the world");
  assert.equal(controller().tickCount >= 100, true, "one controller tick per game tick");
});

test("AC-42 multiple bots — each answers its own owner and does its own work", () => {
  const { dim, owner } = freshWorld({ size: 72 });
  const second = bedrock.addPlayer("Second", { x: -14, y: sim.GROUND_Y, z: -14 });
  const first = spawnBot(owner, "Steve");
  const other = spawnBot(second, "Janet");
  assert.equal(controller().all().length, 2, "both bots exist");
  assert.equal(controller().byName("steve"), first.agent, "and are addressable by name, case-insensitively");

  sim.plantOakTree(dim, 6, 3, 4);
  const janetStart = { ...other.agent.entity.location };
  first.agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");
  sim.playUntil(() => (first.agent.tasks.current?.progress || 0) >= 1, 1500, 5);

  assert.ok((first.agent.tasks.current?.progress || 0) >= 1, "Steve works");
  assert.ok(sim.distanceBetween(janetStart, other.agent.entity.location) < 1.5, "Janet is not dragged into Steve's task");
  assert.equal(other.agent.tasks.current, null, "and has no task of her own");
  assert.equal(first.agent.ownerId, owner.id);
  assert.equal(other.agent.ownerId, second.id, "ownership never crosses over");
});

/* ─────────────────────────── P. persistence ───────────────────────────────── */

test("AC-43 save / reload — the bot, its owner and its task survive a world reload", () => {
  const { dim, owner } = freshWorld();
  const { agent } = spawnBot(owner, "Persist");
  sim.plantOakTree(dim, 6, 3, 4);
  agent.createCollectTask("minecraft:oak_log", 4, "Collect 4 oak_log");
  sim.playUntil(() => (agent.tasks.current?.progress || 0) >= 1, 1500, 5);
  const progress = agent.tasks.current.progress;
  assert.ok(progress >= 1, "there is something worth saving");

  const restored = sim.simulateReload(controller());
  assert.equal(restored.length, 1, "the bot is adopted again from its saved properties");
  const again = restored[0];
  assert.equal(again.name, "Persist", "same name");
  assert.equal(again.ownerId, owner.id, "same owner");
  assert.equal(again.tasks.current?.goal, "Collect 4 oak_log", "same objective");
  assert.ok((again.tasks.current?.progress || 0) >= progress, `progress is restored, not reset (${again.tasks.current?.progress} >= ${progress})`);
  assert.equal(itemCount(again, "minecraft:oak_log"), itemCount(agent, "minecraft:oak_log"), "and the inventory it earned is still there");
});

/* ─────────────────────── Q. the whole thing together ──────────────────────── */

test("AC-44 full player scenario — create, order, work, fight, finish, report", () => {
  const { dim, owner } = freshWorld({ size: 72 });

  // 1. Create.
  const { agent, teleports } = spawnBot(owner, "Buddy");
  assert.match(said(owner), /Created Buddy/);

  // 2. Follow the player somewhere.
  slash("bot:follow", owner);
  owner.location = { x: 10, y: sim.GROUND_Y, z: 10 };
  sim.play(240);
  assert.ok(sim.distanceBetween(agent.entity.location, owner.location) < 6, "it followed");

  // 3. A gathering order.
  sim.plantOakTree(dim, 14, 12, 4);
  // Custom commands take ONE optional string parameter, exactly as Bedrock
  // passes it: "/bot:collect 4 oak_log".
  slash("bot:collect", owner, "4 oak_log");
  assert.equal(agent.tasks.current?.status, TaskStatus.ACTIVE, "the slash command created a real task");

  // 4. A fight interrupts it.
  sim.give(agent.entity, "minecraft:iron_sword", 1);
  const zombie = sim.spawnMob(dim, "minecraft:zombie", { x: agent.entity.location.x + 3, y: sim.GROUND_Y, z: agent.entity.location.z }, { health: 6 });
  sim.playUntil(() => !zombie.isValid, 1500, 5);
  assert.equal(zombie.isValid, false, "the interruption is survived");
  assert.notEqual(agent.tasks.current?.status, TaskStatus.FAILED, "and the order is not lost");

  // 5. Finish the order.
  sim.playUntil(() => agent.tasks.current?.status === TaskStatus.COMPLETED, 3000, 10);
  assert.equal(
    agent.tasks.current?.status, TaskStatus.COMPLETED,
    `the wood arrives (progress ${agent.tasks.current?.progress}/${agent.tasks.current?.target}, last action ${agent.runtime.lastAction?.type ?? "-"}: ${agent.tasks.current?.failureReason || agent.runtime.lastAction?.reason || "no reason given"})`
  );
  assert.equal(itemCount(agent, "minecraft:oak_log"), 4);

  // 6. Report, then stop.
  slash("bot:status", owner);
  assert.match(said(owner), /4\/4|COMPLETED|Complete/i, "status tells the truth about the finished job");
  slash("bot:stop", owner);
  sim.play(20);
  assert.ok(Math.hypot(agent.entity.getVelocity().x, agent.entity.getVelocity().z) < 0.05, "stop means stop");
  assert.equal(teleports(), 0, "the whole scenario ran without a single teleport");
  assert.doesNotMatch(said(owner), /\[object Object\]|undefined|NaN/, "and nothing internal ever reached the player");
});

/* ─────────────────────────── R. conversation (AC-45) ─────────────────────────── */

test("AC-45 conversation — the bot answers about this world instead of going quiet", () => {
  const { dim, owner } = freshWorld();
  const { agent } = spawnBot(owner, "Chatty");

  // Wound it: the answer has to change with the world, or it is a canned line.
  const health = agent.entity.getComponent("minecraft:health");
  if (health) health.currentValue = 7;

  slash("bot:talk", owner, "how are you");
  const hurt = said(owner);
  assert.match(hurt, /Chatty/, "the bot answers in its own name");
  assert.match(hurt, /7\/20/, `the health in the answer must be the live health, got: ${hurt}`);

  const here = agent.entity.location;
  slash("bot:talk", owner, "where are you");
  const where = said(owner);
  assert.match(where, new RegExp(`${Math.floor(here.x)}, ?${Math.floor(here.y)}, ?${Math.floor(here.z)}`), `the position must be the live position, got: ${where}`);

  // A real job, then a report about that job.
  sim.plantOakTree(dim, 6, 4, 4);
  slash("bot:talk", owner, "get me 8 oak logs");
  assert.equal(agent.tasks.current?.status, TaskStatus.ACTIVE, "an order typed at the bot is still an order");
  assert.equal(agent.tasks.current?.kind, "collect");
  sim.play(10);
  slash("bot:talk", owner, "what are you doing");
  const busy = said(owner);
  assert.match(busy, /8 oak_log|Collect 8 oak_log|\/8/, `the report must name the live task, got: ${busy}`);

  // A mine order goes through the mine path, not the collect path.
  sim.give(agent.entity, "minecraft:wooden_pickaxe", 1);
  slash("bot:talk", owner, "mine 4 stone");
  assert.equal(agent.tasks.current?.kind, "mine", "the word 'mine' must produce a mining task");

  // Nothing gets silence, and nothing internal ever reaches the player.
  for (const words of ["asdfghjkl", "why is the sky blue", "banana banana banana", "?!"]) {
    bedrock.world.messages.length = 0;
    slash("bot:talk", owner, words);
    const reply = said(owner);
    assert.ok(reply.includes("[Chatty]"), `"${words}" got no reply`);
    assert.doesNotMatch(reply, /\[object Object\]|undefined|NaN/, `"${words}" leaked internals: ${reply}`);
  }
});
