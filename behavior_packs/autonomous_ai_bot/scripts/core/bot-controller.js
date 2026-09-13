import { world } from "@minecraft/server";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config.js";
import { ActionEngine } from "./action-engine.js";
import { validatePlan } from "./action-validator.js";
import { makeObservation } from "./observation.js";
import { MemoryStore } from "./memory.js";
import { TaskManager, TaskStatus } from "./task-manager.js";
import { countItem, equipItem, pickupNearbyItems, readInventory, tryEatBestFood, useItem } from "./inventory.js";
import { BotState, readBotStatus, setBotStatus } from "./status.js";
import { fallbackPlan, safeFallback } from "./planner.js";
import { providerFor } from "./ai-provider.js";
import { applyPlayerStep, clearRoute, isSafeCell, StuckDetector, stopEntity } from "./navigation.js";
import { validateNamedCommand, canUseBot } from "./permissions.js";
import { commandHint, talkHint, noBotMessage } from "./hints.js";

const BOT_ENTITY_ID = "aibot:companion";
/**
 * A no-op stand-in for the test-mode harness. main.js replaces
 * `controller.test` with a real TestMode instance, but agents are also built by
 * unit tests and by the world-load restore path, where no harness may exist.
 * The important part is that `guard()` *runs* the action: an agent must never
 * silently skip its own behaviour because the debugger is absent.
 */
/** @type {any} */
const SILENT_TEST = Object.freeze({
  enabled: false,
  watching: false,
  entries: [],
  liveness: { tps: 0, tick: 0, aiBeat: -1, moveBeat: -1, stalled: false, movementStalled: false },
  error() { return null; },
  warn() { return null; },
  note() { return null; },
  guard(_where, action) { return action(); },
  beat() {},
  persist() {},
  clear() {},
  recent() { return []; },
  errorCount() { return 0; },
  warnCount() { return 0; },
  logLines() { return []; },
  statusLines() { return []; },
  setEnabled() { return false; },
  setWatch() {},
  onPlayerJoin() {},
  handle() { return false; },
  runSelfTest() { return false; }
});
const DIMENSIONS = ["overworld", "nether", "the_end"];
const DROP_FOR_BLOCK = Object.freeze({
  "minecraft:iron_ore": "minecraft:raw_iron", "minecraft:gold_ore": "minecraft:raw_gold",
  "minecraft:copper_ore": "minecraft:raw_copper", "minecraft:coal_ore": "minecraft:coal",
  "minecraft:diamond_ore": "minecraft:diamond", "minecraft:redstone_ore": "minecraft:redstone",
  "minecraft:lapis_ore": "minecraft:lapis_lazuli", "minecraft:stone": "minecraft:cobblestone",
  "minecraft:deepslate_iron_ore": "minecraft:raw_iron", "minecraft:deepslate_gold_ore": "minecraft:raw_gold",
  "minecraft:deepslate_copper_ore": "minecraft:raw_copper", "minecraft:deepslate_coal_ore": "minecraft:coal",
  "minecraft:deepslate_diamond_ore": "minecraft:diamond", "minecraft:deepslate_redstone_ore": "minecraft:redstone",
  "minecraft:deepslate_lapis_ore": "minecraft:lapis_lazuli", "minecraft:deepslate": "minecraft:cobbled_deepslate"
});

function positionArray(position) { return [Math.round(position.x), Math.round(position.y), Math.round(position.z)]; }
/**
 * A bot embedded in solid blocks is effectively invisible — its model is
 * swallowed by the terrain and players report it as "not in the world".
 * Relocate the bot to the nearest standing-open cell (open feet + head,
 * solid floor), searching a small spiral around its current position.
 * Returns true when the bot was moved.
 */
function relocateToSafeCell(entity) {
  const origin = {
    x: Math.floor(entity.location.x),
    y: Math.floor(entity.location.y),
    z: Math.floor(entity.location.z)
  };
  for (let radius = 0; radius <= 4; radius += 1) {
    const cells = [];
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        for (const dy of [0, 1]) cells.push({ x: origin.x + dx, y: origin.y + dy, z: origin.z + dz });
      }
    }
    for (const cell of cells) {
      try {
        if (!isSafeCell(entity.dimension, cell)) continue;
        if (cell.x === origin.x && cell.y === origin.y && cell.z === origin.z) continue;
        entity.teleport(
          { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 },
          { dimension: entity.dimension, keepVelocity: false }
        );
        return true;
      } catch { /* try the next cell */ }
    }
  }
  return false;
}
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
function isHostile(type) {
  return /zombie|husk|drowned|skeleton|stray|creeper|spider|cave_spider|witch|enderman|phantom|pillager|vindicator|ravager|slime|magma_cube|blaze|ghast|piglin|hoglin|warden|guardian|shulker|vex|evoker/.test(String(type || ""));
}
function isValidEntity(entity) {
  try { return Boolean(entity && entity.isValid === true); } catch (error) { return false; }
}

class BotAgent {
  constructor(controller, entity) {
    this.controller = controller;
    this.entity = entity;
    this.ownerId = String(entity.getDynamicProperty("aibot:owner_id") || "");
    this.ownerName = String(entity.getDynamicProperty("aibot:owner_name") || "");
    this.name = String(entity.getDynamicProperty("aibot:name") || entity.nameTag || "AI Bot").split("\n")[0];
    this.config = loadConfig(entity);
    this.tasks = new TaskManager(this.readJson("aibot:tasks", null));
    this.memory = new MemoryStore(this.readJson("aibot:memory", null));
    this.observation = null;
    this.engine = new ActionEngine(this);
    this.runtime = {
      plan: null, planIndex: 0, targetBlock: null, targetPosition: null, entityTarget: null,
      combatTarget: null, chest: null, follow: false, home: this.readPosition(),
      lastPlanAt: 0, planning: null, planFailures: 0, lastMinedKey: "", lastMinedAt: 0,
      lastAttackAt: 0, returningAfterTask: false, stuck: new StuckDetector(), exploreTarget: null,
      aiErrorShown: false, lastPersistAt: 0, tick: 0, lastAction: null, lastPlan: null,
      lastAIRequest: "none", lastAIResponse: "none", lastValidation: "not run", lastPlanReason: "none", inventoryFullReturn: false,
      tickFailures: 0, lastFollowResult: "not running"
    };
    this.status = readBotStatus(entity);
    this.setName();
  }

  readJson(key, fallback) {
    try { const raw = this.entity.getDynamicProperty(key); return raw ? JSON.parse(String(raw)) : fallback; } catch { return fallback; }
  }
  readPosition() {
    try { const raw = this.entity.getDynamicProperty("aibot:home"); return raw ? JSON.parse(String(raw)) : null; } catch { return null; }
  }
  owner() {
    try {
      const players = world.getPlayers();
      return players.find((player) => player.id === this.ownerId) || players.find((player) => player.name === this.ownerName) || null;
    } catch { return null; }
  }
  setName() {
    try { this.entity.setDynamicProperty("aibot:name", this.name); } catch { /* invalid entity */ }
  }
  currentCollectionItem() { return DROP_FOR_BLOCK[this.tasks.current?.block] || this.tasks.current?.block || "minecraft:oak_log"; }
  entityInventoryIsFull() { const inventory = readInventory(this.entity); return inventory.size > 0 && inventory.freeSlots === 0; }
  progressText() { const task = this.tasks.current; return task ? `${task.progress}/${task.target}` : ""; }
  notify(message) { this.owner()?.sendMessage(`§b[${this.name}]§r ${message}`); }
  /** Never null: see SILENT_TEST. Everything that can throw goes through it. */
  get test() { return this.controller?.test || SILENT_TEST; }

  /**
   * Reply in chat like a teammate. Always goes to the owner (and optionally the
   * player who just spoke). Used for task acks, free-form chat, and status.
   */
  say(message, player = null) {
    const text = `§b[${this.name}]§r ${message}`;
    const owner = this.owner();
    const targets = new Set();
    if (player) targets.add(player);
    if (owner) targets.add(owner);
    if (!targets.size) return;
    for (const target of targets) {
      try { target.sendMessage(text); } catch { /* left */ }
    }
  }

  /** Handle a free-form chat line directed at this bot (not a structured intent). */
  async chatWith(player, message) {
    const text = String(message || "").trim();
    if (!text) return;
    this.memory.playerRequest(text);
    // Lightweight local replies so the bot always "talks back" even without AI.
    const lower = text.toLowerCase();
    if (/\b(hi|hello|hey|howdy|yo)\b/.test(lower)) {
      this.say(`Hey ${player.name}! What do you need?`, player);
      return;
    }
    if (/\b(thank|thanks|thx)\b/.test(lower)) {
      this.say("Anytime.", player);
      return;
    }
    if (/\b(how are you|you ok|status)\b/.test(lower)) {
      this.say(this.statusText().replace(/\n/g, " · "), player);
      return;
    }
    if (/\b(help|what can you)\b/.test(lower)) {
      this.say(`I can follow, mine, collect, protect, pick up drops, use items, and fight. Try "${this.name}, get me 16 oak logs" or "${this.name}, protect me".`, player);
      return;
    }
    // Try the AI provider for a short spoken reply + optional plan when a task is active.
    if (this.config.provider !== "fallback") {
      try {
        const provider = providerFor(this.config);
        if (provider?.generateChatReply) {
          const reply = await provider.generateChatReply(text, this.observation, this.memory.promptContext(this.tasks.current));
          if (reply) { this.say(reply, player); return; }
        }
      } catch {
        // Fall through to the deterministic ack.
      }
    }
    this.say(`Got it. Say a clear order like "follow me", "protect me", "get me 20 iron", or "stop".`, player);
  }
  persist(force = false) {
    if (!force && this.runtime.tick - this.runtime.lastPersistAt < 100) return;
    // Tasks, memory and config all live in dynamic properties. A rejected write
    // (property size cap, unloading entity) used to vanish here, which is why a
    // bot can "forget" its task after a reload with no explanation anywhere.
    this.test.guard("persist bot", () => {
      this.entity.setDynamicProperty("aibot:tasks", JSON.stringify(this.tasks.snapshot()));
      this.entity.setDynamicProperty("aibot:memory", JSON.stringify(this.memory.snapshot()));
      this.entity.setDynamicProperty("aibot:config", JSON.stringify(this.config));
      if (this.runtime.home) this.entity.setDynamicProperty("aibot:home", JSON.stringify(positionArray(this.runtime.home)));
      this.runtime.lastPersistAt = this.runtime.tick;
    }, undefined, { level: "warn", context: `${this.name}: task progress and memory may not survive a reload` });
  }

  setPlan(plan) {
    const checked = validatePlan(plan, {
      maxPlanActions: this.config.maxPlanActions,
      position: this.observation?.position,
      maxDistance: this.config.maxPlanDistance
    });
    if (!checked.ok) throw new Error(checked.reason);
    this.runtime.plan = checked.plan;
    this.runtime.planIndex = 0;
    this.runtime.planFailures = 0;
    if (this.tasks.current) this.tasks.current.remainingActions = checked.plan.actions.map((item) => item.type);
  }

  requestPlan(reason) {
    if (this.runtime.planning || !this.tasks.current || this.tasks.current.status !== TaskStatus.ACTIVE) return;
    if (this.config.provider === "fallback") {
      this.runtime.lastPlan = safeFallback(this.tasks.current, { maxPlanActions: this.config.maxPlanActions, position: this.observation?.position, maxDistance: this.config.maxPlanDistance });
      this.runtime.lastValidation = "deterministic fallback accepted";
      this.runtime.lastPlanReason = reason;
      this.setPlan(this.runtime.lastPlan);
      return;
    }
    if (Date.now() - this.runtime.lastPlanAt < this.config.aiCooldownMs) {
      this.setPlan(safeFallback(this.tasks.current, { maxPlanActions: this.config.maxPlanActions, position: this.observation?.position, maxDistance: this.config.maxPlanDistance }));
      return;
    }
    this.runtime.lastPlanAt = Date.now();
    this.runtime.planning = this.planWithProvider(reason).finally(() => { this.runtime.planning = null; });
  }

  async planWithProvider(reason) {
    this.runtime.lastPlanReason = reason;
    this.runtime.lastAIRequest = JSON.stringify({ provider: this.config.provider, model: this.config.model || "", endpoint: this.config.endpoint || "", task: this.tasks.current?.id || "-", observationAt: this.observation?.timestamp || 0 }).slice(0, 400);
    setBotStatus(this.entity, BotState.THINKING, { target: reason });
    try {
      const provider = providerFor(this.config);
      const plan = await provider.generatePlan(this.observation, this.memory.promptContext(this.tasks.current), this.tasks.current);
      this.runtime.lastPlan = plan;
      this.runtime.lastAIResponse = JSON.stringify(plan).slice(0, 400);
      this.runtime.lastValidation = "accepted";
      this.setPlan(plan);
      this.memory.event(`Provider plan accepted for ${reason}.`, "ai");
      this.config.provider !== "fallback" && this.notify("§aAI connection restored; using a validated plan.");
      this.runtime.aiErrorShown = false;
    } catch (error) {
      this.runtime.lastPlan = safeFallback(this.tasks.current, { maxPlanActions: this.config.maxPlanActions, position: this.observation?.position, maxDistance: this.config.maxPlanDistance });
      this.runtime.lastAIResponse = String(error).slice(0, 400);
      this.runtime.lastValidation = `fallback after rejection: ${String(error).slice(0, 100)}`;
      this.setPlan(this.runtime.lastPlan);
      this.memory.event(`AI unavailable: ${String(error).slice(0, 140)}; deterministic fallback used.`, "error");
      // The provider failing is normal on Bedrock mobile (no fetch), so it is a
      // recorded error rather than a chat shout — unless the player asked to see
      // everything, in which case test mode echoes it line by line.
      this.test.error("AI provider", error, {
        context: `${this.config.provider}/${this.config.model || "no model"} at ${String(this.config.endpoint || "no endpoint").slice(0, 40)}`
      });
      if (!this.runtime.aiErrorShown && this.config.provider !== "fallback") {
        this.notify("§e⚠ AI unavailable. Using fallback behavior. §f/aibot:debug log §eshows why; §f/aibot:test net §eshows the endpoint verdict.");
        this.runtime.aiErrorShown = true;
      }
    }
  }

  createCollectTask(block, target, goal) {
    const item = DROP_FOR_BLOCK[block] || block;
    const current = countItem(this.entity, item);
    const task = this.tasks.create({ goal, kind: "collect", block, target, startingCount: current });
    this.memory.playerRequest(goal);
    this.memory.event(`Task created: ${goal}`);
    this.runtime.follow = false;
    this.runtime.returningAfterTask = false;
    this.runtime.plan = null;
    this.runtime.targetBlock = null;
    this.runtime.stuck.reset();
    this.say(`§aOn it.§r ${goal} — I'll path there, mine, and pick up the drops. Progress 0/${target}.`);
    this.requestPlan("new player task");
    this.persist(true);
    return task;
  }

  /** Use / equip an item from inventory like a player. */
  useHeldItem(itemId) {
    const result = useItem(this.entity, itemId);
    if (result.success) this.say(`Using ${itemId.replace(/^minecraft:/, "").replace(/_/g, " ")}.`);
    else {
      this.test.note("use item", `refused: ${result.reason}`, { level: "warn", context: this.name });
      this.say(`Can't use that: ${result.reason}`);
    }
    return result;
  }

  follow() {
    this.runtime.follow = true;
    this.runtime.plan = null;
    this.runtime.planIndex = 0;
    this.runtime.stuck.reset();
    setBotStatus(this.entity, BotState.FOLLOWING, { target: this.ownerName || "owner" });
    this.say("Following you.");
  }
  stop() {
    this.runtime.follow = false;
    this.runtime.plan = null;
    this.runtime.combatTarget = null;
    stopEntity(this.entity);
    try {
      if (typeof this.entity.setProperty === "function") this.entity.setProperty("aibot:attacking", false);
    } catch { /* optional */ }
    if (this.tasks.current?.status === TaskStatus.ACTIVE) this.tasks.pause("Stopped by player.");
    setBotStatus(this.entity, BotState.IDLE);
    this.say("Stopped. Current task is paused.");
    this.persist(true);
  }
  resume() {
    if (!this.tasks.current || this.tasks.current.status !== TaskStatus.PAUSED) {
      this.notify("There is no paused task to resume.");
      return;
    }
    if (this.entityInventoryIsFull()) {
      this.notify("Inventory is still full; store items first.");
      return;
    }
    this.tasks.resume();
    this.runtime.plan = null;
    this.runtime.targetBlock = null;
    this.memory.event("Paused task resumed by player.");
    this.notify(`Resuming task. Progress: ${this.progressText()}`);
    this.requestPlan("player resumed task");
    this.persist(true);
  }
  protect() {
    this.runtime.follow = false;
    this.config.combatMode = "defend_owner";
    this.runtime.plan = { goal: "Defend owner", thought: "Deterministic threat response.", actions: [{ type: "defend_player" }] };
    this.runtime.planIndex = 0;
    setBotStatus(this.entity, BotState.DEFENDING, { target: this.ownerName || "owner" });
    this.say("Defending you. I'll path to hostiles and fight.");
  }
  returnHome() {
    this.runtime.follow = false;
    this.runtime.plan = { goal: "Return to owner", thought: "Deterministic return.", actions: [{ type: "return_home" }] };
    this.runtime.planIndex = 0;
    this.runtime.returningAfterTask = false;
    this.say("Coming back to you.");
  }
  cancel() {
    this.tasks.cancel();
    this.runtime.plan = null;
    this.runtime.follow = false;
    this.runtime.combatTarget = null;
    stopEntity(this.entity);
    setBotStatus(this.entity, BotState.IDLE);
    this.memory.event("Current task cancelled.");
    this.say("Task cancelled.");
    this.persist(true);
  }

  findThreat() {
    if (this.config.combatMode === "passive") return null;
    const owner = this.owner();
    try {
      const defendOwner = this.config.combatMode === "defend_owner";
      const origins = defendOwner && owner ? [owner.location, this.entity.location] : [this.entity.location];
      const range = defendOwner ? 16 : 10;
      const candidates = new Set();
      for (const origin of origins) {
        for (const candidate of this.entity.dimension.getEntities({ location: origin, maxDistance: range })) {
          if (!isValidEntity(candidate)) continue;
          if (isHostile(candidate.typeId)) candidates.add(candidate);
        }
      }
      const priority = {
        "minecraft:creeper": 100, "minecraft:skeleton": 90, "minecraft:stray": 90, "minecraft:witch": 85,
        "minecraft:pillager": 80, "minecraft:vindicator": 80, "minecraft:zombie": 70, "minecraft:husk": 70,
        "minecraft:drowned": 65, "minecraft:spider": 50, "minecraft:cave_spider": 55, "minecraft:enderman": 40,
        "minecraft:phantom": 75, "minecraft:slime": 30, "minecraft:magma_cube": 35
      };
      return [...candidates].sort((a, b) =>
        (priority[b.typeId] || 20) - (priority[a.typeId] || 20)
        || distance(this.entity.location, a.location) - distance(this.entity.location, b.location)
      )[0] || null;
    } catch { return null; }
  }

  handleCombat() {
    // Drop a stale combat target that unloaded or died.
    if (this.runtime.combatTarget && !isValidEntity(this.runtime.combatTarget)) {
      this.runtime.combatTarget = null;
      this.runtime.entityTarget = null;
    }
    const target = isValidEntity(this.runtime.combatTarget) ? this.runtime.combatTarget : this.findThreat();
    let ownHealth;
    try { ownHealth = this.entity.getComponent("minecraft:health"); } catch { ownHealth = null; }

    // Eat when hurt — player-like item use.
    if (ownHealth && ownHealth.currentValue <= Math.max(8, ownHealth.effectiveMax * 0.45)) {
      const ate = tryEatBestFood(this.entity);
      if (ate.success) {
        this.memory.event(`Ate ${ate.used} at ${Math.ceil(ownHealth.currentValue)} health.`, "recovery");
        setBotStatus(this.entity, BotState.EATING, { target: ate.used });
        if (!target) return true;
      }
    }

    if (target && ownHealth && ownHealth.currentValue <= Math.max(5, ownHealth.effectiveMax * 0.25)) {
      const away = {
        x: this.entity.location.x + (this.entity.location.x - target.location.x) * 3,
        y: this.entity.location.y,
        z: this.entity.location.z + (this.entity.location.z - target.location.z) * 3
      };
      this.runtime.targetPosition = away;
      this.engine.execute({ type: "move_to_target" });
      setBotStatus(this.entity, BotState.FLEEING, { target: target.typeId, distance: distance(this.entity.location, target.location) });
      return true;
    }

    if (!target) {
      if (this.runtime.combatTarget) {
        this.runtime.combatTarget = null;
        this.runtime.entityTarget = null;
        try {
          if (typeof this.entity.setProperty === "function") this.entity.setProperty("aibot:attacking", false);
        } catch { /* optional */ }
        if (this.tasks.current?.status === TaskStatus.PAUSED) {
          this.tasks.resume();
          this.memory.event("Threat cleared; task resumed.");
          this.notify(`§aResuming task.§r Progress: ${this.progressText()}`);
        }
      }
      return false;
    }

    if (!this.runtime.combatTarget && this.tasks.current?.status === TaskStatus.ACTIVE) {
      this.tasks.pause(`Hostile entity detected: ${target.typeId}.`);
      this.memory.event(`Task paused for ${target.typeId}.`, "combat");
      this.notify(`§c⚠ ${target.typeId.replace(/^minecraft:/, "")} detected. Fighting — task paused.`);
    }
    this.runtime.combatTarget = target;
    this.runtime.entityTarget = target;

    const inventory = readInventory(this.entity);
    if (!/sword|axe/.test(String(inventory.selectedItem?.id || ""))) {
      const weapon = [
        "minecraft:netherite_sword", "minecraft:diamond_sword", "minecraft:iron_sword",
        "minecraft:stone_sword", "minecraft:golden_sword", "minecraft:wooden_sword",
        "minecraft:netherite_axe", "minecraft:diamond_axe", "minecraft:iron_axe"
      ].find((id) => countItem(this.entity, id) > 0);
      if (weapon) equipItem(this.entity, weapon);
    }

    const result = this.engine.execute({ type: "attack_entity" });
    if (result?.success) {
      this.runtime.combatTarget = null;
      this.runtime.entityTarget = null;
      pickupNearbyItems(this.entity, 4.5);
      if (this.tasks.current?.status === TaskStatus.PAUSED) {
        this.tasks.resume();
        this.memory.event("Combat completed; task resumed.", "combat");
        this.notify(`§a✓ Threat defeated.§r Resuming task. Progress: ${this.progressText()}`);
      } else {
        this.notify("§a✓ Threat defeated.");
      }
    }
    return true;
  }

  executePlan() {
    const plan = this.runtime.plan;
    if (!plan || this.runtime.planIndex >= plan.actions.length) {
      this.runtime.plan = null;
      return;
    }
    const action = plan.actions[this.runtime.planIndex];
    /** @type {any} */
    const result = this.engine.execute(action);
    this.runtime.lastAction = result;
    if (result.success) {
      this.tasks.addAction(action.type);
      if (this.tasks.current?.remainingActions?.length) this.tasks.current.remainingActions.shift();
      this.runtime.planIndex += 1;
      this.runtime.planFailures = 0;
      if (action.type === "return_home" && this.runtime.returningAfterTask) {
        this.runtime.returningAfterTask = false;
        setBotStatus(this.entity, BotState.IDLE);
        this.notify("§aDone.§r The requested items are in my inventory.");
      }
      if (action.type === "return_home" && this.runtime.inventoryFullReturn) {
        this.runtime.inventoryFullReturn = false;
        setBotStatus(this.entity, BotState.WAITING, { target: "inventory storage" });
        this.notify("§eI am back, but my inventory is still full. Store items, then use !aibot resume.");
      }
      if (this.runtime.planIndex >= plan.actions.length) {
        this.runtime.plan = null;
        if (this.tasks.current?.status === TaskStatus.ACTIVE && this.tasks.current.progress < this.tasks.current.target) {
          this.runtime.targetBlock = null;
          this.requestPlan("next collection cycle");
        }
      }
      return;
    }
    if (result.pending) return;
    if (result.reason === "Inventory is full.") {
      this.tasks.pause("Inventory full; returning to owner for storage.");
      this.memory.event("Task paused because inventory is full.", "recovery");
      this.runtime.inventoryFullReturn = true;
      this.runtime.targetBlock = null;
      this.runtime.plan = { goal: "Return to owner for inventory storage", thought: "Inventory is full; do not claim collection progress.", actions: [{ type: "return_home" }] };
      this.runtime.planIndex = 0;
      this.notify("§eInventory full.§r Returning to you; task is paused until items are stored.");
      return;
    }
    this.runtime.planFailures += 1;
    this.runtime.targetBlock = null;
    this.runtime.plan = null;
    // Every failed action used to be swallowed here; the reason is exactly what
    // a player needs ("no walkable path", "no tool", "block is not mineable").
    this.test.note("action failed", `${result.action || "action"}: ${result.reason || "no reason given"}`, {
      level: "warn",
      context: `${this.name} · plan step ${(this.runtime.planIndex || 0) + 1} · failure ${this.runtime.planFailures + 1}/4`
    });
    setBotStatus(this.entity, BotState.ERROR, { target: result.reason || "action failed" });
    if (this.runtime.planFailures >= 4) {
      this.tasks.fail(result.reason || "Action failed repeatedly.");
      this.memory.event(`Task failed: ${result.reason}`, "error");
      this.notify(`§cTask failed.§r ${result.reason}`);
      setBotStatus(this.entity, BotState.ERROR, { target: result.reason });
      this.persist(true);
    } else {
      this.requestPlan(result.reason || "action failed");
    }
  }

  tick(tick) {
    if (!isValidEntity(this.entity)) {
      clearRoute(this.entity?.id);
      return false;
    }
    this.runtime.tick = tick;

    // Player-like passive pickup every few ticks while moving or idle near drops.
    if (tick % 4 === 0) {
      try { pickupNearbyItems(this.entity, 1.8); } catch { /* ignore */ }
    }

    if (tick % Math.max(10, this.config.observationIntervalTicks) === 0 || !this.observation) {
      this.observation = makeObservation(this.entity, this.tasks.current, this.memory, this.config);
      this.memory.observe(this.observation);
      if (this.tasks.current?.status === TaskStatus.ACTIVE) {
        this.tasks.syncCount(countItem(this.entity, this.currentCollectionItem()));
        if (this.tasks.current?.status === TaskStatus.COMPLETED && !this.runtime.returningAfterTask) {
          this.memory.archiveTask(this.tasks.current);
          this.runtime.returningAfterTask = true;
          this.runtime.plan = { goal: "Return to player", thought: "Collection target verified in inventory.", actions: [{ type: "return_home" }] };
          this.runtime.planIndex = 0;
          this.notify(`§a✓ ${this.tasks.current.target}/${this.tasks.current.target} collected.§r Returning to you.`);
          this.memory.event("Collection completed and inventory count verified.");
        }
      }
    }

    // Auto-eat outside combat when damaged.
    if (tick % 40 === 0) {
      try {
        const health = this.entity.getComponent("minecraft:health");
        if (health && health.currentValue < health.effectiveMax * 0.7) tryEatBestFood(this.entity);
      } catch { /* optional */ }
    }

    if (this.handleCombat()) { this.persist(); return true; }

    if (this.runtime.follow && (!this.tasks.current || this.tasks.current.status !== TaskStatus.ACTIVE)) {
      /** @type {any} */
      let step = null;
      try {
        step = this.engine.execute({ type: "follow_player" });
      } catch (error) {
        this.test.error("follow step", error, { context: this.name });
      }
      // "It says Following you but never moves" is the most common complaint in
      // the wild, and the engine's verdict used to be thrown away. Under test
      // mode (or tracing) every non-arriving verdict is visible, folded by reason.
      // `pending` is the engine saying "still walking" — the normal case, and it
      // must never be reported as a failure (that would make tracing useless).
      if (step && !step.success && !step.arrived && !step.pending) {
        this.runtime.lastFollowResult = step.reason || "no reason given";
        this.test.note("follow", `follow_player → ${this.runtime.lastFollowResult} (${Math.round(step.distance ?? -1)}m away)`, { level: "warn", context: this.name });
      } else if (step) this.runtime.lastFollowResult = step.arrived ? "arrived" : "walking";
      else this.runtime.lastFollowResult = "engine threw (see the error log)";
    } else if (!this.runtime.plan && !this.runtime.follow) {
      // Idle — release the movement keys so the bot eases to a player-like stop.
      if (tick % 10 === 0) stopEntity(this.entity);
    }

    if (this.runtime.returningAfterTask && !this.runtime.plan) {
      this.runtime.plan = { goal: "Return to player", thought: "Returning after verified task.", actions: [{ type: "return_home" }] };
      this.runtime.planIndex = 0;
    }
    if (this.tasks.current?.status === TaskStatus.ACTIVE && !this.runtime.plan && !this.runtime.planning) {
      this.requestPlan("task needs an action");
    }
    if (this.runtime.plan) {
      this.executePlan();
      const target = this.runtime.targetBlock || this.runtime.targetPosition;
      const stuck = this.runtime.stuck.update(this.entity.location, target);
      if (stuck.stuck) setBotStatus(this.entity, stuck.attempts > 1 ? BotState.RECOVERING : BotState.STUCK, { target: "recalculating route" });
      if (stuck.stuck && stuck.attempts > 3) {
        this.runtime.plan = null;
        this.runtime.targetBlock = null;
        this.tasks.fail("Target unreachable after path recovery attempts.");
        this.notify("§cTarget unreachable.§r Task failed after safe recovery attempts.");
        setBotStatus(this.entity, BotState.ERROR, { target: "unreachable" });
      }
    }
    if (this.config.debug && tick % 100 === 0) this.notify(`\n${this.debugText()}`);
    this.persist();
    return true;
  }

  statusText() {
    const task = this.tasks.current;
    const status = readBotStatus(this.entity);
    const health = this.entity.getComponent("minecraft:health");
    const inventory = readInventory(this.entity);
    const follow = this.runtime.follow ? `Follow: ${this.runtime.lastFollowResult || "walking"}` : "Follow: off";
    return `${this.name}\nStatus: ${status.state}${status.block ? ` ${status.block}` : ""}\nTask: ${task?.goal || "None"}\nProgress: ${task ? `${task.progress}/${task.target}` : "-"}\nHealth: ${health ? `${Math.ceil(health.currentValue)}/${Math.ceil(health.effectiveMax ?? health.defaultValue ?? 20)}` : "unknown"}\nInventory: ${inventory.slots.length}/${inventory.size}\n${follow}\nAI: ${this.config.provider === "fallback" ? "fallback" : (this.runtime.aiErrorShown ? "unavailable / fallback" : this.config.provider)}`;
  }

  debugText() {
    const target = this.runtime.targetBlock || this.runtime.targetPosition;
    const distanceToTarget = target ? Math.round(distance(this.entity.location, target) * 10) / 10 : "-";
    const task = this.tasks.current;
    const status = readBotStatus(this.entity);
    return [
      `§8[BOT DEBUG ${this.name}]§r`,
      `STATE: ${status.state}`, `CURRENT TASK: ${task?.id || "-"}`, `TARGET: ${target ? JSON.stringify(target) : "-"}`,
      `TARGET DISTANCE: ${distanceToTarget}`, `CURRENT ACTION: ${this.runtime.lastAction?.action || "-"}`,
      `TASK PROGRESS: ${task ? `${task.progress}/${task.target}` : "-"}`, `PATH STATUS: ${this.runtime.stuck.attempts > 0 ? `recovery ${this.runtime.stuck.attempts}` : "clear"}`,
      `AI: ${this.runtime.aiErrorShown ? "UNAVAILABLE / FALLBACK" : this.config.provider}`, `LAST PLAN: ${this.runtime.lastPlanReason}`,
      `AI REQUEST: ${this.runtime.lastAIRequest}`, `AI RESPONSE: ${this.runtime.lastAIResponse}`,
      `ACTION VALIDATION: ${this.runtime.lastValidation}`, `INVENTORY: ${readInventory(this.entity).slots.length}/${readInventory(this.entity).size}`,
      `FOLLOW VERDICT: ${this.runtime.lastFollowResult || "-"}`,
      `MOVEMENT LOOP: ${this.controller?.test?.liveness?.movementStalled ? "STALLED (bots cannot walk)" : "running"}`,
      `MEMORY EVENTS: ${this.memory.snapshot().shortTerm.length}`,
      `§7Errors are listed by §f/aibot:debug log§7; the check-up is §f/aibot:test§7§r`
    ].join("\n");
  }

  inventoryText() {
    const inventory = readInventory(this.entity);
    const lines = inventory.slots.map((item) => `Slot ${item.slot + 1}: ${item.name} ×${item.count}`);
    return `§b${this.name} inventory§r\n${lines.join("\n") || "(empty)"}\nFree slots: ${inventory.freeSlots}`;
  }

  updateConfig(next) { this.config = saveConfig(this.entity, { ...this.config, ...next }); this.persist(true); }
}

export class BotController {
  constructor() {
    this.agents = new Map();
    this.tickCount = 0;
    /**
     * The test-mode harness (see core/testmode.js). main.js swaps in the live
     * instance; until then every capture call is a no-op that still runs the
     * guarded code.
     * @type {any}
     */
    this.test = SILENT_TEST;
    /**
     * While the self-test's probe entity exists, main.js's auto-registration
     * hook is paused so a throwaway entity is never adopted as a real bot.
     * @type {{suppressAutoRegister:boolean}}
     */
    this.probe = { suppressAutoRegister: false };
    /** Filled in by main.js so `!aibot info` can explain a silent failure. */
    this.diagnostics = {
      scriptVersion: "unknown", chatSource: "unbound", itemUseSource: "unbound",
      slashCommands: "unknown (startup event has not fired yet)", scriptEvent: "unbound",
      engineStarted: false, tickJob: false, spawnFailures: 0, lastSpawnError: "",
      duplicate: "not checked yet", interactSource: "unknown",
      testMode: "not started", errorLog: "not started"
    };
  }
  register(entity) {
    if (!entity || entity.typeId !== BOT_ENTITY_ID) return null;
    if (this.agents.has(entity.id)) return this.agents.get(entity.id);
    const agent = new BotAgent(this, entity);
    this.agents.set(entity.id, agent);
    return agent;
  }
  restore() {
    for (const dimensionId of DIMENSIONS) {
      try { for (const entity of world.getDimension(dimensionId).getEntities({ type: BOT_ENTITY_ID })) this.register(entity); } catch { /* dimension unavailable */ }
    }
  }
  remove(id) { this.agents.delete(id); }
  all() { return [...this.agents.values()]; }
  byName(name) { const wanted = String(name || "").toLowerCase(); return this.all().find((agent) => agent.name.toLowerCase() === wanted); }
  forPlayer(player, name = "") {
    const found = this.lookupForPlayer(player, name);
    if (found) return found;
    // A companion that exists in the world but is missing from THIS controller's
    // registry (chunk unloaded and entityLoad was missed, or a second copy of
    // this pack having spawned the bot) must never be reported as
    // "No bot is assigned to you". One cheap dimension re-scan fixes all of
    // those before any message claims the player has no bot.
    try { this.restore(); } catch { /* dimension query unavailable */ }
    return this.lookupForPlayer(player, name);
  }
  lookupForPlayer(player, name = "") {
    const named = name ? this.byName(name) : null;
    if (named && canUseBot(player, named, named.config)) { this.healOwnerBinding(named, player); return named; }
    const agent = this.all().find((agent) => (!agent.ownerId || agent.ownerId === player.id || agent.ownerName === player.name) && canUseBot(player, agent, agent.config)) || null;
    if (agent) this.healOwnerBinding(agent, player);
    return agent;
  }
  /**
   * Runtime entity ids are re-assigned every session, so a bot saved with an
   * owner id from the previous session no longer matches its returning owner.
   * When the owner name matches, trust it and rewrite the stored id so the
   * binding stays fresh instead of failing forever with "No bot is assigned".
   */
  healOwnerBinding(agent, player) {
    if (!agent || !player || !agent.ownerName || agent.ownerName !== player.name) return;
    if (agent.ownerId === player.id) return;
    agent.ownerId = player.id;
    try { agent.entity.setDynamicProperty("aibot:owner_id", player.id); } catch { /* entity invalid */ }
  }
  /**
   * A dead or unloaded bot must never permanently block its own name. If the
   * stored entity is gone, the stale registration is dropped and the create
   * continues instead of returning "already exists".
   */
  reclaimDeadName(name) {
    const existing = this.byName(name);
    if (!existing) return null;
    if (isValidEntity(existing.entity)) return existing;
    this.agents.delete(existing.entity?.id);
    return null;
  }
  /**
   * Scan the actual world (not just this controller's registry) for a live
   * companion with this name. When two copies of the pack are active at once,
   * the other copy's bot exists in the dimension but is unknown to this
   * controller — and without this check each copy would spawn its own bot
   * with the same name during auto-summon. Also covers a missed entityLoad.
   */
  findLiveEntityByName(name) {
    const wanted = String(name || "").toLowerCase();
    if (!wanted) return null;
    for (const dimensionId of DIMENSIONS) {
      try {
        for (const entity of world.getDimension(dimensionId).getEntities({ type: BOT_ENTITY_ID })) {
          const stored = String(entity.getDynamicProperty("aibot:name") || entity.nameTag || "").split("\n")[0];
          if (stored.toLowerCase() === wanted && isValidEntity(entity)) return entity;
        }
      } catch { /* dimension unavailable */ }
    }
    return null;
  }
  spawnLocation(player) {
    const base = player.location;
    return [
      { x: base.x + 1, y: base.y, z: base.z + 1 },
      { x: base.x - 1, y: base.y, z: base.z - 1 },
      { x: base.x + 1, y: base.y, z: base.z - 1 },
      { x: base.x - 1, y: base.y, z: base.z + 1 },
      { x: base.x, y: base.y, z: base.z },
      { x: base.x, y: base.y + 1, z: base.z }
    ];
  }
  create(player, requestedName = "Steve") {
    const name = String(requestedName || "Steve").replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 24) || "Steve";
    const existing = this.reclaimDeadName(name) || this.register(this.findLiveEntityByName(name));
    if (existing) {
      // The player's own bot still exists (typical after rejoining a world):
      // hand it back instead of scolding them with "already exists" — that
      // message is what made rejoining players think the mod was broken.
      if (existing.ownerId === player.id || (existing.ownerName && existing.ownerName === player.name)) {
        player.sendMessage(`§a✔ ${name}§a is already at your side.§r Use §e${commandHint(this, "status")}§r, §e${commandHint(this, "follow")}§r, or ${talkHint(this, name)}.`);
        return { agent: existing, created: false, reclaimed: true };
      }
      return {
        agent: existing, created: false,
        reason: existing.ownerName
          ? `${name} already exists and belongs to ${existing.ownerName}. Choose another name.`
          : `${name} already exists. Use §e${commandHint(this, `status ${name}`)}§r, or §e${commandHint(this, `remove ${name}`)}§r to despawn and recreate.`
      };
    }
    const dimension = player.dimension || world.getDimension(player.dimensionId ?? "overworld");
    // Prefer cells the bot can actually stand in (open feet + head, solid
    // floor). Spawning inside solid blocks is the classic "bot doesn't show
    // up" report: the entity exists but is swallowed by the terrain.
    const candidates = this.spawnLocation(player);
    const openCandidates = candidates.filter((candidate) => {
      try { return isSafeCell(dimension, candidate); } catch { return false; }
    });
    const ordered = openCandidates.length
      ? [...openCandidates, ...candidates.filter((candidate) => !openCandidates.includes(candidate))]
      : candidates;
    let entity = null;
    let lastError = "";
    for (const candidate of ordered) {
      try {
        const spawned = dimension.spawnEntity(BOT_ENTITY_ID, candidate);
        if (spawned) { entity = spawned; break; }
        lastError = "spawnEntity returned nothing.";
      } catch (error) {
        lastError = String(error?.message || error).slice(0, 200);
      }
    }
    if (!entity) {
      this.diagnostics.spawnFailures += 1;
      this.diagnostics.lastSpawnError = lastError;
      // Recorded here, explained in chat by reportCreate(): the friendly reason
      // already names this error, so echoing both would only double the panic.
      // `/aibot:test` re-runs the same spawn and prints the raw verdict.
      this.test.error("spawn bot", lastError || "spawnEntity returned nothing", {
        context: `${name} attempted at ${ordered.length} position(s) near ${player.name}`
      });
      return {
        agent: null, created: false,
        reason: `Could not spawn ${BOT_ENTITY_ID}. ${lastError ? `Game said: ${lastError}. ` : ""}`
          + "The scripts are running, so the behavior pack IS active — the entity definition itself was rejected by the game "
          + "(that happens when entities/companion.json declares a format_version the game cannot parse). "
          + "Re-import the latest AI-Bot-Bedrock-Mobile.mcaddon, keep exactly one copy of the pack active, and reload the world."
      };
    }
    try {
      entity.setDynamicProperty("aibot:name", name);
      entity.setDynamicProperty("aibot:owner_id", player.id);
      entity.setDynamicProperty("aibot:owner_name", player.name);
      entity.setDynamicProperty("aibot:home", JSON.stringify(positionArray(player.location)));
      entity.nameTag = name;
    } catch (error) {
      return { agent: null, created: false, reason: `Bot spawned but metadata could not be written: ${String(error).slice(0, 140)}` };
    }
    // If the bot still ended up inside solid blocks (the pocket around the
    // player was built up), relocate it to the nearest standing-open cell so
    // it is actually visible in the world.
    try {
      if (!isSafeCell(entity.dimension, entity.location)) relocateToSafeCell(entity);
    } catch { /* best effort */ }
    const agent = this.register(entity);
    agent.name = name;
    agent.ownerId = player.id;
    agent.ownerName = player.name;
    agent.runtime.home = player.location;
    setBotStatus(entity, BotState.IDLE);
    agent.persist(true);
    const at = `${Math.round(entity.location.x)}, ${Math.round(entity.location.y)}, ${Math.round(entity.location.z)}`;
    // talkHint already names the follow option on this build, so the sentence
    // below must not list it a second time — the old wording read
    // "…use /aibot:follow, or tap AIBot, or use /aibot:follow".
    player.sendMessage(`§a✔ Created ${name}§a, standing at ${at}.§r ${talkHint(this, name)} §7· §e${commandHint(this, "panel")} §7opens the control panel§r`);
    player.sendMessage(`§7If you see the name but no body — or nothing at all — the resource model is missing: open Edit World → Add-Ons, confirm "Autonomous AI Bot - Resources" is active, then reload the world. §r`);
    return { agent, created: true };
  }
  removeByName(player, requestedName = "") {
    const agent = requestedName ? this.byName(requestedName) : this.forPlayer(player);
    if (!agent) return "No bot matched that name.";
    if (!canUseBot(player, agent, agent.config)) return "Permission denied: that bot has a different owner.";
    const name = agent.name;
    try { if (isValidEntity(agent.entity)) agent.entity.remove(); } catch { /* already gone */ }
    this.agents.delete(agent.entity?.id);
    return `§aRemoved ${name}.§r Its tasks and memory are gone; use §e${commandHint(this, `create ${name}`)}§r to start fresh.`;
  }
  infoText() {
    const d = this.diagnostics;
    const bots = this.all().map((agent) => {
      let position = "unknown";
      try {
        if (isValidEntity(agent.entity)) {
          position = `${Math.round(agent.entity.location.x)}, ${Math.round(agent.entity.location.y)}, ${Math.round(agent.entity.location.z)}`;
        }
      } catch { /* entity unloading */ }
      return `  • ${agent.name} — ${readBotStatus(agent.entity).state}, at ${position}, owner ${agent.ownerName || "none"}, entity ${isValidEntity(agent.entity) ? "loaded" : "MISSING"}`;
    }).join("\n") || "  (none loaded)";
    let dimensions = "unknown";
    try { dimensions = DIMENSIONS.map((id) => `${id}:${world.getDimension(id).getEntities({ type: BOT_ENTITY_ID }).length}`).join(" "); } catch { /* dimension query unavailable */ }
    const log = this.test;
    const logged = typeof log?.errorCount === "function" ? log.errorCount() : 0;
    const warned = typeof log?.warnCount === "function" ? log.warnCount() : 0;
    d.errorLog = `${logged} error(s), ${warned} warning(s) — /aibot:debug log`;
    d.testMode = log && log !== SILENT_TEST
      ? (log.enabled ? "ON — new errors appear in chat" : "off — errors are recorded, not echoed (/aibot:debug on)")
      : "not loaded";
    return [
      `§bAI Bot diagnostics§r`,
      `Script: v${d.scriptVersion} (loaded — this message proves the script engine is running)`,
      `Chat event: ${d.chatSource}`,
      `Slash commands: ${d.slashCommands}`,
      `Duplicate packs: ${d.duplicate}`,
      `Scriptevent bridge: ${d.scriptEvent}`,
      `Compass menu event: ${d.itemUseSource || "not reported"}`,
      `Tick loop: ${d.engineStarted ? "running" : "NOT RUNNING"}${d.tickJob ? "" : " (interval job missing)"}`,
      `Entities in world: ${dimensions}`,
      `Registered bots: ${this.all().length}`, bots,
      `Spawn failures: ${d.spawnFailures}${d.lastSpawnError ? ` — last: ${d.lastSpawnError}` : ""}`,
      `Test mode: ${d.testMode}`,
      `Error log: ${d.errorLog}`,
      `§7Bot invisible?§r If a bot above is "loaded" you should at least see its name tag. ` +
        `No body + no name → the entity did not spawn (check the "Entities in world" line). ` +
        `Name but no body → the render model is missing: Edit World → Add-Ons → activate ` +
        `"Autonomous AI Bot - Resources", then reload the world.\n` +
      `§eOr run §f/aibot:test§e — it checks all of this automatically, and §f/aibot:debug on§e streams every error the pack catches.`
    ].join("\n");
  }
  tick() {
    this.tickCount += 1;
    for (const [id, agent] of this.agents) {
      // One agent must never kill the loop for everybody else. Before this, a
      // single throwing bot stopped every other bot in the world and the whole
      // failure was invisible on mobile — the classic "bot frozen" report.
      let outcome = null;
      try {
        outcome = { alive: agent.tick(this.tickCount) };
      } catch (error) {
        this.test.error("bot tick", error, { context: `${agent.name} (agent ${id})` });
      }
      if (outcome === null) {
        // A throwing agent used to be indistinguishable from a dead world: the
        // loop carried on and the bot simply stopped acting. After a second of
        // failures the owner is told, once, instead of on every tick.
        agent.runtime.tickFailures = (agent.runtime.tickFailures || 0) + 1;
        if (agent.runtime.tickFailures === 12) {
          agent.runtime.tickFailures = 0;
          agent.notify(`§c⚠ ${agent.name} keeps failing every tick and is now idle. §f/aibot:debug log §rprints the error, §f/aibot:test §rchecks what is broken.`);
          try { setBotStatus(agent.entity, BotState.ERROR, { target: "script errors — run /aibot:debug log" }); } catch { /* entity gone */ }
        }
      } else {
        if (agent.runtime.tickFailures) agent.runtime.tickFailures = 0;
        if (outcome.alive === false) this.agents.delete(id);
      }
    }
  }
  /**
   * Player-like movement step, driven every game tick from main.js.
   * The 5-tick AI loop above decides WHERE each bot goes; this steers the
   * velocity every tick (accelerate, turn, jump on step-ups, ease to a stop)
   * so the motion looks and feels like a real player instead of a series of
   * impulses. Cheap: one velocity read + one write per bot per tick.
   */
  stepMovement() {
    for (const agent of this.agents.values()) {
      if (!isValidEntity(agent.entity)) continue;
      // Runs every game tick for every bot, so the happy path is a bare
      // try/catch — and repeats are folded by signature. An error here means
      // "the bot is being steered and refuses to move", otherwise invisible.
      try {
        applyPlayerStep(agent.entity);
      } catch (error) {
        this.test.warn("movement step", error, {
          context: `${agent.name} at ${Math.round(agent.entity.location.x)}, ${Math.round(agent.entity.location.y)}, ${Math.round(agent.entity.location.z)}`
        });
      }
    }
  }
  handleDeath(entity) {
    const agent = this.agents.get(entity.id);
    if (!agent) return;
    this.test.warn("bot died", `${agent.name} was killed at ${Math.round(entity.location?.x || 0)}, ${Math.round(entity.location?.y || 0)}, ${Math.round(entity.location?.z || 0)}`, {
      context: "the entity is gone; re-create it with /aibot:create (the task stays in its memory)"
    });
    agent.notify("§cI died. My task remains in memory, but I need to be spawned again.");
    agent.memory.event("Bot died; task state persisted.", "error");
    agent.persist(true);
    this.agents.delete(entity.id);
  }
  names() { return this.all().map((agent) => agent.name); }
  status(player, name) { const agent = this.forPlayer(player, name); return agent?.statusText() || noBotMessage(this); }
  inventory(player, name) { const agent = this.forPlayer(player, name); return agent?.inventoryText() || noBotMessage(this); }
  runNamedCommand(player, name, args) {
    const agent = this.forPlayer(player);
    if (!agent) return noBotMessage(this);
    if (!canUseBot(player, agent, agent.config)) return "Permission denied.";
    const checked = validateNamedCommand(name, args, agent.config);
    if (!checked.ok) return checked.reason;
    const safeSay = args.join(" ").replace(/[\r\n]/g, " ").replace(/[^A-Za-z0-9 _.,!?'-]/g, "").slice(0, 160);
    const commands = { time: `time set ${args[0]}`, weather: `weather ${args[0]}`, say: `say ${safeSay}` };
    try {
      player.dimension.runCommand(commands[checked.command]);
      return `Allowed command executed: ${checked.command}.`;
    } catch (error) {
      // On a world without cheats every script command throws; the log line is
      // the explanation the chat reply alone cannot carry.
      this.test.error("named command", error, {
        context: "script runCommand needs cheats enabled; on this build it may not exist at all"
      });
      return `Command failed: ${String(error?.message || error).slice(0, 160)} §7— also in §f/aibot:debug log§r`;
    }
  }
}
