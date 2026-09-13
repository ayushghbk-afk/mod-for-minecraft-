/**
 * TOOL SELECTION — AC-16.
 *
 * "Does not unnecessarily use an obviously inappropriate tool when a suitable
 * one is available" needs three separate answers, and the mining code used to
 * approximate all of them with two regexes:
 *
 *   1. which tool FAMILY fits this block (axe for logs, pickaxe for stone/ore,
 *      shovel for dirt/sand/gravel, nothing for leaves);
 *   2. which TIER the block requires before it drops anything at all
 *      (iron ore needs stone+, diamond ore needs iron+);
 *   3. which of the tools actually in the inventory is the best legal choice.
 *
 * Keeping it here (pure, no Bedrock imports) means the acceptance tests can
 * prove the choice without a world, and the engine only has to ask.
 */

/** Best → worst inside each family. Golden tools are fast but brittle: last. */
const PICKAXES = ["minecraft:netherite_pickaxe", "minecraft:diamond_pickaxe", "minecraft:iron_pickaxe", "minecraft:stone_pickaxe", "minecraft:wooden_pickaxe", "minecraft:golden_pickaxe"];
const AXES = ["minecraft:netherite_axe", "minecraft:diamond_axe", "minecraft:iron_axe", "minecraft:stone_axe", "minecraft:wooden_axe", "minecraft:golden_axe"];
const SHOVELS = ["minecraft:netherite_shovel", "minecraft:diamond_shovel", "minecraft:iron_shovel", "minecraft:stone_shovel", "minecraft:wooden_shovel", "minecraft:golden_shovel"];
const SWORDS = ["minecraft:netherite_sword", "minecraft:diamond_sword", "minecraft:iron_sword", "minecraft:stone_sword", "minecraft:golden_sword", "minecraft:wooden_sword"];

/** Tier order used to answer "is this pickaxe good enough for diamond ore?". */
const TIER = Object.freeze({ wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 });

/** Minimum tier that yields a drop, per block. Anything not listed needs no tool. */
const REQUIRED_TIER = Object.freeze({
  "minecraft:iron_ore": 2, "minecraft:deepslate_iron_ore": 2,
  "minecraft:copper_ore": 2, "minecraft:deepslate_copper_ore": 2,
  "minecraft:coal_ore": 1, "minecraft:deepslate_coal_ore": 1,
  "minecraft:lapis_ore": 2, "minecraft:deepslate_lapis_ore": 2,
  "minecraft:redstone_ore": 3, "minecraft:deepslate_redstone_ore": 3,
  "minecraft:gold_ore": 3, "minecraft:deepslate_gold_ore": 3,
  "minecraft:diamond_ore": 3, "minecraft:deepslate_diamond_ore": 3,
  "minecraft:emerald_ore": 3, "minecraft:deepslate_emerald_ore": 3,
  "minecraft:stone": 1, "minecraft:cobblestone": 1, "minecraft:deepslate": 1,
  "minecraft:cobbled_deepslate": 1, "minecraft:obsidian": 4
});

/** Blocks a shovel is for; everything else in the "soft ground" family. */
const SHOVEL_BLOCKS = /^(dirt|grass_block|sand|red_sand|gravel|clay|coarse_dirt|dirt_with_roots|rooted_dirt|podzol|mycelium|farmland|dirt_path|soul_sand|soul_soil|snow_block|snow)$/;
/** Blocks a pickaxe is for (ores are matched separately by the `_ore` suffix). */
const PICKAXE_BLOCKS = /^(stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|calcite|obsidian|netherrack|blackstone|basalt|end_stone|terracotta|stone_bricks|bricks|furnace|blast_furnace|smoker|iron_block|gold_block|diamond_block|coal_block|copper_block|redstone_block|lapis_block|stonecutter|anvil|brewing_stand|enchanting_table|nether_bricks|end_stone_bricks|prismarine|purpur_block|quartz_block|mossy_cobblestone)$/;

/**
 * Which tool family fits which block. "none" means bare hands are the right
 * answer (leaves, flowers) — the bot must not swap to a tool for those.
 */
export function toolFamily(blockId) {
  const id = String(blockId || "").toLowerCase().replace(/^minecraft:/, "");
  if (/(_log|_wood|wood|_planks|planks)$/.test(id)) return "axe";
  if (/^(crafting_table|chest|trapped_chest|bookshelf|barrel|loom|composter)$/.test(id)) return "axe";
  if (SHOVEL_BLOCKS.test(id)) return "shovel";
  if (/_ore$/.test(id) || PICKAXE_BLOCKS.test(id)) return "pickaxe";
  return "none";
}

/** The tier (1–5) an item id represents, or 0 for a non-tool. */
export function toolTier(itemId) {
  const id = String(itemId || "").toLowerCase();
  for (const [name, tier] of Object.entries(TIER)) if (id.startsWith(`minecraft:${name}_`)) return tier;
  return 0;
}

/** Minimum tier this block needs to drop anything (0 = bare hand is fine). */
export function requiredTier(blockId) {
  return Number(REQUIRED_TIER[String(blockId || "").toLowerCase()] || 0);
}

/** Candidate tools for a block, best first. Empty when no tool helps. */
export function candidatesFor(blockId) {
  const family = toolFamily(blockId);
  if (family === "axe") return AXES;
  if (family === "pickaxe") return PICKAXES;
  if (family === "shovel") return SHOVELS;
  return [];
}

/**
 * Pick the best tool for `blockId` out of the ids the bot actually has.
 * `heldIds` is a list of item ids in inventory (a Set or array).
 *
 * @returns {{family:string, best:string|null, meetsRequirement:boolean, required:number, heldTier:number, appropriate:boolean}}
 */
export function chooseTool(blockId, heldIds = []) {
  const held = heldIds instanceof Set ? [...heldIds] : Array.from(heldIds || []);
  const family = toolFamily(blockId);
  const candidates = candidatesFor(blockId);
  const best = candidates.find((id) => held.includes(id)) || null;
  const required = requiredTier(blockId);
  const heldTier = best ? toolTier(best) : 0;
  return {
    family,
    best,
    required,
    heldTier,
    meetsRequirement: required === 0 || heldTier >= required,
    /** An obviously wrong tool in hand (a shovel facing an ore) is a bug worth reporting. */
    appropriate: family === "none" || Boolean(best)
  };
}

/**
 * Is the item currently in hand a sensible choice for this block? Used to
 * decide whether a swap is needed at all (AC-16: "does not *unnecessarily*
 * use an inappropriate tool" — so an appropriate tool already in hand is left
 * alone, and the durability is not wasted on a swap).
 */
export function isAppropriate(heldItemId, blockId) {
  const family = toolFamily(blockId);
  const id = String(heldItemId || "");
  if (family === "none") return true;
  if (!id) return false;
  if (family === "axe") return AXES.includes(id);
  if (family === "pickaxe") return PICKAXES.includes(id);
  if (family === "shovel") return SHOVELS.includes(id);
  return false;
}

/**
 * The sentence to show a player when mining cannot legally succeed
 * (AC-32: "I don't have a suitable tool.").
 */
export function toolGapMessage(blockId, choice) {
  const block = String(blockId || "").replace(/^minecraft:/, "").replace(/_/g, " ");
  if (!choice.best && choice.family !== "none") {
    return `I don't have a ${choice.family} for ${block}.`;
  }
  if (!choice.meetsRequirement) {
    const tierName = Object.keys(TIER).find((name) => TIER[name] === choice.required) || "better";
    const article = /^[aeiou]/.test(tierName) ? "an" : "a";
    return `I need at least ${article} ${tierName} ${choice.family} for ${block}.`;
  }
  return "";
}

/** Best weapon available, for combat (AC-23). Swords first, then axes. */
export function chooseWeapon(heldIds = []) {
  const held = heldIds instanceof Set ? [...heldIds] : Array.from(heldIds || []);
  return [...SWORDS, ...AXES].find((id) => held.includes(id)) || null;
}

/** Weapon damage by tier — close to vanilla player swings. */
export function weaponDamage(itemId) {
  const id = String(itemId || "");
  if (id.includes("netherite_sword")) return 8;
  if (id.includes("diamond_sword")) return 7;
  if (id.includes("iron_sword")) return 6;
  if (id.includes("stone_sword")) return 5;
  if (id.includes("golden_sword") || id.includes("wooden_sword")) return 4;
  if (id.includes("netherite_axe")) return 7;
  if (id.includes("diamond_axe")) return 6;
  if (id.includes("iron_axe")) return 5;
  if (id.includes("axe")) return 4;
  return 3;
}

export { PICKAXES, AXES, SHOVELS, SWORDS, TIER, REQUIRED_TIER };
