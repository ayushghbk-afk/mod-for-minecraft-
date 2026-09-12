import { world } from "@minecraft/server";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config.js";
import { ActionEngine } from "./action-engine.js";
import { validatePlan } from "./action-validator.js";
import { makeObservation } from "./observation.js";
import { MemoryStore } from "./memory.js";
import { TaskManager, TaskStatus } from "./task-manager.js";
import { countItem, readInventory } from "./inventory.js";
import { BotState, readBotStatus, setBotStatus } from "./status.js";
import { fallbackPlan, safeFallback } from "./planner.js";
import { providerFor } from "./ai-provider.js";
import { StuckDetector } from "./navigation.js";
import { validateNamedCommand, canUseBot } from "./permissions.js";
import { commandHint, talkHint, noBotMessage } from "./hints.js";

const BOT_ENTITY_ID = "aibot:companion";
const DIMENSIONS = ["overworld", "nether", "the_end"];
const DROP_FOR_BLOCK = Object.freeze({
  "minecraft:iron_ore": "minecraft:raw_iron", "minecraft:gold_ore": "minecraft:raw_gold",
  "minecraft:copper_ore": "minecraft:raw_copper", "minecraft:coal_ore": "minecraft:coal",
  "minecraft:diamond_ore": "minecraft:diamond", "minecraft:redstone_ore": "minecraft:redstone",
  "minecraft:lapis_ore": "minecraft:lapis_lazuli", "minecraft:stone": "minecraft:cobblestone"
});

function positionArray(position) { return [Math.round(position.x), Math.round(position.y), Math.round(position.z)]; }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
function isHostile(type) { return /zombie|skeleton|creeper|spider|witch|enderman|phantom/.test(String(type)); }
function isValidEntity(entity) {
  try { return Boolean(entity && entity.isValid !== false && (!entity.isValid || entity.isValid())); } catch { return false; }
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
      lastAIRequest: "none", lastAIResponse: "none", lastValidation: "not run", lastPlanReason: "none", inventoryFullReturn: false
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
  persist(force = false) {
    if (!force && this.runtime.tick - this.runtime.lastPersistAt < 100) return;
    try {
      this.entity.setDynamicProperty("aibot:tasks", JSON.stringify(this.tasks.snapshot()));
      this.entity.setDynamicProperty("aibot:memory", JSON.stringify(this.memory.snapshot()));
      this.entity.setDynamicProperty("aibot:config", JSON.stringify(this.config));
      if (this.runtime.home) this.entity.setDynamicProperty("aibot:home", JSON.stringify(positionArray(this.runtime.home)));
      this.runtime.lastPersistAt = this.runtime.tick;
    } catch { /* dynamic property writes can fail during entity removal */ }
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
      if (!this.runtime.aiErrorShown && this.config.provider !== "fallback") {
        this.notify("§e⚠ AI unavailable. Using fallback behavior.");
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
    this.notify(`§bTASK CREATED§r ${goal}\nProgress: 0/${target}`);
    this.requestPlan("new player task");
    this.persist(true);
    return task;
  }

  follow() {
    this.runtime.follow = true;
    this.runtime.plan = null;
    this.runtime.planIndex = 0;
    setBotStatus(this.entity, BotState.FOLLOWING, { target: this.ownerName || "owner" });
    this.notify("Following you.");
  }
  stop() {
    this.runtime.follow = false;
    this.runtime.plan = null;
    if (this.tasks.current?.status === TaskStatus.ACTIVE) this.tasks.pause("Stopped by player.");
    setBotStatus(this.entity, BotState.IDLE);
    this.notify("Stopped. The current task is paused.");
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
    this.notify("Defending you.");
  }
  returnHome() {
    this.runtime.follow = false;
    this.runtime.plan = { goal: "Return to owner", thought: "Deterministic return.", actions: [{ type: "return_home" }] };
    this.runtime.planIndex = 0;
    this.runtime.returningAfterTask = false;
  }
  cancel() {
    this.tasks.cancel();
    this.runtime.plan = null;
    this.runtime.follow = false;
    setBotStatus(this.entity, BotState.IDLE);
    this.memory.event("Current task cancelled.");
    this.notify("Task cancelled.");
    this.persist(true);
  }

  findThreat() {
    if (this.config.combatMode === "passive") return null;
    const owner = this.owner();
    try {
      const origins = this.config.combatMode === "defend_owner" && owner ? [owner.location, this.entity.location] : [this.entity.location];
      const candidates = new Set();
      for (const origin of origins) {
        for (const candidate of this.entity.dimension.getEntities({ location: origin, maxDistance: this.config.combatMode === "defend_owner" ? 10 : 7 })) {
          if (isHostile(candidate.typeId)) candidates.add(candidate);
        }
      }
      return [...candidates].sort((a, b) => distance(this.entity.location, a.location) - distance(this.entity.location, b.location))[0] || null;
    } catch { return null; }
  }

  handleCombat() {
    const target = isValidEntity(this.runtime.combatTarget) ? this.runtime.combatTarget : this.findThreat();
    if (!target) {
      if (this.runtime.combatTarget) {
        this.runtime.combatTarget = null;
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
      this.notify(`§c⚠ ${target.typeId} detected. Task paused.`);
    }
    this.runtime.combatTarget = target;
    this.engine.execute({ type: "attack_entity" });
    try {
      const health = target.getComponent("minecraft:health");
      if (health && health.currentValue <= 0) {
        this.runtime.combatTarget = null;
        this.runtime.entityTarget = null;
        if (this.tasks.current?.status === TaskStatus.PAUSED) {
          this.tasks.resume();
          this.memory.event("Combat completed; task resumed.", "combat");
          this.notify(`§a✓ Threat defeated.§r Resuming task. Progress: ${this.progressText()}`);
        }
      }
    } catch { /* next observation will clear a removed entity */ }
    return true;
  }

  executePlan() {
    const plan = this.runtime.plan;
    if (!plan || this.runtime.planIndex >= plan.actions.length) {
      this.runtime.plan = null;
      return;
    }
    const action = plan.actions[this.runtime.planIndex];
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
    if (!isValidEntity(this.entity)) return false;
    this.runtime.tick = tick;
    if (tick % Math.max(10, this.config.observationIntervalTicks) === 0 || !this.observation) {
      this.observation = makeObservation(this.entity, this.tasks.current, this.memory, this.config);
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
    if (this.handleCombat()) { this.persist(); return true; }
    if (this.runtime.follow && (!this.tasks.current || this.tasks.current.status !== TaskStatus.ACTIVE)) {
      this.engine.execute({ type: "follow_player" });
    }
    if (this.runtime.returningAfterTask && !this.runtime.plan) {
      this.runtime.plan = { goal: "Return to player", thought: "Returning after verified task.", actions: [{ type: "return_home" }] };
      this.runtime.planIndex = 0;
    }
    if (this.tasks.current?.status === TaskStatus.ACTIVE && !this.runtime.plan && !this.runtime.planning) this.requestPlan("task needs an action");
    if (this.runtime.plan) {
      const before = this.entity.location;
      this.executePlan();
      const target = this.runtime.targetBlock || this.runtime.targetPosition;
      const stuck = this.runtime.stuck.update(this.entity.location, target);
      if (stuck.stuck && stuck.attempts > 3) {
        this.runtime.plan = null;
        this.runtime.targetBlock = null;
        this.tasks.fail("Target unreachable after path recovery attempts.");
        this.notify("§cTarget unreachable.§r Task failed after safe recovery attempts.");
        setBotStatus(this.entity, BotState.ERROR, { target: "unreachable" });
      }
      void before;
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
    return `${this.name}\nStatus: ${status.state}${status.block ? ` ${status.block}` : ""}\nTask: ${task?.goal || "None"}\nProgress: ${task ? `${task.progress}/${task.target}` : "-"}\nHealth: ${health ? `${Math.ceil(health.currentValue)}/${Math.ceil(health.effectiveMax ?? health.defaultValue ?? 20)}` : "unknown"}\nInventory: ${inventory.slots.length}/${inventory.size}\nAI: ${this.config.provider === "fallback" ? "fallback" : (this.runtime.aiErrorShown ? "unavailable / fallback" : this.config.provider)}`;
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
      `MEMORY EVENTS: ${this.memory.snapshot().shortTerm.length}`
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
    /** Filled in by main.js so `!aibot info` can explain a silent failure. */
    this.diagnostics = {
      scriptVersion: "unknown", chatSource: "unbound", itemUseSource: "unbound",
      slashCommands: "unknown (startup event has not fired yet)", scriptEvent: "unbound",
      engineStarted: false, tickJob: false, spawnFailures: 0, lastSpawnError: "",
      duplicate: "not checked yet"
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
    let entity = null;
    let lastError = "";
    for (const candidate of this.spawnLocation(player)) {
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
      return {
        agent: null, created: false,
        reason: `Could not spawn ${BOT_ENTITY_ID}. ${lastError ? `Game said: ${lastError}. ` : ""}`
          + "This almost always means the AI Bot behavior pack is not active on this world, or the world was created before the pack was added."
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
    const agent = this.register(entity);
    agent.name = name;
    agent.ownerId = player.id;
    agent.ownerName = player.name;
    agent.runtime.home = player.location;
    setBotStatus(entity, BotState.IDLE);
    agent.persist(true);
    player.sendMessage(`§a✔ Created ${name}§a.§r Use §e${commandHint(this, "panel")}§r, §e${commandHint(this, "follow")}§r, or ${talkHint(this, name)}.`);
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
    const bots = this.all().map((agent) => `  • ${agent.name} — ${readBotStatus(agent.entity).state}, owner ${agent.ownerName || "none"}, entity ${isValidEntity(agent.entity) ? "loaded" : "MISSING"}`).join("\n") || "  (none loaded)";
    let dimensions = "unknown";
    try { dimensions = DIMENSIONS.map((id) => `${id}:${world.getDimension(id).getEntities({ type: BOT_ENTITY_ID }).length}`).join(" "); } catch { /* dimension query unavailable */ }
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
      `Spawn failures: ${d.spawnFailures}${d.lastSpawnError ? ` — last: ${d.lastSpawnError}` : ""}`
    ].join("\n");
  }
  tick() {
    this.tickCount += 1;
    for (const [id, agent] of this.agents) {
      if (!agent.tick(this.tickCount)) this.agents.delete(id);
    }
  }
  handleDeath(entity) {
    const agent = this.agents.get(entity.id);
    if (!agent) return;
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
    try { player.dimension.runCommand(commands[checked.command]); return `Allowed command executed: ${checked.command}.`; } catch (error) { return `Command failed: ${String(error)}`; }
  }
}
