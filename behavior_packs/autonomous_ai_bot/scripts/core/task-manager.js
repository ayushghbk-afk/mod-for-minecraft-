/**
 * THE TASK SYSTEM — AC-04 (a task is created with an identifiable objective),
 * AC-06 (completion stops the work), AC-19 (inventory-aware planning),
 * AC-26/AC-27 (progress and completion survive cycles and reloads).
 *
 * Progress semantics are ABSOLUTE, not relative. `Required: 16` means "hold 16
 * of this item", so a bot already carrying 12 reports `12/16` and only goes out
 * for four more. The earlier relative reading (`progress = count - starting`)
 * made the same bot collect 16 *additional* logs, which is exactly what AC-19
 * forbids.
 *
 * The whole state is plain JSON so it can live in one entity dynamic property
 * and survive a world reload unchanged (AC-43).
 */

export const TaskStatus = Object.freeze({
  PENDING: "PENDING",
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED"
});

function makeId() {
  return `task_${Date.now().toString(36)}_${Math.floor(Math.random() * 0xffff).toString(36)}`;
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

/** "minecraft:oak_log" → "Oak Log" — the wording AC-04 shows in chat. */
function prettyBlock(block) {
  return String(block || "").replace(/^minecraft:/, "").replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Stable identity for "is this the same objective the player already asked for?"
 * Used by AC-27 so a completed task is never silently recreated.
 */
export function taskKey({ kind = "generic", block = "", target = 1 } = {}) {
  return `${String(kind).toLowerCase()}:${String(block || "").toLowerCase()}:${Math.max(1, Number(target) || 1)}`;
}

export class TaskManager {
  constructor(serialized) {
    this.state = serialized && typeof serialized === "object" ? serialized : { current: null, history: [] };
    this.state.history = Array.isArray(this.state.history) ? this.state.history.slice(-20) : [];
    /** Keys of objectives finished in this world — the AC-27 "don't redo it" list. */
    this.state.completedKeys = Array.isArray(this.state.completedKeys) ? this.state.completedKeys.slice(-24) : [];
  }

  /**
   * @param {{goal?: string, kind?: string, block?: string, target?: number, startingCount?: number, requiredItems?: string[], priority?: number}} [input]
   *   `startingCount` is what the bot ALREADY holds; it becomes the starting
   *   progress so the task only asks for the difference (AC-19).
   */
  create({ goal, kind = "generic", block = "", target = 1, startingCount = 0, requiredItems = [], priority = 5 } = {}) {
    if (this.state.current) {
      if ([TaskStatus.ACTIVE, TaskStatus.PAUSED, TaskStatus.PENDING].includes(this.state.current.status)) this.pause("Replaced by a newer player request.");
      this.archiveCurrent();
    }
    const count = Math.max(1, Math.min(64, Number(target) || 1));
    const held = Math.max(0, Number(startingCount) || 0);
    /** @type {any} */
    const task = {
      id: makeId(), goal: String(goal || "Untitled task").slice(0, 200), kind,
      block, status: TaskStatus.ACTIVE, priority: Math.max(0, Math.min(100, Number(priority) || 5)),
      key: taskKey({ kind, block, target: count }),
      progress: Math.min(count, held), target: count,
      startingCount: held, remaining: Math.max(0, count - Math.min(count, held)),
      requiredItems: Array.isArray(requiredItems) ? requiredItems.slice(0, 16) : [],
      completedActions: [], remainingActions: [], failureReason: "",
      createdAt: Date.now(), lastUpdate: Date.now(), interruption: null,
      alreadySatisfied: held >= count
    };
    // Nothing to do: the requirement is already met by what the bot is holding.
    // Marking it complete here (instead of on the next observation) is what stops
    // the bot walking off to gather items the player already has (AC-19).
    if (task.alreadySatisfied) {
      task.status = TaskStatus.COMPLETED;
      task.progress = count;
      task.remaining = 0;
      this.rememberCompleted(task);
    }
    this.state.current = task;
    return copy(task);
  }

  get current() { return this.state.current; }
  get history() { return this.state.history; }
  get completedKeys() { return this.state.completedKeys; }

  /**
   * Re-read reality (AC-17: progress only ever reflects the actual inventory).
   * `currentCount` is the number of the wanted item the bot is holding NOW.
   */
  syncCount(currentCount) {
    const task = this.state.current;
    if (!task || task.status !== TaskStatus.ACTIVE) return task;
    const count = Math.max(0, Number(currentCount) || 0);
    const previous = task.progress;
    task.progress = Math.max(0, Math.min(task.target, count));
    task.remaining = Math.max(0, task.target - task.progress);
    task.lastUpdate = Date.now();
    if (task.progress > previous) task.gathered = (task.gathered || 0) + (task.progress - previous);
    if (task.progress >= task.target) this.complete();
    return task;
  }

  /** Items still needed — the number a player asks about ("how many more?"). */
  stillNeeded() {
    const task = this.state.current;
    return task ? Math.max(0, task.target - task.progress) : 0;
  }

  addAction(action) {
    if (!this.current) return;
    this.current.completedActions.push(String(action).slice(0, 120));
    this.current.lastUpdate = Date.now();
  }

  pause(reason = "Interrupted.") {
    if (!this.current || this.current.status !== TaskStatus.ACTIVE) return false;
    this.current.status = TaskStatus.PAUSED;
    this.current.interruption = { reason: String(reason).slice(0, 160), at: Date.now() };
    this.current.lastUpdate = Date.now();
    return true;
  }

  resume() {
    if (!this.current || this.current.status !== TaskStatus.PAUSED) return false;
    this.current.status = TaskStatus.ACTIVE;
    this.current.interruption = null;
    this.current.lastUpdate = Date.now();
    return true;
  }

  complete() {
    if (!this.current) return false;
    this.current.status = TaskStatus.COMPLETED;
    this.current.remaining = 0;
    this.current.progress = this.current.target;
    this.current.lastUpdate = Date.now();
    this.rememberCompleted(this.current);
    return true;
  }

  fail(reason) {
    if (!this.current) return false;
    this.current.status = TaskStatus.FAILED;
    this.current.failureReason = String(reason).slice(0, 200);
    this.current.lastUpdate = Date.now();
    return true;
  }

  cancel(reason = "Cancelled by player.") {
    if (!this.current) return false;
    this.current.status = TaskStatus.CANCELLED;
    this.current.failureReason = String(reason).slice(0, 200);
    this.current.lastUpdate = Date.now();
    return true;
  }

  /** AC-27: remember finished objectives so they are not recreated blindly. */
  rememberCompleted(task) {
    if (!task) return;
    const key = task.key || taskKey(task);
    if (!this.state.completedKeys.includes(key)) this.state.completedKeys.push(key);
    this.state.completedKeys = this.state.completedKeys.slice(-24);
  }

  hasCompleted(key) { return this.state.completedKeys.includes(String(key || "")); }

  /**
   * Is `key` finished *and* still satisfied? A completed "collect 16 oak logs"
   * stops being "already done" the moment the player takes the logs, so the
   * caller must check the live inventory count too — this helper only answers
   * the memory half of the question.
   */
  isRepeatOfCompleted(candidate) {
    if (!candidate) return false;
    const current = this.state.current;
    if (current && current.status === TaskStatus.COMPLETED && (current.key || taskKey(current)) === taskKey(candidate)) return true;
    return this.hasCompleted(taskKey(candidate)) && this.history.some((entry) => (entry.key || taskKey(entry)) === taskKey(candidate) && entry.status === TaskStatus.COMPLETED);
  }

  archiveCurrent() {
    if (!this.current) return;
    this.state.history.push(copy(this.current));
    this.state.history = this.state.history.slice(-20);
    this.state.current = null;
  }

  snapshot() { return copy(this.state); }

  summary() {
    const task = this.current;
    if (!task) return "No active task.";
    return `${task.goal} — ${task.progress}/${task.target} (${task.status})`;
  }

  /**
   * The objective card AC-04 asks for:
   *
   *   Task: Collect Oak Logs
   *   Target: minecraft:oak_log
   *   Required: 16
   *   Progress: 0/16
   *   Status: ACTIVE
   */
  describe() {
    const task = this.current;
    if (!task) return "Task: none\nStatus: IDLE";
    const lines = [
      `Task: ${task.goal}`,
      task.block ? `Target: ${task.block}` : null,
      `Required: ${task.target}`,
      `Progress: ${task.progress}/${task.target}`,
      `Status: ${task.status}`
    ].filter(Boolean);
    if (task.status === TaskStatus.PAUSED && task.interruption) lines.push(`Interrupted by: ${task.interruption.reason}`);
    if (task.status === TaskStatus.FAILED && task.failureReason) lines.push(`Failed because: ${task.failureReason}`);
    if (task.remaining > 0 && task.status === TaskStatus.ACTIVE) lines.push(`Still needed: ${task.remaining}`);
    return lines.join("\n");
  }
}

export { prettyBlock, taskKey as keyOf };
