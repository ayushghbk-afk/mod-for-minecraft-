export const CONFIG_VERSION = 1;

export const DEFAULT_CONFIG = Object.freeze({
  version: CONFIG_VERSION,
  provider: "openai-compatible",
  endpoint: "https://groq-proxy.mr-hackerdon808.workers.dev/",
  model: "llama-3.3-70b-versatile",
  personality: "friendly",
  combatMode: "defend_owner",
  commandsEnabled: false,
  debug: false,
  ownerOnly: true,
  observationRadius: 8,
  observationIntervalTicks: 20,
  aiCooldownMs: 10000,
  maxPlanActions: 8,
  maxPlanDistance: 32,
  retryCount: 2
});

const PROVIDERS = new Set(["fallback", "mideafire", "custom", "openai-compatible"]);
const COMBAT_MODES = new Set(["passive", "defend_owner", "hostile_mobs", "defend_self"]);
const PERSONALITIES = new Set(["friendly", "focused", "quiet", "protective"]);

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function safeEndpoint(value) {
  if (typeof value !== "string") return DEFAULT_CONFIG.endpoint;
  return value.slice(0, 512).split(/[?#]/)[0].replace(/^(https?:\/\/)[^/@]+@/i, "$1");
}

/**
 * Secrets intentionally do not appear in this object. An add-on cannot safely
 * protect an API key shipped in a world or resource pack. Provider credentials
 * belong in the optional proxy documented in AI_PROVIDERS.md.
 */
export function sanitiseConfig(value = {}) {
  /** @type {Record<string, any>} */
  const source = value && typeof value === "object" ? value : {};
  // Whitelist fields instead of spreading source: this intentionally drops
  // apiKey and any other unrecognized secret/control field.
  return {
    version: CONFIG_VERSION,
    provider: PROVIDERS.has(source.provider) ? source.provider : DEFAULT_CONFIG.provider,
    endpoint: safeEndpoint(source.endpoint),
    model: typeof source.model === "string" ? source.model.slice(0, 128) : DEFAULT_CONFIG.model,
    personality: PERSONALITIES.has(source.personality) ? source.personality : DEFAULT_CONFIG.personality,
    combatMode: COMBAT_MODES.has(source.combatMode) ? source.combatMode : DEFAULT_CONFIG.combatMode,
    commandsEnabled: source.commandsEnabled === true,
    debug: source.debug === true,
    ownerOnly: source.ownerOnly !== false,
    observationRadius: boundedNumber(source.observationRadius, DEFAULT_CONFIG.observationRadius, 4, 12),
    observationIntervalTicks: boundedNumber(source.observationIntervalTicks, DEFAULT_CONFIG.observationIntervalTicks, 10, 200),
    aiCooldownMs: boundedNumber(source.aiCooldownMs, DEFAULT_CONFIG.aiCooldownMs, 3000, 120000),
    maxPlanActions: boundedNumber(source.maxPlanActions, DEFAULT_CONFIG.maxPlanActions, 1, 8),
    maxPlanDistance: boundedNumber(source.maxPlanDistance, DEFAULT_CONFIG.maxPlanDistance, 8, 48),
    retryCount: boundedNumber(source.retryCount, DEFAULT_CONFIG.retryCount, 0, 3)
  };
}

export function loadConfig(entity) {
  try {
    const raw = entity.getDynamicProperty("aibot:config");
    return sanitiseConfig(raw ? JSON.parse(String(raw)) : DEFAULT_CONFIG);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(entity, config) {
  const safe = sanitiseConfig(config);
  entity.setDynamicProperty("aibot:config", JSON.stringify(safe));
  return safe;
}
