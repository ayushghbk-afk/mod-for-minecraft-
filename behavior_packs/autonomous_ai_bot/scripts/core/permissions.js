export const ALLOWED_COMMANDS = Object.freeze(new Set(["time", "weather", "say", "tp"]));
export const NEVER_ALLOWED_COMMANDS = Object.freeze(new Set(["op", "deop", "stop", "ban", "kill", "give"]));

export function canUseBot(player, agent, config) {
  if (!agent || !player) return false;
  // The stored owner id is a RUNTIME entity id: it is not guaranteed to match
  // after a world reload, because runtime ids are re-assigned every session
  // (the stable cross-session Player.persistentId is still pre-release and not
  // available on the @minecraft/server version this pack targets). The owner
  // NAME is stored next to it and is stable, so it must be accepted here too —
  // otherwise a returning owner is told "No bot is assigned to you" forever,
  // exactly like forPlayer() and owner() already handle it.
  if (config.ownerOnly !== false && agent.ownerId && agent.ownerId !== player.id && agent.ownerName !== player.name) return false;
  return true;
}

/**
 * This is deliberately a named-command API, never a raw command string. The
 * AI action schema has no command action at all.
 */
export function validateNamedCommand(name, args = [], config) {
  const command = String(name || "").toLowerCase();
  if (!config?.commandsEnabled) return { ok: false, reason: "Commands are disabled." };
  if (NEVER_ALLOWED_COMMANDS.has(command)) return { ok: false, reason: "That command is permanently denied." };
  if (!ALLOWED_COMMANDS.has(command)) return { ok: false, reason: "Command is not on the allowlist." };
  if (command === "time" && !["day", "night"].includes(String(args[0]).toLowerCase())) {
    return { ok: false, reason: "Only time day and time night are allowed." };
  }
  if (command === "weather" && !["clear", "rain", "thunder"].includes(String(args[0]).toLowerCase())) {
    return { ok: false, reason: "Only clear, rain and thunder are allowed." };
  }
  if (command === "say" && args.join(" ").length > 160) return { ok: false, reason: "Message is too long." };
  if (command === "tp") return { ok: false, reason: "Teleport is optional and disabled in this build." };
  return { ok: true, command, args: args.map(String) };
}
