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

## If import fails

- Use Minecraft Bedrock **1.26.0 or newer**.
- Import the `.mcaddon`, not a zip you renamed by hand.
- Activate **both** packs. The resource pack depends on the behavior pack.
- Chat commands need cheats / operator permission in that world.
