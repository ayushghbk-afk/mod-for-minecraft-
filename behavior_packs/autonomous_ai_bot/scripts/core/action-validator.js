export const ACTION_TYPES = Object.freeze([
  "find_block", "find_entity", "move_to_target", "follow_player", "stop",
  "mine_block", "collect_item", "pickup_item", "drop_item", "attack_entity", "defend_player",
  "eat_food", "use_item", "equip_item", "craft_item", "smelt_item", "open_chest",
  "store_item", "withdraw_item", "sleep", "build", "explore", "return_home", "interact"
]);

export const ALLOWED_BLOCKS = Object.freeze(new Set([
  "minecraft:oak_log", "minecraft:spruce_log", "minecraft:birch_log", "minecraft:jungle_log",
  "minecraft:acacia_log", "minecraft:dark_oak_log", "minecraft:mangrove_log", "minecraft:cherry_log",
  "minecraft:stripped_oak_log", "minecraft:stone", "minecraft:cobblestone", "minecraft:deepslate", "minecraft:cobbled_deepslate", "minecraft:dirt",
  "minecraft:grass_block", "minecraft:sand", "minecraft:gravel", "minecraft:coal_ore", "minecraft:deepslate_coal_ore", "minecraft:iron_ore", "minecraft:deepslate_iron_ore", "minecraft:copper_ore", "minecraft:deepslate_copper_ore",
  "minecraft:gold_ore", "minecraft:deepslate_gold_ore", "minecraft:redstone_ore", "minecraft:deepslate_redstone_ore", "minecraft:lapis_ore", "minecraft:deepslate_lapis_ore", "minecraft:diamond_ore", "minecraft:deepslate_diamond_ore",
  "minecraft:crafting_table", "minecraft:chest", "minecraft:trapped_chest", "minecraft:furnace"
]));

const ID_PATTERN = /^minecraft:[a-z0-9_]+$/;

function isFiniteInteger(value) {
  return Number.isFinite(Number(value)) && Number.isInteger(Number(value));
}

function normaliseBlock(value) {
  const block = String(value || "").toLowerCase();
  return block.includes(":") ? block : `minecraft:${block}`;
}

export function validateAction(action, context = {}) {
  if (!action || typeof action !== "object") return { ok: false, reason: "Action is not an object." };
  const type = String(action.type || "").toLowerCase();
  if (!ACTION_TYPES.includes(type)) return { ok: false, reason: `Unsupported action type: ${type || "empty"}.` };
  const result = { ...action, type };
  if (["find_block", "mine_block", "build"].includes(type)) {
    result.block = normaliseBlock(action.block || context.block);
    if (!ID_PATTERN.test(result.block) || !ALLOWED_BLOCKS.has(result.block)) {
      return { ok: false, reason: `Block is not allowlisted: ${result.block}.` };
    }
  }
  if (type === "find_entity" && !/^[a-z0-9_:.]+$/i.test(String(action.entity || ""))) {
    return { ok: false, reason: "Entity type is invalid." };
  }
  if (["collect_item", "pickup_item", "drop_item", "craft_item", "smelt_item", "withdraw_item", "store_item"].includes(type)) {
    const count = action.count === undefined ? 1 : Number(action.count);
    if (!isFiniteInteger(count) || count < 1 || count > 64) return { ok: false, reason: "Count must be an integer from 1 to 64." };
    result.count = count;
  }
  if (action.position !== undefined) {
    if (!Array.isArray(action.position) || action.position.length !== 3 || !action.position.every(isFiniteInteger)) {
      return { ok: false, reason: "Position must be three integer coordinates." };
    }
    const [x, y, z] = action.position.map(Number);
    const origin = context.position;
    if (origin && Math.hypot(x - origin[0], y - origin[1], z - origin[2]) > (context.maxDistance ?? 32)) {
      return { ok: false, reason: "Target is outside the action radius." };
    }
    result.position = [x, y, z];
  }
  if (["equip_item", "use_item", "eat_food", "drop_item", "store_item", "withdraw_item"].includes(type)) {
    const item = action.item || action.food;
    // eat_food may omit item (engine picks best food); use_item/equip require one.
    if (type !== "eat_food" && !ID_PATTERN.test(String(item || ""))) {
      return { ok: false, reason: "Item id is invalid." };
    }
    if (item) result.item = String(item).toLowerCase().includes(":") ? String(item).toLowerCase() : `minecraft:${String(item).toLowerCase()}`;
  }
  return { ok: true, action: result };
}

export function validatePlan(plan, context = {}) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return { ok: false, reason: "Plan must be an object." };
  if (typeof plan.goal !== "string" || plan.goal.length > 200) return { ok: false, reason: "Plan goal is missing or too long." };
  if (!Array.isArray(plan.actions) || plan.actions.length < 1) return { ok: false, reason: "Plan needs at least one action." };
  const limit = context.maxPlanActions ?? 8;
  if (plan.actions.length > limit) return { ok: false, reason: `Plan exceeds the ${limit}-action limit.` };
  const actions = [];
  for (const action of plan.actions) {
    const checked = validateAction(action, context);
    if (!checked.ok) return checked;
    actions.push(checked.action);
  }
  return {
    ok: true,
    plan: {
      thought: typeof plan.thought === "string" ? plan.thought.slice(0, 400) : "",
      goal: plan.goal.slice(0, 200),
      actions
    }
  };
}

export function parsePlanText(text) {
  if (typeof text !== "string") return { ok: false, reason: "Provider response was not text." };
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch {
    return { ok: false, reason: "Provider response was not valid JSON." };
  }
}
