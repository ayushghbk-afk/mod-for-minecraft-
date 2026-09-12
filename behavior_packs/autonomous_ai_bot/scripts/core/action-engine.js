import { ItemStack } from "@minecraft/server";
import { addItem, consumeItem, countItem, equipItem, getContainer, itemStackFromEntity, readInventory } from "./inventory.js";
import { setBotStatus, BotState } from "./status.js";
import { moveEntityTowards } from "./navigation.js";

function blockAt(dimension, position) {
  try {
    const value = Array.isArray(position) ? { x: position[0], y: position[1], z: position[2] } : position;
    return dimension.getBlock({ x: Math.floor(value.x), y: Math.floor(value.y), z: Math.floor(value.z) });
  } catch (error) { return null; }
}
function targetPosition(agent) { return agent.runtime.targetBlock || agent.runtime.targetPosition || null; }
function hostile(typeId) { return String(typeId).includes("zombie") || String(typeId).includes("skeleton") || String(typeId).includes("creeper") || String(typeId).includes("spider") || String(typeId).includes("witch") || String(typeId).includes("enderman"); }
function hasLineOfSight(dimension, from, to) {
  const steps = Math.max(2, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) * 2));
  for (let index = 1; index < steps; index += 1) {
    const t = index / steps;
    const value = blockAt(dimension, { x: from.x + (to.x - from.x) * t, y: from.y + 1.2 + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t });
    if (value && !["minecraft:air", "minecraft:cave_air", "minecraft:void_air", "minecraft:short_grass", "minecraft:tall_grass"].includes(value.typeId)) return false;
  }
  return true;
}

export class ActionEngine {
  constructor(agent) { this.agent = agent; }
  get bot() { return this.agent.entity; }

  result(action, success, reason = "", extra = {}) {
    return { action: action.type, success, reason, ...extra };
  }

  execute(action) {
    try {
      switch (action.type) {
        case "find_block": return this.findBlock(action);
        case "find_entity": return this.findEntity(action);
        case "move_to_target": return this.moveToTarget(action);
        case "follow_player": return this.followPlayer(action);
        case "stop": return this.stop(action);
        case "mine_block": return this.mineBlock(action);
        case "collect_item":
        case "pickup_item": return this.collectItem(action);
        case "drop_item": return this.dropItem(action);
        case "attack_entity": return this.attackEntity(action);
        case "defend_player": return this.defendPlayer(action);
        case "equip_item": return this.equip(action);
        case "return_home": return this.returnHome(action);
        case "explore": return this.explore(action);
        case "build": return this.build(action);
        case "open_chest": return this.openChest(action);
        case "store_item": return this.storeItem(action);
        case "withdraw_item": return this.withdrawItem(action);
        case "eat_food":
        case "craft_item":
        case "smelt_item":
        case "sleep":
        case "interact": return this.unsupported(action);
        default: return this.result(action, false, "Action was not registered in the deterministic engine.");
      }
    } catch (error) {
      return this.result(action, false, `Engine error: ${String(error).slice(0, 180)}`);
    }
  }

  findBlock(action) {
    const match = this.agent.observation?.nearbyBlocks?.find((block) => block.type === action.block);
    if (!match) {
      setBotStatus(this.bot, BotState.SEARCHING, { target: action.block });
      return this.result(action, false, `No ${action.block} was found within the observation radius.`);
    }
    const [x, y, z] = match.position || match.relative.map((offset, index) => Math.floor([this.bot.location.x, this.bot.location.y, this.bot.location.z][index] + offset));
    this.agent.runtime.targetBlock = { x, y, z, type: action.block };
    setBotStatus(this.bot, BotState.SEARCHING, { target: action.block, distance: match.distance });
    return this.result(action, true, "Target block located.", { target: this.agent.runtime.targetBlock });
  }

  findEntity(action) {
    const entities = this.agent.observation?.nearbyEntities || [];
    const match = entities.find((entity) => entity.type === action.entity || entity.type.endsWith(`:${action.entity}`));
    if (!match) return this.result(action, false, `No ${action.entity} was found nearby.`);
    try {
      const found = this.bot.dimension.getEntities({ location: this.bot.location, maxDistance: match.distance + 1 }).find((entity) => entity.typeId === match.type);
      if (!found) return this.result(action, false, "Entity disappeared before it could be targeted.");
      this.agent.runtime.entityTarget = found;
      return this.result(action, true, "Target entity located.", { target: found.id });
    } catch { return this.result(action, false, "Entity query failed."); }
  }

  moveToTarget(action) {
    const target = targetPosition(this.agent);
    if (!target) return this.result(action, false, "There is no target to approach.");
    const movement = moveEntityTowards(this.bot, target, { speed: 0.45, stopDistance: 2.2 });
    if (movement.success && movement.arrived) {
      setBotStatus(this.bot, BotState.WALKING, { target: target.type || "target", distance: movement.distance });
      return this.result(action, true, "Target reached.", { arrived: true });
    }
    setBotStatus(this.bot, BotState.WALKING, { target: target.type || "target", distance: movement.distance });
    return movement.success ? this.result(action, false, "Moving toward target.", { pending: true, distance: movement.distance }) : this.result(action, false, movement.reason);
  }

  followPlayer(action) {
    this.agent.runtime.follow = true;
    const owner = this.agent.owner();
    if (!owner) return this.result(action, false, "Owner is not online.");
    const movement = moveEntityTowards(this.bot, owner.location, { speed: 0.5, stopDistance: 3 });
    setBotStatus(this.bot, BotState.FOLLOWING, { target: owner.name, distance: movement.distance });
    return movement.success ? this.result(action, false, "Following owner.", { pending: true }) : this.result(action, false, movement.reason);
  }

  stop(action) {
    this.agent.runtime.follow = false;
    this.agent.runtime.plan = null;
    setBotStatus(this.bot, BotState.IDLE);
    return this.result(action, true, "Stopped.");
  }

  mineBlock(action) {
    const target = this.agent.runtime.targetBlock;
    if (!target) return this.result(action, false, "No target block is selected.");
    const block = blockAt(this.bot.dimension, target);
    const key = `${target.x},${target.y},${target.z}`;
    if (this.agent.runtime.lastMinedKey === key && block && ["minecraft:air", "minecraft:cave_air", "minecraft:void_air"].includes(block.typeId)) {
      this.agent.tasks.addAction(`mined ${action.block} at ${key}`);
      this.agent.runtime.targetBlock = null;
      return this.result(action, true, "Block change verified.");
    }
    if (!block || block.typeId !== action.block) {
      this.agent.runtime.targetBlock = null;
      return this.result(action, false, `Target is no longer ${action.block}.`);
    }
    const distance = Math.hypot(this.bot.location.x - target.x, this.bot.location.y - target.y, this.bot.location.z - target.z);
    if (distance > 5) return this.result(action, false, "Target is unreachable from the current position.");
    const axeBlock = /_log$/.test(action.block);
    const toolCandidates = axeBlock
      ? ["minecraft:netherite_axe", "minecraft:diamond_axe", "minecraft:iron_axe", "minecraft:stone_axe", "minecraft:wooden_axe"]
      : ["minecraft:netherite_pickaxe", "minecraft:diamond_pickaxe", "minecraft:iron_pickaxe", "minecraft:stone_pickaxe", "minecraft:wooden_pickaxe"];
    const inventory = readInventory(this.bot);
    if (!toolCandidates.includes(inventory.selectedItem?.id)) {
      const available = toolCandidates.find((id) => countItem(this.bot, id) > 0);
      if (available) equipItem(this.bot, available);
    }
    const equipped = readInventory(this.bot).selectedItem?.id || "empty hand";
    if (/diamond_ore|gold_ore|redstone_ore/.test(action.block) && !/iron_pickaxe|diamond_pickaxe|netherite_pickaxe/.test(equipped)) return this.result(action, false, `A suitable iron-tier pickaxe is required for ${action.block}.`);
    if (/iron_ore/.test(action.block) && !/stone_pickaxe|iron_pickaxe|diamond_pickaxe|netherite_pickaxe/.test(equipped)) return this.result(action, false, `A stone-tier pickaxe is required for ${action.block}.`);
    setBotStatus(this.bot, BotState.MINING, { block: action.block, progress: this.agent.progressText() });
    if (this.agent.runtime.lastMinedKey !== key) {
      // Stable Script API has no custom-mob breakBlock call. This is a fixed,
      // allowlisted operation; later ticks verify the block and real drop.
      this.bot.dimension.runCommand(`setblock ${target.x} ${target.y} ${target.z} air destroy`);
      this.agent.runtime.lastMinedKey = key;
      this.agent.runtime.lastMinedAt = Date.now();
      return this.result(action, false, "Mining started; waiting for block verification.", { pending: true });
    }
    if (Date.now() - this.agent.runtime.lastMinedAt < 1200) return this.result(action, false, "Waiting for block-state verification.", { pending: true });
    this.agent.runtime.targetBlock = null;
    return this.result(action, false, "Mining command completed but the block did not change.");
  }

  collectItem(action) {
    const before = countItem(this.bot, this.agent.currentCollectionItem());
    let collected = 0;
    let found = false;
    try {
      const wanted = this.agent.currentCollectionItem();
      const items = this.bot.dimension.getEntities({ location: this.bot.location, maxDistance: 4 }).filter((entity) => entity.typeId === "minecraft:item");
      for (const itemEntity of items) {
        const stack = itemStackFromEntity(itemEntity);
        if (!stack || stack.typeId !== wanted) continue;
        found = true;
        const added = addItem(this.bot, stack);
        const accepted = stack.amount - (added.remaining?.amount || 0);
        collected += Math.max(0, accepted);
        if (added.success) itemEntity.remove();
        else if (accepted > 0) {
          try { itemEntity.getComponent("minecraft:item").itemStack = added.remaining; } catch { /* leave the real remainder in-world */ }
        }
      }
    } catch { /* item entity may despawn during the query */ }
    const after = countItem(this.bot, this.agent.currentCollectionItem());
    setBotStatus(this.bot, BotState.COLLECTING, { target: this.agent.currentCollectionItem(), progress: `+${Math.max(0, after - before)}` });
    if (collected > 0 || after > before) {
      this.agent.tasks.addAction(`collected ${collected} item(s)`);
      return this.result(action, true, "Inventory confirms an item was collected.", { collected });
    }
    if (!found && this.agent.runtime.lastMinedAt > Date.now() - 2500) return this.result(action, false, "Waiting for the verified block drop.", { pending: true });
    if (found && this.agent.entityInventoryIsFull()) return this.result(action, false, "Inventory is full.");
    return this.result(action, false, "No collectable item reached the bot; task progress was not claimed.");
  }

  dropItem(action) {
    const container = getContainer(this.bot);
    const amount = Math.max(1, Math.min(64, Number(action.count) || 1));
    if (!container) return this.result(action, false, "Inventory is unavailable.");
    for (let slot = 0; slot < container.size; slot += 1) {
      const item = container.getItem(slot);
      if (!item || item.typeId !== action.item) continue;
      const dropCount = Math.min(amount, item.amount);
      try {
        const dropped = this.bot.dimension.spawnItem(new ItemStack(item.typeId, dropCount), this.bot.location);
        if (!dropped) return this.result(action, false, "The game did not create the dropped item.");
        if (dropCount === item.amount) container.setItem(slot, undefined);
        else { item.amount -= dropCount; container.setItem(slot, item); }
        return this.result(action, true, `Dropped ${dropCount} ${action.item}.`);
      } catch (error) { return this.result(action, false, `Drop failed: ${String(error)}`); }
    }
    return this.result(action, false, `No ${action.item} is in inventory.`);
  }

  attackEntity(action) {
    const target = this.agent.runtime.entityTarget || this.agent.runtime.combatTarget;
    if (!target) return this.result(action, false, "No combat target.");
    try {
      if (target.typeId === "minecraft:item" || !hostile(target.typeId) || target.location === undefined) return this.result(action, false, "Target is not an allowed hostile mob.");
      const distance = Math.hypot(this.bot.location.x - target.location.x, this.bot.location.y - target.location.y, this.bot.location.z - target.location.z);
      if (distance > 3.5) {
        const movement = moveEntityTowards(this.bot, target.location, { speed: 0.5, stopDistance: 2.5 });
        setBotStatus(this.bot, BotState.ATTACKING, { target: target.typeId, distance });
        return this.result(action, false, movement.success ? "Closing on hostile target." : movement.reason, { pending: true });
      }
      if (!hasLineOfSight(this.bot.dimension, this.bot.location, target.location)) return this.result(action, false, "A solid block obstructs the attack; repositioning is required.");
      if (!this.agent.runtime.lastAttackAt || Date.now() - this.agent.runtime.lastAttackAt > 650) {
        target.applyDamage(4, { damagingEntity: this.bot });
        this.agent.runtime.lastAttackAt = Date.now();
      }
      setBotStatus(this.bot, BotState.ATTACKING, { target: target.typeId, distance: Math.round(distance * 10) / 10 });
      return this.result(action, false, "Attack applied; waiting for threat verification.", { pending: true });
    } catch (error) { return this.result(action, false, `Attack failed: ${String(error)}`); }
  }

  defendPlayer(action) {
    const owner = this.agent.owner();
    if (!owner) return this.result(action, false, "Owner is not online.");
    try {
      const threat = owner.dimension.getEntities({ location: owner.location, maxDistance: 10 }).find((entity) => hostile(entity.typeId));
      if (!threat) return this.result(action, true, "No hostile target is currently near the owner.");
      this.agent.runtime.combatTarget = threat;
      return this.attackEntity({ type: "attack_entity" });
    } catch { return this.result(action, false, "Could not inspect threats near the owner."); }
  }

  equip(action) {
    const result = equipItem(this.bot, action.item);
    if (result.success) this.agent.tasks.addAction(`equipped ${action.item}`);
    return this.result(action, result.success, result.reason || "Item equipped.");
  }

  returnHome(action) {
    const owner = this.agent.owner();
    const target = this.agent.runtime.home || owner?.location;
    if (!target) return this.result(action, false, "Home or owner location is unavailable.");
    const movement = moveEntityTowards(this.bot, target, { speed: 0.5, stopDistance: 3 });
    setBotStatus(this.bot, BotState.RETURNING, { target: owner?.name || "home", distance: movement.distance });
    return movement.success && movement.arrived ? this.result(action, true, "Returned.") : this.result(action, false, movement.reason || "Returning.", { pending: true });
  }

  explore(action) {
    if (!this.agent.runtime.exploreTarget) {
      const angle = (Date.now() / 1000) % (Math.PI * 2);
      this.agent.runtime.exploreTarget = { x: this.bot.location.x + Math.cos(angle) * 12, y: this.bot.location.y, z: this.bot.location.z + Math.sin(angle) * 12 };
    }
    const movement = moveEntityTowards(this.bot, this.agent.runtime.exploreTarget, { speed: 0.45, stopDistance: 2 });
    setBotStatus(this.bot, BotState.EXPLORING, { distance: movement.distance });
    if (movement.success && movement.arrived) { this.agent.runtime.exploreTarget = null; return this.result(action, true, "Exploration point reached."); }
    return this.result(action, false, movement.reason || "Exploring.", { pending: true });
  }

  build(action) {
    if (!action.position) return this.result(action, false, "Build requires an explicit validated position.");
    const existing = blockAt(this.bot.dimension, action.position);
    if (existing && existing.typeId !== "minecraft:air" && existing.typeId !== "minecraft:cave_air") return this.result(action, false, "Build target is occupied.");
    const item = action.block.replace("_log", "_planks");
    if (countItem(this.bot, item) < 1 && countItem(this.bot, action.block) < 1) return this.result(action, false, `No ${item} available.`);
    this.bot.dimension.runCommand(`setblock ${action.position[0]} ${action.position[1]} ${action.position[2]} ${action.block} replace`);
    const placed = blockAt(this.bot.dimension, action.position);
    if (!placed || placed.typeId !== action.block) return this.result(action, false, "Block placement was not verified.");
    consumeItem(this.bot, countItem(this.bot, action.block) > 0 ? action.block : item, 1);
    setBotStatus(this.bot, BotState.BUILDING, { target: action.block });
    return this.result(action, true, "Block placement verified.");
  }

  openChest(action) {
    const target = action.position || this.agent.runtime.targetPosition;
    const block = target && blockAt(this.bot.dimension, target);
    const inventory = block?.getComponent("minecraft:inventory")?.container;
    if (!inventory) return this.result(action, false, "No chest inventory is available at the target.");
    this.agent.runtime.chest = inventory;
    return this.result(action, true, "Chest inventory opened for deterministic transfers.");
  }

  storeItem(action) {
    const chest = this.agent.runtime.chest;
    const container = getContainer(this.bot);
    if (!chest || !container) return this.result(action, false, "Bot inventory or chest is unavailable.");
    const wanted = action.item || container.getItem(0)?.typeId;
    for (let slot = 0; slot < container.size; slot += 1) {
      const item = container.getItem(slot);
      if (!item || (wanted && item.typeId !== wanted)) continue;
      const original = item.amount;
      const remaining = chest.addItem(item);
      const left = remaining?.amount || 0;
      if (left === 0) container.setItem(slot, undefined);
      else { item.amount = left; container.setItem(slot, item); }
      return this.result(action, true, `Stored ${original - left} item(s).`);
    }
    return this.result(action, false, `No ${wanted || "item"} to store.`);
  }

  withdrawItem(action) {
    const chest = this.agent.runtime.chest;
    if (!chest) return this.result(action, false, "No chest is open.");
    const wanted = action.item;
    for (let slot = 0; slot < chest.size; slot += 1) {
      const item = chest.getItem(slot);
      if (!item || (wanted && item.typeId !== wanted)) continue;
      const stack = item;
      const added = addItem(this.bot, stack);
      if (added.success) chest.setItem(slot, undefined);
      else if (added.remaining) chest.setItem(slot, added.remaining);
      return this.result(action, added.success, added.success ? "Item withdrawn." : "Inventory is full.");
    }
    return this.result(action, false, `No ${wanted || "item"} is stored in the chest.`);
  }

  unsupported(action) {
    const reasons = {
      eat_food: "Direct item use/eating is not exposed by the targeted stable Script API.",
      craft_item: "Crafting tables are not a stable programmable recipe API in the targeted version.",
      smelt_item: "Furnace automation is isolated until a supported inventory interaction API is available.",
      sleep: "Bed use is not a stable programmable interaction in the targeted API.",
      interact: "Generic interactions are intentionally not delegated to untrusted AI output."
    };
    return this.result(action, false, reasons[action.type] || "Action is not supported.");
  }
}
