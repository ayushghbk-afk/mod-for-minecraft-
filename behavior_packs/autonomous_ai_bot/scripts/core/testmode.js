/**
 * TEST MODE — every error the pack used to swallow, printed in chat.
 *
 * On a phone there is no console to read: Bedrock's content log is a desktop
 * feature, and a script error is otherwise completely invisible. Before this
 * module existed, nearly every `catch` in the pack could hide a real failure
 * behind a comment insisting the case was harmless, which is exactly why "it's not
 * working" reports could never be diagnosed: the AI tick loop, navigation, the
 * provider request and even the entity spawn could be failing every single
 * tick and the player would see nothing at all.
 *
 * Test mode has three parts:
 *   1. a bounded, persisted error log (world dynamic property → survives a
 *      reload, so an error thrown while you were still in the menu is not lost);
 *   2. live chat echo — while test mode is ON every new error is sent to all
 *      players, folded by signature so a per-tick failure cannot flood chat;
 *   3. the in-world self-test (`/aibot:test`, see selftest.js), which exercises
 *      the subsystems the bot depends on and prints a verdict for each.
 *
 * Normal play is unaffected: with test mode OFF errors are still *recorded*
 * (so `/aibot:debug log` can show them afterwards), and only failures that make
 * the whole pack look dead — spawn errors, restore errors, a stalled tick loop,
 * refused command registration — are echoed unasked. Those are marked
 * `{ always: true }` at their call sites.
 */

import { system, world } from "@minecraft/server";
import { SCRIPT_VERSION } from "./version.js";
import { describe, levelColour, sendLines, tryRun } from "./format.js";
import { runSelfTest } from "./selftest.js";
import { printManualSteps, runAcceptance } from "./acceptance.js";

// Re-exported so callers (and tests) can import the output helpers from either
// module; the definitions live in format.js to keep the import graph acyclic.
export { describe, levelColour, sendLines };

const MODE_PROPERTY = "aibot:testmode";
const LOG_PROPERTY = "aibot:testlog";
const MAX_ENTRIES = 30;
const MAX_SERIALIZED = 20000;
/** Repeats of the same error inside this window are folded into `×N`. */
const ECHO_COOLDOWN_MS = 20000;
const ALWAYS_COOLDOWN_MS = 60000;
/** Chat lines released per flush, the flush cadence, and the write throttle. */
const MAX_LINES_PER_FLUSH = 6;
const FLUSH_EVERY_TICKS = 10;
/** Queue ceiling: past this, the oldest lines are dropped (the log keeps them). */
const MAX_QUEUED_LINES = 60;
const PERSIST_EVERY_TICKS = 20;
/** Default verbose-tracing window: 60 s at 20 tps. */
const DEFAULT_WATCH_SECONDS = 60;

export const Level = Object.freeze({ ERROR: "error", WARN: "warn", INFO: "info" });

function isRealBedrock() {
  // In Node tests `world` has no dynamic properties at all; the log then lives
  // in memory only, which is exactly what those tests want to assert.
  return tryRun(() => typeof world.getDynamicProperty === "function" && typeof world.setDynamicProperty === "function", false) === true;
}

export class TestMode {
  /** @param {any} controller */
  constructor(controller) {
    this.controller = controller;
    /** @type {{lvl:string,where:string,msg:string,sig:string,n:number,at:number,tick:number,ctx?:string}[]} */
    this.entries = [];
    /** @type {string[]} queued chat lines waiting for the next flush */
    this.pending = [];
    /** @type {Map<string, number>} signature → last echo time */
    this.lastEchoAt = new Map();
    this.stats = { errors: 0, warnings: 0, notes: 0, echoed: 0, folded: 0, silent: 0, dropped: 0 };
    this.enabled = false;
    this.watchUntilTick = 0;
    this.lastPersistTick = -Infinity;
    /** Liveness of the two script jobs, measured rather than assumed. */
    this.liveness = { tick: 0, aiBeat: -1, moveBeat: -1, tps: 0, lastSampleTick: 0, lastSampleAt: Date.now(), stalled: false, movementStalled: false };
    this.load();
    this.start();
  }

  // ---------------------------------------------------------------- settings

  load() {
    if (!isRealBedrock()) return;
    const raw = tryRun(() => world.getDynamicProperty(LOG_PROPERTY));
    if (typeof raw === "string" && raw) {
      const parsed = tryRun(() => JSON.parse(raw), null);
      if (Array.isArray(parsed)) this.entries = parsed.slice(-MAX_ENTRIES);
    }
    this.enabled = tryRun(() => world.getDynamicProperty(MODE_PROPERTY), false) === true;
  }

  /**
   * World writes are deferred and throttled: the constructor can run in
   * early-execution mode (where writes throw), and an error storm must not
   * turn into a dynamic-property write every tick.
   */
  persist({ force = false } = {}) {
    if (!isRealBedrock()) return;
    const tick = tryRun(() => system.currentTick, 0) || 0;
    if (!force && tick - this.lastPersistTick < PERSIST_EVERY_TICKS) return;
    this.lastPersistTick = tick;
    const keep = this.entries
      .filter((entry) => entry.lvl !== Level.INFO)
      .slice(-MAX_ENTRIES)
      .map(({ lvl, where, msg, n, at, tick, ctx }) => (ctx ? { lvl, where, msg, n, at, tick, ctx } : { lvl, where, msg, n, at, tick }));
    let serialised = JSON.stringify(keep);
    while (serialised.length > MAX_SERIALIZED && keep.length > 1) {
      keep.shift();
      serialised = JSON.stringify(keep);
    }
    tryRun(() => {
      world.setDynamicProperty(MODE_PROPERTY, this.enabled ? true : undefined);
      world.setDynamicProperty(LOG_PROPERTY, keep.length ? serialised : undefined);
    });
  }

  setEnabled(on, { announce = true, origin = null } = {}) {
    const next = on === "on" || on === true || on === 1;
    const hadErrors = this.errorCount();
    const changed = this.enabled !== next;
    this.enabled = next;
    this.persist({ force: true });
    if (this.controller?.diagnostics) {
      this.controller.diagnostics.testMode = next ? "ON — every error is echoed to chat" : "off (errors recorded, not echoed)";
    }
    if (!announce) return next;
    if (next) {
      this.broadcast([
        `§b▶ TEST MODE ON §r§7(script v${SCRIPT_VERSION})§r`,
        "§eEvery error this pack catches now appears in chat, tagged §c[TEST]§e. Repeats are folded into ×N so chat stays readable.§r",
        `§7Run §f/aibot:test§7 for the full check-up, §f/aibot:debug log§7 for what was already caught, §f/aibot:debug off§7 to stop.§r`,
        ...(changed && hadErrors > 0 ? [`§e${hadErrors} earlier error(s) were already captured on this world — read them with §f/aibot:debug log§e.§r`] : [])
      ], origin);
    } else {
      this.broadcast(["§7■ TEST MODE OFF — errors are still recorded: §f/aibot:debug log§7 shows them, §f/aibot:debug clear§7 empties the log.§r"], origin);
    }
    return next;
  }

  /** Verbose tracing for a bounded window: the bot's decisions, not just errors. */
  setWatch(seconds = DEFAULT_WATCH_SECONDS, origin = null) {
    const wanted = Number(seconds);
    if (wanted === 0) {
      this.watchUntilTick = 0;
      this.broadcast(["§7■ Tracing off — errors are still echoed while test mode is on.§r"], origin);
      return;
    }
    const ticks = Math.max(20, Math.min(3600, Math.round((Number.isFinite(wanted) && wanted > 0 ? wanted : DEFAULT_WATCH_SECONDS) * 20)));
    const until = (tryRun(() => system.currentTick, 0) || 0) + ticks;
    this.watchUntilTick = Math.max(this.watchUntilTick, until);
    this.broadcast([`§b▶ TRACING ON §r§7for ${Math.round(ticks / 20)}s — movement verdicts, plans and action results are echoed too. Stop early with §f/aibot:debug watch 0§7.§r`], origin);
  }

  get watching() { return (tryRun(() => system.currentTick, 0) || 0) < this.watchUntilTick; }

  // -------------------------------------------------------------- capture API

  /**
   * Record one problem. `where` is a stable subsystem id (so the log groups
   * repeats and the self-test can point at it); `problem` is an Error or text.
   */
  record(level, where, problem, options = {}) {
    const message = describe(problem);
    const tick = tryRun(() => system.currentTick, 0) || 0;
    const signature = `${level}|${where}|${message}`;
    const now = Date.now();
    let entry = this.entries[this.entries.length - 1];
    if (entry && entry.sig === signature) {
      entry.n += 1;
      entry.at = now;
      entry.tick = tick;
      if (options.context) entry.ctx = describe(options.context);
      this.stats.folded += 1;
    } else {
      entry = {
        lvl: level, where: String(where).slice(0, 28), msg: message, sig: signature, n: 1, at: now, tick,
        ...(options.context ? { ctx: describe(options.context) } : {})
      };
      this.entries.push(entry);
      while (this.entries.length > MAX_ENTRIES) this.entries.shift();
      if (level === Level.ERROR) this.stats.errors += 1;
      else if (level === Level.WARN) this.stats.warnings += 1;
      else this.stats.notes += 1;
    }
    tryRun(() => console.error(`[aibot:test] ${level} ${where}: ${message}${entry.n > 1 ? ` (×${entry.n})` : ""}`));

    const cooldown = options.always ? ALWAYS_COOLDOWN_MS : ECHO_COOLDOWN_MS;
    const firstTime = !this.lastEchoAt.has(signature);
    const due = firstTime || now - (this.lastEchoAt.get(signature) || 0) >= cooldown;
    const shouldEcho = this.enabled || options.always || this.watching;
    if (shouldEcho && due) {
      this.lastEchoAt.set(signature, now);
      const colour = levelColour(level);
      const repeat = entry.n > 1 ? ` §7×${entry.n}§r` : "";
      this.pending.push(`${colour}▶ [TEST] §f${entry.where}§7 — §r${colour}${message}${repeat}`);
      const advice = [entry.ctx ? `↳ ${entry.ctx}` : "", options.fix ? `fix: ${options.fix}` : ""].filter(Boolean).join(" · ");
      if (advice) this.pending.push(`§7  ${advice}`.slice(0, 200));
      this.stats.echoed += 1;
      // A long session with many distinct failures must not grow this map forever.
      if (this.lastEchoAt.size > 200) {
        for (const key of [...this.lastEchoAt.keys()].slice(0, 100)) this.lastEchoAt.delete(key);
      }
    } else if (!shouldEcho) {
      this.stats.silent += 1;
    }
    // If chat cannot drain as fast as the pack fails, drop the oldest queued
    // lines: a diagnostic that eats memory (or lands five minutes late) is
    // worse than one that says "there were 400 of these".
    if (this.pending.length > MAX_QUEUED_LINES) {
      const dropped = this.pending.splice(0, this.pending.length - MAX_QUEUED_LINES);
      this.stats.dropped += dropped.length;
      this.pending.unshift(`§7… ${dropped.length} earlier line(s) dropped to keep chat current (all are in the log)§r`);
    }
    // Errors flush immediately: a crash right after one is the case where
    // waiting half a second means the player sees nothing at all.
    if (level === Level.ERROR) this.flush();
    this.persist();
    return entry;
  }

  error(where, problem, options = {}) { return this.record(Level.ERROR, where, problem, options); }
  warn(where, problem, options = {}) { return this.record(Level.WARN, where, problem, options); }

  /** Trace lines only exist while test mode or tracing is on, to keep memory flat. */
  note(where, message, options = {}) {
    if (!this.enabled && !this.watching && !options.always) return null;
    return this.record(options.level || Level.INFO, where, message, options);
  }

  /**
   * Run `action`; if it throws, record the error and return `fallback`. This is
   * the replacement for the silent `catch {}` blocks that made the pack
   * undiagnosable.
   */
  guard(where, action, fallback = undefined, options = {}) {
    try { return action(); } catch (error) { this.record(options.level || Level.ERROR, where, error, options); return fallback; }
  }

  // -------------------------------------------------------------------- echo

  players() { return tryRun(() => (world.getPlayers() || []).filter(Boolean), []); }

  broadcast(lines, origin = null) {
    const text = Array.isArray(lines) ? lines : [String(lines)];
    if (!text.length) return;
    const targets = new Set();
    if (origin) targets.add(origin);
    for (const player of this.players()) if (player !== origin) targets.add(player);
    if (!targets.size) {
      // Nobody to tell: the log stays the source of truth for the next join.
      for (const line of text) this.pending.push(line);
      return;
    }
    for (const player of targets) sendLines(player, text);
  }

  flush() {
    this.sampleLiveness();
    if (!this.pending.length) return;
    const lines = this.pending.splice(0, MAX_LINES_PER_FLUSH);
    if (this.pending.length) lines.push(`§7… ${this.pending.length} more line(s) queued — §f/aibot:debug log§7 shows everything§r`);
    const players = this.players();
    if (!players.length) { this.pending.length = 0; return; }
    for (const player of players) sendLines(player, lines, { perMessage: MAX_LINES_PER_FLUSH });
  }

  /**
   * A script that loads but never ticks is indistinguishable from a script that
   * never loaded, so liveness is measured: main.js beats once per AI loop and
   * once per movement step, and silence while the game keeps ticking is a
   * failure rather than a shrug.
   */
  sampleLiveness() {
    const tick = tryRun(() => system.currentTick, 0) || 0;
    const now = Date.now();
    const elapsedTicks = tick - this.liveness.lastSampleTick;
    const elapsedMs = now - this.liveness.lastSampleAt;
    if (elapsedMs > 250) {
      this.liveness.tps = Math.max(0, Math.round((elapsedTicks / elapsedMs) * 1000));
      this.liveness.lastSampleTick = tick;
      this.liveness.lastSampleAt = now;
    }
    this.liveness.tick = tick;
    const aiSilent = this.liveness.aiBeat < 0 ? tick : tick - this.liveness.aiBeat;
    const moveSilent = this.liveness.moveBeat < 0 ? tick : tick - this.liveness.moveBeat;
    const started = this.liveness.aiBeat >= 0 || this.liveness.moveBeat >= 0;
    const stalledNow = started && aiSilent > 120;
    const movementStalledNow = started && moveSilent > 120;
    if (stalledNow && !this.liveness.stalled) {
      this.liveness.stalled = true;
      this.error("tick loop stalled", `the AI loop has not run for ${aiSilent} game ticks while the game ticked at ${this.liveness.tps} tps`, {
        always: true,
        fix: "reload the world; if it comes back the AI loop is throwing every tick — read the errors above"
      });
    } else if (!stalledNow) this.liveness.stalled = false;
    if (movementStalledNow && !this.liveness.movementStalled) {
      this.liveness.movementStalled = true;
      this.warn("movement loop stalled", `no movement step ran for ${moveSilent} game ticks, so bots cannot walk`, { fix: "reload the world" });
    } else if (!movementStalledNow) this.liveness.movementStalled = false;
  }

  beat(kind = "ai") {
    const tick = tryRun(() => system.currentTick, 0) || 0;
    if (kind === "movement") this.liveness.moveBeat = tick;
    else this.liveness.aiBeat = tick;
  }

  // --------------------------------------------------------------- log access

  recent(limit = 15) {
    const wanted = Math.max(1, Math.min(MAX_ENTRIES, Number(limit) > 0 ? Number(limit) : 15));
    return this.entries.slice(-wanted).reverse();
  }

  errorCount() { return this.entries.reduce((total, entry) => total + (entry.lvl === Level.ERROR ? entry.n : 0), 0); }
  warnCount() { return this.entries.reduce((total, entry) => total + (entry.lvl === Level.WARN ? entry.n : 0), 0); }

  clear() {
    this.entries = [];
    this.pending = [];
    this.lastEchoAt.clear();
    this.stats = { errors: 0, warnings: 0, notes: 0, echoed: 0, folded: 0, silent: 0, dropped: 0 };
    this.persist({ force: true });
  }

  /** Chat-ready dump of the log, newest first. */
  logLines(limit = 15) {
    const entries = this.recent(limit);
    const header = [`§bAI BOT ERROR LOG §r§7${this.entries.length} stored · §c${this.errorCount()} error(s)§7 · §e${this.warnCount()} warning(s)§7 · test mode ${this.enabled ? "§aON" : "§coff"}§r`];
    if (!entries.length) return [...header, "§aNothing has gone wrong since the log was last cleared. Reproduce the problem, then run this again — or turn on §f/aibot:debug on§r and try again live.§a"];
    const lines = [...header];
    for (const entry of entries) {
      const age = Math.max(0, Math.round((Date.now() - entry.at) / 1000));
      const colour = levelColour(entry.lvl);
      lines.push(`${colour}${entry.lvl.toUpperCase()} §f${entry.where}§7 @tick ${entry.tick} · ${age}s ago${entry.n > 1 ? ` · §c×${entry.n}§7` : ""}§r`);
      lines.push(`   ${colour}${entry.msg}§r`);
      if (entry.ctx) lines.push(`   §7↳ ${entry.ctx}§r`);
    }
    lines.push("§7Empty it with §f/aibot:debug clear§7 · stream new ones live with §f/aibot:debug on§7 · diagnose with §f/aibot:test§r");
    return lines;
  }

  statusLines() {
    const liveness = this.liveness;
    return [
      `§bAI BOT TEST MODE §r§7v${SCRIPT_VERSION}§r`,
      `Test mode: ${this.enabled ? "§aON§r — errors are echoed to every player" : "§cOFF§r — errors are recorded but not echoed"}`,
      `Tracing: ${this.watching ? `§aON§r until tick ${this.watchUntilTick} (bot decisions echoed too)` : "off (§f/aibot:debug watch 60§7 to turn on)"}`,
      `Log: ${this.entries.length} entr(ies) · §c${this.errorCount()} error(s)§r · §e${this.warnCount()} warning(s)§r · ${this.stats.folded} repeat(s) folded · ${this.stats.silent} not echoed (mode off)`,
      `Chat echoes: ${this.stats.echoed} line(s) sent, queue ${this.pending.length}${this.stats.dropped ? `, ${this.stats.dropped} dropped` : ""}`,
      `Liveness: ${liveness.tps > 0 ? `${liveness.tps} tps` : "not sampled yet"} · AI loop ${liveness.stalled ? "§cSTALLED§r" : "ok"} · movement loop ${liveness.movementStalled ? "§cSTALLED§r" : "ok"} §7(last beats: ai ${liveness.tick - Math.max(0, liveness.aiBeat)}t, movement ${liveness.moveBeat < 0 ? "never" : `${liveness.tick - Math.max(0, liveness.moveBeat)}t`} ago)§r`,
      `Persistence: ${isRealBedrock() ? "world dynamic properties — the log survives a reload" : "memory only (this build blocks world properties)"}`,
      `§eRun §f/aibot:test§e for a full check-up. §7Others: §f/aibot:debug log§7, §f/aibot:debug clear§7, §f/aibot:debug watch 60§7, §f/aibot:test net§r`
    ];
  }

  /**
   * Single entry point for chat.js and the slash commands, so the wording and
   * argument handling cannot drift apart between the two front doors.
   * @returns {boolean|Promise<boolean>} true when the sub-command was handled
   */
  handle(player, sub = "status", args = [], controller = this.controller) {
    const action = String(sub || "status").toLowerCase();
    switch (action) {
      case "on":
      case "enable":
      case "true":
        this.setEnabled(true, { origin: player });
        // The per-bot debug dump (state, target, plan) is what players usually
        // mean by "debug on", so the toggle drives both streams.
        for (const agent of tryRun(() => controller?.all() || [], [])) tryRun(() => agent.updateConfig({ debug: true }));
        return true;
      case "off":
      case "disable":
      case "false":
        this.setEnabled(false, { origin: player });
        for (const agent of tryRun(() => controller?.all() || [], [])) tryRun(() => agent.updateConfig({ debug: false }));
        this.watchUntilTick = 0;
        return true;
      case "toggle":
        this.setEnabled(!this.enabled, { origin: player });
        return true;
      case "log":
      case "errors":
      case "last":
        sendLines(player, this.logLines(Number(args[0]) || 15));
        return true;
      case "clear":
      case "reset":
        this.clear();
        sendLines(player, [`§aError log cleared. Test mode stays ${this.enabled ? "ON" : "OFF"}: reproduce the problem and every error will be listed here.§r`]);
        return true;
      // `debug bot on` is the per-bot state dump, which lives on the agent, not
      // in the harness — return false so chat.js falls through to it instead of
      // treating "bot" as an unknown sub-command.
      case "bot":
        return false;
      case "watch":
      case "trace":
        this.setWatch(args.length ? Number(args[0]) : DEFAULT_WATCH_SECONDS, player);
        return true;
      case "status":
      case "info":
      case "state":
        sendLines(player, this.statusLines());
        return true;
      case "test":
      case "selftest":
      case "check":
      case "doctor":
        return this.runSelfTest(player, controller, { deep: args[0] === "net" || args[0] === "full" });
      case "net":
      case "ping":
        return this.runSelfTest(player, controller, { deep: true, only: "network" });
      // The gameplay acceptance run (AC-01..AC-45). Probes that touch the world
      // are opt-in by name: `mine` places and breaks one stone block, `move`
      // follows the player for six seconds and measures the distance closed.
      case "acceptance":
      case "ac":
      case "accept":
        return this.runAcceptance(player, controller, args);
      case "help":
      case "?":
        sendLines(player, [
          "§bAI BOT TEST MODE §r— makes every hidden error visible in chat",
          "§f/aibot:debug on§r — echo every error the pack catches, live",
          "§f/aibot:debug log [n]§r — show the last n captured errors",
          "§f/aibot:debug watch 60§r — also trace bot decisions for 60s",
          "§f/aibot:debug clear§r — empty the log (it survives world reloads)",
          "§f/aibot:debug status§r — mode, counters and loop liveness",
          "§f/aibot:test§r — full check-up: chat, commands, entity, model, movement, mining, persistence",
          "§f/aibot:acceptance§r — the AC-01..AC-45 gameplay acceptance verdicts, measured in this world",
          "§f/aibot:acceptance mine move§r — also run the two world-touching probes; §fmanual§r prints the human steps",
          "§f/aibot:test net§r — the same, plus a real request to the AI endpoint",
          "§7On builds with chat events these are also §f!aibot debug …§7 / §f!aibot test§7, and the panel has the same buttons§r"
        ]);
        return true;
      default:
        sendLines(player, [`§eUnknown test-mode sub-command "§f${action}§e".§r`, ...this.statusLines().slice(1)]);
        return true;
    }
  }

  /**
   * The acceptance runner must never be able to take the pack down either — it
   * pokes the live bot, and a diagnostic that kills the bot is worse than no
   * diagnostic at all.
   */
  async runAcceptance(player, controller, args = []) {
    const wanted = (Array.isArray(args) ? args : String(args).split(/\s+/)).map((entry) => String(entry).toLowerCase()).filter(Boolean);
    try {
      if (wanted.includes("manual") || wanted.includes("steps")) {
        printManualSteps(player);
        return true;
      }
      const probes = [];
      if (wanted.includes("mine")) probes.push("mine");
      if (wanted.includes("move")) probes.push("move");
      if (wanted.includes("all")) probes.push("mine", "move");
      await runAcceptance({ player, controller, testMode: this, probes });
      return true;
    } catch (error) {
      this.error("acceptance", error, { fix: "the acceptance runner crashed — report exactly this error" });
      sendLines(player, [`§c✖ The acceptance run crashed: §r${describe(error)}`]);
      return false;
    }
  }

  /** The check-up itself must never be able to take the pack down. */
  async runSelfTest(player, controller, options = /** @type {any} */ ({})) {
    try {
      await runSelfTest({ player, controller, testMode: this, ...options });
      return true;
    } catch (error) {
      this.error("self-test", error, { fix: "the check-up itself crashed — report exactly this error" });
      sendLines(player, [`§c✖ The self-test crashed: §r${describe(error)}`]);
      return false;
    }
  }

  /** Called from main.js on join, so a captured failure is never lost. */
  onPlayerJoin(player) {
    const errors = this.errorCount();
    if (!this.enabled) {
      if (errors > 0) sendLines(player, [`§e⚠ ${errors} error(s) were caught by the AI Bot before you joined. §f/aibot:debug log§r to read them, §f/aibot:test§r to diagnose.`]);
      return;
    }
    sendLines(player, [`§b▶ TEST MODE is ON§r — ${errors} error(s) captured so far; new ones appear here as they happen.`]);
    if (this.entries.length) sendLines(player, this.logLines(6));
  }

  start() {
    if (this.started) return;
    this.started = true;
    tryRun(() => { this.flushJob = system.runInterval(() => this.flush(), FLUSH_EVERY_TICKS); });
    if (this.controller?.diagnostics) {
      this.controller.diagnostics.testMode = this.enabled ? "ON — every error is echoed to chat" : "off (errors recorded, not echoed)";
    }
  }
}
