import { parsePlanText, validatePlan } from "./action-validator.js";

export class AIProviderError extends Error {
  constructor(message, code = "PROVIDER_ERROR") { super(message); this.code = code; }
}

export function createFetchTransport() {
  if (typeof globalThis.fetch !== "function") return null;
  return async ({ endpoint, headers, body, timeoutMs }) => {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await globalThis.fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: controller?.signal });
      const text = await response.text();
      if (!response.ok) throw new AIProviderError(`HTTP ${response.status}: ${text.slice(0, 200)}`, `HTTP_${response.status}`);
      try { return JSON.parse(text); } catch { return text; }
    } finally { if (timer) clearTimeout(timer); }
  };
}

function contentFromResponse(response) {
  if (typeof response === "string") return response;
  if (response?.plan) return typeof response.plan === "string" ? response.plan : JSON.stringify(response.plan);
  const choice = response?.choices?.[0];
  if (choice?.message?.content) return choice.message.content;
  if (choice?.text) return choice.text;
  if (response?.output_text) return response.output_text;
  if (response?.output?.[0]?.content?.[0]?.text) return response.output[0].content[0].text;
  if (response?.actions && response?.goal) return JSON.stringify(response);
  return "";
}

export class AIProvider {
  constructor(config, transport) { this.config = config; this.transport = transport; }
  requestBody(observation, memory, task) {
    return {
      model: this.config.model,
      temperature: 0.1,
      messages: [
        { role: "system", content: "You are a Minecraft autonomous agent. Return JSON only with thought, goal, and an actions array. Never return commands or arbitrary code. The deterministic game engine validates every action." },
        { role: "user", content: JSON.stringify({ observation, memory, task }) }
      ],
      response_format: { type: "json_object" }
    };
  }
  async generatePlan(observation, memory, task) {
    if (!this.transport) throw new AIProviderError("No HTTP transport is available in the Bedrock Script API. Use the documented secure proxy or a host bridge.", "NO_TRANSPORT");
    if (!this.config.endpoint || !this.config.model) throw new AIProviderError("Provider endpoint and model are not configured.", "NOT_CONFIGURED");
    const body = this.requestBody(observation, memory, task);
    let lastError;
    for (let attempt = 0; attempt <= (this.config.retryCount ?? 2); attempt += 1) {
      try {
        const response = await this.transport({ endpoint: this.config.endpoint, headers: { "Content-Type": "application/json" }, body, timeoutMs: 30000 });
        const parsed = typeof response === "object" ? response : parsePlanText(String(response));
        const raw = parsed?.ok ? parsed.value : parsed;
        const content = contentFromResponse(raw);
        const asJson = typeof content === "string" ? parsePlanText(content) : { ok: true, value: content };
        if (!asJson.ok) throw new AIProviderError(asJson.reason, "INVALID_JSON");
        const checked = validatePlan(asJson.value, { maxPlanActions: this.config.maxPlanActions, position: observation.position, maxDistance: this.config.maxPlanDistance });
        if (!checked.ok) throw new AIProviderError(checked.reason, "INVALID_PLAN");
        return checked.plan;
      } catch (error) {
        lastError = error instanceof AIProviderError ? error : new AIProviderError(String(error));
        if (!["HTTP_408", "HTTP_429", "HTTP_500", "HTTP_502", "HTTP_503", "NO_TRANSPORT"].includes(lastError.code)) break;
      }
    }
    throw lastError || new AIProviderError("Provider request failed.");
  }
}

export class OpenAICompatibleProvider extends AIProvider {}
export class CustomProvider extends AIProvider {}
export class MideafireProvider extends AIProvider {}

export function providerFor(config, transport = createFetchTransport()) {
  if (config.provider === "mideafire") return new MideafireProvider(config, transport);
  if (config.provider === "custom") return new CustomProvider(config, transport);
  return new OpenAICompatibleProvider(config, transport);
}
