import test from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider } from "../behavior_packs/autonomous_ai_bot/scripts/core/ai-provider.js";

test("OpenAI-compatible provider sends structured request and validates response", async () => {
  let request;
  const provider = new OpenAICompatibleProvider({ endpoint: "https://proxy.invalid/v1/plan", model: "test", retryCount: 0, maxPlanActions: 4 }, async (value) => {
    request = value;
    return { choices: [{ message: { content: JSON.stringify({ thought: "safe", goal: "collect", actions: [{ type: "find_block", block: "minecraft:oak_log" }] }) } }] };
  });
  const plan = await provider.generatePlan({ position: [0, 64, 0] }, {}, { goal: "Collect wood" });
  assert.equal(plan.actions[0].type, "find_block");
  assert.equal(request.body.messages[0].role, "system");
  assert.equal(request.body.model, "test");
});

test("provider rejects malformed plans instead of returning them", async () => {
  const provider = new OpenAICompatibleProvider({ endpoint: "https://proxy.invalid", model: "test", retryCount: 0 }, async () => ({ choices: [{ message: { content: "{bad" } }] }));
  await assert.rejects(provider.generatePlan({}, {}, {}), /valid JSON|Provider/);
});
