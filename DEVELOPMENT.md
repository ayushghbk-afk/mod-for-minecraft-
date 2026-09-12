# Development, tests and known limitations

## Architecture

```text
Minecraft events / Bot entity
        ↓
observation.js → bounded WorldState
        ↓
MemoryStore + TaskManager
        ↓
providerFor / fallbackPlan
        ↓
action-validator.js
        ↓
ActionEngine
        ↓
navigation.js + inventory.js + fixed verified operations
        ↓
status.js / persistence / chat
```

The AI decides a bounded plan. `ActionEngine` decides how an action is carried out, checks game state and returns `{ success, reason }`. A failed or missing provider never bypasses the engine.

## Local tests and automatic builds

Run from the repository root:

```sh
npm test
npm run build
node --check proxy/server.mjs
for f in behavior_packs/autonomous_ai_bot/scripts/**/*.js behavior_packs/autonomous_ai_bot/scripts/*.js; do node --check "$f"; done
```

GitHub Actions is defined in `.github/workflows/build-addon.yml`. Every push, pull request and manual dispatch runs tests, syntax validation and `npm run build`, then uploads a **bedrock-mobile-modpack** artifact (`AI-Bot-Bedrock-Mobile.mcaddon` plus `.mcpack` files). Pushes also update the `bedrock-mobile-latest` GitHub Release so phones can download the pack. Pushing a tag such as `v1.0.1` additionally creates a versioned GitHub Release.

The Node tests cover action rejection, plan limits, JSON parsing, task progress/pause/resume/completion, bounded memory, intent parsing, key removal and provider response validation. Files importing `@minecraft/server` cannot be executed by Node because that module exists only inside Bedrock; use the live checklist below for those parts.

## Live Bedrock checklist

Run in a disposable Bedrock 1.26.0+ world after importing both packs:

1. Create, despawn and recreate a bot; verify model, name tag, health and collision.
2. Run `!aibot follow`, walk over uneven terrain, run `!aibot stop`, and check bounded movement/stuck recovery.
3. Place oak logs and dropped items nearby. Run `Steve, get me 2 oak logs`; verify the block actually changes, item entities are picked up, inventory count increases, task reaches `2/2`, and the bot returns.
4. Spawn a zombie near the bot during collection. Verify `PAUSED`, attack, health/death verification and `RESUMING TASK`.
5. Fill all 36 inventory slots. Verify collection fails without claiming progress and the item remains in the world; test chest store/withdraw separately.
6. Test missing tool/material and unreachable target; verify a finite failure rather than an infinite loop.
7. Test provider fallback with no endpoint, invalid JSON, timeout and a valid proxy response. Confirm no invalid plan action executes.
8. Test owner and non-owner chat, command OFF, allowlist ON, and permanent deny commands.
9. Open the control panel and verify settings, task history, memory and inventory reflect actual entity state.
10. Spawn two named bots with two owners and confirm identity/task/memory/inventory separation.

## Genuine API limitations

These are isolated rather than faked:

- The targeted stable mobile Script API does not provide a portable outbound HTTP client. The provider classes and secure proxy are real, but an external host transport is required for live network planning. Without it the fallback is used.
- There is no general stable `breakBlock` or player-click API for a custom entity. Verified mining uses a fixed allowlisted `setblock ... air destroy`, so it creates real drops and verifies the changed block, but it does not emulate every tool harvest rule or durability cost.
- Script-controlled movement is best-effort safe-step steering. The add-on does not claim a full A* navigation mesh; obstacles, unloaded chunks and complex vertical terrain can still produce a finite unreachable failure.
- Direct stable APIs for arbitrary item use/eating, recipe crafting, furnace GUI interaction and sleeping are not available in the targeted contract. Those action types return an explicit unsupported reason rather than reporting success.
- Chest transfer is implemented through the block inventory component where exposed; opening a visual chest UI is not simulated.
- The resource model is custom and player-like, not Mojang's exact player renderer or animations.

## Adding a provider

Implement `generatePlan(observation, memory, task)` and return the same schema. Do not import Minecraft APIs into provider code. Add the provider to `providerFor`, keep credentials in a host adapter, and add a validator test for its response shape.
