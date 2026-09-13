/**
 * Small output primitives shared by test mode and the self-test.
 *
 * These live apart from testmode.js on purpose: testmode.js imports
 * selftest.js (to run the check-up), so selftest.js must be able to print
 * without importing back into testmode.js. Bedrock's module loader resolves a
 * circular import to `undefined` during first evaluation, which would turn a
 * tidy dependency graph into "sendLines is not a function" at the exact moment
 * a player asks for help.
 */

export function tryRun(action, fallback) {
  try { return action(); } catch { return fallback; }
}

/** First useful stack frame — the most valuable line of a mobile bug report. */
export function stackLine(error) {
  const lines = String(error?.stack || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const frame = lines.find((line) => /aibot/i.test(line)) || lines[1] || lines[0] || "";
  return frame.replace(/^at\s+/, "").slice(0, 90);
}

/**
 * Turn anything thrown (or any string) into one readable plain-text line.
 * Formatting codes are deliberately not stored: colour is applied when the
 * text is rendered, so the persisted log stays short and paste-friendly.
 */
export function describe(value, limit = 240) {
  let text;
  if (value instanceof Error || (value && typeof value === "object" && typeof value.message === "string")) {
    const name = value.name && value.name !== "Error" ? `${value.name}: ` : "";
    const message = String(value.message || "").replace(/[\r\n]+/g, " ").trim();
    const code = value.code ? ` [${value.code}]` : "";
    const frame = stackLine(value);
    text = `${name}${message}${code}` || "Unknown error";
    if (frame) text += ` (${frame})`;
  } else {
    text = String(value ?? "empty error").replace(/[\r\n]+/g, " ").trim() || "empty error";
  }
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Colour per severity, shared by the error log and the self-test report. */
export function levelColour(level) {
  if (level === "error") return "§c";
  if (level === "warn") return "§e";
  if (level === "info") return "§7";
  return "§f";
}

/** Wrap on spaces so a long diagnostic does not run off the edge of chat. */
function wrap(text, column) {
  if (text.length <= column) return [text];
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    if (!current.length) { current = word; continue; }
    if (current.length + 1 + word.length > column) { lines.push(current); current = word; }
    else current += ` ${word}`;
  }
  if (current.length) lines.push(current);
  return lines.length ? lines : [""];
}

/**
 * Send long text to a player safely. Bedrock chat wraps and truncates on its
 * own, so a 40-line diagnostic blob arrives mangled; chunked messages do not.
 */
export function sendLines(target, lines, { perMessage = 6, maxLines = 60, column = 120 } = {}) {
  if (!target || typeof target.sendMessage !== "function") return 0;
  const flat = [];
  for (const raw of Array.isArray(lines) ? lines : [String(lines)]) {
    for (const line of wrap(String(raw), column)) flat.push(line);
    if (flat.length >= maxLines) break;
  }
  const overflow = Math.max(0, flat.length - maxLines);
  const body = flat.slice(0, maxLines);
  if (overflow > 0) body.push(`§7… ${overflow} more line(s) — run the command again for the rest§r`);
  let sent = 0;
  for (let index = 0; index < body.length; index += perMessage) {
    const chunk = body.slice(index, index + perMessage).join("\n");
    sent += 1;
    tryRun(() => target.sendMessage(chunk));
  }
  return sent;
}
