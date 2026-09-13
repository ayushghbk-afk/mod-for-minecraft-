import { ItemStack } from "@minecraft/server";
import {
  addItem, consumeItem, countItem, equipItem, getContainer, itemStackFromEntity,
  pickupNearbyItems, readInventory, tryEatBestFood, useItem
} from "./inventory.js";
import { setBotStatus, BotState } from "./status.js";
import { MOVEMENT_SPEEDS, findReachCell, moveEntityTowards, stopEntity, withinSwingReach, distance as navDistance } from "./navigation.js";
import { isCreeperType, isHostileType } from "./observation.js";
import { CREEPER_SAFE_DISTANCE } from "./priority.js";
import { chooseTool, chooseWeapon, isAppropriate, toolGapMessage, weaponDamage } from "./tools.js";

function blockAt(dimension, position) {
  try {
    const value = Array.isArray(position) ? { x: position[0], y: position[1], z: position[2] } : position;
    return dimension.getBlock({ x: Math.floor(value.x), y: Math.floor(value.y), z: Math.floor(value.z) });
  } catch { return null; }
}
function targetPosition(agent) { return agent.runtime.targetBlock || agent.runtime.targetPosition || null; }
/**
 * Creeper numbers, in one place: it ignites inside ~3 blocks and detonates
 * about 1.5 s later, so the bot strikes from just outside that and stays out
 * for longer than the fuse (AC-24).
 */
const CREEPER_STANDOFF = 3.0;
const CREEPER_STRIKE_RANGE = 3.2;
const CREEPER_FUSE_MS = 2600;

/** One classifier for the whole pack — see observation.isHostileType. */
const hostile = isHostileType;

/** A point `range` blocks directly away from `threat`, for backing off. */
function awayFrom(origin, threat, range) {
  const dx = origin.x - threat.x;
  const dz = origin.z - threat.z;
  const length = Math.hypot(dx, dz) || 1;
  return { x: origin.x + (dx / length) * range, y: origin.y, z: origin.z + (dz / length) * range };
}
function hasLineOfSight(dimension, from, to) {
  const steps = Math.max(2, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) * 2));
  for (let index = 1; index < steps; index += 1) {
    const t = index / steps;
    const value = blockAt(dimension, {
      x: from.x + (to.x - from.x) * t,
      y: from.y + 1.2 + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t
    });
    if (value && !["minecraft:air", "minecraft:cave_air", "minecraft:void_air", "minecraft:short_grass", "minecraft:tall_grass"].includes(value.typeId)) {
      return false;
    }
  }
  return true;
}

function setAttackingFlag(entity, on) {
  try {
    if (typeof entity.setProperty === "function") entity.setProperty("aibot:attacking", Boolean(on));
  } catch { /* property optional */ }
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
        case "use_item":
        case "eat_food": return this.useOrEat(action);
        case "return_home": return this.returnHome(action);
        case "explore": return this.explore(action);
        case "build": return this.build(action);
        case "open_chest": return this.openChest(action);
        case "store_item": return this.storeItem(action);
        case "withdraw_item": return this.withdrawItem(action);
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

  /**
   * Pick the target block — and prove it is still there.
   *
   * The observation is a snapshot up to a second old, so a log the bot broke one
   * tick ago is still listed in it. Acting on that snapshot produced the worst
   * failure this pack ever had: the bot "mined" air, the verification branch saw
   * the cell it had already broken and reported "Block change verified" a second
   * time, and the task claimed progress for a block that never changed (AC-13,
   * AC-17). Every candidate is therefore re-read from the dimension here.
   */
  findBlock(action) {
    const matches = (this.agent.observation?.nearbyBlocks || []).filter((block) => block.type === action.block);
    for (const match of matches) {
      const [x, y, z] = match.position || match.relative.map((offset, index) => Math.floor([this.bot.location.x, this.bot.location.y, this.bot.location.z][index] + offset));
      const live = blockAt(this.bot.dimension, { x, y, z });
      if (!live || live.typeId !== action.block) continue; // already gone: try the next one
      this.agent.runtime.targetBlock = { x, y, z, type: action.block };
      setBotStatus(this.bot, BotState.SEARCHING, { target: action.block, distance: match.distance });
      return this.result(action, true, "Target block located.", { target: this.agent.runtime.targetBlock });
    }
    // Ask for a fresh snapshot next tick instead of re-reading the same stale one.
    this.agent.runtime.needsObservation = true;
    setBotStatus(this.bot, BotState.SEARCHING, { target: action.block });
    return this.result(action, false, matches.length
      ? `Every ${action.block} I could see is already gone; looking again.`
      : `No ${action.block} was found within the observation radius.`);
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

  /**
   * Walk to the target. For a block target the destination is a cell the bot can
   * stand in AND swing from — never the block itself, which is solid: routing at
   * a log always answered "no walkable path", and that is how a bot gave up on
   * the top log of a tree it was already standing under (AC-05/AC-14/AC-15).
   */
  moveToTarget(action) {
    const target = targetPosition(this.agent);
    if (!target) return this.result(action, false, "There is no target to approach.");
    // Vacuum drops while walking so the bot behaves like a player.
    pickupNearbyItems(this.bot, 2.0);
    const speed = this.agent.combatMode ? MOVEMENT_SPEEDS.sprint : MOVEMENT_SPEEDS.walk;
    const reachCell = this.agent.runtime.targetBlock === target
      ? findReachCell(this.bot.dimension, target, this.bot.location)
      : null;
    const goal = reachCell ? { x: reachCell.x + 0.5, y: reachCell.y, z: reachCell.z + 0.5 } : target;
    if (reachCell && navDistance(this.bot.location, goal) <= 0.8) {
      // Already standing where the swing lands: arrival, not "unreachable".
      stopEntity(this.bot);
      setBotStatus(this.bot, BotState.WALKING, { target: target.type || "block", distance: navDistance(this.bot.location, target) });
      return this.result(action, true, "In reach of the target block.", { arrived: true, distance: navDistance(this.bot.location, target) });
    }
    // legDistance: a remembered tree or a search ring can be 40 blocks away,
    // which is beyond one bounded A* but not beyond walking (AC-06/AC-08).
    const movement = moveEntityTowards(this.bot, goal, {
      speed,
      stopDistance: reachCell ? 0.8 : 2.0,
      maxRadius: 28,
      legDistance: 20,
      // A mining stance has to be exact: the default 1.05-cell arrival tolerance
      // let the bot declare "Target reached" one cell short of the spot it can
      // actually swing from, and mine_block then failed on every cycle.
      tolerance: reachCell ? 0.75 : undefined
    });
    if (movement.success && movement.arrived) {
      stopEntity(this.bot);
      setBotStatus(this.bot, BotState.WALKING, { target: target.type || "target", distance: movement.distance });
      return this.result(action, true, "Target reached.", { arrived: true });
    }
    setBotStatus(this.bot, BotState.WALKING, { target: target.type || "target", distance: movement.distance });
    return movement.success
      ? this.result(action, false, "Moving toward target.", { pending: true, moving: true, distance: movement.distance })
      : this.result(action, false, movement.reason);
  }

  /**
   * Follow the owner — AC-08, with AC-09's obstacle handling.
   *
   * When the controller has set a detour (the direct line stalled), the bot
   * walks to the detour point first and only then resumes following the player.
   * Without that, a bot that hit a wall simply stood there: following has no
   * plan, so nothing in the plan-failure ladder ever noticed.
   */
  followPlayer(action) {
    this.agent.runtime.follow = true;
    const owner = this.agent.owner();
    if (!owner) return this.result(action, false, "Owner is not online.");
    pickupNearbyItems(this.bot, 2.0);
    let detour = this.agent.runtime.followDetour || null;
    if (detour && navDistance(this.bot.location, detour) < 1.6) {
      this.agent.runtime.followDetour = null;
      detour = null;
    }
    const aim = detour || owner.location;
    // Follow at sprint speed so the bot keeps up with a walking/sprinting player.
    const movement = moveEntityTowards(this.bot, aim, { speed: MOVEMENT_SPEEDS.sprint, stopDistance: detour ? 1.2 : 2.5, maxRadius: 32, legDistance: 24 });
    setBotStatus(this.bot, BotState.FOLLOWING, { target: owner.name, distance: movement.distance });
    return movement.success
      ? this.result(action, false, detour ? "Stepping around an obstacle." : "Following owner.", { pending: true, moving: true, arrived: !detour && movement.arrived === true, detour: Boolean(detour) })
      : this.result(action, false, movement.reason, { moving: false });
  }

  stop(action) {
    this.agent.runtime.follow = false;
    this.agent.runtime.plan = null;
    stopEntity(this.bot);
    setAttackingFlag(this.bot, false);
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
      // Forget the key: without this the SAME broken cell answered "verified"
      // every time the plan came round again, and each answer looked like a
      // freshly mined block (fake progress — the one thing AC-17 forbids).
      this.agent.runtime.lastMinedKey = "";
      return this.result(action, true, "Block change verified.");
    }
    if (!block || block.typeId !== action.block) {
      this.agent.runtime.targetBlock = null;
      return this.result(action, false, `Target is no longer ${action.block}.`);
    }
    // Survival reach, measured the way the game measures it: from the eyes
    // (1.62 m up) to the block centre, about 4.5 m. A flat 5 m radius let the
    // bot "mine" blocks it could never have swung at (AC-15/AC-32).
    if (!withinSwingReach(this.bot.location, target)) {
      return this.result(action, false, "Target is unreachable from the current position.");
    }

    // --- AC-16 TOOL SELECTION -------------------------------------------------
    // One shared table answers: which family fits this block, which tier the
    // block requires, and which of the tools actually in the inventory is best.
    // The bot keeps an appropriate tool that is already in hand (no pointless
    // swap, no wasted durability) and refuses — with a sentence the player can
    // act on — when mining could not legally drop anything (AC-32).
    const heldIds = readInventory(this.bot).slots.map((item) => item.id);
    const choice = chooseTool(action.block, heldIds);
    const inventory = readInventory(this.bot);
    const held = inventory.selectedItem?.id || "";
    if (!isAppropriate(held, action.block) && choice.best) {
      const swap = equipItem(this.bot, choice.best);
      if (!swap.success) {
        this.agent.runtime.lastToolIssue = swap.reason || `Could not equip ${choice.best}.`;
        return this.result(action, false, `I could not equip ${choice.best}: ${swap.reason || "the equipment slot refused it"}.`);
      }
      this.agent.tasks.addAction(`selected ${choice.best} for ${action.block}`);
    }
    const equipped = readInventory(this.bot).selectedItem?.id || "empty hand";
    if (!choice.meetsRequirement) {
      const message = toolGapMessage(action.block, choice) || `A suitable ${choice.family} is required for ${action.block}.`;
      this.agent.runtime.lastToolIssue = message;
      setBotStatus(this.bot, BotState.WAITING, { block: action.block, target: "no suitable tool" });
      return this.result(action, false, message);
    }
    this.agent.runtime.lastToolIssue = "";
    this.agent.runtime.lastToolUsed = equipped;
    setBotStatus(this.bot, BotState.MINING, { block: action.block, progress: this.agent.progressText() });
    if (this.agent.runtime.lastMinedKey !== key) {
      this.bot.dimension.runCommand(`setblock ${target.x} ${target.y} ${target.z} air destroy`);
      this.agent.runtime.lastMinedKey = key;
      this.agent.runtime.lastMinedAt = Date.now();
      return this.result(action, false, "Mining started; waiting for block verification.", { pending: true });
    }
    if (Date.now() - this.agent.runtime.lastMinedAt < 1200) {
      // Keep vacuuming the drop while we wait.
      pickupNearbyItems(this.bot, 3.0);
      return this.result(action, false, "Waiting for block-state verification.", { pending: true });
    }
    this.agent.runtime.targetBlock = null;
    return this.result(action, false, "Mining command completed but the block did not change.");
  }

  /**
   * Pick the drop up — AC-05 step "perform action → verify result" and AC-15.
   *
   * Order matters: a player vacuums the items at their feet first and only then
   * walks to the rest. Walking first meant a drop 2.4 m away — well inside the
   * pickup radius — needed a path, and when no path existed the bot reported
   * "no walkable path" while standing on top of the item it had just mined.
   */
  collectItem(action) {
    const wanted = this.agent.currentCollectionItem();
    const filter = action.item || wanted || null;
    const before = countItem(this.bot, wanted);

    // 1. Vacuum everything already in reach.
    const vacuum = pickupNearbyItems(this.bot, 3.5, filter);
    let collected = vacuum.picked;
    if (!filter) collected += pickupNearbyItems(this.bot, 2.5).picked;
    const after = countItem(this.bot, wanted);
    if (collected > 0 || after > before) {
      this.agent.tasks.addAction(`collected ${Math.max(collected, after - before)} item(s)`);
      setBotStatus(this.bot, BotState.COLLECTING, { target: wanted, progress: `+${Math.max(0, after - before)}` });
      return this.result(action, true, "Inventory confirms an item was collected.", { collected: Math.max(collected, after - before) });
    }

    // 2. Nothing in reach: is there a matching drop worth walking to?
    let found = false;
    try {
      const items = this.bot.dimension.getEntities({ location: this.bot.location, maxDistance: 12, type: "minecraft:item" });
      let nearest = null;
      let nearestDist = Infinity;
      for (const itemEntity of items) {
        const stack = itemStackFromEntity(itemEntity);
        if (!stack) continue;
        if (filter && stack.typeId !== filter) continue;
        found = true;
        const d = navDistance(this.bot.location, itemEntity.location);
        if (d < nearestDist) { nearest = itemEntity; nearestDist = d; }
      }
      if (nearest && nearestDist > 1.6) {
        const move = moveEntityTowards(this.bot, nearest.location, { speed: MOVEMENT_SPEEDS.walk, stopDistance: 1.2 });
        setBotStatus(this.bot, BotState.COLLECTING, { target: wanted, distance: nearestDist });
        // No walkable path to the drop: fail the action so the plan can retry or
        // give up — returning pending here used to hang the task in COLLECTING
        // forever on an unreachable drop.
        if (!move.success) return this.result(action, false, move.reason || "Dropped item is out of reach.", { distance: nearestDist });
        return this.result(action, false, "Moving to dropped item.", { pending: true, moving: true });
      }
      // Close enough to vacuum on the next pass — release the movement keys like
      // a player who stops walking once the item is in reach.
      stopEntity(this.bot);
    } catch { /* query failed */ }

    // 3. Nothing to collect (yet).
    setBotStatus(this.bot, BotState.COLLECTING, { target: wanted, progress: "+0" });
    if (!found && this.agent.runtime.lastMinedAt > Date.now() - 2500) {
      return this.result(action, false, "Waiting for the verified block drop.", { pending: true });
    }
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
    if (!target) {
      setAttackingFlag(this.bot, false);
      return this.result(action, false, "No combat target.");
    }
    try {
      // Validate the entity is still alive / loaded.
      let valid = true;
      try { valid = target.isValid !== false && target.location !== undefined; } catch { valid = false; }
      if (!valid || target.typeId === "minecraft:item" || !hostile(target.typeId)) {
        setAttackingFlag(this.bot, false);
        this.agent.runtime.combatTarget = null;
        this.agent.runtime.entityTarget = null;
        return this.result(action, false, "Target is not an allowed hostile mob.");
      }

      const distance = Math.hypot(
        this.bot.location.x - target.location.x,
        this.bot.location.y - target.location.y,
        this.bot.location.z - target.location.z
      );

      // Equip the best weapon the bot actually has (AC-23). chooseWeapon() is
      // the same table the acceptance tests check, so "it fought with a
      // shovel" cannot happen silently.
      const inventory = readInventory(this.bot);
      const held = String(inventory.selectedItem?.id || "");
      if (!/sword|axe/.test(held)) {
        const weapon = chooseWeapon(inventory.slots.map((item) => item.id));
        if (weapon) {
          const swap = equipItem(this.bot, weapon);
          if (swap.success) this.agent.runtime.lastWeapon = weapon;
        }
      }

      // --- AC-24 CREEPER SAFETY ---------------------------------------------
      // A creeper is not an ordinary target: walking into it kills the bot and
      // craters the terrain around the player. The bot fights it hit-and-run —
      // close to arm's length, swing once, then get outside the blast radius
      // and wait for the fuse to drop before coming back in.
      if (isCreeperType(target.typeId)) {
        const sinceStrike = Date.now() - (this.agent.runtime.lastAttackAt || 0);
        const fused = sinceStrike < CREEPER_FUSE_MS;
        // (1) Inside the blast radius — whether the fuse is lit or the bot simply
        //     drifted in — the only correct move is OUT. The old code guarded
        //     this branch with `!striking`, so a bot that had closed to arm's
        //     length never backed off: it parked itself two blocks from a lit
        //     creeper and swung until it died (AC-24).
        if (distance < CREEPER_SAFE_DISTANCE && (fused || distance < CREEPER_STANDOFF)) {
          const retreat = awayFrom(this.bot.location, target.location, CREEPER_SAFE_DISTANCE + 2);
          const backing = moveEntityTowards(this.bot, retreat, { speed: MOVEMENT_SPEEDS.sprint, stopDistance: 1.0, maxRadius: 20 });
          this.agent.runtime.lastCombatNote = `backing off from the creeper (${Math.round(distance)}m)`;
          setBotStatus(this.bot, BotState.FLEEING, { target: target.typeId, distance: Math.round(distance) });
          return this.result(action, false, backing.success ? "Backing away from the creeper." : "Cannot back away from the creeper.", { pending: true, moving: backing.success !== false, defensive: true });
        }
        // (2) Outside the blast radius but beyond a swing: close to arm's length
        //     only. The generic approach below stops at 2.0 blocks, which is
        //     inside a creeper's ignition range, so creepers get their own.
        if (distance > CREEPER_STRIKE_RANGE) {
          setAttackingFlag(this.bot, false);
          // Aim at a standoff POINT on this side of the creeper, not at the
          // creeper: routing at the mob itself walks the bot into the ignition
          // radius and the pathfinder's own arrival slack leaves it there.
          const across = Math.hypot(this.bot.location.x - target.location.x, this.bot.location.z - target.location.z) || 1;
          const standoff = {
            x: target.location.x + ((this.bot.location.x - target.location.x) / across) * CREEPER_STRIKE_RANGE,
            y: target.location.y,
            z: target.location.z + ((this.bot.location.z - target.location.z) / across) * CREEPER_STRIKE_RANGE
          };
          const movement = moveEntityTowards(this.bot, standoff, { speed: MOVEMENT_SPEEDS.walk, stopDistance: 0.5, maxRadius: 24 });
          if (!movement.arrived) {
            this.agent.runtime.lastCombatNote = "closing on the creeper to arm's length";
            setBotStatus(this.bot, BotState.ATTACKING, { target: target.typeId, distance: Math.round(distance) });
            return this.result(action, false, movement.success ? "Closing on the creeper." : movement.reason, { pending: true, moving: movement.success !== false });
          }
          // (3) At the stance: swing from here. Waiting to be within 3.2 blocks
          //     of the mob itself deadlocked — the pathfinder considers the
          //     stance reached at 3.7, so the bot stood just outside its own
          //     strike condition and never hit the creeper at all.
        }
        this.agent.runtime.lastCombatNote = "hit-and-run strike on the creeper";
      } else {
        this.agent.runtime.lastCombatNote = "";
      }

      // Close distance with pathfinder — never freeze out of range. A creeper is
      // excluded: its stance is handled above, and this generic approach stops
      // at 2.0 blocks, inside the ignition radius.
      if (!isCreeperType(target.typeId) && distance > 2.8) {
        setAttackingFlag(this.bot, false);
        const movement = moveEntityTowards(this.bot, target.location, { speed: MOVEMENT_SPEEDS.sprint, stopDistance: 2.0, maxRadius: 24 });
        setBotStatus(this.bot, BotState.ATTACKING, { target: target.typeId, distance });
        return this.result(action, false, movement.success ? "Closing on hostile target." : movement.reason, { pending: true, moving: movement.success !== false });
      }

      // Strafe slightly if blocked line of sight.
      if (!hasLineOfSight(this.bot.dimension, this.bot.location, target.location)) {
        const side = {
          x: this.bot.location.x + (target.location.z - this.bot.location.z) * 0.4,
          y: this.bot.location.y,
          z: this.bot.location.z - (target.location.x - this.bot.location.x) * 0.4
        };
        moveEntityTowards(this.bot, side, { speed: MOVEMENT_SPEEDS.walk, stopDistance: 0.5 });
        setBotStatus(this.bot, BotState.ATTACKING, { target: target.typeId, distance });
        return this.result(action, false, "Repositioning for a clear swing.", { pending: true });
      }

      // In range: stand still and swing, like a player fighting at arm's length.
      stopEntity(this.bot);
      if (isCreeperType(target.typeId) && distance > CREEPER_STRIKE_RANGE + 1.0) {
        return this.result(action, false, "Creeping back into creeper range.", { pending: true, moving: true });
      }
      const now = Date.now();
      const cooldown = 500;
      if (!this.agent.runtime.lastAttackAt || now - this.agent.runtime.lastAttackAt > cooldown) {
        const dmg = weaponDamage(readInventory(this.bot).selectedItem?.id);
        // Prefer applyDamage; fall back to a scripted hurt event.
        let hit = false;
        try {
          target.applyDamage(dmg, { damagingEntity: this.bot, cause: "entityAttack" });
          hit = true;
        } catch {
          try {
            // Some builds only accept a bare number.
            target.applyDamage(dmg);
            hit = true;
          } catch {
            try {
              this.bot.dimension.runCommand(
                `damage @e[type=${target.typeId},x=${Math.floor(target.location.x)},y=${Math.floor(target.location.y)},z=${Math.floor(target.location.z)},r=2,c=1] ${dmg} entity_attack`
              );
              hit = true;
            } catch { /* last resort failed */ }
          }
        }
        if (hit) {
          this.agent.runtime.lastAttackAt = now;
          setAttackingFlag(this.bot, true);
          // Face the target with a rotation only. The old "same-location
          // teleport" re-synced the whole entity every swing, which shows up
          // as a hitch on mobile.
          try {
            const dx = target.location.x - this.bot.location.x;
            const dz = target.location.z - this.bot.location.z;
            if (Math.hypot(dx, dz) > 0.01 && typeof this.bot.setRotation === "function") {
              this.bot.setRotation({ x: 0, y: Math.atan2(-dx, dz) * (180 / Math.PI) });
            }
          } catch { /* optional */ }
        }
      } else {
        setAttackingFlag(this.bot, true);
      }

      setBotStatus(this.bot, BotState.ATTACKING, { target: target.typeId, distance: Math.round(distance * 10) / 10 });

      // Check if the target died.
      try {
        const health = target.getComponent("minecraft:health");
        if (!health || health.currentValue <= 0) {
          setAttackingFlag(this.bot, false);
          this.agent.runtime.combatTarget = null;
          this.agent.runtime.entityTarget = null;
          // Loot vacuum after a kill.
          pickupNearbyItems(this.bot, 4.0);
          return this.result(action, true, "Threat defeated.");
        }
      } catch {
        // Entity removed mid-tick counts as a kill.
        setAttackingFlag(this.bot, false);
        this.agent.runtime.combatTarget = null;
        this.agent.runtime.entityTarget = null;
        pickupNearbyItems(this.bot, 4.0);
        return this.result(action, true, "Threat defeated.");
      }

      return this.result(action, false, "Attack applied; waiting for threat verification.", { pending: true });
    } catch (error) {
      setAttackingFlag(this.bot, false);
      return this.result(action, false, `Attack failed: ${String(error)}`);
    }
  }

  defendPlayer(action) {
    const owner = this.agent.owner();
    if (!owner) return this.result(action, false, "Owner is not online.");
    try {
      const threats = owner.dimension.getEntities({ location: owner.location, maxDistance: 14 })
        .filter((entity) => hostile(entity.typeId));
      threats.sort((a, b) => navDistance(owner.location, a.location) - navDistance(owner.location, b.location));
      const threat = threats[0];
      if (!threat) {
        // Stay near owner while defending with nothing to hit.
        moveEntityTowards(this.bot, owner.location, { speed: MOVEMENT_SPEEDS.walk, stopDistance: 3 });
        setAttackingFlag(this.bot, false);
        return this.result(action, true, "No hostile target is currently near the owner.");
      }
      this.agent.runtime.combatTarget = threat;
      return this.attackEntity({ type: "attack_entity" });
    } catch { return this.result(action, false, "Could not inspect threats near the owner."); }
  }

  equip(action) {
    const result = equipItem(this.bot, action.item);
    if (result.success) this.agent.tasks.addAction(`equipped ${action.item}`);
    return this.result(action, result.success, result.reason || "Item equipped.");
  }

  useOrEat(action) {
    const item = action.item || action.food;
    if (item) {
      const result = useItem(this.bot, item, { position: action.position });
      if (result.success) {
        setBotStatus(this.bot, result.kind === "food" ? BotState.EATING : BotState.IDLE, { target: item });
        this.agent.tasks.addAction(`used ${item}`);
      }
      return this.result(action, result.success, result.reason || `Used ${item}.`, result);
    }
    const ate = tryEatBestFood(this.bot);
    if (ate.success) {
      setBotStatus(this.bot, BotState.EATING, { target: ate.used });
      this.agent.tasks.addAction(`ate ${ate.used}`);
    }
    return this.result(action, ate.success, ate.reason || "Ate food.", ate);
  }

  returnHome(action) {
    const owner = this.agent.owner();
    // A "come here" order means come to where the player IS: someone who walks
    // off while the bot is on its way expects the bot to keep coming, not to
    // arrive at the empty spot they were standing in (AC-36).
    const target = this.agent.runtime.cameTo && owner
      ? owner.location
      : (this.agent.runtime.home || owner?.location);
    if (!target) return this.result(action, false, "Home or owner location is unavailable.");
    pickupNearbyItems(this.bot, 2.0);
    // Home can be a long walk; legs keep the bounded search from calling it
    // unreachable just because it is beyond one A* (AC-06/AC-08).
    const movement = moveEntityTowards(this.bot, target, { speed: MOVEMENT_SPEEDS.sprint, stopDistance: 2.5, maxRadius: 32, legDistance: 24 });
    setBotStatus(this.bot, BotState.RETURNING, { target: owner?.name || "home", distance: movement.distance });
    if (movement.success && movement.arrived) return this.result(action, true, "Returned.");
    return this.result(action, false, movement.reason || "Returning.", { pending: true, moving: movement.success !== false });
  }

  /**
   * Walk to a point and look around — the engine half of a search (AC-13).
   *
   * Two details matter. Directions come from a golden-angle counter rather than
   * the clock, so consecutive explores cover different ground instead of
   * re-rolling nearly the same bearing. And a point that cannot be reached —
   * inside a hill, across a ravine — must NOT pend forever: that froze the bot
   * mid-search with "Exploring" on its status line and no plan failure to break
   * the deadlock (AC-09).
   */
  explore(action) {
    if (!this.agent.runtime.exploreTarget) {
      const turn = (this.agent.runtime.exploreTurn = ((this.agent.runtime.exploreTurn || 0) + 1) * 2.399963229728653);
      this.agent.runtime.exploreTarget = {
        x: this.bot.location.x + Math.cos(turn) * 14,
        y: this.bot.location.y,
        z: this.bot.location.z + Math.sin(turn) * 14
      };
    }
    pickupNearbyItems(this.bot, 2.0);
    const movement = moveEntityTowards(this.bot, this.agent.runtime.exploreTarget, { speed: MOVEMENT_SPEEDS.walk, stopDistance: 2, maxRadius: 24, legDistance: 18 });
    setBotStatus(this.bot, BotState.EXPLORING, { distance: movement.distance });
    if (movement.success && movement.arrived) {
      this.agent.runtime.exploreTarget = null;
      this.agent.runtime.exploreRetries = 0;
      return this.result(action, true, "Exploration point reached.");
    }
    if (!movement.success) {
      const retries = (this.agent.runtime.exploreRetries = (this.agent.runtime.exploreRetries || 0) + 1);
      this.agent.runtime.exploreTarget = null; // pick a new bearing next tick
      if (retries > 3) {
        this.agent.runtime.exploreRetries = 0;
        return this.result(action, false, movement.reason || "Exploration point unreachable.");
      }
      return this.result(action, false, "That way is blocked; trying another direction.", { pending: true });
    }
    return this.result(action, false, movement.reason || "Exploring.", { pending: true, moving: true });
  }

  build(action) {
    if (!action.position) return this.result(action, false, "Build requires an explicit validated position.");
    const existing = blockAt(this.bot.dimension, action.position);
    if (existing && existing.typeId !== "minecraft:air" && existing.typeId !== "minecraft:cave_air") {
      return this.result(action, false, "Build target is occupied.");
    }
    const item = action.block.replace("_log", "_planks");
    if (countItem(this.bot, item) < 1 && countItem(this.bot, action.block) < 1) {
      return this.result(action, false, `No ${item} available.`);
    }
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
      craft_item: "Crafting tables are not a stable programmable recipe API in the targeted version.",
      smelt_item: "Furnace automation is isolated until a supported inventory interaction API is available.",
      sleep: "Bed use is not a stable programmable interaction in the targeted API.",
      interact: "Generic interactions are intentionally not delegated to untrusted AI output."
    };
    return this.result(action, false, reasons[action.type] || "Action is not supported.");
  }
}
