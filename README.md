# Autonomous Minecraft Bedrock / Pocket Edition AI Bot

This repository contains a Bedrock add-on architecture for a player-like companion. It is intentionally **not** a chatbot NPC: perception, bounded memory, persistent tasks, deterministic movement, inventory verification, block mining, item collection, combat interruption/recovery, status tags and strict AI-plan validation are separate systems.

## Target and compatibility

- Bedrock / Pocket Edition **1.26.0 or newer** (the 2026 year-based version series).
- `@minecraft/server` **2.9.0** stable.
- `@minecraft/server-ui` **2.1.0** stable.
- JavaScript Script API pack; no TypeScript build step is required.
- The project was statically checked and its pure logic was tested with Node. A live Bedrock client/server is not available in this repository, so the live-game checklist in `DEVELOPMENT.md` must be run in Bedrock before release.

## What is implemented

The behavior pack contains:

- `aibot:companion`, a named custom entity with a visible player-like model, collision, health, movement, equipment slots and a 36-slot inventory.
- Compact, throttled nearby block/entity perception with hostile-threat classification.
- Persistent task manager and bounded memory in entity dynamic properties.
- Deterministic action engine and validator. AI text never becomes a command or JavaScript.
- Best-effort safe-step movement, follow-owner behavior and stuck detection with a finite recovery limit.
- Verified destroy-mining, real item-entity pickup into the bot inventory, progress tracking and return-to-owner behavior.
- Hostile mob defense, task pause, attack, threat verification and task resume.
- Owner-gated natural-language intents and a Bedrock-friendly control panel.
- Provider-independent planner interface for fallback, Mideafire, custom and OpenAI-compatible providers.
- Offline fallback: follow, stop, return, threat response and deterministic task loops keep working when a provider is unavailable.

See the limitations section below before calling this production-ready for a particular world.

## Install on Android / Bedrock

1. Make a copy of the world.
2. Run `npm run build`, then use `dist/autonomous_ai_bot.mcaddon` for the simplest install. The build also produces separate behavior/resource `.mcpack` files.
3. Open the `.mcaddon` on Android, Windows or another Bedrock device and import it into Minecraft.
4. Edit the world, activate both packs, and enable **Beta APIs / Script API experiments only if the target game build requires them**. The manifests target stable APIs; do not enable unrelated experiments.
5. Enter the world and run the spawn command below.

From the repository root, the equivalent desktop packaging commands are:

```sh
npm run build
```

This writes an importable `dist/autonomous_ai_bot.mcaddon` plus the separate packs to `dist/`. GitHub Actions runs the same build automatically on pushes, pull requests and manual dispatch. A tag such as `v1.0.1` also creates a GitHub Release containing the add-on and pack files.

Do not put API keys in either pack or in a public world template.

## Spawn and control

Preferred owner-aware spawn:

```text
!aibot create Steve
```

The creating player becomes the owner. Exact controls:

```text
!aibot help
!aibot panel
!aibot status
!aibot inventory
!aibot follow
!aibot stop
!aibot protect
!aibot return
!aibot cancel
!aibot resume
```

Natural-language examples (the bot name is required):

```text
Steve, follow me.
Steve, stop.
Steve, get me 32 oak logs.
Steve, mine 20 iron.
Steve, protect me.
Steve, come back.
Steve, show inventory.
```

A raw Bedrock summon is also possible:

```text
/summon aibot:companion ~ ~ ~
```

That entity has no owner until it is recreated through `!aibot create`; owner-gated natural-language control will therefore reject it. The preferred command creates the entity and records owner/home metadata.

## MVP oak-log flow

For `Steve, get me 32 oak logs`, the deterministic loop is:

1. Parse the request into a bounded `collect` task.
2. Scan a small local observation, find an allowlisted oak-log block and approach it with safe incremental steps.
3. Run a fixed `setblock <x> <y> <z> air destroy` operation, then verify the block changed.
4. Collect only real nearby item entities into the 36-slot inventory.
5. Count the actual inventory item, update persistent progress and find the next tree.
6. Pause for a nearby hostile mob, defend, verify threat health, then resume.
7. When the requested count is in inventory, mark the task complete and return to the owner.

The visible name tag and dynamic properties report actual engine state; an AI response cannot mark a task complete.

## Provider summary

The default configuration uses the supplied Cloudflare Worker at `https://groq-proxy.mr-hackerdon808.workers.dev/` as an OpenAI-compatible endpoint with model `llama-3.3-70b-versatile`. The model can be changed in the panel. See `AI_PROVIDERS.md` for the request contract. Stable mobile Script API does not provide a generally available outbound HTTP API, so the pack intentionally falls back instead of pretending it can contact a provider. A supported host bridge / dedicated-server integration is still required for the add-on to make outbound requests.

## Security defaults

- Commands are **OFF** by default.
- AI output is JSON-only, schema-checked, action allowlisted, bounded by radius and limited to eight actions.
- There is no AI `run_command`, `eval`, file, permission or secret action.
- Players other than the owner cannot issue instructions when `ownerOnly` is enabled.
- Permanently denied named commands include `op`, `deop`, `stop`, `ban`, `kill` and `give`.
- API keys are not accepted by the in-world settings form and are never written to dynamic properties.

## Documentation

- `CONFIGURATION.md` — in-world settings and safe defaults.
- `AI_PROVIDERS.md` — provider abstraction, proxy, Mideafire/custom/OpenAI-compatible setup.
- `BOT_COMMANDS.md` — commands, natural-language intents and status output.
- `PERMISSIONS.md` — owner, action and command policy.
- `DEVELOPMENT.md` — architecture, API limitations, tests and live Bedrock checklist.
