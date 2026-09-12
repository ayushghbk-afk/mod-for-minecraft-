const MAX_EVENTS = 24;
const MAX_LOCATIONS = 16;

function clone(value) { return JSON.parse(JSON.stringify(value)); }

export class MemoryStore {
  constructor(serialized) {
    const data = serialized && typeof serialized === "object" ? serialized : {};
    this.data = {
      shortTerm: Array.isArray(data.shortTerm) ? data.shortTerm.slice(-MAX_EVENTS) : [],
      completedTasks: Array.isArray(data.completedTasks) ? data.completedTasks.slice(-12) : [],
      failedTasks: Array.isArray(data.failedTasks) ? data.failedTasks.slice(-12) : [],
      locations: Array.isArray(data.locations) ? data.locations.slice(-MAX_LOCATIONS) : [],
      facts: Array.isArray(data.facts) ? data.facts.slice(-20) : [],
      playerRequests: Array.isArray(data.playerRequests) ? data.playerRequests.slice(-12) : []
    };
  }

  event(text, kind = "info") {
    this.data.shortTerm.push({ text: String(text).slice(0, 180), kind, at: Date.now() });
    this.data.shortTerm = this.data.shortTerm.slice(-MAX_EVENTS);
  }

  playerRequest(text) {
    this.data.playerRequests.push({ text: String(text).slice(0, 180), at: Date.now() });
    this.data.playerRequests = this.data.playerRequests.slice(-12);
  }

  rememberLocation(name, position, dimension) {
    if (!Array.isArray(position) || position.length !== 3) return;
    const existing = this.data.locations.find((location) => location.name === name);
    const value = { name: String(name).slice(0, 64), position: position.map((n) => Math.round(Number(n))), dimension: String(dimension), at: Date.now() };
    if (existing) Object.assign(existing, value);
    else this.data.locations.push(value);
    this.data.locations = this.data.locations.slice(-MAX_LOCATIONS);
  }

  fact(text) {
    const value = String(text).slice(0, 180);
    if (!this.data.facts.some((fact) => fact.text === value)) this.data.facts.push({ text: value, at: Date.now() });
    this.data.facts = this.data.facts.slice(-20);
  }

  archiveTask(task) {
    if (!task) return;
    const target = task.status === "COMPLETED" ? this.data.completedTasks : this.data.failedTasks;
    target.push({ id: task.id, goal: task.goal, progress: task.progress, target: task.target, status: task.status, at: Date.now() });
    while (target.length > 12) target.shift();
  }

  snapshot() { return clone(this.data); }

  /** Relevant context only; old event history is intentionally bounded. */
  promptContext(task) {
    return {
      currentTask: task ? { id: task.id, goal: task.goal, status: task.status, progress: task.progress, target: task.target, remaining: task.remaining } : null,
      importantFacts: this.data.facts.slice(-8),
      knownLocations: this.data.locations.slice(-8),
      recentEvents: this.data.shortTerm.slice(-8),
      previousRequests: this.data.playerRequests.slice(-4)
    };
  }
}
