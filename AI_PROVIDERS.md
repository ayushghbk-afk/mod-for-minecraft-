# AI providers and secure networking

## Provider interface

The engine calls one interface:

```js
await provider.generatePlan(observation, memory, task)
```

It returns a validated object:

```json
{
  "thought": "The nearest allowed oak log is reachable.",
  "goal": "Collect 32 oak logs",
  "actions": [
    { "type": "find_block", "block": "minecraft:oak_log" },
    { "type": "move_to_target" },
    { "type": "mine_block", "block": "minecraft:oak_log" },
    { "type": "collect_item", "count": 1 }
  ]
}
```

Implementations in `scripts/core/ai-provider.js` are:

- `MideafireProvider` — uses the configured endpoint and the generic chat request shape because a canonical Mideafire endpoint/response contract was not supplied in this repository.
- `CustomProvider` — uses an OpenAI-compatible chat body and accepts a `plan`, `choices[0].message.content`, `choices[0].text` or direct plan response.
- `OpenAICompatibleProvider` — same body and response extraction for compatible services.
- Fallback planner — no network; deterministic local actions for supported task kinds.

The provider is not allowed to invoke actions. `action-validator.js` rejects unknown actions, unsafe blocks, distant positions, bad counts and non-JSON output before the engine sees a plan.

## Important Bedrock networking limitation

The stable mobile `@minecraft/server` API targeted by the behavior pack does not expose a portable outbound HTTP client. The add-on therefore detects the absence of a host transport and displays `AI unavailable; using fallback behavior`. This is deliberate and honest: a URL in a UI does not make a mobile add-on capable of networking.

To use a provider, run the included proxy on a trusted host and connect it through a supported dedicated-server/host bridge that supplies a transport to `providerFor`. Do not add an unverified networking module to a mobile pack just to bypass this limitation.

## Secure proxy

The proxy at `proxy/server.mjs` stores the upstream key in environment variables and exposes only a small `/v1/plan` route:

```sh
cd proxy
AIBOT_PROVIDER=openai-compatible \
AIBOT_ENDPOINT=https://api.example.com/v1/chat/completions \
AIBOT_MODEL=my-model \
AIBOT_API_KEY='set-outside-the-repository' \
node server.mjs
```

For a Mideafire deployment use `AIBOT_PROVIDER=mideafire`, `MIDEAFIRE_ENDPOINT`, `MIDEAFIRE_API_KEY` and `AIBOT_MODEL`. For a custom compatible endpoint set `AIBOT_ENDPOINT` and `AIBOT_API_KEY`. The proxy never returns the key. It has a body limit, fixed upstream configuration and no arbitrary URL supplied by clients.

Configure the bot endpoint as the proxy URL, for example `http://host.example:8787/v1/plan`, but remember that the pack still needs a supported host transport to make the request. `/health` reports whether the proxy has endpoint/model configuration; it does not verify upstream credentials.

## Request and response contract

The proxy sends:

```json
{
  "model": "MODEL",
  "temperature": 0.1,
  "messages": [
    { "role": "system", "content": "You are a Minecraft autonomous agent..." },
    { "role": "user", "content": "{ observation, memory, task }" }
  ],
  "response_format": { "type": "json_object" }
}
```

A provider may return the plan directly, `{ "plan": ... }`, an OpenAI `choices[0].message.content` string, or `choices[0].text`. Invalid output is rejected and the bot uses the bounded fallback planner.
