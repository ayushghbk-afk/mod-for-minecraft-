# Bedrock 26.40 Compatibility Migration Report

Audit date: 2026-09-12. Baseline: Minecraft Bedrock stable 26.40+, `@minecraft/server` 2.9.0 and `@minecraft/server-ui` 2.1.0. No experiments are required.

## Root causes found

1. Manifests targeted Bedrock 26.0 / server 2.5 while current stable documentation and npm definitions expose server 2.9 and UI 2.1.
2. The resource pack depended on the behavior pack. The load-bearing relation was reversed: the behavior pack now depends on its required resources.
3. `minecraft creeper` was an invalid identifier, preventing exact hostile classification.
4. `Player.selectedSlot` and comments claiming a 2.x rename were wrong. Stable 2.9 uses `selectedSlotIndex`.
5. Entity validity was treated as an old method; stable 2.x exposes `Entity.isValid` as a property.
6. UI forms still passed positional primitive defaults. UI 2.1 requires option objects (`{defaultValue}`, `{defaultValueIndex}`).
7. The companion lacked `minecraft:persistent`, so normal mob despawn rules could remove it after distance/reload.
8. Normal movement teleported the entity every action tick. It did not behave as physical walking and its “pathfinding” only tested five immediate positions.
9. Observation mixed all entities into one list and omitted structured players, mobs, items, directions, game mode, health, and danger fields.
10. Resource JSON had no movement/look animation binding, making the bot slide even when it moved.
11. Equipment replacement discarded the previously held item. Build-position verification also passed an array to an object-only block lookup.
12. Combat chose only the nearest target, did not check line of sight, did not equip a weapon, and had no low-health flee/eat priority.
13. Mining did not select or enforce a suitable tool tier.

## Migration

- Manifests: pack version 2.0.0; `min_engine_version` 1.26.40; stable server 2.9.0; stable UI 2.1.0; BP→RP dependency; unique existing UUIDs retained to allow upgrades.
- Script API: `Entity.isValid()` → `Entity.isValid`; `Player.selectedSlot` fallback → `Player.selectedSlotIndex`; `ModalFormData.textField(..., value)` → `textField(..., {defaultValue: value})`; dropdown/toggle defaults likewise use UI 2.1 option objects. Movement uses stable `clearVelocity()` and `applyImpulse(Vector3)`.
- Entity: format 1.26.40, strict interaction event, persistence group, walking/navigation/physics, follow range, attack, collision, inventory, equipment, and conditional bandwidth optimization.
- Movement: bounded local A* (160 nodes normally, 240 on recovery), physical waypoint movement, step-up impulses, hazard checks, progress/stuck tracking, route replanning, and teleport only after a genuine five-second stall plus three failed replans.
- Vision: structured `{players,mobs,blocks,nearbyItems,danger,threats}` snapshots; correct namespaced IDs; direction, relative position, distance, health and available game mode.
- Memory: bounded completed/failed tasks plus known resources, players, locations, danger zones and recent events, persisted in entity dynamic properties.
- Inventory: compact grouped summaries, selected main-hand item, safe equipment swapping, durability and slot records.
- Mining: tool selection/tier validation, approach, allowlisted destroy command, block verification, real drop pickup, inventory verification, and progress update.
- Combat: threat priority, weapon selection, wall check, cooldown, low-health food/regeneration, flee state, task pause/resume.
- Presentation: resource-specific mining labels and animated player-like limbs/head.

## Stable API limitations

- Bedrock stable Script API has no general custom-mob `breakBlock` or player-equivalent swing/use pipeline. Mining therefore uses one fixed, coordinate-validated `setblock ... air destroy` command and verifies both block state and real drops. Raw AI text can never issue it.
- A custom entity is not a simulated `Player`; it cannot use normal player hunger, recipe UI, beds, shields, or every item. Food is represented by consuming an owned food item and applying stable regeneration.
- Stable mobile/Realm scripting has no portable outbound HTTP client. External AI requires a separately configured supported host bridge; deterministic fallback remains functional.
- Bedrock itself cannot be launched in this CI sandbox. JSON, UUIDs, imports, JavaScript, tests, archive structure and current npm API definitions are validated here; device/world matrix testing remains a release-gate checklist in `DEVELOPMENT.md`.

## v2.0.1 hotfix — entity definitions were never registered

Symptom: `[AI Bot v2.0.0] Script loaded`, then
`Auto-summon failed: Could not spawn aibot:companion. Game said: Invalid value passed to argument [0]. 'aibot:companion' is not a valid entity type.`
— reported on worlds created *after* the add-on was installed, which rules out "pack not active".

Cause: both entity files used `"format_version": "1.26.40"`, i.e. the *game* version. Entity JSON uses
a separate content format-version scale; Mojang's samples top out at `1.21.50` for
`minecraft:entity` and `1.10.0` for `minecraft:client_entity`. An unrecognised value makes the
content parser drop the definition without an in-game error, so the scripts load normally while
`aibot:companion` is never registered as an entity type.

Fix:
- `behavior_packs/autonomous_ai_bot/entities/companion.json` → `format_version` `1.21.50`.
- `resource_packs/autonomous_ai_bot/entity/companion.entity.json` → `format_version` `1.10.0`.
- `scripts/package.mjs` fails the build if any behaviour/client entity exceeds those versions.
- `tests/compatibility.test.mjs` asserts the same bound plus the identifier and `is_summonable`.
- The spawn-failure message no longer blames an inactive pack when the scripts are demonstrably running.
- Pack/script version bumped to 2.0.1 so the fixed copy is distinguishable in the join banner.

## v2.2.0 — invisible bot + player-like movement

Two field reports addressed at once: *"bot is invisible / not showing in the
world"* and *"movement does not feel like a player"*.

### Invisible / not showing in the world

The entity now spawns **visible** and the render chain is audited in CI:

- **Spawn into open space only.** `create()` now filters its spawn candidates
  with `isSafeCell` (open feet + head, solid floor) and, if the bot still ends
  up inside solid blocks, `relocateToSafeCell()` teleports it to the nearest
  standing-open cell (spiral search, radius 4). A bot embedded in terrain is
  the classic "bot not in the world" report — the entity exists but is
  swallowed by the blocks.
- **Geometry hardened.** Every bone in `aibot.player.geo.json` now carries an
  explicit `pivot` **and** `rotation`. A missing bone rotation is a documented
  cause of "entity exists but does not render".
- **Client-entity Molang fixed.** The `pre_animation` script called
  `math.max(a, b, c)` with three arguments; Molang `math.max` takes exactly
  two. An invalid expression in the client entity scripts risks Bedrock
  dropping the whole client entity — the bot then exists but renders nothing.
  The call is now nested two-argument `math.max`.
- **Animation controller hardened.** Boolean property transitions now use the
  classic `query.property('aibot:attacking') == 1.0 / == 0.0` numeric form.
- **Owners get an answer.** `/aibot:create` now reports the bot's exact
  coordinates plus an explicit "if you see the name but no body, activate
  Autonomous AI Bot - Resources" tip; `/aibot:info` lists each bot's position
  and explains the name-only vs. nothing-at-all distinction.
- **New CI guard.** `tests/compatibility.test.mjs` audits the full render
  chain (texture file on disk, geometry identifier + per-bone pivot/rotation,
  every animation/controller/render-controller reference resolves, controller
  states only play defined animations, no 3-argument `math.max` anywhere in
  the resource pack) so an invisible-bot regression fails the build.

### Player-like movement

The old movement applied `applyImpulse` every action tick (5 game ticks):
velocity accumulated past player speed and the constant upward component made
the bot hop every half second. Movement is now continuous velocity control,
like a player holding the movement keys:

- `moveEntityTowards()` only refreshes a per-entity **steering state**
  (direction, constant speed, step-up flag); it no longer injects impulses.
- New `applyPlayerStep()` runs **every game tick** (1-tick `stepMovement()`
  job in `main.js`): horizontal velocity lerps toward the travel direction
  (natural acceleration/turning), the vertical velocity is preserved (real
  gravity — no hopping), and a jump impulse of 0.42 blocks/tick (vanilla
  player jump) is applied only for a genuine step-up while grounded.
- Speeds match a player: walk 0.215 blocks/tick (≈4.3 m/s), sprint 0.279
  (≈5.6 m/s, used for follow/return/approach).
- `stopEntity()` replaces instant `clearVelocity()`: the bot decelerates
  (0.6× per tick) like a player releasing the keys. Steering states expire
  after 1.5 s without a refresh, so a bot whose AI stops issuing movement
  eases to a stop instead of drifting.
- Pack/script version bumped to 2.2.0 so the fixed build is distinguishable
  in the join banner.

## v2.2.1 hotfix — unreachable targets, item loss on swap, invalid effect

Five bugs found during a full code audit of the v2.2.0 build:

1. **Items were silently lost on every equipment swap.** `equipItem()`
   checked the return value of `EquippableComponent.setEquipment()`, but the
   stable API returns **void** — so every equip "returned" `undefined`, was
   treated as rejected ("Item is not accepted by the main hand slot"), and
   skipped the line that puts the previous main-hand item back into the
   container. The swap itself happened, but the old item (a sword, a food
   item, a tool) just disappeared. The swap is now verified by reading the
   slot back, and the previous item is always restored to the container.
2. **`findLocalRoute()` returned partial "routes" to dead ends.** When A*
   exhausted its node budget without reaching the goal, it returned a path
   to the best cell found — for a target inside the search region behind a
   wall, that is the cell *in front of the wall*. The bot walked there,
   shoved, got flagged stuck, and entered the recovery loop below. The
   pathfinder now returns an empty route (the "unreachable" verdict) when
   the goal is inside the search region but not reached, while a goal outside
   the region still yields the partial route that powers long-range follow.
3. **The bot teleported in place on unreachable targets.** With the partial
   dead-end routes, `recover()` re-planned, found no movement, and — after
   two failures — teleported the bot to a neighbouring cell… every ~7 s,
   forever, with no task to fail (a following bot whose owner is in a house
   or on a ledge). `recover()` now only teleports when a REAL route exists
   but the bot is stuck on it.
4. **Unreachable targets caused a full A* replan storm.** `routeState()`
   treated every empty route as stale, so each 5-tick planning call re-ran
   the full bounded A* (and `recover()` added a second one every 3.5 s).
   Empty routes are now tracked as `noRoute`: re-check as soon as the target
   moves (so recovery is immediate when a path opens) and otherwise at a
   calm 1.5 s cadence. On a `noRoute` verdict `moveEntityTowards()` eases
   the bot to a stop and reports `No walkable path to the target.`, so
   plans fail fast and deterministically (task: "Target unreachable…")
   instead of churn.
5. **`useItem()` applied a `"saturation"` effect** — a Java Edition concept
   that does not exist in Bedrock; the call threw on every meal (swallowed
   by the "effect optional" catch). Removed; hunger refills itself when the
   food is consumed.

Related small fixes found in the same audit:

- `collect_item` now fails the action when the dropped item is unreachable
  instead of returning `pending` forever (the task hung in COLLECTING).
- `attack_entity` faces the target with `setRotation()` instead of a
  same-location `teleport()` every swing, which re-synced the whole entity
  and showed up as a hitch on mobile.

Tests: three new regression tests (unreachable-target behaviour incl. no
teleport + throttled replans + recovery when a gap opens; collect_item fast
fail on an unreachable drop; eating only applies valid Bedrock effects and
restores the previous main-hand item). Pack/script version bumped to 2.2.1.
## v2.3.0 — the pack has to diagnose itself

The reports this pack keeps getting are not "the code is wrong" but **"nothing happens and
nothing is printed"**. That is a tooling gap, not a logic bug: the target API has no content
log on mobile, and the codebase had ~40 `catch` blocks whose comments promised the failure was
harmless ("entity unloading", "optional", "best effort") while giving no way to prove it. The
bot tick loop, the movement step, mining, the provider request and even `spawnEntity` could
each throw every tick and the player would see a silent mod.

Added in v2.3.0, all of it reachable without chat, without commands and without cheats:

- **Test mode** (`core/testmode.js`): `/aibot:debug on|log|watch|clear|status|off`. Every
  caught error goes to a bounded 30-entry log stored in the `aibot:testlog` world dynamic
  property (so it survives a reload and exists before anyone joins), and while test mode is on
  each new one is echoed to every player. Repeats of the same signature fold into `×N` with a
  20 s echo cooldown and at most 6 chat lines per flush, because a per-tick failure must not
  become a chat flood. "Dead-mod-shaped" failures (spawn rejected, restore failed, tick loop
  stalled, command registration refused) are echoed even with test mode off.
- **Measured liveness** instead of assumptions: `main.js` beats once per AI loop and once per
  movement step; the sampler runs on its own interval and reports a stalled loop, plus
  measured ticks/second. "Script loaded but frozen" now has a line of its own.
- **The self-test** (`core/selftest.js`): `/aibot:test`, 20+ checks across six groups (loading,
  commands, world & pack, your bot, movement & mining, AI provider). Each check calls the same
  API the bot calls — a real `spawnEntity` probe, a real `findLocalRoute` from the bot to the
  owner, a real `runCommand` permission probe, a real world-property round-trip — so a failing
  check is a failure the bot hits too. Every failure carries a fix, is written to the error
  log, and the report is chunked because Bedrock truncates long chat messages.
  `/aibot:test net` adds one real request to the configured endpoint and quotes the HTTP
  answer verbatim; the default run never touches the network.
- **The one question a script cannot answer for itself**: the check-up spawns a probe entity,
  asks *"do you see it?"* through a form, and turns "name tag but no body" into
  `✖ visible model → the resource pack is not active`, versus `✖ … did not appear at all` for
  a client that is rendering a stale copy. The probe is explicitly excluded from bot
  auto-registration (`controller.probe.suppressAutoRegister`) so it can never become a phantom
  bot in `/aibot:list`.
- **Per-agent isolation**: one throwing bot used to stop the AI loop for every bot in the world
  (a single `try` around the whole loop). Each agent is now guarded individually, a failing
  agent is reported once per second of failures instead of per tick, and its healthy neighbours
  keep running. The `follow_player` verdict — the difference between "Following you" and a bot
  that stands still — is kept on the agent and shown in `/aibot:status`.
- **Capability-honest wording**: a missing `chatSend` is a `▲` warning when `/aibot:*` or the
  compass menu still works, and only a `✖` failure when *no* input path exists; the create
  confirmation stopped naming the same follow command twice.

No gameplay rule, action validator, movement tuning or manifest dependency changed; the API
floor stays `@minecraft/server` 2.9.0 / `@minecraft/server-ui` 2.1.0 on Bedrock 26.40+, and the
harness degrades to a `SILENT_TEST` no-op whose `guard()` still runs the callback, so agents
behave identically with or without it. Pack/script version bumped to 2.3.0.
