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

export class TaskManager {
  constructor(serialized) {
    this.state = serialized && typeof serialized === "object" ? serialized : { current: null, history: [] };
    this.state.history = Array.isArray(this.state.history) ? this.state.history.slice(-20) : [];
  }

  create({ goal, kind = "generic", block = "", target = 1, startingCount = 0, requiredItems = [] } = {}) {
    if (this.state.current) {
      if ([TaskStatus.ACTIVE, TaskStatus.PAUSED, TaskStatus.PENDING].includes(this.state.current.status)) this.pause("Replaced by a newer player request.");
      this.archiveCurrent();
    }
    const count = Math.max(1, Math.min(64, Number(target) || 1));
    const task = {
      id: makeId(), goal: String(goal || "Untitled task").slice(0, 200), kind,
      block, status: TaskStatus.ACTIVE, priority: 5, progress: 0, target: count,
      startingCount: Math.max(0, Number(startingCount) || 0), remaining: count,
      requiredItems: Array.isArray(requiredItems) ? requiredItems.slice(0, 16) : [],
      completedActions: [], remainingActions: [], failureReason: "",
      createdAt: Date.now(), lastUpdate: Date.now(), interruption: null
    };
    this.state.current = task;
    return copy(task);
  }

  get current() { return this.state.current; }
  get history() { return this.state.history; }

  syncCount(currentCount) {
    const task = this.state.current;
    if (!task || task.status !== TaskStatus.ACTIVE) return task;
    const count = Math.max(0, Number(currentCount) || 0);
    task.progress = Math.max(0, Math.min(task.target, count - task.startingCount));
    task.remaining = Math.max(0, task.target - task.progress);
    task.lastUpdate = Date.now();
    if (task.progress >= task.target) this.complete();
    return task;
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
    this.current.lastUpdate = Date.now();
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
}
