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
