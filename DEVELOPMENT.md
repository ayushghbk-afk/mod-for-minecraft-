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
        ↘
         testmode.js (error log + chat echo) → selftest.js (the /aibot:test check-up)
```

`testmode.js` is the pack's own diagnostic plane. Every `catch` that used to be silent goes
through `testMode.error/warn/note` (or `guard`/`guardAsync`), which keeps a bounded 30-entry
log in the `aibot:testlog` world dynamic property, echoes new entries to every player while
`/aibot:debug on` is set (`aibot:testmode`), folds repeats of the same signature into `×N`,
and measures whether the AI and movement interval jobs are still beating — a script that
loaded but never ticks is otherwise indistinguishable from one that never loaded. Failures
that make the whole pack look dead are echoed even when test mode is off (`{ always: true }`).
`selftest.js` is only reachable through it and must never import back into it (Bedrock
resolves a cycle to `undefined` on first evaluation), which is why `sendLines`/`describe`
live in `format.js`. `BotController.test` defaults to `SILENT_TEST`, whose `guard()` *runs*
the callback, so agents behave identically with or without the harness attached.

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

The Node tests cover action rejection, plan limits, JSON parsing, task progress/pause/resume/completion, bounded memory, intent parsing, key removal and provider response validation.

`tests/command-e2e.test.mjs` goes further: it loads the real `scripts/main.js` against an
in-memory stub of `@minecraft/server` and `@minecraft/server-ui` (`tests/stubs/`), wired up with
`module.registerHooks` and the `#stub/*` subpath imports in `package.json`. That makes the chat
command path testable outside Bedrock, so it asserts that:

- the entry module loads and exports a script version;
- `!aibot create Steve` really spawns an `aibot:companion` entity with owner metadata and
  answers exactly once (a double-bound chat signal would spawn two bots);
- tolerant prefixes (`aibot …`, `!bot …`, `!aibot: …`, upper case) still parse, while ordinary
  sentences such as `bot follow me please` are ignored;
- `/aibot:info` reports the bound chat signal, slash-command registration, tick loop and entity counts;
- `/aibot:remove` frees a name for re-creation;
- a failed `spawnEntity` produces an actionable error instead of silence.

`tests/conversation.test.mjs` and `tests/chat-brain.test.mjs` cover the conversation itself
(AC-45): the same sentence produces the same task whether it arrives as a chat mention, as
`/aibot:talk`, or through the panel's Talk form; every category of question is answered rather
than dropped, with the numbers read from the live bot (health after it is wounded, its real
coordinates, the objective it is actually working on); a question the engine cannot ground says
so instead of inventing an answer; a provider that fails or hangs still leaves a spoken answer;
and no reply ever contains an internal value (`undefined`, `NaN`, `[object Object]`).

`tests/testmode.test.mjs` covers the diagnostic plane itself: errors are recorded with test
mode off and echoed with it on; 25 identical failures become one chat line plus `×25`; the
per-agent tick guard keeps a healthy bot ticking while a throwing one is reported once; the
flag and the log survive a reload; the liveness sampler reports a stalled AI/movement loop;
the self-test turns a chat-less build, an unregistered entity and a refused `registerCommand`
into named failures with fixes (each also written to the log); the report is chunked so
Bedrock cannot truncate it; the probe entity is never adopted as a real bot; and the network
check is opt-in, quoting the endpoint's own error verbatim.

The stub is test-only and lives outside `behavior_packs/`, so it is never packaged into the
`.mcpack`. It requires Node **22.15+** (`module.registerHooks`); `npm test` is the same command
CI runs. Anything that genuinely needs the live game is still covered by the checklist below.

## Script API version policy

Declare the **oldest** `@minecraft/server` level the code actually needs, never the newest one
that exists. Bedrock refuses to load a script module whose declared dependency is newer than the
API the client ships, and it fails **silently** — the pack imports, the entity may even render,
but no command ever answers. Each stable build provides a specific level (26.0 → 2.5.0,
26.20 → 2.7.0, 26.40 → 2.9.0), so pinning 2.9.0 excluded everyone below 26.40.

When you use a newer API, raise the dependency deliberately, gate the call behind an optional
accessor (the codebase already does this for chat signals via `safeSubscribe`), and document the
minimum game version.

### Chat events do not exist on stable 2.x — slash commands are the interface

Stable `@minecraft/server` 2.x (Bedrock 26.x) ships **no** `world.beforeEvents.chatSend` /
`world.afterEvents.chatSend`; they were removed in 2.0.0 and only exist in beta builds again
since ~2.12.0-beta. That is why "chat is not working" is a real report with a real answer: the
player's words have to reach the script through a transport this build actually has.
`scripts/core/conversation.js` owns that one path — `runPlayerWords()` decides whether a line is
a task or a conversation, and `core/chat-brain.js` produces the reply from live data with no
network at all — so `/aibot:talk`, the panel's Talk form and a real chat mention cannot drift
apart. When adding a new way for a player to type at the bot, route it through `runPlayerWords`
rather than re-implementing the branch. The pack therefore registers namespaced **custom slash
commands**
(`/aibot:create`, `/aibot:help`, …) in `system.beforeEvents.startup` and a `/scriptevent aibot:cmd …`
bridge. When touching command code remember the registry's hard rules: names must be
namespaced, parameter types must be `CustomCommandParamType` values, and `cheatsRequired: false`
is what keeps the commands usable without cheats. Tests in `tests/slash-command.test.mjs`
simulate a chat-less build and fail if any of those rules regresses.

## Live Bedrock checklist

Run in a disposable Bedrock 1.26.40+ world after importing both packs:

0. Confirm the cyan `[AI Bot v…] Script loaded` join message and that `/aibot:info` replies;
   without those, nothing else can work. Verify the message's `chat:` note matches reality and
   that `/aibot:create Steve` spawns a bot even when chat is unavailable.
0b. Run **`/aibot:debug on`** then **`/aibot:test`**: every check must be `✔ pass` or an
   explained `▲`; `/aibot:debug status` must show the AI and movement loops non-stalled;
   answer the "do you see the probe?" dialog (✔ with a body / ✖ name only = resource pack);
   run `/aibot:test net` with a proxy reachable and confirm the round-trip line quotes the
   HTTP status. Then reload the world and confirm `/aibot:debug log` still shows the earlier
   entries (the log lives in a world dynamic property on purpose).
1. Create, despawn and recreate a bot; verify model, name tag, health and collision.
2. Run `/aibot:follow`, walk over uneven terrain, run `/aibot:stop`, and check bounded movement/stuck recovery.
3. Place oak logs and dropped items nearby. Run `Steve, get me 2 oak logs`; verify the block actually changes, item entities are picked up, inventory count increases, task reaches `2/2`, and the bot returns.
4. Spawn a zombie near the bot during collection. Verify `PAUSED`, attack, health/death verification and `RESUMING TASK`.
5. Fill all 36 inventory slots. Verify collection fails without claiming progress and the item remains in the world; test chest store/withdraw separately.
6. Test missing tool/material and unreachable target; verify a finite failure rather than an infinite loop.
7. Test provider fallback with no endpoint, invalid JSON, timeout and a valid proxy response. Confirm no invalid plan action executes.
8. Test owner and non-owner chat, command OFF, allowlist ON, and permanent deny commands.
9. Open the control panel and verify settings, task history, memory and inventory reflect actual entity state.
10. Spawn two named bots with two owners and confirm identity/task/memory/inventory separation.
11. Break something on purpose (deactivate the resource pack; disable cheats) and confirm
    `/aibot:test` points at exactly that, and that `/aibot:debug log` carries the game's own
    error string rather than a paraphrase.

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
