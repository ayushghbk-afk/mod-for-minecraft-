import { EquipmentSlot, ItemStack } from "@minecraft/server";

const EQUIPMENT = ["Head", "Chest", "Legs", "Feet", "Mainhand", "Offhand"];
const DISPLAY_NAMES = Object.freeze({
  "minecraft:oak_log": "Oak Log", "minecraft:stone": "Stone", "minecraft:iron_ore": "Iron Ore",
  "minecraft:coal_ore": "Coal Ore", "minecraft:diamond": "Diamond", "minecraft:iron_ingot": "Iron Ingot",
  "minecraft:bread": "Bread", "minecraft:cooked_beef": "Steak", "minecraft:wooden_pickaxe": "Wooden Pickaxe",
  "minecraft:stone_pickaxe": "Stone Pickaxe", "minecraft:iron_pickaxe": "Iron Pickaxe", "minecraft:iron_axe": "Iron Axe",
  "minecraft:apple": "Apple", "minecraft:golden_apple": "Golden Apple", "minecraft:cooked_porkchop": "Cooked Porkchop",
  "minecraft:cooked_chicken": "Cooked Chicken", "minecraft:carrot": "Carrot", "minecraft:baked_potato": "Baked Potato",
  "minecraft:torch": "Torch", "minecraft:iron_sword": "Iron Sword", "minecraft:diamond_sword": "Diamond Sword"
});

/** Foods the bot can eat like a player (restore via regeneration effect + consume). */
export const FOOD_ITEMS = Object.freeze([
  ["minecraft:golden_apple", 10, 1],
  ["minecraft:cooked_beef", 8, 0],
  ["minecraft:cooked_porkchop", 8, 0],
  ["minecraft:cooked_mutton", 6, 0],
  ["minecraft:cooked_chicken", 6, 0],
  ["minecraft:bread", 5, 0],
  ["minecraft:baked_potato", 5, 0],
  ["minecraft:carrot", 3, 0],
  ["minecraft:apple", 4, 0],
  ["minecraft:potato", 1, 0],
  ["minecraft:cookie", 2, 0],
  ["minecraft:melon_slice", 2, 0]
]);

const FOOD_SET = new Set(FOOD_ITEMS.map(([id]) => id));

function itemName(typeId) {
  return DISPLAY_NAMES[typeId] || String(typeId || "unknown").replace(/^minecraft:/, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getContainer(entity) {
  try { return entity.getComponent("minecraft:inventory")?.container || null; } catch { return null; }
}

function itemRecord(item, slot) {
  if (!item) return null;
  let durability;
  try {
    const component = item.getComponent("minecraft:durability");
    if (component) durability = { damage: component.damage, max: component.maxDurability };
  } catch { /* old API versions may not expose durability */ }
  return { slot, id: item.typeId, name: itemName(item.typeId), count: item.amount, durability };
}

export function readInventory(entity) {
  const container = getContainer(entity);
  if (!container) return { slots: [], size: 0, freeSlots: 0, totalItems: 0, equipment: {} };
  const slots = [];
  let totalItems = 0;
  for (let slot = 0; slot < container.size; slot += 1) {
    const record = itemRecord(container.getItem(slot), slot);
    if (record) { slots.push(record); totalItems += record.count; }
  }
  const equipment = {};
  try {
    const component = entity.getComponent("minecraft:equippable");
    for (const name of EQUIPMENT) {
      const slot = EquipmentSlot[name];
      const item = slot ? component?.getEquipment(slot) : undefined;
      if (item) equipment[name] = itemRecord(item, name);
    }
  } catch { /* equipment is optional on older entities */ }
  const compact = [];
  for (const item of slots) {
    const existing = compact.find((entry) => entry.id === item.id);
    if (existing) existing.count += item.count;
    else compact.push({ id: item.id, name: item.name, count: item.count });
  }
  return {
    slots, size: container.size, freeSlots: container.emptySlotsCount, totalItems, equipment,
    selectedItem: equipment.Mainhand || null, summary: compact.slice(0, 16)
  };
}

export function countItem(entity, typeId) {
  const wanted = String(typeId || "").toLowerCase();
  return readInventory(entity).slots.filter((item) => item.id === wanted).reduce((sum, item) => sum + item.count, 0);
}

export function addItem(entity, stack) {
  const container = getContainer(entity);
  if (!container || !stack) return { success: false, reason: "Inventory is unavailable.", remaining: stack };
  try {
    const remaining = container.addItem(stack);
    return { success: !remaining || remaining.amount <= 0, remaining };
  } catch (error) {
    return { success: false, reason: String(error), remaining: stack };
  }
}

export function consumeItem(entity, typeId, amount = 1) {
  const container = getContainer(entity);
  let left = Math.max(0, Number(amount) || 0);
  if (!container || left === 0) return { success: left === 0, consumed: 0 };
  // Prefer mainhand first so "use item" feels player-like.
  try {
    const equipment = entity.getComponent("minecraft:equippable");
    const main = equipment?.getEquipment(EquipmentSlot.Mainhand);
    if (main && main.typeId === typeId) {
      const take = Math.min(left, main.amount);
      if (take === main.amount) equipment.setEquipment(EquipmentSlot.Mainhand, undefined);
      else { main.amount -= take; equipment.setEquipment(EquipmentSlot.Mainhand, main); }
      left -= take;
    }
  } catch { /* fall through to container */ }
  for (let slot = 0; slot < container.size && left > 0; slot += 1) {
    const item = container.getItem(slot);
    if (!item || item.typeId !== typeId) continue;
    const take = Math.min(left, item.amount);
    if (take === item.amount) container.setItem(slot, undefined);
    else { item.amount -= take; container.setItem(slot, item); }
    left -= take;
  }
  return { success: left === 0, consumed: amount - left, remaining: left };
}

export function equipItem(entity, typeId) {
  const container = getContainer(entity);
  if (!container) return { success: false, reason: "Inventory is unavailable." };
  for (let slot = 0; slot < container.size; slot += 1) {
    const item = container.getItem(slot);
    if (!item || item.typeId !== typeId) continue;
    try {
      const equipment = entity.getComponent("minecraft:equippable");
      if (!equipment) return { success: false, reason: "Equipment component is unavailable." };
      const previous = equipment.getEquipment(EquipmentSlot.Mainhand);
      // setEquipment returns void on the stable API — checking its return
      // value treated EVERY equip as rejected (it always "returned"
      // undefined), reported "Item is not accepted by the main hand slot",
      // and skipped the container restore below, so whatever was in the main
      // hand before was silently LOST on every swap. Verify the swap by
      // reading the slot back instead, and always put the previous item back.
      equipment.setEquipment(EquipmentSlot.Mainhand, item);
      const held = equipment.getEquipment(EquipmentSlot.Mainhand);
      if (!held || held.typeId !== typeId) {
        equipment.setEquipment(EquipmentSlot.Mainhand, previous ?? undefined);
        return { success: false, reason: "Item is not accepted by the main hand slot." };
      }
      container.setItem(slot, previous ?? undefined);
      return { success: true, item: typeId };
    } catch (error) {
      return { success: false, reason: `Equipment API rejected item: ${String(error)}` };
    }
  }
  return { success: false, reason: `No ${typeId} in inventory.` };
}

/**
 * Use an item the way a player would: equip it, then apply its effect.
 * Foods restore health via regeneration; torches place; tools stay equipped.
 */
export function useItem(entity, typeId, options = {}) {
  const id = String(typeId || "");
  if (!id) return { success: false, reason: "No item specified." };
  if (countItem(entity, id) < 1) return { success: false, reason: `No ${id} in inventory.` };

  const equipped = equipItem(entity, id);
  // Food may already be in mainhand — equip failure is ok if we can still consume.
  if (FOOD_SET.has(id)) {
    const food = FOOD_ITEMS.find(([foodId]) => foodId === id);
    const eaten = consumeItem(entity, id, 1);
    if (!eaten.success) return { success: false, reason: "Could not consume food." };
    try {
      const amplifier = Number(food?.[2] ?? 0);
      const heal = Number(food?.[1] ?? 4);
      // "saturation" is NOT a Bedrock effect (Java Edition only) — applying it
      // threw on every meal. Hunger refills on its own when the food is
      // consumed, so regeneration is the only effect the bot needs.
      entity.addEffect("regeneration", 60 + (amplifier * 40), { amplifier, showParticles: true });
      return { success: true, used: id, kind: "food", healed: heal };
    } catch { /* effect optional */ }
    return { success: true, used: id, kind: "food", healed: Number(food?.[1] ?? 4) };
  }

  if (id === "minecraft:torch" || id === "minecraft:soul_torch") {
    const place = options.position || {
      x: Math.floor(entity.location.x + (options.facing?.x || 0)),
      y: Math.floor(entity.location.y),
      z: Math.floor(entity.location.z + (options.facing?.z || 0))
    };
    try {
      entity.dimension.runCommand(`setblock ${place.x} ${place.y} ${place.z} ${id} keep`);
      consumeItem(entity, id, 1);
      return { success: true, used: id, kind: "place", position: place };
    } catch (error) {
      return { success: false, reason: `Could not place torch: ${String(error).slice(0, 80)}` };
    }
  }

  // Tools / weapons: equip is the use.
  if (equipped.success || /sword|axe|pickaxe|shovel|hoe|bow|crossbow|trident|shield/.test(id)) {
    if (!equipped.success) {
      // Already in hand or equip rejected — still report success if held.
      const held = readInventory(entity).selectedItem?.id;
      if (held === id) return { success: true, used: id, kind: "equip" };
      return equipped;
    }
    return { success: true, used: id, kind: "equip" };
  }

  return equipped.success
    ? { success: true, used: id, kind: "equip" }
    : { success: false, reason: equipped.reason || "Item cannot be used." };
}

/** Eat the best available food when health is low. */
export function tryEatBestFood(entity) {
  let health;
  try { health = entity.getComponent("minecraft:health"); } catch { return { success: false, reason: "No health component." }; }
  if (!health) return { success: false, reason: "No health component." };
  if (health.currentValue >= health.effectiveMax * 0.85) return { success: false, reason: "Not hungry enough." };
  for (const [id] of FOOD_ITEMS) {
    if (countItem(entity, id) > 0) {
      const result = useItem(entity, id);
      if (result.success) return result;
    }
  }
  return { success: false, reason: "No food in inventory." };
}

export function itemStackFromEntity(itemEntity) {
  try {
    const component = itemEntity.getComponent("minecraft:item");
    const stack = component?.itemStack;
    return stack ? new ItemStack(stack.typeId, stack.amount) : null;
  } catch { return null; }
}

/**
 * Vacuum nearby dropped item entities into the bot inventory, like a player
 * walking over them. Returns how many item stacks were fully taken.
 */
export function pickupNearbyItems(entity, maxDistance = 2.2, filterTypeId = null) {
  const container = getContainer(entity);
  if (!container) return { picked: 0, types: [] };
  let picked = 0;
  const types = [];
  try {
    const items = entity.dimension.getEntities({ location: entity.location, maxDistance, type: "minecraft:item" });
    for (const itemEntity of items) {
      const stack = itemStackFromEntity(itemEntity);
      if (!stack) continue;
      if (filterTypeId && stack.typeId !== filterTypeId) continue;
      const added = addItem(entity, stack);
      const accepted = stack.amount - (added.remaining?.amount || 0);
      if (accepted > 0) {
        picked += 1;
        types.push(stack.typeId);
        if (added.success) {
          try { itemEntity.remove(); } catch { /* already gone */ }
        } else if (added.remaining) {
          try { itemEntity.getComponent("minecraft:item").itemStack = added.remaining; } catch { /* leave remainder */ }
        }
      }
    }
  } catch { /* entity query failed mid-tick */ }
  return { picked, types };
}

export { itemName, FOOD_SET };
