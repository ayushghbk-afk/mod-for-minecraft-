# Autonomous Minecraft Bedrock / Pocket Edition AI Bot

This repository contains a Bedrock add-on architecture for a player-like companion. It is intentionally **not** a chatbot NPC: perception, bounded memory, persistent tasks, deterministic movement, inventory verification, block mining, item collection, combat interruption/recovery, status tags and strict AI-plan validation are separate systems.

## Target and compatibility

- Minecraft Bedrock / Pocket Edition **26.40 or newer** (latest stable compatibility baseline checked on 2026-09-12).
- `@minecraft/server` **2.9.0**, shipped stable with Bedrock 26.40.
- `@minecraft/server-ui` **2.1.0** stable.
- **No experiments are required.** Preview/beta modules are intentionally not used.

> **Why this matters:** if a manifest declares a `@minecraft/server` version newer than the
> game provides, Bedrock refuses to load the script module and does it **silently** — no
> error in chat, no bot, and `!aibot create Steve` appears to do nothing. This pack now
> declares the oldest API level it actually needs instead of the newest one that exists.
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

## Download for Bedrock / mobile

Every successful GitHub Actions run packages the mod pack and publishes:

- `AI-Bot-Bedrock-Mobile.mcaddon` — one file for Android, iOS and Windows Bedrock
- `AI-Bot-Behavior.mcpack` and `AI-Bot-Resources.mcpack` — separate packs

Phone download (after the workflow has published):

```text
https://github.com/ayushghbk-afk/mod-for-minecraft-/releases/download/bedrock-mobile-latest/AI-Bot-Bedrock-Mobile.mcaddon
```

The workflow also uploads a **bedrock-mobile-modpack** artifact on the Actions run. See `INSTALL_MOBILE.md` for Android and iOS steps.

> **Already imported an older copy?** Minecraft keeps using the version of a pack that the
> world was saved with — and an old import with different manifest UUIDs can stay active
> **alongside** the new one (you will see two `[AI Bot …] Script loaded` banners with
> different versions). After a fix: import the new `.mcaddon`, open *Edit World → Behavior
> Packs*, **deactivate every older "Autonomous AI Bot" entry so exactly one remains**, then
> remove + re-add the remaining pack (or create a fresh world).

## Install on Android / Bedrock

1. Make a copy of the world.
2. Open `AI-Bot-Bedrock-Mobile.mcaddon` on the device and import it into Minecraft.
3. Edit the world and activate **Autonomous AI Bot - Behavior**. Its manifest dependency activates the matching resource pack. No experimental toggle is required.
4. Enter the world and run the spawn command below.

From the repository root, local packaging is:

```sh
npm run build
```

This writes `dist/AI-Bot-Bedrock-Mobile.mcaddon` plus the `.mcpack` files. GitHub Actions runs the same build on pushes, pull requests and manual dispatch, then **gives the `.mcpack` / `.mcaddon` files as artifacts and updates the `bedrock-mobile-latest` release**. A tag such as `v1.0.1` also creates a versioned GitHub Release.

Do not put API keys in either pack or in a public world template.

## Spawn and control

Preferred owner-aware spawn (works on every current build, **no cheats needed**):

```text
/aibot:create Steve
```

This is a real custom slash command: type `/aibot:create` in the command line exactly like
`/gamemode` or `/summon`, and pick it from autocomplete. The creating player becomes the owner.

If your game build still has chat events (the join message says `chat: ok`), the same command
also works typed in plain chat as `!aibot create Steve`. On Bedrock 26.x builds the join
message says `chat: unavailable` — chat commands are impossible there (Mojang removed the
`chatSend` script events from the stable API), which is exactly why the `/aibot:*` slash
commands exist. Exact controls:

```text
/aibot:help
/aibot:panel
/aibot:status
/aibot:inventory
/aibot:follow
/aibot:stop
/aibot:protect
/aibot:return
/aibot:cancel
/aibot:resume
/aibot:list
/aibot:remove <name>
/aibot:info
```

`/aibot:info` prints script version, which chat signal the pack bound to, how many slash
commands registered, whether the tick loop is running, how many `aibot:companion` entities
exist per dimension, and the last spawn error. It is the first thing to run when the bot
"does nothing".

Forgiving input: when chat works, `aibot create Steve`, `!bot create Steve` and
`!aibot: create Steve` are all accepted as chat messages.

No-chat alternatives (the default on current builds): hold a **compass** and use it to open
the create form, or the control panel if you already own a bot. Interacting with the bot
itself also opens the panel. On worlds with cheats enabled,
`/scriptevent aibot:cmd create Steve` reaches the same handler.

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
2. Scan a bounded local observation, find an allowlisted oak-log block, calculate local A* waypoints, and walk using physics impulses. Teleport is reserved for recovery after repeated stuck detection.
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

## Troubleshooting "the command does nothing / no bot spawns"

Work through this in order; the first line that is false is your cause.

| Check | Fix |
|---|---|
| You see the cyan **`[AI Bot v…] Script loaded`** message when you join the world | If you do not, the script module is not loading: re-import the newest `.mcaddon` and re-activate **both** packs on the world. |
| You see the banner **only once** | Two banners with different versions (e.g. `v1.2.0` and `v1.3.x` at the same time) mean **two copies of the behavior pack are active on that world** — every command is handled twice by two separate scripts and you get doubled messages, two bots with the same name, and `No bot is assigned to you` from the copy that did not create your bot. Fix: *Edit World → Behavior Packs* and **deactivate the older "Autonomous AI Bot" pack**, then save and reload the world. Since v1.3.1 the pack also detects a second running copy automatically (both copies must be v1.3.1+) and prints a red `⚠ Two copies…` warning with these steps. |
| You see **`No bot is assigned to you`** although a bot exists | Since v1.3.1 this heals itself: the bot's stored owner id is a runtime id that changes every session, so old builds lost track of the owner after a world reload. Update to v1.3.1+ and use `/aibot:status` — the bot is re-bound to you by name automatically. If it still fails, run `/aibot:info` and check the `Duplicate packs:` line. |
| The join message says **`chat: unavailable`** | That is normal on Bedrock 26.x: Mojang removed chat script events from the stable API, so `!aibot …` typed in chat **cannot** work. Use `/aibot:create Steve` (custom slash command), the **compass** menu, or `/scriptevent aibot:cmd create Steve` with cheats on. |
| `Settings → Profile` shows Bedrock **1.26.40+** | Update Minecraft. The pack cannot load on an older engine. |
| Both **Autonomous AI Bot - Behavior** and **- Resources** are ACTIVE on that world | Activate them in *Edit World*, not just in global storage. |
| You typed `/aibot:create` (namespaced, with the colon) | A bare `/aibot` has never existed as a slash command; every command is `/aibot:<action>`, e.g. `/aibot:create Steve`, `/aibot:help`. |
| `/aibot:info` replies | If it replies but `create` fails, it prints the real spawn error (usually the behaviour pack is applied but the entity type is not registered — re-add the pack to the world). `/aibot:info` also prints the `Duplicate packs:` line — anything other than `none detected` means deactivate the older copy as above. |
| Chat is not muted/filtered and you are not on a server that strips `!` messages | Ask the server owner, or use the compass UI instead of chat. |

Verbose content log (Windows Bedrock: `Settings → Creator → Enable Content Log`, or launch
with `-verboseLogging`) prints `[aibot] script v… loaded; chat source: …`, which confirms the
module loaded and which chat event it bound to.

## Documentation

- `CONFIGURATION.md` — in-world settings and safe defaults.
- `AI_PROVIDERS.md` — provider abstraction, proxy, Mideafire/custom/OpenAI-compatible setup.
- `BOT_COMMANDS.md` — commands, natural-language intents and status output.
- `PERMISSIONS.md` — owner, action and command policy.
- `DEVELOPMENT.md` — architecture, API limitations, tests and live Bedrock checklist.
