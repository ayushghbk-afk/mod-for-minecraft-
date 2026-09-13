# Bot commands and chat

All examples assume the bot is named `Steve`. Names are case-insensitive for parsing and owner checks use both player id and name fallback.

## Slash commands (work on every current build, no cheats needed)

Stable `@minecraft/server` 2.x — the API level this pack targets — has **no chat events**,
so these namespaced custom commands are the primary way to control the bot. They are
registered during the script startup event with `permissionLevel: Any` and
`cheatsRequired: false`, and autocomplete as you type them:

| Command | Effect |
|---|---|
| `/aibot:help` | Show help |
| `/aibot:create Steve` | Spawn an owner-bound bot. If your bot with that name already exists (e.g. after a world reload) it is handed back to you instead of erroring — bots are never duplicated |
| `/aibot:panel` | Open control UI |
| `/aibot:list` | List loaded bots |
| `/aibot:status` | Grounded status, task, health and inventory occupancy |
| `/aibot:inventory` | Actual inventory slots and counts |
| `/aibot:follow` | Follow owner |
| `/aibot:stop` | Stop and pause the current task |
| `/aibot:protect` | Defend owner mode |
| `/aibot:return` | Return to the owner/home position |
| `/aibot:cancel` | Cancel the current task |
| `/aibot:resume` | Resume a paused task after recovery |
| `/aibot:remove <name>` | Despawn a bot you own and free its name |
| `/aibot:info` | Script version, chat binding, slash registration, tick loop, entity counts and last spawn error |
| `/aibot:debug on` | **Test mode**: every error the pack catches is printed in chat, live |
| `/aibot:debug log [n]` | The captured error log (last `n`, default 15) — newest first, with `×N` repeat counts |
| `/aibot:debug watch 60` | Verbose tracing for 60 s: bot decisions, movement verdicts, plan results |
| `/aibot:debug clear` | Empty the log (it is stored in the world and survives reloads) |
| `/aibot:debug status` | Mode, counters, echo queue and measured loop liveness |
| `/aibot:test` | The self-test: 20+ checks over packs, events, entity, model, movement, mining and persistence |
| `/aibot:test net` | The same, plus one real request to the configured AI endpoint |
| `/aibot:errors` | Shorthand for `/aibot:debug log` |

The name parameter is optional where it makes sense (`status`, `inventory`, `follow`, `stop`,
`return`, `protect`, `cancel`, `resume`, `remove`); without it the command targets your own bot.

## Chat commands (only on builds where chat events exist)

If the join message says `chat: ok`, the same actions also work as chat messages with the
`!` prefix. On Bedrock 26.x builds it says `chat: unavailable` — Mojang removed the
`chatSend` events from the stable script API, so **nothing typed in chat can reach the
script** and the slash commands above are the only text interface.

| Command | Effect |
|---|---|
| `!aibot create Steve` | Spawn an owner-bound bot (`spawn`, `new` are aliases) |
| `!aibot help` | Show help |
| `!aibot panel` | Open control UI |
| `!aibot allow on` | Enable named allowlisted server commands |
| `!aibot debug on` | Test mode: stream every caught error into chat (also turns on the per-bot debug dump) |
| `!aibot debug log` | The captured error log |
| `!aibot debug bot on` | Per-bot debug dump only, without the error stream |
| `!aibot test` | Run the self-test |
| `!aibot test net` | Self-test including a live request to the AI endpoint |

The UI exposes provider, model, personality, combat mode, command and debug settings. It never exposes an API-key field.

### Typing rules

- Slash commands must be namespaced: `/aibot:create Steve`, not `/aibot create Steve`.
  A bare `/aibot` has never been registered and Bedrock answers "Unknown command".
- Chat prefixes: `!aibot`, `aibot`, `!bot`, `!ai`, and an optional `:` after the prefix.
  Name matching is case-insensitive.
- `/scriptevent aibot:cmd <command> [args]` (cheats worlds only) reaches the same handler,
  e.g. `/scriptevent aibot:cmd create Steve`.
- If nothing replies at all, the script module is not loading. Run the troubleshooting table in
  `README.md`; the usual cause is a stale imported pack or a game version older than the
  `@minecraft/server` level the manifest declares.
- Seeing **two** `[AI Bot …] Script loaded` banners with different versions means two copies
  of the behavior pack are active on the world — deactivate the older one in
  *Edit World → Behavior Packs*, then reload the world. Since v1.3.1 the pack detects a
  second running copy (v1.3.1+) itself and prints a red `⚠ Two copies…` warning.

### Without chat (the default on current builds)

Use the `/aibot:*` slash commands above, or hold a **compass** and use it to open the create
form (or the control panel once you own a bot). Interacting with the bot entity also opens
its panel, which matters on touch screens where chat is awkward.

## Test mode — "it's not working" without a console

Mobile players have no content log to read, and until v2.3.0 nearly every `catch` in the
pack could swallow a failure silently: the bot tick loop, navigation, the provider request
and even the entity spawn could throw every single tick with nothing printed anywhere. Test
mode is the answer to that class of report.

| Command | What it does |
|---|---|
| `/aibot:debug on` | Echoes every error into chat, tagged `[TEST]`. Identical errors are folded into `×N` (20 s window) so a per-tick failure cannot flood the chat, and at most 6 lines are released per flush. |
| `/aibot:debug log` | The last 30 captured problems — **including ones from before test mode was turned on**, and from before the last world reload. |
| `/aibot:debug watch 60` | Also traces non-error decisions (follow verdicts, action failures, plan requests) for a bounded window. |
| `/aibot:test` | Runs the check-up below and prints a verdict per subsystem. Every failure it finds is also written into the error log. |
| `/aibot:debug off` | Stops echoing. Errors keep being recorded. |

Failures that make the whole pack look dead (a refused entity spawn, a restore that could not
re-adopt bots, an AI loop that stopped ticking, a refused command registration) are echoed
even when test mode is off, because there is no other way to notice them.

State lives in two world dynamic properties: `aibot:testmode` (the switch) and `aibot:testlog`
(the bounded log). Both are per world, and clearing the log removes the property entirely.

### What `/aibot:test` checks

| Group | Checks |
|---|---|
| Script loading | module is alive; every needed API export exists; the AI loop and the movement job are actually ticking (measured, incl. ticks/second); no second copy of the pack is running |
| Commands & menus | chat events, `/aibot:*` registration (`n/total` from the real `registerCommand` results), `/scriptevent` bridge, compass menu binding, tap-a-bot binding |
| World & pack | world dynamic properties can round-trip; `aibot:companion` is a registered entity type; a **real probe entity** can be spawned and read; its inventory component works; chunks around the player can be read; **and it asks you one question** — "do you see the probe?" — which is the only way a script can tell "no model" from "no entity" |
| Your bot | per bot: state, position, distance to you, follow flag, current plan and step, task progress, health, last action **and its failure reason**, last validation verdict, plus a live A\* route from the bot to you |
| Movement & mining | `getVelocity`/`setVelocity`/`setRotation`/`teleport` availability, ground state, whether the bot is standing in a valid cell, and whether the game accepts a script `runCommand` at all (that is what decides whether mining works without cheats) |
| AI provider | the per-bot config, endpoint sanity (`https`), whether this build has `fetch`, and — with `/aibot:test net` — one real request whose HTTP status and body excerpt are quoted verbatim |

A check that throws is reported as a failure with the raw error text; a check never aborts the
run, and the report is chunked into several chat messages because Bedrock truncates long ones.
If the dialog cannot be answered the visual check is reported as *skipped*, never as a pass.

## Natural language

The bot name must be mentioned. The bot **takes the task and chats back** (owner always gets a reply):

- `Steve, follow me` → follow owner.
- `Steve, stop` → pause movement/task.
- `Steve, get me 32 oak logs` → persistent verified collection task (pathfind → mine → pick up drops).
- `Steve, mine 20 iron` → bounded iron-ore collection task (progress is raw-iron inventory).
- `Steve, protect me` → owner-defense mode with real pathfinding combat.
- `Steve, come back` → return home/owner.
- `Steve, pick up items` / `Steve, loot` → vacuum nearby dropped items into inventory.
- `Steve, eat` → use the best food in inventory like a player.
- `Steve, use iron sword` → equip / use an inventory item.
- `Steve, show inventory` → actual inventory report.
- `Steve, what are you doing?` → actual status/task report.
- `Steve, hi` / any free-form line → the bot replies in chat (local greetings, or AI reply when a provider is configured).

Unknown orders still get a spoken hint instead of silence.

## Status tag

The entity name tag contains the bot name and an engine-written state such as:

```text
Steve
⛏ MINING: minecraft:oak_log
```

State and details are also stored in `aibot:state` and `aibot:status` dynamic properties, with state tags such as `aibot_state_mining`. A provider cannot write these values.
