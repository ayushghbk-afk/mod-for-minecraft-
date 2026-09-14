# ACCEPTANCE — every criterion, exercised and marked

Pack: **Autonomous AI Bot** v2.5.0 · Bedrock **26.40+** · `@minecraft/server` **2.9.0** (stable) ·
`@minecraft/server-ui` **2.1.0** (stable) · **no experiments, no cheats, no beta APIs.**

This file is the honest record of whether the pack does what it promises. The rule it is held to:

> A criterion is **PASS** only when the behaviour the criterion asks for was *exercised* and
> observed. "It compiles", "the manifest validates", "the code looks right" are not evidence and
> are never accepted here. Anything that cannot be exercised outside the game is marked as such
> instead of being quietly counted as passing.

## Reproduce it

```bash
npm install
npm run acceptance     # the 45 criteria below, as 47 end-to-end tests
npm test               # acceptance + unit + command + conversation + compatibility suites (146 tests)
npm run typecheck      # tsc over the pack's scripts
```

`npm run acceptance` runs `tests/acceptance.test.mjs`. Every test drives the **real** `main.js`,
the **real** controller, planner, action engine, navigation and observation code — the same modules
the game loads — on top of a simulated Bedrock world (`tests/stubs/bedrock.mjs`,
`tests/stubs/world-sim.mjs`) that provides terrain, gravity, distance-aware entity queries,
`setblock … destroy` drops, a per-tick clock (50 ms/tick) and a chat/command transport. No
production code path is stubbed out to make a test pass; the stubs replace only the game itself.

## Status legend

| Status | Meaning |
| --- | --- |
| **PASS** | Exercised end-to-end in the simulated world; the observed behaviour is the required behaviour. |
| **PASS †** | Exercised end-to-end in simulation, **and** part of the criterion (pixels, on-screen forms, device frame time, chat transport on a specific build) can only be confirmed by a human in the game. The † note says exactly which part. |
| **FAIL** | Not met. Recorded with what happens instead. |

**Current tally: 45 / 45 criteria exercised · 37 PASS · 8 PASS † · 0 FAIL.**

## A · SPAWN & BASIC LIFE

| AC | Criterion | Status | How it was exercised |
| --- | --- | --- | --- |
| AC-01 | Bot spawn | **PASS †** | `/bot:create` → a real `aibot:companion` entity exists in the dimension, owner-bound by dynamic property, spawned only into a standing-open cell (a spawn inside solid blocks is relocated), and the player is told where it stood. Spawn safety and duplicate-creation are covered again by `core.test.mjs` and `command-e2e.test.mjs`. † *Whether the model is visible depends on the resource pack being active in the world; the render chain (client entity → geometry → texture → spawn egg) is verified statically by `compatibility.test.mjs`, but only a human can confirm pixels.* |

## B · PLAYER INTERACTION

| AC | Criterion | Status | How it was exercised |
| --- | --- | --- | --- |
| AC-02 | Player detection | **PASS** | Observation names the owner and separates strangers, with distance and direction; a player 20 blocks off is seen (entity sight is 24 blocks) and a player at 40 is *not* claimed to be seen — "I can't see you" is treated as information, not an error. |
| AC-03 | Natural chat | **PASS †** | A plain sentence in chat ("Steve, come here") is parsed by the intent parser, produces the real order (`comeTo`), and is answered conversationally ("Coming to you."), then the bot actually walks to the player. Typos, prefixes and name-less sentences are covered in `command-e2e.test.mjs`. † *`world.beforeEvents.chatSend` is not exposed by stable `@minecraft/server` 2.9.0 — it exists on preview/host builds. The pack feature-detects it and, where it is absent, the identical intent is carried by `/bot:say …`, the control panel's text field and `/scriptevent aibot:…`; those transports are the ones tested in `slash-command.test.mjs`. Which transport your build has is reported at load and by `/aibot:info`.* |

## C · TASK SYSTEM

| AC | Criterion | Status | How it was exercised |
| --- | --- | --- | --- |
| AC-04 | Task creation | **PASS** | A collect order produces an objective card (goal, block, count, status) — asserted against the card format in `core.test.mjs` too — and an order for an impossible block is refused in words instead of creating a task that can never finish. |
| AC-05 | Task execution | **PASS** | The plan is carried out in the world step by step: route → reach cell → break → pick up, with each action's result observed rather than assumed. |
| AC-06 | Task completion | **PASS** | The objective is met, reported with real numbers, and **not restarted**: 15 s after completion the task is still COMPLETED, no new plan is invented, the four logs are still in the inventory, and the bot brings the work back to the player. |

## D · MOVEMENT

| AC | Criterion | Status | How it was exercised |
| --- | --- | --- | --- |
| AC-07 | Normal movement | **PASS †** | The bot accelerates to player walk/sprint speed (`MOVEMENT_SPEEDS`), holds it, eases to a stop, jumps step-ups, and **never teleports** — a teleport counter is wrapped around the entity for the whole run and asserted to be 0. `core.test.mjs` repeats this for local A* routing around a solid obstacle. † *The on-screen animation (`setMoveAnim` values) is data here; how it looks is a human check.* |
| AC-08 | Following | **PASS** | `/bot:follow` then a walking player: the bot keeps up and settles at a natural distance (not inside the player), picking up drops on the way. |
| AC-09 | Obstacle recovery | **PASS** | Two halves, both exercised. (a) A wall with a way round (11 blocks wide): the bot finds the route around it and reaches the player, with zero teleports and a finite recovery ladder. (b) A wall spanning the whole world: the bot tries the direct line, replans, steps aside alternating left/right, and then says plainly *"I can't reach you — something is in the way… come closer or clear a path"* instead of standing mute or looping. |
| AC-10 | Stuck recovery | **PASS** | An impossible target ends in an honest stop: bounded search attempts (8), bounded no-progress cycles, then a real failure the player can act on — never an endless loop and never a teleport-in-place. |

## E · VISION / OBSERVATION

| AC | Criterion | Status | How it was exercised |
| --- | --- | --- | --- |
| AC-11 | Block recognition | **PASS** | The scan reports Bedrock ids (`minecraft:oak_log`, not `oak log`), with position, distance and direction; a tree 6 blocks away is seen trunk-and-canopy. |
| AC-12 | Entity recognition | **PASS** | Hostiles, animals and item drops are classified separately; a drop on the ground is recognised with its real stack size and a player-facing name; the correctly-namespaced creeper is flagged as a creeper (`core.test.mjs`). |
| AC-13 | Observation accuracy | **PASS** | Everything reported exists — each block/entity in the snapshot is re-read from the world and compared — and stale sightings are refused: a block that has since been removed is not reported as present. |

## F · MINING

| AC | Criterion | Status | How it was exercised |
| --- | --- | --- | --- |
| AC-14 | Basic mining | **PASS** | `/bot:mine stone` breaks a legally breakable block and keeps the drop: cobblestone appears in the inventory and task progress becomes 1. (This is the criterion that exposed the silent-no-op mining bug — see the fix log below.) |
| AC-15 | Wood gathering | **PASS** | A standing 4-log oak becomes four `minecraft:oak_log` in the inventory, including the top log (swing-reach model + walk-to-reach-cell). |
| AC-16 | Tool selection | **PASS** | One table (`core/tools.js`) decides the tool for a block and is the same table the bot uses at runtime; a job with no possible tool is refused in words ("I'd need a diamond pickaxe…"). |
| AC-17 | Mining verification | **PASS** | Progress follows the *world*, not the swing: the block is re-read after the break, one break verifies once (`lastMinedKey`), and a break that did not happen does not increment progress. |

## G · INVENTORY

| AC | Criterion | Status | How it was exercised |
| --- | --- | --- | --- |
| AC-18 | Inventory inspection | **PASS** | The bot reports what it is really carrying (counts read back from the container, held item included exactly once). |
| AC-19 | Inventory-aware planning | **PASS** | A requirement is absolute — a task needing an item the bot lacks does not pretend to proceed — and a task already satisfied by the inventory completes instead of collecting more (`isRepeatOfCompleted`). |

## H · FOOD / HEALTH

| AC | Criterion | Status | How it was exercised |
| --- | --- | --- | --- |
| AC-20 | Low health response | **PASS** | Hurt and carrying food, the bot eats — and the food really disappears from the inventory. Only valid Bedrock effects are applied (no Java-only `saturation`; `core.test.mjs`). |
| AC-21 | No food | **PASS** | Hurt with nothing to eat, it says so once, plainly, instead of pretending to heal or looping the complaint. |

## I · COMBAT

| AC | Criterion | Status | How it was exercised |
| --- | --- | --- | --- |
| AC-22 | Hostile mob detection | **PASS** | A zombie inside the defend radius changes what the bot is doing (priority flips off "task") within one observation cycle. |
| AC-23 | Combat | **PASS** | It fights back: the best weapon it actually owns is equipped (`chooseWeapon`), the mob's health really drops tick by tick until it dies, the kill is reported, and no cheat command (`give`/`kill`/`tp`/`gamemode`) is ever issued. |
| AC-24 | Creeper safety | **PASS** | Measured per tick over the whole fight: the bot never body-blocks (closest approach ≥ 2.4 blocks), spends < 15 % of ticks inside the 3-block ignition radius, no single visit inside it outlasts a creeper fuse (< 25 ticks), most of the fight (> 25 % of ticks) happens outside the 6-block blast radius, and the creeper still takes damage. |
| AC-25 | Combat recovery | **PASS** | A fight that interrupts a task does not destroy it: after the kill the task resumes from its recorded progress and completes. |

## J · MEMORY

| AC | Criterion | Status | How it was exercised |
| --- | --- | --- | --- |
| AC-26 | Current task memory | **PASS** | The bot can say what it is doing and why, in words, with the true progress numbers; memory stays bounded (`core.test.mjs`). |
| AC-27 | Completed task memory | **PASS** | Finished work is remembered and named on a repeat request ("I already collected 4 oak logs…"). |
| AC-28 | Interrupted task | **PASS** | A pause keeps the objective *and* its progress, and records why (`task.interruption.reason` names the follow order that interrupted it). |

## K · PRIORITY SYSTEM

| AC | Criterion | Status | How it was exercised |
| --- | --- | --- | --- |
| AC-29 | Emergency priority | **PASS** | Hurt (20 % health) with a zombie 3 blocks away, the assessed behaviour is `flee` at EMERGENCY (100) — above the task (50) and above eating (95) — and no block is broken while it saves itself. |
| AC-30 | Player command priority | **PASS** | A direct order outranks whatever the bot had planned: `come` interrupts a task, and on completion of a come/follow order the bot returns to the *live* player position, not the spot the player was standing in when they called. |

## L · CHAT STATUS

| AC | Criterion | Status | How it was exercised |
| --- | --- | --- | --- |
| AC-31 | Progress reporting | **PASS** | Milestones are announced with numbers that are true (asserted against the inventory/world, not against the message). |
| AC-32 | Failure reporting | **PASS** | An impossible job (diamond ore with no diamond pickaxe, a resource that does not exist nearby) ends in plain, actionable words after the bounded search ladder is exhausted — no infinite searching, no silent give-up. |

## M · COMMANDS

| AC | Criterion | Status | How it was exercised |
| --- | --- | --- | --- |
| AC-33 | Stop command | **PASS** | `/bot:stop` halts the bot (velocity ≈ 0 within a second), drops the plan, pauses rather than deletes the task, tells the player how to resume or cancel — and *stays* stopped (it no longer re-arms the return-home walk on the next tick). |
| AC-34 | Status command | **PASS †** | `/bot:status` reports health, task and progress, position, load and threat state in one message, with numbers that match the world. † *The message text is verified; the control-panel form that carries the same data is verified as data (fields, labels, bound values) against the `@minecraft/server-ui` stub — how the form renders on screen is a human check.* |
| AC-35 | Follow command | **PASS** | `/bot:follow` starts real following (see AC-08) and is answered in chat. |
| AC-36 | Come command | **PASS** | `/bot:come` walks the bot to the player who called it, and keeps coming if that player moves. |
| AC-37 | Inventory command | **PASS †** | `/bot:inventory` shows the real contents with the names the game uses ("Oak Log ×5", "Steak" for `cooked_beef`), true counts, slot usage and free slots — and never invents items or dumps raw ids at the player. † *As AC-34: text verified here, form rendering in-game.* |

## N · AI FAILURE SAFETY

| AC | Criterion | Status | How it was exercised |
| --- | --- | --- | --- |
| AC-38 | AI unavailable | **PASS** | With the endpoint unreachable/refusing, the bot says so **once** and keeps working on the local fallback planner — tasks still complete (`provider.test.mjs` covers the provider layer). |
| AC-39 | Invalid AI response | **PASS** | A malformed/hostile plan (unknown action, out-of-bounds position, too many actions) is rejected by the validator and never executed; the fallback plan runs instead. |
| AC-40 | Impossible action | **PASS** | The allowlist is *one* list (`ALLOWED_BLOCKS`, a Set) used by both the validator and the runtime — pinned by reading the source, so a second list cannot drift in — and it is enforced: bedrock is refused, oak log is allowed, arbitrary commands are rejected. |

## O · PERFORMANCE

| AC | Criterion | Status | How it was exercised |
| --- | --- | --- | --- |
| AC-41 | No tick flooding | **PASS †** | Measured, not assumed: ≤ 600 block reads per observation, observations at most once per second per bot (the interval is honoured in *game ticks* whatever cadence the loop runs at), entity reads capped, and the counters are visible in `/aibot:info` instead of being a claim. † *These are the budgets the pack keeps in a simulation on a laptop; a phone's actual frame time can only be measured on a device.* |
| AC-42 | Multiple bots | **PASS** | Two bots, two owners: each answers its own owner, does its own work, and one throwing agent no longer stops the others (`duplicate-guard.test.mjs` covers double-activation). |

## P · WORLD RELOAD

| AC | Criterion | Status | How it was exercised |
| --- | --- | --- | --- |
| AC-43 | Save / reload | **PASS †** | The bot, its owner binding, its name, its home and its in-flight task (with progress) are written to dynamic properties and re-adopted on the next load; a bot that cannot be re-adopted is reported rather than silently missing. † *Exercised against a simulated reload (world state cleared, script re-bootstrapped); an actual client restart with a saved world is a human check.* |

## R · CONVERSATION

| AC | Criterion | Status | How it was exercised |
| --- | --- | --- | --- |
| AC-45 | Conversation | **PASS** | The bot is asked four things through the real `/bot:talk` transport — `how are you`, `where are you`, `what are you doing`, and a sentence that means nothing (`asdfghjkl`) — and every one of them is answered, in its own name, with **the numbers the world actually has**: the answer reports `7/20` after the bot is wounded to 7 HP, its true coordinates, and the live objective (`Collect 8 oak_log`) once a task exists. An order phrased at the same box (`get me 8 oak logs`) becomes a real `collect` task with block `minecraft:oak_log` and target 8, and `mine 4 stone` becomes the `mine` kind — the same parser, the same engine, whether the words arrive by command, by the panel's Talk form, or as a chat mention. Nothing internal (`[object Object]`, `undefined`, `NaN`) ever appears in a reply. In-world, `/aibot:acceptance` re-runs the same check against the live bot and prints its verdict. |

## Q · END-TO-END

| AC | Criterion | Status | How it was exercised |
| --- | --- | --- | --- |
| AC-44 | Full player scenario | **PASS** | One continuous run: create → follow the player across the map → take a gather order from a slash command → survive a zombie ambush mid-task without losing the order → finish the order (4/4 logs verified in the inventory) → `/bot:status` tells the truth about the finished job → `/bot:stop` means stop. Zero teleports across the whole scenario, and nothing internal (`[object Object]`, `undefined`, `NaN`) ever reaches the player. |

## What a simulation cannot prove

Recorded so that no PASS above overstates itself:

1. **Pixels.** Models, textures, animations, particles and sounds are verified as data (files exist,
   ids match, render chain complete, format versions parse). Only a human in the game can confirm
   the bot looks right — AC-01 †, AC-07 †.
2. **Forms.** `@minecraft/server-ui` forms are exercised against a stub that records what was shown;
   layout and touch behaviour on a device are human checks — AC-34 †, AC-37 †.
3. **Chat transport.** `world.beforeEvents.chatSend` is a host/preview extension, not part of stable
   2.9.0. The pack detects it and falls back to `/bot:say`, the panel text field and `/scriptevent`;
   which one your build has is printed at load — AC-03 †.
4. **Device performance.** Budgets are measured here (reads/scan, scans/second, entities/scan);
   frame time on a phone is not — AC-41 †.
5. **A real restart.** Reload is simulated by clearing world state and re-bootstrapping the script —
   AC-43 †.

## Bugs this acceptance round found and fixed

Each of these was a promise the pack made and did not keep. They are listed because the criteria
above only mean something if the failures were allowed to surface:

| # | Symptom a player would see | Root cause | Fix |
| --- | --- | --- | --- |
| 1 | `/bot:mine stone` says "on it" and the bot never moves, forever | `planner.js` `fallbackPlan` only handled `kind === "collect"`; `mine` tasks fell through to a bare `stop` action while the task stayed ACTIVE | `fallbackPlan` now handles any block-targeted gather kind (`collect` / `mine` / `gather`) |
| 2 | Bot reports "Target reached" one block short, then "unreachable" every cycle | A* arrival tolerance (1.05 cells) was coarser than a mining stance needs | `findLocalRoute` takes `options.tolerance`; reach-cell moves use 0.75 |
| 3 | Following into a wall = silent freeze; the player waits and nothing happens | The stuck ladder only ran when a *plan* existed; following has none, and "no route at all" was not distinguished from "still walking" | New follow ladder: replan → step aside (alternating sides) → say plainly it cannot reach the player, then keep listening for an opening |
| 4 | Bot parks 2 blocks from a creeper and swings until it dies | The back-off branch was guarded by `!striking`, so once inside arm's length it could never fire | Real hit-and-run: retreat whenever inside the blast radius with a lit fuse or under 3 blocks, approach to a *standoff point* (not to the mob), swing, repeat |
| 5 | Bot stands next to a creeper and never hits it | Waiting to be within 3.2 blocks of the mob deadlocked against the pathfinder's own arrival slack | At the stance (`movement.arrived`) it swings instead of re-closing |
| 6 | A mob 3 blocks away is ignored for up to 5 seconds | The loop runs every 5 ticks but the observation interval was counted in *runs*, so 20 became 100 ticks | `observe()` measures elapsed time against the interval in game ticks (20 ticks = 1 s) |
| 7 | "Investigate the oak canopy" for a tree it is standing next to; order then fails | The trunk band bought six heights for near columns and none beyond ~5.9 blocks — a trunk at 6.4 was invisible while its leaves at 4.2 were seen | Trunk band is now column-complete out to `reach` (3 heights inside 6 blocks, trunk height beyond) within the same 600-cell budget |
| 8 | `/bot:stop` says "I'm standing by" and then walks off | `stop()` cleared the plan but not the `returningAfterTask` flag, so the next tick re-created "Return to player" | `stop()` and `cancel()` clear every movement intent, including the return-home flag |
| 9 | Bot teleports one block when wedged | Navigation's last-resort recovery was a teleport to a neighbouring cell | Recovery is now a jump-and-shoulder impulse — the "never teleports" promise is absolute (asserted with a teleport counter) |
| 10 | "I can't see you" while the player stands 20 blocks away | Entity sight radius was clamped to 16 | Sight is now `min(32, max(radius × 2, 24))` |
| 11 | Inventory summary read `cooked_beef x2` | Summary used raw ids while the detail section used display names | Summary uses the game's names (`itemName`) |
| 12 | "fighting, task paused at ." | A progress fragment was interpolated into a sentence even when there was no task | The clause is emitted only when there is progress to report |

## Known limits that are *not* bugs

- Melee reach, tool speeds and creeper fuse timings are modelled on vanilla values, not read from
  the game (the stable API does not expose them). They are constants in one place each.
- The bot does not craft, smelt, build structures or use beds/boats/minecarts. Refusals for those
  are explicit (AC-40), not silent.
- Pathfinding is local (bounded A*, ≤ 28-block radius, ≤ 560 nodes) with a leg-target carrot for
  long walks. It is not a continent-scale pathfinder, and it says so when it runs out of legs.
