import { EquipmentSlot, ItemStack } from "@minecraft/server";

const EQUIPMENT = ["Head", "Chest", "Legs", "Feet", "Mainhand", "Offhand"];
const DISPLAY_NAMES = Object.freeze({
  "minecraft:oak_log": "Oak Log", "minecraft:stone": "Stone", "minecraft:iron_ore": "Iron Ore",
  "minecraft:coal_ore": "Coal Ore", "minecraft:diamond": "Diamond", "minecraft:iron_ingot": "Iron Ingot",
  "minecraft:bread": "Bread", "minecraft:cooked_beef": "Steak", "minecraft:wooden_pickaxe": "Wooden Pickaxe",
  "minecraft:stone_pickaxe": "Stone Pickaxe", "minecraft:iron_pickaxe": "Iron Pickaxe", "minecraft:iron_axe": "Iron Axe"
});

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
  return { slots, size: container.size, freeSlots: container.emptySlotsCount, totalItems, equipment };
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
      equipment.setEquipment(EquipmentSlot.Mainhand, item);
      container.setItem(slot, undefined);
      return { success: true, item: typeId };
    } catch (error) {
      return { success: false, reason: `Equipment API rejected item: ${String(error)}` };
    }
  }
  return { success: false, reason: `No ${typeId} in inventory.` };
}

export function itemStackFromEntity(itemEntity) {
  try {
    const component = itemEntity.getComponent("minecraft:item");
    const stack = component?.itemStack;
    return stack ? new ItemStack(stack.typeId, stack.amount) : null;
  } catch { return null; }
}

export { itemName };
