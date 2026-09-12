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
| `!aibot debug on` | Enable per-bot debug setting |

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

## Natural language

The bot name must be mentioned:

- `Steve, follow me` → follow owner.
- `Steve, stop` → pause movement/task.
- `Steve, get me 32 oak logs` → persistent verified collection task.
- `Steve, mine 20 iron` → bounded iron-ore collection task (progress is raw-iron inventory).
- `Steve, protect me` → owner-defense mode.
- `Steve, come back` → return home/owner.
- `Steve, show inventory` → actual inventory report.
- `Steve, what are you doing?` → actual status/task report.

Unknown or unsupported requests are not silently turned into actions.

## Status tag

The entity name tag contains the bot name and an engine-written state such as:

```text
Steve
⛏ MINING: minecraft:oak_log
```

State and details are also stored in `aibot:state` and `aibot:status` dynamic properties, with state tags such as `aibot_state_mining`. A provider cannot write these values.
