import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Map the Bedrock-only modules onto the in-memory stub before main.js loads.
const stubs = new Map([
  ["@minecraft/server", "#stub/bedrock"],
  ["@minecraft/server-ui", "#stub/bedrock-ui"]
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (stubs.has(specifier)) return nextResolve(stubs.get(specifier), context);
    return nextResolve(specifier, context);
  }
});

const bedrock = await import("#stub/bedrock");

// Simulate the exact build that produced the "(chat: unavailable)" report:
// stable @minecraft/server 2.x removed world.beforeEvents.chatSend AND
// world.afterEvents.chatSend, so nothing typed in chat can ever reach a script.
// The pack must still be fully controllable on such a build.
bedrock.setChatAvailable(false);

const main = await import("../behavior_packs/autonomous_ai_bot/scripts/main.js");

/**
 * Fake of the game's CustomCommandRegistry. Like the real one, it throws when a
 * command name is not namespaced — the exact silent failure that disabled the
 * old "/aibot" registration and left players with no working command at all.
 */
function makeRegistry() {
  const registrations = new Map();
  return {
    registrations,
    registerCommand(spec, callback) {
      if (!/^[a-z0-9_]+:[a-z0-9_]+$/.test(String(spec.name))) {
        throw new Error(`Custom command names must be namespaced, got '${spec.name}'`);
      }
      registrations.set(spec.name, { spec, callback });
    }
  };
}

test("on a build without chat events the script still loads and reports the cause", () => {
  assert.match(main.SCRIPT_VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(globalThis.__aibotController.diagnostics.chatSource, /^NONE/);
});

test("all /aibot:* slash commands register with a valid, non-cheating schema", () => {
  const registry = makeRegistry();
  bedrock.fireStartup(registry);

  assert.equal(registry.registrations.size, 14, "every documented action needs a slash command");
  for (const [name, { spec }] of registry.registrations) {
    assert.match(name, /^aibot:[a-z]+$/, `${name} must be namespaced or the game rejects it`);
    assert.equal(spec.permissionLevel, bedrock.CommandPermissionLevel.Any, `${name} must be usable by any player`);
    assert.equal(spec.cheatsRequired, false, `${name} must work in worlds without cheats`);
    for (const parameter of spec.optionalParameters ?? []) {
      assert.equal(parameter.type, bedrock.CustomCommandParamType.String, `${name} parameter types must be API enums`);
    }
  }
  assert.ok(registry.registrations.has("aibot:create"));
  assert.ok(registry.registrations.has("aibot:help"));
  assert.ok(registry.registrations.has("aibot:panel"));
  assert.match(globalThis.__aibotController.diagnostics.slashCommands, /14\/14 registered/);
});

test("/aibot:create Slashbot spawns a real owner-bound bot without any chat", () => {
  const registry = makeRegistry();
  bedrock.fireStartup(registry);
  const player = bedrock.addPlayer("Slashy");

  const result = registry.registrations.get("aibot:create").callback({ sourceEntity: player }, "Slashbot");
  assert.equal(result.status, bedrock.CustomCommandStatus.Success);
  bedrock.advance(4);

  const bots = bedrock.world.getDimension("overworld").getEntities({ type: "aibot:companion" });
  assert.equal(bots.length, 1, "the companion entity must actually exist");
  assert.equal(bots[0].getDynamicProperty("aibot:name"), "Slashbot");
  assert.equal(bots[0].getDynamicProperty("aibot:owner_id"), player.id);
  assert.match(player.sentMessages.join("\n"), /Created Slashbot/);
});

test("/aibot:follow drives the same handler that chat commands used", () => {
  const registry = makeRegistry();
  bedrock.fireStartup(registry);
  const player = bedrock.addPlayer("Follower");

  assert.equal(registry.registrations.get("aibot:create").callback({ sourceEntity: player }, "Trail").status, bedrock.CustomCommandStatus.Success);
  bedrock.advance(2);
  const result = registry.registrations.get("aibot:follow").callback({ sourceEntity: player });
  assert.equal(result.status, bedrock.CustomCommandStatus.Success);
  bedrock.advance(4);

  assert.match(player.sentMessages.join("\n"), /Following you/);
});

test("/scriptevent aibot:cmd ... reaches the same handler and non-aibot ids are ignored", () => {
  const player = bedrock.addPlayer("Evented");

  bedrock.system.afterEvents.scriptEventReceive.fire({ id: "aibot:cmd", message: "create Eventful", sourceEntity: player });
  bedrock.advance(4);
  assert.ok(globalThis.__aibotController.byName("Eventful"));
  assert.match(player.sentMessages.join("\n"), /Created Eventful/);

  bedrock.system.afterEvents.scriptEventReceive.fire({ id: "aibot:stop", message: "", sourceEntity: player });
  bedrock.advance(2);
  assert.match(player.sentMessages.join("\n"), /Stopped/);

  const before = player.sentMessages.length;
  bedrock.system.afterEvents.scriptEventReceive.fire({ id: "othermod:thing", message: "create Intruder", sourceEntity: player });
  bedrock.advance(2);
  assert.equal(player.sentMessages.length, before, "foreign scriptevent ids must not trigger the bot");
  assert.equal(globalThis.__aibotController.byName("Intruder"), undefined);
});

test("the join message explains what actually works instead of dead chat commands", () => {
  const player = bedrock.addPlayer("Newbie");
  bedrock.world.afterEvents.playerSpawn.fire({ player, initialSpawn: true });
  bedrock.advance(80);

  const text = player.sentMessages.join("\n");
  assert.match(text, /Script loaded \(chat: §cunavailable§r\)/);
  assert.match(text, /Chat commands are unavailable on this game build/);
  assert.match(text, /\/aibot:create Steve/);
  assert.match(text, /compass/);
  assert.doesNotMatch(text, /Type §e!aibot create Steve/, "must not advertise chat commands that cannot work");

  // The Verity-style auto-summon must also work on this build.
  assert.match(text, /Auto-summoned AIBot/);
  assert.ok(globalThis.__aibotController.byName("AIBot"));
});

test("with no bot assigned, the reply recommends a command this build can run", () => {
  const registry = makeRegistry();
  bedrock.fireStartup(registry);
  const player = bedrock.addPlayer("Lonely");

  assert.equal(registry.registrations.get("aibot:follow").callback({ sourceEntity: player }).status, bedrock.CustomCommandStatus.Success);
  bedrock.advance(4);

  const text = player.sentMessages.join("\n");
  assert.match(text, /No bot is assigned to you/);
  assert.match(text, /\/aibot:create Steve/);
  assert.doesNotMatch(text, /!aibot create/, "a build without chat events must never point the player back to chat");
});

test("a returning owner keeps their bot after the runtime player id changes", () => {
  const registry = makeRegistry();
  bedrock.fireStartup(registry);

  // Session 1: the bot is created and bound to the player's runtime id.
  const first = bedrock.addPlayer("Returning");
  registry.registrations.get("aibot:create").callback({ sourceEntity: first }, "Loyal");
  bedrock.advance(4);

  // Session 2: same player, brand-new runtime id (Bedrock re-assigns entity
  // ids every session; the bot still stores the previous session's id).
  first.removed = true;
  const second = bedrock.addPlayer("Returning");
  assert.notEqual(second.id, first.id);

  registry.registrations.get("aibot:follow").callback({ sourceEntity: second });
  bedrock.advance(4);

  const text = second.sentMessages.join("\n");
  assert.match(text, /Following you/, `the owner must still control their bot, got: ${JSON.stringify(text)}`);
  assert.doesNotMatch(text, /No bot is assigned/);
  const bot = globalThis.__aibotController.byName("Loyal");
  assert.equal(bot.entity.getDynamicProperty("aibot:owner_id"), second.id, "the stale owner id must be healed");
});

test("tapping a bot with none assigned opens the create form, not a dead-end chat command", async () => {
  const ui = await import("#stub/bedrock-ui");
  ui.resetShownForms();
  const player = bedrock.addPlayer("Tapper");
  bedrock.world.afterEvents.playerInteractWithEntity.fire({ player, target: { typeId: "aibot:companion" } });
  bedrock.advance(2);

  const text = player.sentMessages.join("\n");
  assert.match(text, /No bot is assigned to you yet/);
  assert.match(text, /\/aibot:create/);
  assert.doesNotMatch(text, /!aibot create/);
  const modal = ui.shownForms.filter((form) => form.kind === "modal").pop();
  assert.equal(modal?.titleText, "Create AI Bot", "the create dialog must actually open");
});
