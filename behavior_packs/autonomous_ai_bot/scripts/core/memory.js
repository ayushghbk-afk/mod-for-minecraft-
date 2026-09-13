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
      knownResources: Array.isArray(data.knownResources) ? data.knownResources.slice(-24) : [],
      knownPlayers: Array.isArray(data.knownPlayers) ? data.knownPlayers.slice(-12) : [],
      knownDangerZones: Array.isArray(data.knownDangerZones) ? data.knownDangerZones.slice(-12) : [],
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

  observe(observation) {
    if (!observation) return;
    // Prefer the curated resource list: the nearest 8 blocks of a raw scan are
    // almost always the ground the bot is standing on, which is worth nothing
    // when it later needs to remember where it saw ore or a tree.
    const resources = Array.isArray(observation.resources) && observation.resources.length
      ? observation.resources
      : (observation.blocks || []);
    for (const block of resources.slice(0, 8)) {
      const value = { id: block.id, position: block.position, dimension: observation.dimension, at: Date.now() };
      const existing = this.data.knownResources.find((entry) => entry.id === value.id && entry.dimension === value.dimension);
      if (existing) Object.assign(existing, value); else this.data.knownResources.push(value);
    }
    for (const player of observation.players || []) {
      const value = { name: player.name, distance: player.distance, direction: player.direction?.compass, at: Date.now() };
      const existing = this.data.knownPlayers.find((entry) => entry.name === value.name);
      if (existing) Object.assign(existing, value); else this.data.knownPlayers.push(value);
    }
    if (observation.danger) this.data.knownDangerZones.push({ position: observation.position, dimension: observation.dimension, threats: observation.threats.slice(0, 4).map((item) => item.type), at: Date.now() });
    this.data.knownResources = this.data.knownResources.slice(-24);
    this.data.knownPlayers = this.data.knownPlayers.slice(-12);
    this.data.knownDangerZones = this.data.knownDangerZones.slice(-12);
  }

  /**
   * The most recent sighting of a block id, if it is still young enough to
   * trust. Three minutes is the honest limit: blocks get mined, water flows and
   * other players build — a stale memory would send the bot to an empty hole.
   * @param {string} id
   * @param {number} [maxAgeMs]
   * @returns {{id:string, position:number[], dimension:string, at:number}|null}
   */
  knownResource(id, maxAgeMs = 180000) {
    const wanted = String(id || "");
    const now = Date.now();
    const matches = this.data.knownResources.filter((entry) => entry.id === wanted && Array.isArray(entry.position) && now - Number(entry.at || 0) <= maxAgeMs);
    if (!matches.length) return null;
    return matches[matches.length - 1];
  }

  /** Drop a memory that turned out to be wrong, so the bot stops revisiting it. */
  forgetResource(id) {
    const wanted = String(id || "");
    this.data.knownResources = this.data.knownResources.filter((entry) => entry.id !== wanted);
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
      knownResources: this.data.knownResources.slice(-8),
      knownPlayers: this.data.knownPlayers.slice(-6),
      knownDangerZones: this.data.knownDangerZones.slice(-4),
      recentEvents: this.data.shortTerm.slice(-8),
      previousRequests: this.data.playerRequests.slice(-4)
    };
  }
}
