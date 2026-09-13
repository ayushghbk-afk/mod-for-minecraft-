/**
 * CHAT REPORTING — AC-31 (progress without spam) and AC-32 (failures are
 * explained, never silently dropped).
 *
 * Two failure modes are equally bad here and the module exists to keep both
 * impossible:
 *
 *   • a bot that reports every tick buries the player's chat and hides the one
 *     line that matters (AC-41 counts chat flood as a performance failure);
 *   • a bot that reports nothing looks broken — the player cannot tell a task
 *     that is progressing from one that died three minutes ago.
 *
 * The rule implemented below: milestone-based progress (25 % steps, never
 * faster than MIN_PROGRESS_GAP_MS apart), one line per distinct failure reason
 * per cooldown, and every failure translated from engine language
 * ("No walkable path to the target.") into something a player can act on
 * ("The target area is unreachable.").
 */

/** Never report progress faster than this, even across milestones. */
const MIN_PROGRESS_GAP_MS = 8000;
/** Never repeat the same failure line faster than this. */
const MIN_FAILURE_GAP_MS = 12000;
/** Milestones that earn a chat line. 0 and 100 are handled separately. */
const MILESTONES = [25, 50, 75];

/**
 * Translate an engine/validator reason into the sentence a player should read
 * (AC-32). The engine's own wording is kept as the fallback so nothing is ever
 * silently swallowed — an unmapped reason still reaches chat.
 *
 * @param {string} reason engine text
 * @param {{block?:string,goal?:string}} [task]
 * @returns {string}
 */
export function explainFailure(reason, task = {}) {
  const text = String(reason || "").trim();
  const block = String(task?.block || "").replace(/^minecraft:/, "").replace(/_/g, " ");
  const what = block || "the target";

  if (/no (minecraft:)?[a-z_ ]*(was|were) found within the observation radius/i.test(text) || /no .* found nearby/i.test(text)) {
    return `I can't find any ${what} nearby.`;
  }
  if (/suitable|pickaxe is required|axe is required|no tool/i.test(text)) {
    return `I don't have a suitable tool for ${what}.`;
  }
  if (/no walkable path|unreachable|out of reach|not reachable/i.test(text)) {
    return "The target area is unreachable.";
  }
  if (/inventory is full/i.test(text)) return "My inventory is full — store some items and I'll carry on.";
  if (/owner is not online/i.test(text)) return "I can't see you anymore — come closer and I'll pick this up again.";
  if (/no longer/i.test(text)) return `That ${what} is gone — something else broke it first.`;
  if (/did not change|not verified/i.test(text)) return `I couldn't break that ${what}. It may need a better tool or cheats-enabled commands.`;
  if (/no combat target|not an allowed hostile/i.test(text)) return "My target is gone.";
  if (/no food in inventory/i.test(text)) return "I have no food — I can't heal myself.";
  if (/not hungry enough/i.test(text)) return "I'm not hurt enough to eat.";
  if (/unsupported|not supported|not a stable programmable/i.test(text)) return `I can't do that yet: ${text}`;
  return text || "That didn't work, and I don't know why.";
}

/**
 * Per-bot chat reporter. One instance lives on the agent (never shared between
 * bots, so two bots cannot suppress each other's lines — AC-42).
 */
export class Reporter {
  /** @param {{say:(message:string, player?:any)=>void, name?:string}} agent */
  constructor(agent) {
    this.agent = agent;
    /** @type {Map<string, number>} key → last emitted timestamp */
    this.lastAt = new Map();
    /** Last reported progress percentage, so 25 % is announced once. */
    this.lastMilestone = -1;
    this.lastProgressText = "";
    /** Counters the acceptance runner and /status can read (AC-41 evidence). */
    this.stats = { progressLines: 0, failureLines: 0, suppressed: 0 };
  }

  /** True when `key` may be spoken again. Records the time when it returns true. */
  allow(key, gapMs) {
    const now = Date.now();
    const previous = this.lastAt.get(key) || 0;
    if (now - previous < gapMs) {
      this.stats.suppressed += 1;
      return false;
    }
    this.lastAt.set(key, now);
    return true;
  }

  /**
   * Announce a one-off event (task created, task completed, threat defeated).
   * Always delivered unless the identical key was announced inside `gapMs`.
   */
  event(key, message, gapMs = 1500) {
    if (!this.allow(`event:${key}`, gapMs)) return false;
    this.agent.say(message);
    return true;
  }

  /**
   * Milestone progress (AC-31): `Collecting oak logs: 8/16`.
   *
   * Emits on creation (0 %), on each 25 % step, and on completion — and never
   * more often than MIN_PROGRESS_GAP_MS, so a bot mining fast cannot flood.
   *
   * @param {{progress:number,target:number,block?:string,label?:string,force?:boolean}} state
   */
  progress({ progress, target, block, label, force = false }) {
    const total = Math.max(1, Number(target) || 1);
    const done = Math.max(0, Math.min(total, Number(progress) || 0));
    const percent = Math.floor((done / total) * 100);
    const name = label || String(block || "items").replace(/^minecraft:/, "").replace(/_/g, " ");
    const milestone = done >= total ? 100 : MILESTONES.filter((step) => percent >= step).pop() ?? 0;
    const text = `${done >= total ? "Done" : "Collecting"} ${name}: ${done}/${total}`;
    if (!force && milestone === this.lastMilestone && text === this.lastProgressText) return false;
    if (!force && !this.allow("progress", MIN_PROGRESS_GAP_MS)) return false;
    this.lastMilestone = milestone;
    this.lastProgressText = text;
    this.stats.progressLines += 1;
    this.agent.say(`§e${text}§r`);
    return true;
  }

  /**
   * Report a failure in player language (AC-32). One line per distinct reason
   * per cooldown: a bot that retries the same impossible action every 5 ticks
   * says it once, then stays quiet while it keeps trying.
   */
  failure(reason, task = {}) {
    const message = explainFailure(reason, task);
    if (!this.allow(`failure:${message}`, MIN_FAILURE_GAP_MS)) return false;
    this.stats.failureLines += 1;
    this.agent.say(`§c${message}§r`);
    return true;
  }

  /** A new task resets the milestone ladder so 0/16 is announced again. */
  reset() {
    this.lastMilestone = -1;
    this.lastProgressText = "";
  }

  snapshot() {
    return { ...this.stats, milestones: this.lastMilestone };
  }
}

export { MILESTONES, MIN_PROGRESS_GAP_MS, MIN_FAILURE_GAP_MS };
