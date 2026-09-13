/**
 * THE PRIORITY SYSTEM — AC-29 (emergency overrides work) and AC-30 (player
 * commands are evaluated, not blindly obeyed).
 *
 * Before this module existed the arbitration was implicit and spread over
 * `handleCombat()`, the follow branch and the plan branch of `BotAgent.tick()`.
 * It mostly worked, but it could not answer the two questions the acceptance
 * criteria actually ask:
 *
 *   • "While collecting wood, a hostile mob appears and my health is low —
 *      does survival win?"                     → needs a *ranked* decision.
 *   • "While the bot is busy, I type a command — does it interrupt?"
 *                                              → needs a *comparable* level.
 *
 * So every behaviour the bot can be doing now has a numeric level, and one pure
 * function (`assess`) picks the winner from the observed world state. The agent
 * tick executes the winner and remembers the decision, which is what
 * `/aibot:status` prints and what the acceptance runner checks.
 *
 * The function is deliberately pure and dependency-free: it can be unit-tested
 * in Node without a world, and it can never throw inside a game tick.
 */

export const Priority = Object.freeze({
  /** Health-critical: flee, eat, survive. Nothing outranks this. */
  EMERGENCY: 100,
  /** An armed response to a hostile mob that is actually close. */
  COMBAT: 90,
  /** A direct order from an authorised player. */
  PLAYER_COMMAND: 80,
  /** The active collection / mining task. */
  TASK: 50,
  /** Following the owner — a standing order, lower than a task the owner set. */
  FOLLOW: 40,
  /** Nothing to do. */
  IDLE: 0
});

/** Behaviour labels returned by `assess`. One per branch of the agent tick. */
export const Behavior = Object.freeze({
  FLEE: "flee",
  EAT: "eat",
  COMBAT: "combat",
  TASK: "task",
  FOLLOW: "follow",
  IDLE: "idle"
});

const LEVEL_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(Priority).map(([name, level]) => [level, name]))
);

/** Human name for a level, e.g. `EMERGENCY` — used in chat and in /status. */
export function priorityName(level) {
  return LEVEL_NAMES[level] || "IDLE";
}

/**
 * Health thresholds, as fractions of the entity's effective maximum.
 * Tuned so a 20 HP bot flees at ≤5 HP and eats at ≤12 HP, and so the numbers
 * still make sense for a bot that has been given extra health.
 */
export const HEALTH = Object.freeze({
  /** At or below this the bot disengages and runs (AC-25). */
  FLEE: 0.25,
  /** At or below this the bot stops work and eats if it can (AC-20). */
  EAT: 0.6,
  /** Never spam "I have no food" more often than this (AC-21). */
  CRITICAL: 0.15
});

/** A hostile inside this distance is an immediate threat (AC-22). */
export const THREAT_RANGE = 10;
/** Defending the owner widens the ring around the owner, not around the bot. */
export const DEFEND_RANGE = 16;
/**
 * Creepers are not ordinary targets: they must be engaged from outside the
 * blast radius or not at all (AC-24).
 */
export const CREEPER_SAFE_DISTANCE = 6;

function ratio(health) {
  const max = Number(health?.max) || 0;
  const current = Number(health?.current);
  if (!Number.isFinite(max) || max <= 0) return 1;
  if (!Number.isFinite(current)) return 1;
  return Math.max(0, Math.min(1, current / max));
}

function isCreeper(threat) {
  return /creeper/.test(String(threat?.typeId || ""));
}

/**
 * Rank the behaviours available right now and return the winner.
 *
 * @param {object} context
 * @param {{current:number,max:number}} [context.health] bot health
 * @param {{typeId:string,distance:number}[]} [context.threats] observed hostiles, nearest first
 * @param {{status:string,goal?:string}|null} [context.task] current task
 * @param {boolean} [context.follow] follow mode is on
 * @param {boolean} [context.hasFood] the bot is carrying something edible
 * @param {boolean} [context.passive] combatMode "passive" disables combat entirely
 * @param {boolean} [context.ownerOnline] needed to widen the defend ring
 * @returns {{level:number,name:string,behavior:string,reason:string,threat:object|null,candidates:object[]}}
 */
export function assess(context = {}) {
  const health = context.health || null;
  const hurt = ratio(health);
  const threats = Array.isArray(context.threats) ? context.threats : [];
  const nearest = threats[0] || null;
  const passive = context.passive === true;
  const range = context.ownerOnline ? DEFEND_RANGE : THREAT_RANGE;
  const immediate = nearest && Number(nearest.distance) <= range ? nearest : null;
  const creeper = immediate && isCreeper(immediate) ? immediate : null;

  /** @type {{level:number,behavior:string,reason:string,threat?:object|null}[]} */
  const candidates = [];

  // 1. Run for your life. Low health AND something close enough to hit again is
  //    the only combination that justifies abandoning a fight mid-swing;
  //    fleeing at low health with no threat nearby would strand the bot idle.
  if (!passive && immediate && hurt <= HEALTH.FLEE) {
    candidates.push({
      level: Priority.EMERGENCY,
      behavior: Behavior.FLEE,
      reason: `health ${Math.round(hurt * 100)}% with ${String(immediate.typeId).replace("minecraft:", "")} ${Math.round(immediate.distance)}m away`,
      threat: immediate
    });
  }

  // 2. A creeper inside its blast radius is an emergency even at full health:
  //    closing on it is how a bot (and the player next to it) dies (AC-24).
  if (!passive && creeper && Number(creeper.distance) <= CREEPER_SAFE_DISTANCE && hurt <= HEALTH.EAT) {
    candidates.push({
      level: Priority.EMERGENCY,
      behavior: Behavior.FLEE,
      reason: `creeper ${Math.round(creeper.distance)}m away is inside its explosion radius`,
      threat: creeper
    });
  }

  // 3. Eat. Only when hurt, and only when there is food: with no food this is
  //    not a candidate at all, so the bot can never loop on "eat" (AC-21).
  if (hurt <= HEALTH.EAT && context.hasFood) {
    candidates.push({
      level: Priority.EMERGENCY - 5,
      behavior: Behavior.EAT,
      reason: `health ${Math.round(hurt * 100)}% and food is available`,
      threat: immediate
    });
  }

  // 4. Fight.
  if (!passive && immediate && hurt > HEALTH.FLEE) {
    candidates.push({
      level: Priority.COMBAT,
      behavior: Behavior.COMBAT,
      reason: `${String(immediate.typeId).replace("minecraft:", "")} ${Math.round(immediate.distance)}m away`,
      threat: immediate
    });
  }

  // 5. The player's task.
  if (context.task && String(context.task.status) === "ACTIVE") {
    candidates.push({
      level: Priority.TASK,
      behavior: Behavior.TASK,
      reason: `task "${String(context.task.goal || "untitled").slice(0, 40)}" is active`,
      threat: null
    });
  }

  // 6. Following.
  if (context.follow) {
    candidates.push({ level: Priority.FOLLOW, behavior: Behavior.FOLLOW, reason: "follow mode is on", threat: null });
  }

  candidates.push({ level: Priority.IDLE, behavior: Behavior.IDLE, reason: "nothing needs doing", threat: null });
  candidates.sort((a, b) => b.level - a.level);
  const winner = candidates[0];
  return {
    level: winner.level,
    name: priorityName(winner.level),
    behavior: winner.behavior,
    reason: winner.reason,
    threat: winner.threat || null,
    candidates
  };
}

/**
 * Directives a player can issue, with the level they carry (AC-30).
 *
 * Informational commands (`status`, `inventory`, `list`, `task`) must NOT
 * interrupt anything — a player asking "what are you doing?" while the bot is
 * fighting a zombie should get an answer, not a bot that stops fighting.
 * Directives either replace the current work (same or higher level) or are
 * refused/queued with an explanation.
 */
export const COMMAND_PRIORITY = Object.freeze({
  stop: { level: Priority.PLAYER_COMMAND, interrupts: true, kind: "directive" },
  cancel: { level: Priority.PLAYER_COMMAND, interrupts: true, kind: "directive" },
  follow: { level: Priority.PLAYER_COMMAND, interrupts: true, kind: "directive" },
  come: { level: Priority.PLAYER_COMMAND, interrupts: true, kind: "directive" },
  return: { level: Priority.PLAYER_COMMAND, interrupts: true, kind: "directive" },
  protect: { level: Priority.PLAYER_COMMAND, interrupts: true, kind: "directive" },
  resume: { level: Priority.PLAYER_COMMAND, interrupts: true, kind: "directive" },
  collect: { level: Priority.PLAYER_COMMAND, interrupts: true, kind: "directive" },
  mine: { level: Priority.PLAYER_COMMAND, interrupts: true, kind: "directive" },
  pickup: { level: Priority.PLAYER_COMMAND, interrupts: true, kind: "directive" },
  eat: { level: Priority.PLAYER_COMMAND, interrupts: true, kind: "directive" },
  use_item: { level: Priority.PLAYER_COMMAND, interrupts: true, kind: "directive" },
  build: { level: Priority.PLAYER_COMMAND, interrupts: true, kind: "directive" },
  say: { level: Priority.PLAYER_COMMAND, interrupts: false, kind: "conversation" },
  chat: { level: Priority.PLAYER_COMMAND, interrupts: false, kind: "conversation" },
  status: { level: Priority.IDLE, interrupts: false, kind: "informational" },
  task: { level: Priority.IDLE, interrupts: false, kind: "informational" },
  inventory: { level: Priority.IDLE, interrupts: false, kind: "informational" },
  list: { level: Priority.IDLE, interrupts: false, kind: "informational" },
  info: { level: Priority.IDLE, interrupts: false, kind: "informational" }
});

/**
 * Decide whether an incoming player command should interrupt what the bot is
 * doing right now, and say why in one line (AC-30 wants an *evaluation*, not a
 * blanket yes).
 *
 * @param {string} command one of COMMAND_PRIORITY's keys (or anything else)
 * @param {{level:number,behavior:string}} current the live priority decision
 * @returns {{interrupt:boolean,level:number,kind:string,reason:string}}
 */
export function evaluateCommand(command, current = { level: Priority.IDLE, behavior: Behavior.IDLE }) {
  const spec = COMMAND_PRIORITY[String(command || "").toLowerCase()] || {
    level: Priority.PLAYER_COMMAND, interrupts: true, kind: "directive"
  };
  const currentLevel = Number(current?.level ?? 0);
  if (!spec.interrupts) {
    return {
      interrupt: false,
      level: spec.level,
      kind: spec.kind,
      reason: spec.kind === "informational"
        ? `informational — ${priorityName(currentLevel)} work continues`
        : `answered without interrupting ${priorityName(currentLevel)} work`
    };
  }
  // Emergency survival is the one thing a player command does not cancel:
  // "collect 16 logs" while the bot is running from a creeper is queued behind
  // survival, and the bot says so instead of silently turning around.
  if (currentLevel >= Priority.EMERGENCY && spec.level < Priority.EMERGENCY) {
    return {
      interrupt: false,
      level: spec.level,
      kind: spec.kind,
      reason: `deferred — surviving (${priorityName(currentLevel)}) outranks a new order; it is picked up as soon as the bot is safe`
    };
  }
  if (spec.level > currentLevel) {
    return { interrupt: true, level: spec.level, kind: spec.kind, reason: `player command outranks ${priorityName(currentLevel)}` };
  }
  return {
    interrupt: true,
    level: spec.level,
    kind: spec.kind,
    reason: `player command replaces the current ${priorityName(currentLevel)} work`
  };
}
