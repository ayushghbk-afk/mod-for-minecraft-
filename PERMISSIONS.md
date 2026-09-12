# Permissions and security

## Default policy

- A new bot records the creating player's id and name as owner.
- `ownerOnly` is true by default; other players cannot give natural-language tasks.
- Commands are disabled by default.
- The AI receives observation, bounded memory and task data, not secrets or arbitrary world history.
- The AI output is treated as hostile input and passes through `validatePlan` and `validateAction`.

## Named command allowlist

When `!aibot allow on` is explicitly enabled by the owner (chat builds only; it is a chat-only command), only these named commands are available through `!aibot command`:

- `time day`
- `time night`
- `weather clear`
- `weather rain`
- `weather thunder`
- `say <bounded message>`

`tp` is present as a documented optional name but is disabled in this build. The permanent deny list includes `op`, `deop`, `stop`, `ban`, `kill` and `give`. No raw command string is accepted by the AI action schema.

The engine itself uses fixed internal `setblock ... destroy` / `setblock ... replace` operations for verified mining/building. Coordinates and block ids are validated before those operations; an AI cannot choose a command or inject command text.

## API keys

An API key is never embedded in the behavior pack, stored in dynamic properties, returned by the proxy, or entered into the in-world UI. Put credentials in a private server environment and expose only the configured proxy route. If a provider requires a different authentication header or body, implement that in the host proxy, not in public add-on files.
