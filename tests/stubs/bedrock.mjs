/**
 * Minimal in-memory stand-in for the Bedrock Script API, used by
 * tests/command-e2e.test.mjs. It is NOT shipped inside the behaviour pack —
 * Minecraft supplies the real modules at runtime.
 *
 * It models just enough of `@minecraft/server` to load scripts/main.js and drive
 * a chat command through the same code path the game uses:
 *   chatSend → handleChat → BotController.create → Dimension.spawnEntity
 */

class Signal {
  constructor() { this.handlers = []; }
  subscribe(handler) { this.handlers.push(handler); return handler; }
  unsubscribe(handler) { this.handlers = this.handlers.filter((entry) => entry !== handler); }
  fire(event) { for (const handler of [...this.handlers]) handler(event); }
}

export class ItemStack {
  constructor(typeId, amount = 1) { this.typeId = typeId; this.amount = amount; }
  getComponent() { return undefined; }
}

export const EquipmentSlot = Object.freeze({
  Head: "Head", Chest: "Chest", Legs: "Legs", Feet: "Feet", Mainhand: "Mainhand", Offhand: "Offhand"
});

/** Stable enums main.js imports for Custom Command registration. */
export const CommandPermissionLevel = Object.freeze({ Any: 0, GameDirectors: 1, Admin: 2, Host: 3, Owner: 4 });
export const CustomCommandParamType = Object.freeze({ Boolean: 0, Integer: 1, Float: 2, String: 3, Enum: 4, Player: 5 });
export const CustomCommandStatus = Object.freeze({ Success: 0, Failure: 1 });

class Container {
  constructor(size) { this.size = size; this.slots = new Array(size).fill(undefined); }
  get emptySlotsCount() { return this.slots.filter((slot) => !slot).length; }
  getItem(index) { return this.slots[index] ?? undefined; }
  setItem(index, value) { this.slots[index] = value; }
  addItem(stack) {
    for (let index = 0; index < this.size; index += 1) {
      const existing = this.slots[index];
      if (existing && existing.typeId === stack.typeId) { existing.amount += stack.amount; return undefined; }
    }
    for (let index = 0; index < this.size; index += 1) {
      if (!this.slots[index]) { this.slots[index] = new ItemStack(stack.typeId, stack.amount); return undefined; }
    }
    return stack;
  }
}

class Component { constructor(id) { this.id = id; } }

class HealthComponent extends Component {
  constructor(max = 20) { super("minecraft:health"); this.currentValue = max; this.effectiveMax = max; this.defaultValue = max; }
}

class InventoryComponent extends Component {
  constructor(size = 36) { super("minecraft:inventory"); this.container = new Container(size); }
}

class EquippableComponent extends Component {
  constructor() { super("minecraft:equippable"); this.slots = {}; }
  getEquipment(slot) { return this.slots[slot]; }
  setEquipment(slot, item) { this.slots[slot] = item; }
}

let nextEntityId = 1;

export class Entity {
  constructor(typeId, location, dimension) {
    this.typeId = typeId;
    this.id = `entity-${nextEntityId++}`;
    this.location = { ...location };
    this.dimension = dimension;
    this.nameTag = "";
    this.rotation = { x: 0, y: 0 };
    this.removed = false;
    this.sentMessages = [];
    this.commands = [];
    this.properties = new Map();
    this.tags = new Set();
    this.components = new Map([
      ["minecraft:health", new HealthComponent()],
      ["minecraft:inventory", new InventoryComponent()],
      ["minecraft:equippable", new EquippableComponent()]
    ]);
  }
  isValid() { return !this.removed; }
  getComponent(id) { return this.components.get(id); }
  hasComponent(id) { return this.components.has(id); }
  getDynamicProperty(key) { return this.properties.get(key); }
  setDynamicProperty(key, value) { this.properties.set(key, value); }
  getDynamicPropertyIds() { return [...this.properties.keys()]; }
  hasTag(tag) { return this.tags.has(tag); }
  addTag(tag) { this.tags.add(tag); return true; }
  removeTag(tag) { return this.tags.delete(tag); }
  getTags() { return [...this.tags]; }
  teleport(location) { this.location = { ...location }; }
  applyDamage() { return true; }
  remove() { this.removed = true; }
  kill() { this.removed = true; }
  sendMessage(text) { this.sentMessages.push(text); }
  runCommand(command) { this.commands.push(command); return { successCount: 1 }; }
}

export class Player extends Entity {
  constructor(name, location, dimension) {
    super("minecraft:player", location, dimension);
    this.name = name;
    this.nameTag = name;
    this.selectedSlotIndex = 0;
  }
}

class Block {
  constructor(location, typeId) { this.location = location; this.typeId = typeId; }
  get permutation() { return { type: { id: this.typeId } }; }
  isAir() { return this.typeId === "minecraft:air"; }
  isValid() { return true; }
}

const KNOWN_ENTITY_TYPES = new Set(["aibot:companion", "minecraft:item", "minecraft:zombie"]);

export class Dimension {
  constructor(id) {
    this.id = id;
    this.blocks = new Map();
    this.entities = [];
    this.commands = [];
  }
  static key(location) { return `${Math.floor(location.x)},${Math.floor(location.y)},${Math.floor(location.z)}`; }
  getBlock(location) {
    const key = Dimension.key(location);
    if (!this.blocks.has(key)) {
      this.blocks.set(key, new Block({ x: Math.floor(location.x), y: Math.floor(location.y), z: Math.floor(location.z) }, "minecraft:air"));
    }
    return this.blocks.get(key);
  }
  spawnEntity(typeId, location) {
    if (!KNOWN_ENTITY_TYPES.has(typeId)) throw new Error(`Unknown entity type '${typeId}'`);
    const entity = new Entity(typeId, location, this);
    this.entities.push(entity);
    return entity;
  }
  spawnItem(stack, location) {
    const entity = this.spawnEntity("minecraft:item", location);
    entity.components.set("minecraft:item", { itemStack: stack });
    return entity;
  }
  getEntities(filter = {}) {
    return this.entities.filter((entity) => entity.isValid() && (!filter.type || entity.typeId === filter.type));
  }
  getPlayers() { return this.entities.filter((entity) => entity.typeId === "minecraft:player" && entity.isValid()); }
  runCommand(command) { this.commands.push(command); return { successCount: 1 }; }
}

class ScriptWorld {
  constructor() {
    this.dimensions = new Map([
      ["overworld", new Dimension("overworld")],
      ["nether", new Dimension("nether")],
      ["the_end", new Dimension("the_end")]
    ]);
    this.afterEvents = {
      chatSend: new Signal(), entityDie: new Signal(), playerSpawn: new Signal(),
      playerInteractWithEntity: new Signal(), itemUse: new Signal()
    };
    this.beforeEvents = { chatSend: new Signal(), itemUse: new Signal() };
    this.messages = [];
  }
  getDimension(id) {
    const dimension = this.dimensions.get(id);
    if (!dimension) throw new Error(`Unknown dimension '${id}'`);
    return dimension;
  }
  getPlayers() { return [...this.dimensions.values()].flatMap((dimension) => dimension.getPlayers()); }
  sendMessage(text) { this.messages.push(text); }
}

export const world = new ScriptWorld();

const systemBeforeEvents = { startup: new Signal() };
const systemAfterEvents = { scriptEventReceive: new Signal() };

const jobs = [];
let currentTick = 0;

export const system = {
  get currentTick() { return currentTick; },
  beforeEvents: systemBeforeEvents,
  afterEvents: systemAfterEvents,
  run(callback) { jobs.push({ runAt: currentTick, callback }); return jobs.length; },
  runTimeout(callback, ticks = 1) { jobs.push({ runAt: currentTick + ticks, callback }); return jobs.length; },
  runInterval(callback, ticks = 1) { jobs.push({ runAt: currentTick, every: Math.max(1, ticks), callback }); return jobs.length; },
  clearRun(id) { if (jobs[id - 1]) jobs[id - 1] = null; }
};

/** Advance the simulated world, executing queued script work in tick order. */
export function advance(ticks = 1) {
  for (let step = 0; step < ticks; step += 1) {
    currentTick += 1;
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      if (!job) continue;
      if (job.every) { if (currentTick % job.every === 0) job.callback(); continue; }
      if (job.runAt <= currentTick) { jobs[index] = null; job.callback(); }
    }
  }
}

export function addPlayer(name, location = { x: 12, y: 70, z: -4 }, dimensionId = "overworld") {
  const dimension = world.getDimension(dimensionId);
  const player = new Player(name, location, dimension);
  dimension.entities.push(player);
  return player;
}

/** Send a chat message the way the game does, using whichever signal exists. */
export function sendChat(player, message) {
  const event = { message, sender: player, cancel: false };
  const signal = world.beforeEvents.chatSend || world.afterEvents.chatSend;
  if (!signal) throw new Error("This simulated build exposes no chat signal");
  signal.fire(event);
  return event;
}

/** Type a command, let the script queue drain, and return the new messages. */
export function command(player, message, settleTicks = 4) {
  const seen = player.sentMessages.length;
  sendChat(player, message);
  advance(settleTicks);
  return player.sentMessages.slice(seen);
}

export function resetWorld() {
  world.dimensions.set("overworld", new Dimension("overworld"));
  world.dimensions.set("nether", new Dimension("nether"));
  world.dimensions.set("the_end", new Dimension("the_end"));
  for (const group of [world.beforeEvents, world.afterEvents, systemBeforeEvents, systemAfterEvents]) {
    for (const signal of Object.values(group)) signal.handlers.length = 0;
  }
  jobs.length = 0;
  currentTick = 0;
}

let savedChatBefore = null;
let savedChatAfter = null;

/**
 * Pretend the game build has (or has not) removed the chatSend events, exactly
 * like stable @minecraft/server 2.x did. Detaching keeps the original signal
 * objects so re-enabling restores the script's subscriptions untouched.
 */
export function setChatAvailable(enabled) {
  if (!enabled) {
    savedChatBefore = world.beforeEvents.chatSend ?? null;
    savedChatAfter = world.afterEvents.chatSend ?? null;
    delete world.beforeEvents.chatSend;
    delete world.afterEvents.chatSend;
  } else {
    if (savedChatBefore) world.beforeEvents.chatSend = savedChatBefore;
    else world.beforeEvents.chatSend ??= new Signal();
    if (savedChatAfter) world.afterEvents.chatSend = savedChatAfter;
    else world.afterEvents.chatSend ??= new Signal();
  }
}

/** Fire the startup event the way the game does, with a scriptable registry. */
export function fireStartup(customCommandRegistry) {
  systemBeforeEvents.startup.fire({ customCommandRegistry });
}

/**
 * Pretend the behaviour pack is missing (or put it back) so `spawnEntity`
 * throws exactly like the game does for an unregistered entity type.
 */
export function setEntityRegistered(registered) {
  if (registered) KNOWN_ENTITY_TYPES.add("aibot:companion");
  else KNOWN_ENTITY_TYPES.delete("aibot:companion");
}

/**
 * Turn world dynamic properties on, like a real Bedrock device. The Node
 * world starts WITHOUT them so main.js's isRealBedrock() probe stays false in
 * files that do not opt in — files that test heartbeats / persistence call
 * this before driving the script. Setting undefined clears the property, the
 * same way the real API behaves.
 */
export function enableWorldProperties() {
  const properties = new Map();
  world.properties = properties;
  world.getDynamicProperty = (id) => properties.get(id);
  world.setDynamicProperty = (id, value) => {
    if (value === undefined) properties.delete(id);
    else properties.set(id, value);
  };
  world.getDynamicPropertyIds = () => [...properties.keys()];
  return world;
}
