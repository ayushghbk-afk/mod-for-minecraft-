# Install on Bedrock, Android and iOS

After GitHub Actions finishes, download the pack from the **bedrock-mobile-latest** release. The file you want on a phone is:

`AI-Bot-Bedrock-Mobile.mcaddon`

Direct download (replace with this repository):

```text
https://github.com/ayushghbk-afk/mod-for-minecraft-/releases/download/bedrock-mobile-latest/AI-Bot-Bedrock-Mobile.mcaddon
```

The same workflow also uploads GitHub Actions artifacts named `bedrock-mobile-modpack`.

## Android

1. Open the `.mcaddon` download. Choose **Minecraft**.
2. Wait for “Import successful”.
3. Play → create or edit a world → **Behavior Packs** and **Resource Packs**.
4. Activate **Autonomous AI Bot - Behavior** and **Autonomous AI Bot - Resources**.
5. If the world asks for Script / Beta APIs, enable only that experiment. Do not enable extra experiments.
6. Enter the world and run `!aibot create Steve`.

## iOS / iPadOS

1. Download the `.mcaddon` in Safari or the GitHub app.
2. Open it in **Files**, then Share → **Minecraft**.
3. Activate both packs on the world as above.
4. Run `!aibot create Steve` in chat.

## Windows / other Bedrock

Double-click `AI-Bot-Bedrock-Mobile.mcaddon`, or copy the `.mcpack` files into Minecraft’s development packs folders. Activate both packs on the world.

## If the command does nothing / no bot spawns

1. **Re-import the pack.** Minecraft keeps the copy of a pack that the world was saved with, so
   after any update you must open the new `.mcaddon` again, then in *Edit World* remove and
   re-add **Autonomous AI Bot - Behavior** and **Autonomous AI Bot - Resources** (or make a new
   world). An old cached pack is the single most common cause.
2. **Check the game version.** You need Bedrock / Pocket Edition **1.26.0 or newer**
   (Settings → Profile). The manifest targets `@minecraft/server` 2.5.0, which ships with 26.0,
   so every 1.26.x build can load it. If a pack asks for a newer script version than your game
   provides, Bedrock skips the scripts **silently**.
3. **Look for the join message.** When the script loads you get a cyan
   `[AI Bot v…] Script loaded` line on join. No line = the scripts are not running; go back to
   step 1.
4. **Use the `/aibot:*` slash commands.** On Bedrock 26.x the join message says
   `chat: unavailable` — Mojang removed chat script events, so `!aibot create Steve` typed in
   chat cannot work there. Run **`/aibot:create Steve`** from the command line instead
   (autocomplete lists it next to `/summon`). No cheats are needed.
5. **Run `/aibot:info`.** It reports the script version, the chat event it bound to, how many
   slash commands registered, whether the tick loop runs, how many bot entities exist, and the
   last spawn error.
6. **Still nothing?** Hold a **compass** and use it to open the create form, or tap/interact
   with the bot to open its panel. With cheats on, `/scriptevent aibot:cmd create Steve` also
   reaches the bot.

Other checks: import the `.mcaddon`, not a hand-renamed zip; activate **both** packs (the
resource pack depends on the behavior pack); on a multiplayer server, ask the owner whether
chat is filtered.
