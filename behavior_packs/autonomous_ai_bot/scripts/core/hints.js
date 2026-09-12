/**
 * Capability-aware command hints.
 *
 * The pack runs on two kinds of builds:
 *  - builds with chat events, where `!aibot create Steve` typed in chat works;
 *  - current stable builds (Bedrock 26.x / @minecraft/server 2.x) where the
 *    chatSend events were removed and ONLY the `/aibot:*` slash commands, the
 *    compass menu and `/scriptevent aibot:cmd` can reach the script.
 *
 * Telling a player on the second kind of build to "type !aibot create Steve"
 * is the single most common "the mod told me to do a thing that does nothing"
 * report: the message looks like a working instruction but can never work.
 * Every user-facing string that names a command must go through these helpers
 * so it recommends something the running build can actually execute.
 *
 * main.js fills `controller.diagnostics.chatSource` at load, before any
 * player-facing code runs, so these hints are safe to use everywhere.
 */

/**
 * True when chat-prefixed commands (like "!aibot help") can reach this script.
 * An unbound or explicitly unavailable chat signal means "no".
 */
export function chatAvailable(controller) {
  const source = String(controller?.diagnostics?.chatSource ?? "");
  return source !== "" && !source.startsWith("NONE");
}

/**
 * Render `action` ("create Steve", "panel", "status AIBot", ...) as the command
 * form that works on this build: `!aibot create Steve` or `/aibot:create Steve`.
 * The first word is the command name; the rest are its argument.
 */
export function commandHint(controller, action) {
  const words = String(action || "").trim().split(/\s+/).filter(Boolean);
  const [head, ...rest] = words;
  if (!head) return chatAvailable(controller) ? "!aibot help" : "/aibot:help";
  const tail = rest.length ? ` ${rest.join(" ")}` : "";
  return chatAvailable(controller) ? `!aibot ${words.join(" ")}` : `/aibot:${head}${tail}`;
}

/** How to ask an existing bot to follow you on this build. */
export function talkHint(controller, name) {
  const safeName = String(name || "your bot");
  if (chatAvailable(controller)) return `say "§f${safeName}§e, follow me§e"`;
  return `tap §f${safeName}§e to open its panel, or use §f/aibot:follow§e`;
}

/** The sentence appended whenever a player has no bot assigned. */
export function noBotMessage(controller) {
  return `§eNo bot is assigned to you.§r Create one with §e${commandHint(controller, "create Steve")}§r, or hold a §fcompass§r and use it.`;
}
