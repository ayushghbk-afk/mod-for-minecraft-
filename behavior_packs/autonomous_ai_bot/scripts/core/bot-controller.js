import { world } from "@minecraft/server";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config.js";
import { ActionEngine } from "./action-engine.js";
import { ALLOWED_BLOCKS, validatePlan } from "./action-validator.js";
import { parseItemRequest } from "./intent-parser.js";
import { HINT_FOR_BLOCK, isCreeperType, isHostileType, makeObservation, observedCount } from "./observation.js";
import { MemoryStore } from "./memory.js";
import { TaskManager, TaskStatus, taskKey } from "./task-manager.js";
import { countItem, equipItem, FOOD_ITEMS, itemName, pickupNearbyItems, readInventory, tryEatBestFood, useItem } from "./inventory.js";
import { BotState, readBotStatus, setBotStatus } from "./status.js";
import { fallbackPlan, safeFallback } from "./planner.js";
import { providerFor } from "./ai-provider.js";
import { describeTopic, replyToMessage } from "./chat-brain.js";
import { applyPlayerStep, clearRoute, isSafeCell, StuckDetector, stopEntity } from "./navigation.js";
import { validateNamedCommand, canUseBot } from "./permissions.js";
import { chatAvailable, commandHint, talkHint, noBotMessage } from "./hints.js";
import { assess, Behavior, evaluateCommand, HEALTH, priorityName, Priority } from "./priority.js";
import { explainFailure, Reporter } from "./reporter.js";
import { chooseTool, chooseWeapon, toolGapMessage } from "./tools.js";

const BOT_ENTITY_ID = "aibot:companion";
/**
 * AC-09 follow ladder, in ticks (20/s). Sidesteps are spaced so the bot has
 * time to actually walk the detour before the next one is chosen; the give-up
 * report comes ~18 s in, which is long enough to be sure and short enough that
 * a player is not left wondering whether the mod died.
 */
const FOLLOW_SIDESTEPS = [40, 120, 200, 280];
const FOLLOW_GIVE_UP_TICKS = 360;
/**
 * How many places a bot looks before it admits defeat (AC-13/AC-32). Eight is
 * the point where the rings it walks (10, 14, 18 … blocks out) cover roughly
 * the 32-block observation span twice over, so "not here" is a real answer and
 * not an early one. Bounded on purpose: an unbounded search is the loop the old
 * re-plan-on-failure code produced.
 */
const MAX_SEARCH_ATTEMPTS = 8;
/** Golden angle in radians — each search ring points somewhere genuinely new. */
const SEARCH_TURN = 2.399963229728653;
/** A task that never gains progress after this many plan cycles is failed. */
const MAX_PROGRESSLESS_CYCLES = 6;
/**
 * Blocks the bot is allowed to break. It is the SAME allowlist the AI plan
 * validator enforces (AC-39/AC-40): one list, so a player command can never
 * target something an AI plan could not, and neither can ever reach bedrock, a
 * command block or a player's build.
 */
const ALLOWED_MINE_BLOCKS = ALLOWED_BLOCKS;
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
/** One classifier for the whole pack — see observation.isHostileType (AC-22). */
const isHostile = isHostileType;
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
    /**
     * Chat reporting (AC-31/AC-32). One reporter per bot: two bots must not
     * share a throttle, or the second bot's progress lines get swallowed.
     */
    this.reporter = new Reporter(this);
    this.runtime = {
      plan: null, planIndex: 0, targetBlock: null, targetPosition: null, entityTarget: null,
      combatTarget: null, chest: null, follow: false, home: this.readPosition(),
      lastPlanAt: 0, planning: null, planFailures: 0, lastMinedKey: "", lastMinedAt: 0,
      lastAttackAt: 0, returningAfterTask: false, stuck: new StuckDetector(), exploreTarget: null,
      aiErrorShown: false, lastPersistAt: 0, tick: 0, lastAction: null, lastPlan: null,
      lastAIRequest: "none", lastAIResponse: "none", lastValidation: "not run", lastPlanReason: "none", inventoryFullReturn: false,
      tickFailures: 0, lastFollowResult: "not running",
      // --- priority / survival bookkeeping (AC-20, AC-21, AC-25, AC-29) ---
      /** @type {{level:number,name:string,behavior:string,reason:string,threat?:any,candidates?:any[]}} */
      priority: { level: Priority.IDLE, name: "IDLE", behavior: Behavior.IDLE, reason: "no decision yet" },
      cameTo: null, lastCommandVerdict: "none", needsObservation: false,
      searchAttempts: 0, searchOrigin: null, searchBlock: "", noProgressCycles: 0,
      followDetour: null, followBlocked: 0,
      lastEatAttempt: 0, noFoodReported: false, survivalSince: 0, survivalReason: "",
      resumedFromSurvival: false, lastCombatNote: "", lastWeapon: "", lastToolUsed: "", lastToolIssue: "",
      // --- AC-28: what the interrupted task was, so it can be resumed or
      //     explicitly abandoned with a reason instead of silently vanishing.
      interruption: null,
      // --- AC-41: per-bot cost counters, reported by /aibot:info.
      scans: 0, scannedCells: 0, scannedEntities: 0, scanMs: 0, chatLines: 0, replans: 0,
      /** AC-45: the last thing the player asked and what the bot answered. */
      lastChat: null, chatProviderDownUntil: 0
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
    this.runtime.chatLines += 1;
    for (const target of targets) {
      try { target.sendMessage(text); } catch { /* left */ }
    }
  }

  /**
   * AC-45: everything the conversation engine is allowed to say, read live.
   *
   * The brain receives data, never promises. When the observation has not run
   * yet, the fields are simply absent and it answers "I don't have a clean
   * reading for that" — which is what makes "the bot claimed it saw diamond"
   * impossible. Nothing here writes to the world.
   */
  chatContext(player = null) {
    const observation = this.observation;
    const status = readBotStatus(this.entity);
    const task = this.tasks.current;
    const inventory = readInventory(this.entity);
    const health = this.healthSnapshot();
    const owner = this.owner();
    const speaker = player || owner;
    const chatOn = chatAvailable(this.controller);
    const talkHow = chatOn
      ? `say "§f${this.name}§e, <words>" in chat`
      : "§f/aibot:talk <words>§e, or the §fTalk§e button on my panel";
    let location = null;
    try { location = this.entity.location; } catch { /* entity unloaded */ }
    const position = location ? [Math.floor(location.x), Math.floor(location.y), Math.floor(location.z)] : null;
    let ownerDistance = observation?.owner?.distance;
    let ownerDirection = observation?.owner?.direction?.compass;
    if (ownerDistance === undefined && speaker?.location && location) {
      try {
        ownerDistance = Math.hypot(speaker.location.x - location.x, speaker.location.y - location.y, speaker.location.z - location.z);
      } catch { ownerDistance = undefined; }
    }
    const food = inventory.slots
      .filter((item) => FOOD_ITEMS.some(([foodId]) => foodId === item.id))
      .map((item) => item.name)
      .slice(0, 3);
    return {
      botName: this.name,
      playerName: speaker?.name || this.ownerName || "",
      personality: this.config.personality,
      turn: this.runtime.tick,
      state: status.state,
      task: task ? {
        goal: task.goal, progress: task.progress, target: task.target, remaining: task.remaining,
        status: task.status, block: task.block, interruption: task.interruption?.reason || ""
      } : null,
      health,
      inventory: inventory.summary,
      freeSlots: inventory.freeSlots,
      food,
      position,
      dimension: (() => { try { return this.entity.dimension.id; } catch { return ""; } })(),
      home: this.runtime.home ? positionArray(this.runtime.home) : null,
      ownerDistance,
      ownerDirection,
      threats: (observation?.threats || []).slice(0, 3).map((threat) => ({ type: threat.type, name: threat.name, distance: threat.distance })),
      danger: observation?.danger === true,
      follow: Boolean(this.runtime.follow),
      followVerdict: this.runtime.lastFollowResult,
      priorityReason: this.runtime.priority?.reason || "",
      timeOfDay: (() => { try { return world.getTimeOfDay(); } catch { return undefined; } })(),
      providerModel: this.config.model || "",
      providerConfigured: this.config.provider !== "fallback",
      // A phone's Script API has no fetch; only a host bridge does. Telling a
      // player "the AI is thinking" on a build that cannot reach the network
      // would be the same lie the chat hints exist to prevent.
      providerReachable: typeof globalThis.fetch === "function",
      chatAvailable: chatOn,
      talkHow,
      lastTopic: this.runtime.lastChat?.topic || "",
      lastReplyTo: this.runtime.lastChat?.asked || ""
    };
  }

  /**
   * Whether a spoken line may be handed to a configured provider: only when one
   * is configured, this host really has an HTTP transport, and the last attempt
   * did not just fail. A phone fails all three (no fetch at all), which is why
   * the bot's conversation is local there.
   */
  chatProviderUsable() {
    if (this.config.provider === "fallback") return false;
    if (typeof globalThis.fetch !== "function") return false;
    return Date.now() >= Number(this.runtime.chatProviderDownUntil || 0);
  }

  /** Remember an informational answer, so the Talk box can show the exchange. */
  noteAnswer(asked, reply, topic) {
    this.runtime.lastChat = { asked: String(asked || "").slice(0, 200), reply: String(reply || ""), topic: topic || "status", source: "local", at: Date.now(), turn: this.runtime.tick };
  }

  /** Remember that the player's last line became an order, for reply continuity. */
  noteOrder(words) {
    this.runtime.lastChat = { asked: String(words || "").slice(0, 200), reply: "", topic: "orders", source: "order", at: Date.now(), turn: this.runtime.tick };
  }

  /**
   * Handle one free-form line directed at this bot (AC-45).
   *
   * A host provider is asked only when this host genuinely has an HTTP
   * transport (a bridge or a dedicated server — a phone has none, and pretending
   * otherwise is how "the bot never answers" used to happen). Everything else is
   * answered locally by core/chat-brain.js from live data, so the bot says
   * something true and specific instead of one canned sentence.
   */
  async chatWith(player, message) {
    const asked = String(message || "").trim();
    this.memory.playerRequest(asked || "(empty)");
    const context = this.chatContext(player);
    // The player's words are shown to the provider as data and nothing else:
    // no reply can become an action, and the deterministic engine still decides
    // everything the bot actually does.
    const local = replyToMessage(asked, context);
    let reply = local.reply;
    let source = "local";
    let topic = local.topic;
    // A model may colour in what the bot cannot answer from its own sensors —
    // never the things it can. "Where are you" must come from the live position,
    // not from a language model's imagination, and it must not wait on a socket
    // either (AC-45). Only small talk and unanswerable questions consult a
    // provider, and only on a host that really has one.
    if (asked && (local.topic === "question" || local.topic === "smalltalk") && this.chatProviderUsable()) {
      try {
        const provider = providerFor(this.config);
        if (provider?.generateChatReply) {
          // A host bridge that hangs must not leave the player without an
          // answer: the local reply is already in hand, so it is used if the
          // model is slow. `setTimeout` is not part of the script runtime on
          // every build, so the deadline is only raced in when it exists —
          // otherwise the provider's own timeout is the only one.
          const pending = provider.generateChatReply(asked, this.observation, this.memory.promptContext(this.tasks.current));
          const deadline = typeof setTimeout === "function"
            ? new Promise((resolve) => setTimeout(() => resolve(""), 2500))
            : null;
          const spoken = String(await (deadline ? Promise.race([pending, deadline]) : pending) || "").trim();
          if (spoken) { reply = spoken; source = "provider"; topic = ""; }
        }
      } catch (error) {
        // Recorded, never shown: a provider that is down must not become a bot
        // that is down. The local answer above stands, and the failure is not
        // retried on every line the player types.
        this.runtime.chatProviderDownUntil = Date.now() + 60000;
        this.test.warn("chat provider", String(error?.message || error).slice(0, 160), { context: `${this.name} answering "${asked.slice(0, 40)}"` });
      }
    }
    this.runtime.lastChat = { asked: asked.slice(0, 200), reply, topic: topic || "provider", source, at: Date.now(), turn: this.runtime.tick };
    this.memory.event(`answered: ${describeTopic(topic || "provider")}`, "chat");
    this.say(reply, player);
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

  /**
   * Create (or refuse) a collection objective — AC-04, AC-19, AC-27.
   *
   * `target` is an ABSOLUTE inventory count: asking for 16 oak logs while
   * holding 12 produces "12/16, still needed: 4", not a hunt for 16 more.
   * Asking for something already held completes immediately instead of sending
   * the bot out for a pointless trip, and asking for the same objective that is
   * already finished is reported as finished rather than recreated.
   *
   * @param {string} block a Bedrock block id, e.g. "minecraft:oak_log"
   * @param {number} target how many of the resulting item the bot should hold
   * @param {string} [goal] the sentence shown to the player
   * @param {{kind?: string, silent?: boolean}} [options]
   */
  createCollectTask(block, target, goal, options = {}) {
    const kind = options.kind || "collect";
    const item = DROP_FOR_BLOCK[block] || block;
    const held = countItem(this.entity, item);
    const wanted = Math.max(1, Math.min(64, Number(target) || 1));
    const title = goal || `Collect ${wanted} ${item.replace(/^minecraft:/, "").replace(/_/g, " ")}`;
    const key = taskKey({ kind, block, target: wanted });

    // AC-19: the requirement is already satisfied. Say so with the real number
    // instead of creating work, and remember it so the same order is not
    // quietly re-run (AC-27).
    if (held >= wanted) {
      const task = this.tasks.create({ goal: title, kind, block, target: wanted, startingCount: held });
      this.memory.playerRequest(title);
      this.memory.archiveTask(task);
      this.memory.fact(`Already holding ${held} ${item.replace(/^minecraft:/, "").replace(/_/g, " ")} — "${title}" needed nothing.`);
      this.memory.event(`Task "${title}" complete on arrival: already holding ${held}/${wanted}.`);
      this.runtime.follow = false;
      this.runtime.plan = null;
      this.runtime.targetBlock = null;
      setBotStatus(this.entity, BotState.IDLE);
      this.reporter.reset();
      this.say(`§aI already have ${held}/${wanted} ${item.replace(/^minecraft:/, "").replace(/_/g, " ")}§r — nothing to collect.`);
      this.persist(true);
      return task;
    }

    // AC-27: an objective that was already finished is remembered and named.
    // The order still runs — the player may have spent the items and genuinely
    // wants another batch — but it is acknowledged rather than silently re-run,
    // which is the difference between a bot that remembers and one that does not.
    const repeated = this.tasks.isRepeatOfCompleted({ kind, block, target: wanted });

    const task = this.tasks.create({ goal: title, kind, block, target: wanted, startingCount: held, priority: Priority.PLAYER_COMMAND });
    this.memory.playerRequest(title);
    if (repeated) this.memory.event(`Repeat order: "${title}" was completed before; running it again.`, "task");
    this.memory.event(`Task created: ${title} (holding ${held}/${wanted})`);
    this.runtime.follow = false;
    this.runtime.returningAfterTask = false;
    this.runtime.plan = null;
    this.runtime.targetBlock = null;
    this.runtime.planFailures = 0;
    this.runtime.noProgressCycles = 0;
    this.runtime.searchAttempts = 0;
    this.runtime.searchOrigin = null;
    this.runtime.searchBlock = "";
    this.runtime.interruption = null;
    this.runtime.replans = 0;
    this.runtime.stuck.reset();
    this.reporter.reset();

    // AC-04: the objective card, so the player can see the task is persistent
    // and identifiable rather than a vague acknowledgement.
    const seen = observedCount(this.observation, block);
    this.say([
      "§aOn it.§r",
      this.tasks.describe().replace(/\n/g, "\n§7"),
      `§7Holding now: ${held} · still needed: ${wanted - held}${seen ? ` · ${seen} visible nearby` : " · none visible yet, I'll search"}.`,
      repeated ? "§7(Done this one before — doing it again.)" : ""
    ].filter(Boolean).join("\n"));
    this.reporter.progress({ progress: task.progress, target: task.target, block: item, force: true });
    setBotStatus(this.entity, BotState.THINKING, { target: title });
    this.requestPlan("new player task");
    this.persist(true);
    return task;
  }

  /**
   * `/bot mine stone` — AC-14. Mining is a collection task whose item is the
   * block's drop, plus an up-front tool check so an impossible request is
   * refused in words instead of failing four times silently.
   */
  mineTask(block, target = 8, goal = "") {
    const id = String(block || "").toLowerCase();
    const normalised = id.includes(":") ? id : `minecraft:${id}`;
    const item = DROP_FOR_BLOCK[normalised] || normalised;
    const heldIds = readInventory(this.entity).slots.map((entry) => entry.id);
    const choice = chooseTool(normalised, heldIds);
    const title = goal || `Mine ${target} ${normalised.replace(/^minecraft:/, "").replace(/_/g, " ")}`;
    if (!choice.meetsRequirement) {
      const message = toolGapMessage(normalised, choice) || `I need a better ${choice.family} for that.`;
      this.memory.event(`Refused "${title}": ${message}`, "error");
      this.say(`§c${message}§r`);
      return null;
    }
    return this.createCollectTask(normalised, target, title, { kind: "mine" });
  }

  /** AC-04/AC-34: the objective card plus the live reason for the current state. */
  taskText() {
    const task = this.tasks.current;
    const lines = [this.tasks.describe()];
    if (task) {
      const item = DROP_FOR_BLOCK[task.block] || task.block;
      lines.push(`Holding: ${countItem(this.entity, item)} ${String(item || "").replace(/^minecraft:/, "")}`);
      lines.push(`Priority: ${this.runtime.priority.name} (${this.runtime.priority.behavior}) — ${this.runtime.priority.reason}`);
      if (task.status === TaskStatus.PAUSED && this.runtime.interruption) lines.push(`Will resume after: ${this.runtime.interruption}`);
      if (this.runtime.lastToolIssue) lines.push(`Tool: ${this.runtime.lastToolIssue}`);
      if (this.runtime.lastAction) lines.push(`Last action: ${this.runtime.lastAction.action} → ${this.runtime.lastAction.success ? "ok" : (this.runtime.lastAction.reason || "failed")}`);
    }
    const done = this.memory.snapshot().completedTasks.slice(-3).map((entry) => `${entry.goal} (${entry.progress}/${entry.target})`);
    if (done.length) lines.push(`Recently finished: ${done.join(", ")}`);
    return lines.join("\n");
  }

  /**
   * Eat on request (and the fallback half of AC-21): try once, report the
   * outcome, and never retry in a loop. With no food the bot says so and keeps
   * doing whatever it was doing at a safer distance.
   */
  eatOnDemand(player = null) {
    const health = this.healthSnapshot();
    if (!this.hasFood()) {
      this.runtime.noFoodReported = true;
      this.memory.fact("No food in inventory — cannot self-heal.");
      this.say(`§cI have no food§r (${Math.ceil(health.current)}/${Math.ceil(health.max)} HP). Drop me something edible and I'll recover on my own.`, player);
      return { success: false, reason: "No food in inventory." };
    }
    this.runtime.lastEatAttempt = Date.now();
    const ate = tryEatBestFood(this.entity);
    if (ate.success) {
      this.runtime.noFoodReported = false;
      setBotStatus(this.entity, BotState.EATING, { target: ate.used });
      this.memory.event(`Ate ${ate.used} on request at ${Math.ceil(health.current)}/${Math.ceil(health.max)} health.`, "recovery");
      this.say(`§eAte ${String(ate.used).replace(/^minecraft:/, "").replace(/_/g, " ")}.§r`, player);
      return ate;
    }
    this.say(`I couldn't eat: ${ate.reason || "not hungry enough"}.`, player);
    return ate;
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

  /**
   * AC-30: every player directive goes through this first. It returns the
   * verdict (interrupt or not) and records it, so the bot can *explain* why it
   * ignored or replaced what it was doing instead of looking arbitrary.
   */
  evaluatePlayerCommand(command, { announce = true } = {}) {
    const verdict = evaluateCommand(command, this.runtime.priority);
    this.runtime.lastCommandVerdict = `${command}: ${verdict.reason}`;
    this.memory.event(`Command "${command}" — ${verdict.reason}`, "command");
    if (announce && !verdict.interrupt && verdict.kind === "directive") {
      this.say(`§eNot yet§r — ${verdict.reason}.`);
    }
    return verdict;
  }

  follow() {
    const verdict = this.evaluatePlayerCommand("follow", { announce: false });
    if (!verdict.interrupt) return verdict;
    this.runtime.follow = true;
    this.runtime.followDetour = null;
    this.runtime.followBlocked = 0;
    this.runtime.plan = null;
    this.runtime.planIndex = 0;
    this.runtime.interruption = null;
    this.runtime.stuck.reset();
    // A follow order supersedes an active collection task, and the player is
    // told the task is paused rather than watching it disappear (AC-28).
    if (this.tasks.current?.status === TaskStatus.ACTIVE) {
      this.tasks.pause("Player asked me to follow.");
      this.runtime.interruption = "follow order";
      this.say(`Following you. Task paused at ${this.progressText()} — say "resume" to finish it.`);
    } else {
      this.say("Following you.");
    }
    setBotStatus(this.entity, BotState.FOLLOWING, { target: this.ownerName || "owner" });
    this.persist(true);
    return verdict;
  }

  stop() {
    this.evaluatePlayerCommand("stop", { announce: false });
    this.runtime.follow = false;
    this.runtime.plan = null;
    this.runtime.planIndex = 0;
    this.runtime.combatTarget = null;
    this.runtime.entityTarget = null;
    this.runtime.targetBlock = null;
    this.runtime.exploreTarget = null;
    this.runtime.followDetour = null;
    this.runtime.followBlocked = 0;
    // Without this the tick loop re-created the "Return to player" plan on the
    // very next run: the bot said "Stopped. I'm standing by." and then walked
    // off, because finishing a task had armed the return-home flag and stop()
    // only disarmed the plan it could see (AC-33/AC-44).
    this.runtime.returningAfterTask = false;
    this.runtime.stuck.reset();
    stopEntity(this.entity);
    try {
      if (typeof this.entity.setProperty === "function") this.entity.setProperty("aibot:attacking", false);
    } catch { /* optional */ }
    const task = this.tasks.current;
    // AC-33: stop must immediately end the *acting*, and it must be obvious
    // afterwards what state the task is in. Progress is preserved (AC-26) and
    // the player is told how to continue or drop it.
    if (task?.status === TaskStatus.ACTIVE || task?.status === TaskStatus.PAUSED) {
      this.tasks.pause("Stopped by player.");
      this.runtime.interruption = "player stop";
      setBotStatus(this.entity, BotState.IDLE);
      this.say(`Stopped. Task paused at ${this.progressText()} — §f${commandHint(this.controller, "resume")}§r continues it, §f${commandHint(this.controller, "cancel")}§r drops it.`);
    } else {
      setBotStatus(this.entity, BotState.IDLE);
      this.say("Stopped. I'm standing by.");
    }
    this.memory.event("Stopped by player; task state preserved.", "command");
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
    this.evaluatePlayerCommand("protect", { announce: false });
    this.runtime.follow = false;
    this.config.combatMode = "defend_owner";
    this.runtime.plan = { goal: "Defend owner", thought: "Deterministic threat response.", actions: [{ type: "defend_player" }] };
    this.runtime.planIndex = 0;
    setBotStatus(this.entity, BotState.DEFENDING, { target: this.ownerName || "owner" });
    this.say("Defending you. I'll path to hostiles and fight.");
  }
  returnHome() {
    this.evaluatePlayerCommand("come", { announce: false });
    this.runtime.follow = false;
    this.runtime.plan = { goal: "Return to owner", thought: "Deterministic return.", actions: [{ type: "return_home" }] };
    this.runtime.planIndex = 0;
    this.runtime.returningAfterTask = false;
    // A "come here" order outranks a collection task; the task is parked with a
    // reason rather than dropped, so progress survives the walk back (AC-28).
    if (this.tasks.current?.status === TaskStatus.ACTIVE) {
      this.tasks.pause("Player called me back.");
      this.runtime.interruption = "come/return order";
      this.say(`Coming back to you. Task paused at ${this.progressText()}.`);
    } else {
      this.say("Coming back to you.");
    }
    const owner = this.owner();
    if (owner) this.runtime.home = owner.location;
    this.persist(true);
  }

  /**
   * AC-36 `/bot come`: walk to the player who asked. Identical mechanics to
   * return_home, but the destination is the *requesting* player (who may not be
   * the owner when ownerOnly is off) and the target is refreshed as they move.
   */
  comeTo(player) {
    const who = player && player.typeId === "minecraft:player" ? player : this.owner();
    if (!who) {
      this.say("I can't see you — come closer and ask again.");
      return false;
    }
    this.evaluatePlayerCommand("come", { announce: false });
    this.runtime.follow = false;
    this.runtime.returningAfterTask = false;
    this.runtime.cameTo = { id: String(who.id), name: String(who.name || "") };
    this.runtime.plan = { goal: `Come to ${who.name || "player"}`, thought: "Player asked me to come.", actions: [{ type: "return_home" }] };
    this.runtime.planIndex = 0;
    this.runtime.home = who.location;
    if (this.tasks.current?.status === TaskStatus.ACTIVE) {
      this.tasks.pause("Player called me over.");
      this.runtime.interruption = "come order";
    }
    setBotStatus(this.entity, BotState.RETURNING, { target: who.name || "player" });
    const pausedAt = this.progressText();
    this.say(`Coming to you${pausedAt ? ` — task paused at ${pausedAt}` : ""}.`);
    this.persist(true);
    return true;
  }
  cancel() {
    this.evaluatePlayerCommand("cancel", { announce: false });
    const task = this.tasks.current;
    this.tasks.cancel();
    this.runtime.plan = null;
    this.runtime.planIndex = 0;
    this.runtime.follow = false;
    this.runtime.combatTarget = null;
    this.runtime.entityTarget = null;
    this.runtime.targetBlock = null;
    this.runtime.exploreTarget = null;
    this.runtime.followDetour = null;
    this.runtime.followBlocked = 0;
    this.runtime.returningAfterTask = false;
    this.runtime.stuck.reset();
    stopEntity(this.entity);
    setBotStatus(this.entity, BotState.IDLE);
    this.memory.event(`Task cancelled${task ? `: ${task.goal} at ${task.progress}/${task.target}` : ""}.`, "command");
    this.runtime.interruption = null;
    this.reporter.reset();
    this.say(`Task cancelled${task ? ` at ${task.progress}/${task.target}` : ""}. I'm idle.`);
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

  /** Health as a plain {current,max} pair the priority system can read. */
  healthSnapshot() {
    try {
      const health = this.entity.getComponent("minecraft:health");
      if (!health) return { current: 20, max: 20 };
      const max = Number(health.effectiveMax ?? health.defaultValue ?? 20) || 20;
      return { current: Number(health.currentValue ?? max), max };
    } catch { return { current: 20, max: 20 }; }
  }

  /** True when the bot is carrying anything edible (AC-20/AC-21). */
  hasFood() {
    try {
      const held = readInventory(this.entity).slots.map((item) => item.id);
      return FOOD_ITEMS.some(([id]) => held.includes(id));
    } catch { return false; }
  }

  /**
   * Threats as the priority system wants them: nearest first, from the LAST
   * OBSERVATION only (AC-13 — no threat that was not actually seen).
   */
  threatList() {
    const threats = this.observation?.threats || [];
    return threats.map((threat) => ({ typeId: threat.type, distance: threat.distance, creeper: threat.creeper, id: threat.id }));
  }

  /**
   * Enter survival mode once: pause the task with a reason the player can see
   * (AC-20, AC-28) instead of letting the task silently rot while the bot runs.
   */
  enterSurvival(reason) {
    if (this.runtime.survivalSince) {
      this.runtime.survivalReason = reason;
      return false;
    }
    this.runtime.survivalSince = Date.now();
    this.runtime.survivalReason = reason;
    const task = this.tasks.current;
    if (task?.status === TaskStatus.ACTIVE) {
      this.tasks.pause(`Survival: ${reason}`);
      this.runtime.interruption = `survival (${reason})`;
      this.runtime.plan = null;
      this.runtime.targetBlock = null;
      this.memory.event(`Task paused for survival: ${reason} (progress ${task.progress}/${task.target} kept)`, "recovery");
      this.reporter.event("survival", `§c⚠ ${reason[0].toUpperCase()}${reason.slice(1)} — task paused at ${task.progress}/${task.target}.§r`);
    }
    return true;
  }

  /**
   * Leave survival mode: resume exactly what was interrupted, or say why it was
   * abandoned (AC-28 wants an intentional state, never a randomly lost one).
   */
  exitSurvival() {
    if (!this.runtime.survivalSince) return false;
    const seconds = Math.round((Date.now() - this.runtime.survivalSince) / 1000);
    this.runtime.survivalSince = 0;
    this.runtime.survivalReason = "";
    const task = this.tasks.current;
    if (task?.status === TaskStatus.PAUSED && /^Survival:/.test(String(task.interruption?.reason || ""))) {
      if (this.entityInventoryIsFull()) {
        this.memory.event(`Survival over, but the inventory is still full — task stays paused.`, "recovery");
        this.reporter.event("resume-blocked", "§eI'm safe again, but my inventory is full — store items and tell me to resume.§r");
        return true;
      }
      this.tasks.resume();
      this.runtime.interruption = null;
      this.runtime.plan = null;
      this.runtime.targetBlock = null;
      this.memory.event(`Survival ended after ${seconds}s; resuming "${task.goal}" at ${task.progress}/${task.target}.`, "recovery");
      this.reporter.event("resume", `§aSafe again — resuming ${task.goal} at ${task.progress}/${task.target}.§r`);
      this.requestPlan("resumed after survival");
      this.persist(true);
    }
    return true;
  }

  /**
   * AC-20 / AC-21 / AC-25 — survival beats every ordinary task.
   * Returns true when survival consumed this tick.
   */
  handleSurvival(decision) {
    const health = this.healthSnapshot();
    const max = health.max || 20;

    if (decision.behavior === Behavior.FLEE) {
      const threat = decision.threat || this.threatList()[0] || null;
      const why = threat ? `fleeing ${String(threat.typeId).replace("minecraft:", "")}` : "fleeing danger";
      this.enterSurvival(why);
      const source = threat ? this.resolveEntity(threat.id) : null;
      const from = source?.location || this.entity.location;
      // Run directly away, far enough that a re-plan is worth doing.
      const away = {
        x: this.entity.location.x + (this.entity.location.x - from.x) * 3 + (this.entity.location.x === from.x ? 6 : 0),
        y: this.entity.location.y,
        z: this.entity.location.z + (this.entity.location.z - from.z) * 3 + (this.entity.location.z === from.z ? 6 : 0)
      };
      this.runtime.targetPosition = away;
      this.runtime.combatTarget = null;
      this.runtime.entityTarget = null;
      try { this.engine.execute({ type: "move_to_target" }); } catch { /* steering is best effort */ }
      setBotStatus(this.entity, BotState.FLEEING, { target: threat?.typeId || "danger", distance: threat?.distance ?? 0 });
      return true;
    }

    if (decision.behavior === Behavior.EAT) {
      // A cooldown, not a per-tick attempt: eating is a 1.6 s animation in game
      // and hammering useItem every tick is the "infinite eating loop" AC-21
      // forbids. With no food this branch is never even reached, because
      // assess() only proposes EAT when hasFood is true.
      const now = Date.now();
      if (now - this.runtime.lastEatAttempt < 4000) return false;
      this.runtime.lastEatAttempt = now;
      const ate = tryEatBestFood(this.entity);
      if (ate.success) {
        this.runtime.noFoodReported = false;
        this.memory.event(`Ate ${ate.used} at ${Math.ceil(health.current)}/${Math.ceil(max)} health.`, "recovery");
        this.reporter.event("eat", `§eAte ${String(ate.used).replace(/^minecraft:/, "").replace(/_/g, " ")} — ${Math.ceil(health.current)}/${Math.ceil(max)} health.§r`);
        setBotStatus(this.entity, BotState.EATING, { target: ate.used });
        return true;
      }
      this.test.note("eat", `refused: ${ate.reason || "unknown"}`, { level: "warn", context: this.name });
      return false;
    }
    return false;
  }

  /**
   * AC-21: hurt and holding nothing edible is reported ONCE, then the bot picks
   * a fallback (keep working at distance / stay near the owner) instead of
   * retrying "eat" forever.
   */
  reportMissingFood(health, hasFood) {
    const hurt = health.max > 0 && health.current / health.max <= HEALTH.EAT;
    if (hurt && !hasFood && !this.runtime.noFoodReported) {
      this.runtime.noFoodReported = true;
      this.memory.fact("No food in inventory — cannot self-heal.");
      this.reporter.event("no-food", `§cI have no food,§r so I can't heal (${Math.ceil(health.current)}/${Math.ceil(health.max)} HP). I'll keep out of trouble — drop me something to eat and I'll recover.`);
      return true;
    }
    if (!hurt && this.runtime.noFoodReported) this.runtime.noFoodReported = false;
    return false;
  }

  /** Look an observed entity up again, so combat acts on a live reference. */
  resolveEntity(id) {
    if (id === undefined || id === null) return null;
    try {
      const found = this.entity.dimension.getEntities({ location: this.entity.location, maxDistance: 24 }).find((candidate) => String(candidate.id) === String(id));
      return found && isValidEntity(found) ? found : null;
    } catch { return null; }
  }

  handleCombat(decision) {
    // Drop a stale combat target that unloaded or died.
    if (this.runtime.combatTarget && !isValidEntity(this.runtime.combatTarget)) {
      this.runtime.combatTarget = null;
      this.runtime.entityTarget = null;
    }
    const observed = decision?.threat ? this.resolveEntity(decision.threat.id) : null;
    const target = isValidEntity(this.runtime.combatTarget)
      ? this.runtime.combatTarget
      : (observed || this.findThreat());
    const health = this.healthSnapshot();

    if (!target) {
      if (this.runtime.combatTarget) {
        this.runtime.combatTarget = null;
        this.runtime.entityTarget = null;
        try {
          if (typeof this.entity.setProperty === "function") this.entity.setProperty("aibot:attacking", false);
        } catch { /* optional */ }
        if (this.tasks.current?.status === TaskStatus.PAUSED) {
          this.tasks.resume();
          this.runtime.interruption = null;
          this.memory.event("Threat cleared; task resumed.", "combat");
          this.reporter.event("threat-cleared", `§a✓ Threat defeated.§r Resuming task at ${this.progressText()}.`);
          this.requestPlan("threat cleared");
        }
      }
      return false;
    }

    // AC-22/AC-29: the FIRST time a threat is picked up, the player hears one
    // line — not one per tick.
    if (!this.runtime.combatTarget) {
      this.enterSurvival(`fighting ${String(target.typeId).replace("minecraft:", "")}`);
      if (this.tasks.current?.status === TaskStatus.PAUSED && !/^Survival:/.test(String(this.tasks.current.interruption?.reason || ""))) {
        this.tasks.current.interruption = { reason: `Hostile entity detected: ${target.typeId}`, at: Date.now() };
      }
      const pausedAt = this.progressText();
      this.reporter.event("threat", `§c⚠ ${String(target.typeId).replace("minecraft:", "")} detected ${Math.round(distance(this.entity.location, target.location))}m away — fighting${pausedAt ? `, task paused at ${pausedAt}` : ""}.§r`);
    }
    this.runtime.combatTarget = target;
    this.runtime.entityTarget = target;

    // AC-16/AC-23: hold the best weapon actually in the inventory.
    const heldIds = readInventory(this.entity).slots.map((item) => item.id);
    const held = readInventory(this.entity).selectedItem?.id || "";
    if (!/sword|axe/.test(String(held))) {
      const weapon = chooseWeapon(heldIds);
      if (weapon) {
        const swap = equipItem(this.entity, weapon);
        if (swap.success) this.runtime.lastWeapon = weapon;
      }
    }

    /** @type {any} */
    const result = this.engine.execute({ type: "attack_entity" });
    this.runtime.lastAction = result;
    // AC-23 requires the kill to be VERIFIED: the engine only returns success
    // when the target's health is gone or the entity was removed, so a swing
    // that connected but did not finish the fight stays `pending` and the bot
    // keeps fighting instead of claiming a win.
    if (result?.success) {
      this.runtime.combatTarget = null;
      this.runtime.entityTarget = null;
      pickupNearbyItems(this.entity, 4.5);
      this.memory.event(`Defeated ${target.typeId}; verified by health/entity check.`, "combat");
      if (this.tasks.current?.status === TaskStatus.PAUSED) {
        this.tasks.resume();
        this.runtime.interruption = null;
        this.memory.event("Combat completed; task resumed.", "combat");
        this.reporter.event("kill", `§a✓ ${String(target.typeId).replace("minecraft:", "")} defeated.§r Resuming task at ${this.progressText()}.`);
        this.requestPlan("combat finished");
      } else {
        this.reporter.event("kill", `§a✓ ${String(target.typeId).replace("minecraft:", "")} defeated.§r`);
      }
    } else if (result && !result.pending && result.reason) {
      this.reporter.failure(result.reason, this.tasks.current || {});
    }
    return true;
  }

  executePlan() {
    const plan = this.runtime.plan;
    if (!plan || this.runtime.planIndex >= plan.actions.length) {
      this.runtime.plan = null;
      return;
    }
    // Spotted while searching: drop the lap and go for it. A player who sees the
    // tree does not finish walking their search circle first, and finishing the
    // lap is how a bot managed to SEE four oak logs and then report that no oak
    // log exists (AC-13 — decisions come from what was actually observed).
    if (plan.search && this.tasks.current?.block && observedCount(this.observation, this.tasks.current.block) > 0) {
      this.runtime.exploreTarget = null;
      this.runtime.searchAttempts = 0;
      this.runtime.plan = null;
      this.runtime.targetBlock = null;
      this.memory.event(`Spotted ${String(this.tasks.current.block).replace(/^minecraft:/, "").replace(/_/g, " ")} while searching — going for it.`, "search");
      this.reporter.event("search", `§aFound it.§r`, 2000);
      this.requestPlan("spotted the target while searching");
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
      // The target is in sight again: a future miss starts a fresh search.
      if (action.type === "find_block") this.runtime.searchAttempts = 0;
      // A verified mine/collect is the moment progress may move (AC-05, AC-17).
      if (["mine_block", "collect_item", "pickup_item"].includes(action.type)) this.syncTask();
      if (action.type === "return_home" && this.runtime.returningAfterTask) {
        this.runtime.returningAfterTask = false;
        setBotStatus(this.entity, BotState.IDLE);
        // AC-06: the completed task is announced, the bot stops acting on it and
        // goes idle instead of starting the same loop again.
        this.reporter.event("delivered", `§aDone.§r ${this.tasks.current?.goal || "The task"} is finished — the items are in my inventory.`);
        this.runtime.cameTo = null;
      }
      if (action.type === "return_home" && this.runtime.cameTo) {
        this.runtime.cameTo = null;
        setBotStatus(this.entity, BotState.IDLE);
        this.say("Here I am.");
      }
      if (action.type === "return_home" && this.runtime.inventoryFullReturn) {
        this.runtime.inventoryFullReturn = false;
        setBotStatus(this.entity, BotState.WAITING, { target: "inventory storage" });
        this.notify(`§eI am back, but my inventory is still full. Store items, then use ${commandHint(this.controller, "resume")}.`);
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
    // AC-13/AC-32: "I cannot see one from here" is a SEARCH problem, not a plan
    // failure. Re-planning the identical plan — which the code below does — just
    // asked the same question in the same place and got the same answer, eight
    // times, then failed the task while a tree stood 30 blocks away.
    if (action.type === "find_block" && this.tasks.current?.status === TaskStatus.ACTIVE
      && this.searchForTarget(action.block || this.tasks.current.block)) return;
    if (result.reason === "Inventory is full.") {
      this.tasks.pause("Inventory full; returning to owner for storage.");
      this.memory.event("Task paused because inventory is full.", "recovery");
      this.runtime.inventoryFullReturn = true;
      this.runtime.targetBlock = null;
      this.runtime.plan = { goal: "Return to owner for inventory storage", thought: "Inventory is full; do not claim collection progress.", actions: [{ type: "return_home" }] };
      this.runtime.planIndex = 0;
      this.reporter.event("inventory-full", "§eInventory full.§r Returning to you; the task is paused until items are stored.");
      return;
    }
    this.runtime.planFailures += 1;
    this.runtime.noProgressCycles += 1;
    this.runtime.targetBlock = null;
    this.runtime.plan = null;
    // Every failed action used to be swallowed here; the reason is exactly what
    // a player needs (AC-32: "no walkable path", "no tool", "not mineable").
    this.test.note("action failed", `${result.action || "action"}: ${result.reason || "no reason given"}`, {
      level: "warn",
      context: `${this.name} · plan step ${(this.runtime.planIndex || 0) + 1} · failure ${this.runtime.planFailures + 1}/4`
    });
    this.reporter.failure(result.reason, this.tasks.current || {});
    // AC-40: reality wins. A "mine diamond_ore" plan with no diamond ore in the
    // observation is recorded as a fact, so the bot does not keep pretending.
    if (/was found within the observation radius|No .* was found nearby/.test(String(result.reason || ""))) {
      this.memory.fact(explainFailure(result.reason, this.tasks.current || {}));
    }
    setBotStatus(this.entity, BotState.ERROR, { target: result.reason || "action failed" });
    // AC-09: never loop forever. Steps can keep "succeeding" (find → walk →
    // find → walk) while the task makes no progress at all — a missing tool is
    // the classic case — so the bound is on cycles without progress, not only on
    // consecutive failures.
    if (this.runtime.noProgressCycles >= MAX_PROGRESSLESS_CYCLES) {
      const reason = result.reason || "Action failed repeatedly.";
      this.tasks.fail(reason);
      this.memory.event(`Task failed: ${MAX_PROGRESSLESS_CYCLES} attempts produced no progress (${reason}).`, "error");
      this.memory.archiveTask(this.tasks.current);
      this.runtime.noProgressCycles = 0;
      this.runtime.searchAttempts = 0;
      this.notify(`§cI could not make progress on that.§r ${explainFailure(reason, this.tasks.current || {})}`);
      setBotStatus(this.entity, BotState.ERROR, { target: reason });
      this.runtime.stuck.reset();
      this.persist(true);
      return;
    }
    if (this.runtime.planFailures >= 4) {
      this.tasks.fail(result.reason || "Action failed repeatedly.");
      this.memory.event(`Task failed: ${result.reason}`, "error");
      this.memory.archiveTask(this.tasks.current);
      this.notify(`§cTask failed.§r ${explainFailure(result.reason, this.tasks.current || {})}`);
      setBotStatus(this.entity, BotState.ERROR, { target: result.reason });
      this.runtime.stuck.reset();
      this.persist(true);
    } else {
      this.requestPlan(result.reason || "action failed");
    }
  }

  /**
   * AC-13 / AC-32 — "I cannot see one from here" is not the end of a task.
   *
   * A player who cannot see the thing they were asked for does three things, in
   * this order: recalls where they last saw one, walks to whatever implies it is
   * nearby (a canopy means a trunk under it), and otherwise heads somewhere new
   * and looks again. This is that ladder, and it is bounded — after
   * MAX_SEARCH_ATTEMPTS the task fails with a sentence that says what was
   * searched, because an endless silent search is worse than an honest stop.
   *
   * @param {string} wanted the block id the task needs
   * @returns {boolean} true when a search plan was set (caller must not count a plan failure)
   */
  searchForTarget(wanted) {
    const block = String(wanted || "");
    if (!block) return false;
    const label = block.replace(/^minecraft:/, "").replace(/_/g, " ");
    if (this.runtime.searchBlock !== block) {
      this.runtime.searchBlock = block;
      this.runtime.searchAttempts = 0;
      this.runtime.searchOrigin = { x: this.entity.location.x, y: this.entity.location.y, z: this.entity.location.z };
    }
    const attempt = (this.runtime.searchAttempts += 1);
    const origin = this.runtime.searchOrigin || this.entity.location;

    if (attempt > MAX_SEARCH_ATTEMPTS) {
      const reached = 8 + MAX_SEARCH_ATTEMPTS * 3;
      this.runtime.searchAttempts = 0;
      this.runtime.searchBlock = "";
      const reason = `No ${block} was found within the observation radius after ${MAX_SEARCH_ATTEMPTS} searches`;
      this.tasks.fail(reason);
      this.memory.event(`Gave up looking for ${label}: ${MAX_SEARCH_ATTEMPTS} searches found nothing.`, "error");
      this.memory.fact(`No ${label} within about ${reached} blocks of ${Math.floor(origin.x)}, ${Math.floor(origin.z)} — searched and found none.`);
      this.memory.archiveTask(this.tasks.current);
      this.notify(`§cNo ${label} anywhere near here.§r I searched ${MAX_SEARCH_ATTEMPTS} spots, out to about ${reached} blocks from ${Math.floor(origin.x)}, ${Math.floor(origin.z)}.\n§7Bring me closer to one (${commandHint(this.controller, "come")}), or ask for something that exists here.`);
      setBotStatus(this.entity, BotState.ERROR, { target: `no ${label} found` });
      this.runtime.stuck.reset();
      this.persist(true);
      return true;
    }

    const plan = (goal, thought, actions) => {
      // `search: true` lets executePlan abort the lap the moment a fresh
      // observation actually contains the target.
      this.runtime.plan = { goal, thought, actions, search: true };
      this.runtime.planIndex = 0;
      this.runtime.planFailures = 0;
      this.runtime.replans += 1;
      this.runtime.needsObservation = true;
      setBotStatus(this.entity, BotState.SEARCHING, { target: label, attempt });
    };

    // 1. Remembered sighting — the cheapest and most reliable lead.
    const known = this.memory.knownResource(block);
    if (known && Array.isArray(known.position)) {
      // Consume the memory: if it is wrong, revisiting it forever is exactly the
      // loop this ladder exists to prevent. A later scan re-adds it if real.
      this.memory.forgetResource(block);
      this.runtime.targetBlock = null;
      this.runtime.targetPosition = { x: known.position[0], y: known.position[1], z: known.position[2] };
      this.memory.event(`Searching for ${label}: I remember seeing one at ${known.position.join(", ")}.`, "search");
      plan(`Find ${label} where I last saw one`, "Memory says one was here; verify before believing it.", [
        { type: "move_to_target" },
        { type: "find_block", block }
      ]);
      return true;
    }

    // 2. A visible hint: leaves overhead mean a trunk is under them.
    const hintIds = HINT_FOR_BLOCK[block] || [];
    const hint = hintIds.length ? (this.observation?.hints || []).find((entry) => hintIds.includes(entry.id)) : null;
    if (hint && Array.isArray(hint.position)) {
      this.runtime.targetBlock = null;
      this.runtime.targetPosition = { x: hint.position[0], y: hint.position[1], z: hint.position[2] };
      this.memory.event(`Searching for ${label}: ${String(hint.id).replace("minecraft:", "").replace(/_/g, " ")} ${hint.distance}m away suggests one is under it.`, "search");
      plan(`Investigate the ${label.replace(/ log$/, "")} canopy`, "Leaves mean a trunk below; walk under them and look again.", [
        { type: "move_to_target" },
        { type: "find_block", block }
      ]);
      if (attempt === 1) this.reporter.event("search", `§eNo ${label} in sight — I can see ${String(hint.id).replace("minecraft:", "").replace(/_/g, " ")} ${hint.distance}m away, checking there.§r`, 3000);
      return true;
    }

    // 3. Nothing to go on: walk outward in a widening golden-angle spiral so no
    //    two attempts check the same ground.
    const angle = attempt * SEARCH_TURN;
    const radius = 8 + attempt * 3;
    this.runtime.exploreTarget = {
      x: Math.floor(origin.x + Math.cos(angle) * radius),
      y: Math.floor(origin.y),
      z: Math.floor(origin.z + Math.sin(angle) * radius)
    };
    this.runtime.targetBlock = null;
    this.runtime.targetPosition = null;
    this.memory.event(`Searching for ${label}: walking ${radius}m out (attempt ${attempt}/${MAX_SEARCH_ATTEMPTS}).`, "search");
    this.test.note("search", `no ${label} visible; searching ${radius}m out (attempt ${attempt}/${MAX_SEARCH_ATTEMPTS})`, { level: "info", context: this.name });
    if (attempt === 1) this.reporter.event("search", `§eNo ${label} in sight — searching nearby.§r`, 3000);
    else if (attempt === 4 || attempt === MAX_SEARCH_ATTEMPTS) {
      this.reporter.event("search", `§eStill no ${label}. I have checked ${attempt} spots out to ${radius} blocks; ${MAX_SEARCH_ATTEMPTS - attempt} to go before I stop.§r`, 3000);
    }
    plan(`Search for ${label}`, "No sighting and no hint: cover new ground and scan again.", [
      { type: "explore" },
      { type: "find_block", block }
    ]);
    return true;
  }

  /**
   * AC-09 / AC-10 — obstacle and stuck recovery, with a finite ladder:
   *   1st stall → drop the route and re-plan (another route),
   *   2nd stall → try a sideways detour around the obstacle,
   *   3rd+      → abandon the movement safely and explain (never loop forever).
   */
  checkStuck() {
    const target = this.runtime.targetBlock || this.runtime.targetPosition;
    const stuck = this.runtime.stuck.update(this.entity.location, target);
    if (!stuck.stuck) return false;
    setBotStatus(this.entity, stuck.attempts > 1 ? BotState.RECOVERING : BotState.STUCK, { target: "recalculating route" });

    if (stuck.attempts === 1) {
      clearRoute(this.entity.id);
      this.runtime.plan = null;
      this.runtime.targetBlock = null;
      this.runtime.replans += 1;
      this.memory.event("Movement stalled — recalculating route.", "recovery");
      this.test.note("stuck", "no progress for 4s; recalculating route", { level: "warn", context: this.name });
      this.requestPlan("route blocked; recalculating");
      return true;
    }
    if (stuck.attempts === 2) {
      const detour = this.detourPoint(target);
      if (detour) {
        this.runtime.exploreTarget = detour;
        this.runtime.plan = { goal: "Detour around an obstacle", thought: "The direct route failed twice; try from another side.", actions: [{ type: "explore" }] };
        this.runtime.planIndex = 0;
        this.runtime.replans += 1;
        this.memory.event("Direct route blocked twice — trying a detour.", "recovery");
        this.reporter.event("detour", "§eSomething is in my way — trying another route.§r");
        return true;
      }
    }
    if (stuck.attempts > 3) {
      this.runtime.plan = null;
      this.runtime.targetBlock = null;
      this.tasks.fail("Target unreachable after path recovery attempts.");
      this.memory.event("Abandoned the movement: target unreachable after detours.", "error");
      this.memory.archiveTask(this.tasks.current);
      this.notify("§cThe target area is unreachable.§r I stopped trying instead of looping — clear a path or give me a closer target.");
      setBotStatus(this.entity, BotState.ERROR, { target: "unreachable" });
      this.runtime.stuck.reset();
      this.persist(true);
    }
    return true;
  }

  /** A point off to the side of the blocked target, used as a detour goal. */
  /**
   * AC-08 / AC-09 — the follow half of stuck recovery.
   *
   * First stall: drop the cached route and try again (the player may have moved
   * and opened a line). Second and third: step sideways off the direct line, so
   * a wall is walked around instead of stood in front of. After that: say so
   * plainly. Following is a standing order, so the bot does not give up on it —
   * but it stops pretending and tells the player what is wrong (AC-32).
   */
  checkFollowStuck() {
    const owner = this.owner();
    if (!owner) return false;
    const stuck = this.runtime.stuck.update(this.entity.location, owner.location);
    if (!stuck.stuck) return false;

    if (stuck.attempts <= 1) {
      clearRoute(this.entity.id);
      this.runtime.followDetour = null;
      this.memory.event("Following stalled — recalculating the route.", "recovery");
      this.test.note("follow stuck", `no progress for 4s, ${Math.round(stuck.distance ?? 0)}m from the owner`, { level: "warn", context: this.name });
      return true;
    }
    if (stuck.attempts <= 3) {
      const detour = this.detourPoint(owner.location);
      if (detour) {
        this.runtime.followDetour = detour;
        clearRoute(this.entity.id);
        this.memory.event(`Something is in the way while following — stepping ${stuck.attempts % 2 === 0 ? "right" : "left"}.`, "recovery");
        this.reporter.event("follow-blocked", "§eSomething is in my way — stepping around it.§r", 8000);
        return true;
      }
    }
    stopEntity(this.entity);
    this.runtime.followDetour = null;
    this.reporter.event("follow-blocked", `§cI can't reach you — something is in the way (§7${Math.round(distance(this.entity.location, owner.location))}m apart§c). Come closer or clear a path and I'll follow again.§r`, 20000);
    this.test.note("follow blocked", `gave up stepping aside; ${Math.round(distance(this.entity.location, owner.location))}m from the owner`, { level: "warn", context: this.name });
    return true;
  }

  /**
   * AC-09 — following when the pathfinder finds no route at all.
   *
   * `moving: false` from the engine means "I could not find a way to you this
   * tick". One such tick is noise (the player stepped behind a hill); hundreds
   * in a row is a wall. Before this ladder existed the bot did nothing in that
   * case — it stood at the obstacle and stayed quiet, which to a player is
   * indistinguishable from a broken mod. Escalate instead: drop the cached
   * route, step sideways looking for a way round (alternating sides), and if
   * none turns up, say so plainly and stop burning the tick budget on a path
   * that does not exist. Following is a standing order, so it keeps listening
   * for the gap to open — it does not cancel itself.
   */
  checkFollowBlocked(step) {
    const owner = this.owner();
    if (!owner) { this.runtime.followBlocked = 0; return false; }
    this.runtime.followBlocked = (this.runtime.followBlocked || 0) + 1;
    const blocked = this.runtime.followBlocked;
    const gap = Math.round(distance(this.entity.location, owner.location));

    if (blocked === 1) {
      this.memory.event(`No route while following (${step.reason || "no reason given"}).`, "recovery");
      this.test.note("follow blocked", `${step.reason || "no route"} · ${gap}m from the owner`, { level: "warn", context: this.name });
    }
    if (blocked === 20) { clearRoute(this.entity.id); return true; }

    // Sidesteps: 2 s, 6 s, 10 s, 14 s of refusing, alternating left and right.
    const sideStep = FOLLOW_SIDESTEPS.indexOf(blocked);
    if (sideStep >= 0) {
      clearRoute(this.entity.id);
      this.runtime.followDetour = this.detourPoint(owner.location, sideStep + 1);
      this.reporter.event("follow-blocked", `§eI can't reach you in a straight line — trying around it (§7${gap}m§e).§r`, 6000);
      return true;
    }
    if (blocked === FOLLOW_GIVE_UP_TICKS) {
      stopEntity(this.entity);
      this.runtime.followDetour = null;
      this.reporter.event("follow-blocked", `§cI can't reach you — something is in the way and I've run out of ways around it (§7${gap}m apart§c). Come closer or clear a path and I'll follow again.§r`, 20000);
      this.test.note("follow gave up", `no route for ${FOLLOW_GIVE_UP_TICKS} ticks; ${gap}m from the owner`, { level: "warn", context: this.name });
      return true;
    }
    if (blocked > FOLLOW_GIVE_UP_TICKS && blocked % 100 === 0) {
      // Still ordered to follow: keep testing for an opening, cheaply.
      clearRoute(this.entity.id);
      this.runtime.followDetour = this.detourPoint(owner.location, Math.floor(blocked / 100));
    }
    return true;
  }

  detourPoint(target, attempt = this.runtime.stuck.attempts) {
    if (!target) return null;
    const here = this.entity.location;
    const dx = target.x - here.x;
    const dz = target.z - here.z;
    const length = Math.hypot(dx, dz) || 1;
    // Perpendicular, 5 blocks out, alternated by attempt count.
    const sign = attempt % 2 === 0 ? 1 : -1;
    return {
      x: here.x + (dx / length) * 3 + (-dz / length) * 5 * sign,
      y: here.y,
      z: here.z + (dz / length) * 3 + (dx / length) * 5 * sign
    };
  }

  /**
   * One AI cycle: observe → decide by priority → act → verify → report.
   * Returns false when the entity is gone (the controller then unregisters it).
   */
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

    // OBSERVE — on the configured interval only, never every tick (AC-41).
    this.observe(tick);
    // VERIFY — progress comes from the real inventory count (AC-17/AC-26).
    this.syncTask();

    const health = this.healthSnapshot();
    const hasFood = this.hasFood();
    const threats = this.threatList();
    const decision = assess({
      health,
      threats,
      task: this.tasks.current,
      follow: this.runtime.follow,
      hasFood,
      passive: this.config.combatMode === "passive",
      ownerOnline: Boolean(this.owner())
    });
    this.runtime.priority = decision;

    // AC-21 first: a hurt, foodless bot says so once instead of looping.
    this.reportMissingFood(health, hasFood);

    // 1. SURVIVAL (AC-20, AC-25) — outranks combat and every task.
    if (decision.behavior === Behavior.FLEE || decision.behavior === Behavior.EAT) {
      if (this.handleSurvival(decision)) { this.persist(); return true; }
    }
    // 2. COMBAT (AC-22..AC-24, AC-29).
    if (decision.behavior === Behavior.COMBAT) {
      if (this.handleCombat(decision)) { this.persist(); return true; }
    }
    // 3. Danger over → resume exactly what was interrupted (AC-28, AC-29).
    this.exitSurvival();
    if (!threats.length && this.runtime.combatTarget) this.handleCombat(decision);

    // 4. Ordinary work, in priority order.
    const task = this.tasks.current;
    if (decision.behavior === Behavior.FOLLOW && (!task || task.status !== TaskStatus.ACTIVE)) {
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
      // AC-08/AC-09: following has no plan, so the plan-failure ladder never saw
      // it — a bot that walked into a wall just stood there forever, silently,
      // while the player waited. Three outcomes are distinct: walking (watch for
      // a stall), refused (no route at all — escalate), arrived (all clear).
      if (step?.moving) {
        // Progress toward the player clears the blocked ladder; progress toward a
        // detour does not, or the bot would sidestep forever and never report.
        if (!this.runtime.followDetour) this.runtime.followBlocked = 0;
        this.checkFollowStuck();
      } else if (step && !step.arrived) {
        this.checkFollowBlocked(step);
      } else {
        this.runtime.followBlocked = 0;
        this.runtime.stuck.reset();
      }
      // AC-08: following must not permanently silence a task the player set.
      if (step?.arrived && task?.status === TaskStatus.PAUSED && this.runtime.interruption === "follow order") {
        // Keep following — the player asked for it — but say the task is waiting.
        this.reporter.event("task-waiting", `§7I'm with you. Your task is paused at ${this.progressText()}; say "resume" when you want me back on it.§r`, 30000);
      }
    } else if (this.runtime.returningAfterTask && !this.runtime.plan) {
      this.runtime.plan = { goal: "Return to player", thought: "Returning after verified task.", actions: [{ type: "return_home" }] };
      this.runtime.planIndex = 0;
    }

    if (task?.status === TaskStatus.ACTIVE && !this.runtime.plan && !this.runtime.planning) {
      this.requestPlan("task needs an action");
    }
    if (this.runtime.plan) {
      this.executePlan();
      // AC-09/AC-10 watch TRAVEL only. A bot standing still while it breaks a
      // block or waits for the drop to appear is working, not stalled — running
      // the stuck ladder on every action used to send it on a pointless detour
      // in the middle of a mine.
      if (this.runtime.lastAction?.moving) this.checkStuck();
      else this.runtime.stuck.reset();
    } else if (decision.behavior === Behavior.IDLE && tick % 10 === 0) {
      // Idle — release the movement keys so the bot eases to a player-like stop.
      stopEntity(this.entity);
      const state = readBotStatus(this.entity);
      if (state.state !== BotState.IDLE && !(task && task.status === TaskStatus.COMPLETED)) setBotStatus(this.entity, BotState.IDLE);
    }

    if (this.config.debug && tick % 100 === 0) this.notify(`\n${this.debugText()}`);
    this.persist();
    return true;
  }

  /**
   * Read the world once per observation interval and fold the cost into this
   * bot's counters. Kept separate from tick() so the acceptance runner (and the
   * tests) can force a fresh observation without waiting for the interval.
   */
  observe(tick, force = false) {
    // The interval is configured in GAME TICKS (20 = one second), but this loop
    // is driven by main.js every 5 ticks, so `tick` here counts RUNS. Counting
    // runs against a tick interval made the real period five times longer than
    // configured: the bot re-read the world every 100 ticks — five seconds. It
    // kept walking and mining from that stale picture, which is fine for a log,
    // and fatal for a creeper: perception has to be at least as fast as the
    // danger it is perceiving. Measure elapsed time instead, so the cadence is
    // what the config says whatever interval the loop is driven at.
    const intervalTicks = Math.max(10, Number(this.config.observationIntervalTicks) || 20);
    const intervalMs = intervalTicks * 50;
    const sinceScan = Date.now() - (this.observation?.timestamp || 0);
    // A stale snapshot costs one extra scan, not a scan per tick: `find_block`
    // sets needsObservation when everything it could see is already gone, and
    // the re-scan is allowed at most twice a second (AC-41).
    const stale = this.runtime.needsObservation === true && sinceScan > 500;
    if (!force && !stale && this.observation && sinceScan < intervalMs) return this.observation;
    this.runtime.needsObservation = false;
    const owner = this.owner();
    const observation = makeObservation(
      this.entity, this.tasks.current, this.memory, this.config,
      owner ? { id: owner.id, name: owner.name } : { id: this.ownerId, name: this.ownerName }
    );
    this.observation = observation;
    this.runtime.scans += 1;
    this.runtime.scannedCells += observation.scan?.cellsRead || 0;
    this.runtime.scannedEntities += observation.scan?.entitiesRead || 0;
    this.runtime.scanMs += observation.scan?.ms || 0;
    this.memory.observe(observation);
    return observation;
  }

  /**
   * Re-read progress from the REAL inventory (AC-17: a failed mine never moves
   * the number; AC-26: the number survives every cycle) and announce milestones
   * without flooding chat (AC-31).
   */
  syncTask() {
    const task = this.tasks.current;
    if (!task || task.status !== TaskStatus.ACTIVE) return task;
    const before = task.progress;
    this.tasks.syncCount(countItem(this.entity, this.currentCollectionItem()));
    const after = this.tasks.current;
    if (!after) return null;
    if (after.progress > before) {
      // Real progress: the "no progress" bound starts over (AC-05/AC-09).
      this.runtime.noProgressCycles = 0;
      this.runtime.searchAttempts = 0;
      this.memory.event(`Progress verified: ${after.progress}/${after.target} ${this.currentCollectionItem()} in inventory.`);
      this.reporter.progress({ progress: after.progress, target: after.target, block: this.currentCollectionItem() });
      this.persist(true);
    }
    if (after.status === TaskStatus.COMPLETED && !this.runtime.returningAfterTask) this.onTaskCompleted(after);
    return after;
  }

  /** AC-06: mark complete, stop the work, report it, then go idle. */
  onTaskCompleted(task) {
    this.runtime.plan = null;
    this.runtime.planIndex = 0;
    this.runtime.targetBlock = null;
    this.runtime.planFailures = 0;
    this.runtime.stuck.reset();
    stopEntity(this.entity);
    this.memory.archiveTask(task);
    this.memory.fact(`Completed "${task.goal}" (${task.progress}/${task.target}).`);
    this.memory.event(`Task completed and verified: ${task.goal} ${task.progress}/${task.target}.`, "task");
    this.reporter.progress({ progress: task.progress, target: task.target, block: this.currentCollectionItem(), force: true });
    this.reporter.event("complete", `§a✓ ${task.progress}/${task.target} — ${task.goal} complete.§r Bringing it back to you.`);
    // Hand the goods back, then idle: the completed action is never repeated.
    this.runtime.returningAfterTask = true;
    this.runtime.plan = { goal: "Return to player", thought: "Collection target verified in inventory.", actions: [{ type: "return_home" }] };
    this.runtime.planIndex = 0;
    setBotStatus(this.entity, BotState.RETURNING, { target: this.ownerName || "owner", progress: `${task.progress}/${task.target}` });
    this.persist(true);
  }

  /**
   * AC-34: current task, progress, target, health and basic state — read from
   * the live entity and the live task object, never from a cached string, so
   * the answer cannot drift from what the bot is actually doing.
   */
  statusText() {
    const task = this.tasks.current;
    const status = readBotStatus(this.entity);
    const health = this.healthSnapshot();
    const inventory = readInventory(this.entity);
    const follow = this.runtime.follow ? `Follow: ${this.runtime.lastFollowResult || "walking"}` : "Follow: off";
    const decision = this.runtime.priority;
    const item = task ? this.currentCollectionItem() : "";
    const lines = [
      `§b${this.name}§r`,
      `State: ${status.state}${status.block ? ` ${String(status.block).replace(/^minecraft:/, "")}` : ""}${status.target ? ` → ${String(status.target).slice(0, 40)}` : ""}`,
      `Task: ${task?.goal || "None"}`,
      task?.block ? `Target: ${task.block} (collecting ${item})` : "Target: -",
      `Progress: ${task ? `${task.progress}/${task.target}${task.remaining ? ` · ${task.remaining} to go` : ""}` : "-"}`,
      task?.status ? `Task status: ${task.status}${task.interruption ? ` (${task.interruption.reason})` : ""}` : null,
      `Priority: ${decision.name} → ${decision.behavior} (${decision.reason})`,
      `Health: ${Math.ceil(health.current)}/${Math.ceil(health.max)}`,
      `Inventory: ${inventory.slots.length}/${inventory.size} used · ${inventory.freeSlots} free${inventory.selectedItem ? ` · holding ${String(inventory.selectedItem.id).replace(/^minecraft:/, "").replace(/_/g, " ")}` : ""}`,
      follow,
      `Position: ${Math.round(this.entity.location.x)}, ${Math.round(this.entity.location.y)}, ${Math.round(this.entity.location.z)}`,
      `Threats seen: ${this.observation?.threats?.length ?? 0}${this.runtime.lastCombatNote ? ` · ${this.runtime.lastCombatNote}` : ""}`,
      `AI: ${this.config.provider === "fallback" ? "fallback (deterministic)" : (this.runtime.aiErrorShown ? "unavailable / fallback" : this.config.provider)}`
    ].filter(Boolean);
    return lines.join("\n");
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
      `PRIORITY: ${this.runtime.priority.name} → ${this.runtime.priority.behavior} (${this.runtime.priority.reason})`,
      `SURVIVAL: ${this.runtime.survivalSince ? `${this.runtime.survivalReason} for ${Math.round((Date.now() - this.runtime.survivalSince) / 1000)}s` : "not active"}`,
      `OBSERVED: ${this.observation ? `${this.observation.blocks.length} blocks, ${this.observation.nearbyEntities.length} entities, ${this.observation.threats.length} threats` : "nothing yet"}`,
      `AI: ${this.runtime.aiErrorShown ? "UNAVAILABLE / FALLBACK" : this.config.provider}`, `LAST PLAN: ${this.runtime.lastPlanReason}`,
      `AI REQUEST: ${this.runtime.lastAIRequest}`, `AI RESPONSE: ${this.runtime.lastAIResponse}`,
      `ACTION VALIDATION: ${this.runtime.lastValidation}`, `INVENTORY: ${readInventory(this.entity).slots.length}/${readInventory(this.entity).size}`,
      `TOOL: ${this.runtime.lastToolUsed || "-"}${this.runtime.lastToolIssue ? ` (issue: ${this.runtime.lastToolIssue})` : ""}`,
      `COST: ${this.runtime.scans} scans / ${this.runtime.scannedCells} block reads / ${this.runtime.scannedEntities} entity reads / ${this.runtime.scanMs}ms · ${this.runtime.chatLines} chat lines · ${this.runtime.replans} replans`,
      `FOLLOW VERDICT: ${this.runtime.lastFollowResult || "-"}`,
      `MOVEMENT LOOP: ${this.controller?.test?.liveness?.movementStalled ? "STALLED (bots cannot walk)" : "running"}`,
      `MEMORY EVENTS: ${this.memory.snapshot().shortTerm.length}`,
      `§7Errors are listed by §f/aibot:debug log§7; the check-up is §f/aibot:test§7§r`
    ].join("\n");
  }

  /**
   * AC-18 / AC-37: an accurate inventory summary. Counts are read from the live
   * container at call time and aggregated by item id (`oak_log x12`), so the
   * number in chat is the number in the inventory — including the item that is
   * currently held, which lives in the equipment slot rather than the container.
   */
  inventoryText() {
    const inventory = readInventory(this.entity);
    /** @type {Map<string, number>} */
    const totals = new Map();
    for (const item of inventory.slots) totals.set(item.id, (totals.get(item.id) || 0) + item.count);
    const held = inventory.selectedItem;
    if (held?.id) totals.set(held.id, (totals.get(held.id) || 0) + (held.count || 1));
    // AC-18/AC-37: the summary is read by a player, so it uses the same names
    // the game shows ("Oak Log ×5"), not raw ids ("oak_log x5").
    const summary = [...totals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, count]) => `${itemName(id)} ×${count}`);
    const slots = inventory.slots.map((item) => `  §8slot ${item.slot + 1}: §7${item.name} ×${item.count}`);
    return [
      `§b${this.name} inventory§r`,
      summary.length ? summary.join("\n") : "(empty)",
      `§8Slots used: ${inventory.slots.length}/${inventory.size} · free: ${inventory.freeSlots} · items: ${inventory.totalItems}${held ? ` · holding: ${held.name}` : ""}§r`,
      ...(slots.length ? [`§8Detail:`, ...slots.slice(0, 12)] : [])
    ].join("\n");
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
     * `probeId` is the stronger guard: the game's entitySpawn event for the
     * probe arrives only after the spawn call returns, so a boolean set
     * around that call misses it — the id is recorded for the probe's whole
     * lifetime instead.
     * @type {{suppressAutoRegister:boolean, probeId?:string|number|null}}
     */
    this.probe = { suppressAutoRegister: false, probeId: null };
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
    // A positive match only: id OR recorded owner name. `!agent.ownerId` used to
    // count as a match, which handed an ownerless bot to whoever asked first.
    const agent = this.all().find((agent) => (agent.ownerId === player.id || (Boolean(agent.ownerName) && agent.ownerName === player.name)) && canUseBot(player, agent, agent.config)) || null;
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
  /** AC-04/AC-34: the objective card for the player's bot. */
  task(player, name = "") { const agent = this.forPlayer(player, name); return agent?.taskText() || noBotMessage(this); }

  /**
   * AC-14 `/bot mine stone [count]`. Returns a chat line; the work itself is
   * the ordinary task pipeline, so mining is verified exactly like collecting.
   */
  mine(player, args = [], name = "") {
    const agent = this.forPlayer(player, name);
    if (!agent) return noBotMessage(this);
    if (!canUseBot(player, agent, agent.config)) return "Permission denied: that bot has a different owner.";
    const request = parseItemRequest(args);
    if (!request.phrase) return `Usage: ${commandHint(this, "mine stone 16")} — a block name, and optionally how many.`;
    if (!ALLOWED_MINE_BLOCKS.has(request.block)) {
      return `§cI can't mine ${request.block}.§r I only break blocks on my safe list (stone, ores, logs, dirt, sand, gravel…). §7That list is what stops an AI plan from ever targeting bedrock, command blocks or a player's build.`;
    }
    // The agent announces the task card (or the tool it is missing) itself; an
    // empty string here means "nothing further to add".
    agent.mineTask(request.block, request.count ?? 8);
    return "";
  }

  /** AC-04/AC-15 `/bot collect 16 oak logs`. */
  collect(player, args = [], name = "") {
    const agent = this.forPlayer(player, name);
    if (!agent) return noBotMessage(this);
    if (!canUseBot(player, agent, agent.config)) return "Permission denied: that bot has a different owner.";
    const request = parseItemRequest(args);
    if (!request.phrase) return `Usage: ${commandHint(this, "collect 16 oak logs")}.`;
    if (!ALLOWED_MINE_BLOCKS.has(request.block)) {
      return `§cI can't collect ${request.block}.§r It is not a block I can safely break — try oak logs, stone, dirt, sand, gravel or an ore.`;
    }
    agent.createCollectTask(request.block, request.count ?? 8, `Collect ${request.count ?? 8} ${request.block.replace(/^minecraft:/, "").replace(/_/g, " ")}`);
    return "";
  }

  /** AC-36 `/bot come` — walk to the player who asked. */
  come(player, name = "") {
    const agent = this.forPlayer(player, name);
    if (!agent) return noBotMessage(this);
    if (!canUseBot(player, agent, agent.config)) return "Permission denied: that bot has a different owner.";
    agent.comeTo(player);
    return "";
  }

  /** AC-35 `/bot follow`. */
  follow(player, name = "") {
    const agent = this.forPlayer(player, name);
    if (!agent) return noBotMessage(this);
    if (!canUseBot(player, agent, agent.config)) return "Permission denied: that bot has a different owner.";
    agent.follow();
    return "";
  }

  /** AC-33 `/bot stop`. */
  stop(player, name = "") {
    const agent = this.forPlayer(player, name);
    if (!agent) return noBotMessage(this);
    if (!canUseBot(player, agent, agent.config)) return "Permission denied: that bot has a different owner.";
    agent.stop();
    return "";
  }
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
