# Configuration

The add-on uses entity dynamic properties, not a file-reading API. Each bot has its own configuration, so multiple bots can use different providers, personalities and combat modes.

## Settings

The control panel is available with the `/aibot:panel` slash command (or `!aibot panel` in chat on builds with chat events), by holding a compass, or by interacting with the bot.

| Setting | Default | Values / notes |
|---|---|---|
| Provider | `fallback` | `fallback`, `mideafire`, `custom`, `openai-compatible` |
| Endpoint | empty | Prefer a secure proxy endpoint, not a provider key-bearing URL |
| Model | empty | Provider model name |
| Personality | `friendly` | `friendly`, `focused`, `quiet`, `protective`; affects provider context only |
| Combat mode | `defend_owner` | `passive`, `defend_owner`, `hostile_mobs`, `defend_self` |
| Commands | `false` | Named allowlist is still enforced when enabled |
| Debug | `false` | Per-bot diagnostic dump every 5 s (state, target, plan, validation). `/aibot:debug on` turns this **and** world-wide test mode on together; `!aibot debug bot on` is the per-bot-only form |
| Owner only | `true` | Natural-language instructions are owner-gated |
| Observation radius | `8` | Clamped to 4–12 blocks |
| AI cooldown | `10000 ms` | Provider requests are throttled |
| Max plan actions | `8` | Hard safety limit |

The exact bounded defaults are in `behavior_packs/autonomous_ai_bot/scripts/core/config.js`.

## Configuration without a UI

For an installed world, use the panel. For a custom host integration, pass a sanitized object to `saveConfig` or configure the same fields in the integration layer. The schema deliberately drops `apiKey`; never add a key to a pack, manifest, world template or client UI.

The default configuration is set to the supplied Cloudflare Worker without storing a key:

```json
{
  "provider": "openai-compatible",
  "endpoint": "https://groq-proxy.mr-hackerdon808.workers.dev/",
  "model": "llama-3.3-70b-versatile",
  "personality": "friendly",
  "combatMode": "defend_owner",
  "commandsEnabled": false,
  "observationRadius": 8,
  "aiCooldownMs": 10000,
  "maxPlanActions": 8
}
```

## Debug state that is not per-bot

Test mode is a **world** setting, stored next to the per-bot config so it survives a reload
and is readable before any player asks:

| Key | Scope | Contents |
|---|---|---|
| `aibot:testmode` | world | `true` while `/aibot:debug on` is active (absent when off) |
| `aibot:testlog` | world | bounded JSON array (≤30 entries, ≤20 KB): level, subsystem id, message with the stack frame, tick, age and `×N` repeat count. Info-level traces are deliberately not persisted. |
| `aibot:hb:<instance>` | world | heartbeat of each running script copy, used by the duplicate-pack guard |

Nothing else about diagnostics is configurable, and no key or token is ever stored: the
provider round-trip in `/aibot:test net` reads the endpoint back out of the per-bot config.

## Performance controls

Perception runs on a bounded local cube and is throttled by `observationIntervalTicks`; task movement and known-target mining do not query an AI every tick. Memory keeps at most 24 short-term events, 20 facts, 16 locations, 12 recent requests and 20 task-history entries.

If a mobile world is slow, increase the observation interval, keep the radius at 8, use fallback planning for routine mining, and avoid spawning unnecessary bots.
