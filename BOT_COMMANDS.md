# Bot commands and chat

All examples assume the bot is named `Steve`. Names are case-insensitive for parsing and owner checks use both player id and name fallback.

## Chat commands

| Command | Effect |
|---|---|
| `!aibot help` | Show help |
| `!aibot create Steve` | Spawn an owner-bound bot |
| `!aibot spawn Steve` | Alias for create; respawn through the controller |
| `!aibot panel` | Open control UI |
| `!aibot list` | List loaded bots |
| `!aibot status` | Grounded status, task, health and inventory occupancy |
| `!aibot inventory` | Actual inventory slots and counts |
| `!aibot follow` | Follow owner |
| `!aibot stop` | Stop and pause the current task |
| `!aibot protect` | Defend owner mode |
| `!aibot return` | Return to the owner/home position |
| `!aibot cancel` | Cancel the current task |
| `!aibot resume` | Resume a paused task after recovery |
| `!aibot remove <name>` | Despawn a bot you own and free its name |
| `!aibot info` | Script version, chat binding, tick loop, entity counts and last spawn error |
| `!aibot allow on` | Enable named allowlisted server commands |
| `!aibot debug on` | Enable per-bot debug setting |

The UI exposes provider, model, personality, combat mode, command and debug settings. It never exposes an API-key field.

### Typing rules

- These are **chat** messages, not slash commands. `/aibot create Steve` is answered by the
  game with "Unknown command" and never reaches the script.
- Accepted prefixes: `!aibot`, `aibot`, `!bot`, `!ai`, and an optional `:` after the prefix.
  Name matching is case-insensitive.
- If nothing replies at all, the script module is not loading. Run the troubleshooting table in
  `README.md`; the usual cause is a stale imported pack or a game version older than the
  `@minecraft/server` level the manifest declares.

### Without chat

Hold a **compass** and use it to open the create form (or the control panel once you own a bot).
Interacting with the bot entity also opens its panel, which matters on touch screens where chat
is awkward.

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
