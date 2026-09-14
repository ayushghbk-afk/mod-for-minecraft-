/**
 * TALKING TO THE BOT — AC-45, end to end, on the build that produced the
 * "chat is not working" report.
 *
 * `setChatAvailable(false)` reproduces Bedrock 26.x exactly: `world.beforeEvents
 * .chatSend` and `world.afterEvents.chatSend` do not exist, so nothing typed in
 * the game's chat box can reach a script. The pack must still hold a
 * conversation — through `/aibot:talk`, through the panel's Talk box, and with
 * the bot answering from the live world rather than from a canned string.
 *
 * Everything here drives the real `main.js`, the real controller and the real
 * forms; the only stand-in is the game itself (tests/stubs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

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
const ui = await import("#stub/bedrock-ui");

// The exact build the report came from: no chat events at all.
bedrock.setChatAvailable(false);

const main = await import("../behavior_packs/autonomous_ai_bot/scripts/main.js");

function makeRegistry() {
  const registrations = new Map();
  return {
    registrations,
    registerCommand(spec, callback) {
      if (!/^[a-z0-9_]+:[a-z0-9_]+$/.test(String(spec.name))) throw new Error(`Custom command names must be namespaced, got '${spec.name}'`);
      registrations.set(spec.name, { spec, callback });
    }
  };
}

function fresh(playerName = "Talker", botName = "Steve") {
  main.__resetForTests();
  ui.resetShownForms();
  const registry = makeRegistry();
  bedrock.fireStartup(registry);
  const player = bedrock.addPlayer(playerName);
  registry.registrations.get("aibot:create").callback({ sourceEntity: player }, botName);
  bedrock.advance(4);
  const agent = globalThis.__aibotController.byName(botName);
  player.sentMessages.length = 0;
  return { registry, player, agent };
}

/** Everything the player was told, newest last, with colour codes stripped. */
function said(player) {
  return player.sentMessages.map((line) => String(line).replace(/§./g, "")).join("\n");
}

function slash(registry, player, command, words) {
  const result = registry.registrations.get(command).callback({ sourceEntity: player }, words);
  // Custom-command callbacks queue their work through system.run(), exactly like
  // the game's read-only callback contract — so the tick has to be advanced
  // before the bot has said anything.
  bedrock.advance(2);
  return result;
}

/** Let the microtask queue drain: replying is async by design. */
function flush() { return new Promise((resolve) => setTimeout(resolve, 0)); }

/** Wait for something the bot says — a bridged provider may take a moment. */
async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

test("the build really has no chat events, and talking is still possible", () => {
  const { registry } = fresh();
  assert.match(globalThis.__aibotController.diagnostics.chatSource, /^NONE/);
  // The two spellings a player can actually use, in both namespaces.
  for (const name of ["aibot:talk", "bot:talk", "aibot:say", "bot:say"]) {
    assert.ok(registry.registrations.has(name), `${name} must exist on a build with no chat`);
  }
});

test("/aibot:talk answers a question from the live bot, not from a canned line", () => {
  const { registry, player, agent } = fresh();
  slash(registry, player, "aibot:talk", "how are you");
  bedrock.advance(2);
  const reply = said(player);
  assert.match(reply, /\[Steve\]/, "the bot must speak in its own name");
  assert.match(reply, /20\/20/, "the health in the answer must be the bot's real health");

  // Wound it and ask again: the answer has to change with the world.
  const health = agent.entity.getComponent("minecraft:health");
  if (health) health.currentValue = 5;
  player.sentMessages.length = 0;
  slash(registry, player, "aibot:talk", "how are you");
  bedrock.advance(2);
  assert.match(said(player), /5\/20/, "a hurt bot must say it is hurt");
});

test("an order typed at the bot becomes a real, verified task (AC-45 + AC-04)", async () => {
  const { registry, player, agent } = fresh();
  slash(registry, player, "bot:talk", "get me 4 oak logs");
  await flush();
  assert.equal(agent.tasks.current?.status, "ACTIVE", `the order must create a task, got: ${JSON.stringify(agent.tasks.current)}`);
  assert.equal(agent.tasks.current?.target, 4);
  assert.equal(agent.tasks.current?.block, "minecraft:oak_log");
  assert.equal(agent.runtime.lastChat?.topic, "orders", "the conversation remembers it was an order");
  assert.match(said(player), /oak log/i, "the bot must acknowledge the order in words");
});

test("/aibot:talk with no words opens the text box instead of a dead end", async () => {
  const { registry, player } = fresh();
  slash(registry, player, "aibot:talk");
  await flush();
  const modal = ui.shownForms.filter((form) => form.kind === "modal").pop();
  assert.ok(modal, "a form must open");
  assert.match(modal.titleText, /Talk to Steve/);
  assert.equal(modal.fields[0]?.kind, "textField", "the box must accept typed words");
  assert.doesNotMatch(said(player), /No bot is assigned/, "the owner has a bot");
});

test("the panel puts Talk first and it opens the same box", async () => {
  const { player, agent } = fresh();
  const { showControlPanel } = await import("../behavior_packs/autonomous_ai_bot/scripts/ui/control-panel.js");
  // The panel opens first (selection 0 = Talk), then the text box: both answers
  // are queued up front because the stub consumes them in call order.
  ui.queueFormResponse({ canceled: false, selection: 0 });
  const promise = showControlPanel(player, globalThis.__aibotController);
  await flush();
  const panel = ui.shownForms.filter((form) => form.kind === "action").pop();
  assert.equal(panel.buttons.length, 7);
  assert.match(panel.buttons[0], /^Talk to Steve$/, "Talk must be the first button on a chat-less build");
  assert.match(panel.bodyText, /that is chat/);
  await promise;
  const talk = ui.shownForms.filter((form) => form.kind === "modal").pop();
  assert.match(talk.titleText, /Talk to Steve/);
  assert.equal(agent.tasks.current, null);
});

test("words typed into the Talk box take the same route as /aibot:talk", async () => {
  const { player, agent } = fresh();
  const { showTalk } = await import("../behavior_packs/autonomous_ai_bot/scripts/ui/control-panel.js");

  // A conversation line: the bot answers in chat and the box re-opens with the
  // exchange in it, which is what makes this read as chat rather than a dialog.
  ui.queueFormResponse({ canceled: false, formValues: ["what are you doing"] });
  const promise = showTalk(player, agent);
  await promise;
  // "what are you doing" is a status request in the pack's intent grammar (AC-34),
  // so the answer is the same grounded card /aibot:status prints — not prose.
  assert.match(said(player), /Task: None|State: IDLE/, "the bot must answer what it is doing");
  assert.equal(agent.runtime.lastChat?.topic, "status", "the exchange is recorded for the transcript");
  const reopened = ui.shownForms.filter((form) => form.kind === "modal").pop();
  const transcript = reopened.labels.join("\n").replace(/§./g, "");
  assert.match(transcript, /You: what are you doing/, "the exchange must be shown back");
  assert.match(transcript, /Steve: Steve · State: IDLE/, "and the answer the bot actually gave");

  // An impossible order is refused in words, not faked: no pickaxe, no stone
  // task (AC-14/AC-16) — the bot says why instead of quietly doing nothing.
  ui.queueFormResponse({ canceled: false, formValues: ["mine 8 stone"] });
  await showTalk(player, agent);
  assert.equal(agent.tasks.current, null, "an impossible request must not create a task");
  assert.match(said(player), /pickaxe/i, "and it must say what is missing");

  // An order it can actually carry out becomes a real task, exactly like the
  // slash form — same parser, same engine.
  ui.queueFormResponse({ canceled: false, formValues: ["get me 4 oak logs"] });
  await showTalk(player, agent);
  assert.equal(agent.tasks.current?.kind, "collect");
  assert.equal(agent.tasks.current?.block, "minecraft:oak_log");
  assert.equal(agent.tasks.current?.target, 4);
  assert.equal(agent.runtime.lastChat?.topic, "orders");
});

test("the conversation works with no network at all (a phone has no fetch)", async () => {
  const { registry, player, agent } = fresh();
  const realFetch = globalThis.fetch;
  delete globalThis.fetch;
  try {
    for (const words of ["hi", "where are you", "what do you have", "any mobs", "tell me a joke", "banana banana"]) {
      player.sentMessages.length = 0;
      slash(registry, player, "aibot:talk", words);
      await flush();
      assert.ok(said(player).length > 0, `"${words}" must be answered with no network`);
      assert.doesNotMatch(said(player), /undefined|NaN|\[object Object\]/);
      assert.equal(agent.runtime.lastChat?.source, "local", "the phone answers locally; nothing is faked");
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the bot never answers with silence, whatever it is asked", async () => {
  const { registry, player } = fresh();
  // The phone case: no transport at all, so nothing can be handed to a model and
  // every answer has to come from the bot itself.
  const realFetch = globalThis.fetch;
  delete globalThis.fetch;
  const lines = [
    "hello", "how are you", "who are you", "what can you do", "can you fly", "thanks", "sorry",
    "you are useless", "i love you", "bye", "ok", "asdfghjkl", "why is the sky blue", "?!"
  ];
  try {
    for (const words of lines) {
      player.sentMessages.length = 0;
      slash(registry, player, "aibot:talk", words);
      await flush();
      const reply = said(player);
      assert.ok(reply.includes("[Steve]"), `"${words}" got no reply`);
      assert.doesNotMatch(reply, /undefined|NaN|\[object Object\]/, `"${words}" leaked internals`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("on a host with a transport, a provider that fails still leaves a spoken answer", async () => {
  const { registry, player, agent } = fresh();
  const realFetch = globalThis.fetch;
  // A bridge host whose upstream is down: the slow path, not the broken one.
  globalThis.fetch = async () => { throw new Error("connection refused"); };
  try {
    player.sentMessages.length = 0;
    slash(registry, player, "aibot:talk", "asdfghjkl");
    const answered = await waitFor(() => said(player).includes("[Steve]"));
    assert.ok(answered, "a failed provider must not silence the bot");
    assert.equal(agent.runtime.lastChat?.source, "local", "the local brain is what answered");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("two questions in a row do not get the same words back", async () => {
  const { registry, player, agent } = fresh();
  const seen = new Set();
  for (let index = 0; index < 8; index += 1) {
    agent.runtime.tick += 7;
    player.sentMessages.length = 0;
    slash(registry, player, "aibot:talk", "tell me a joke");
    await flush();
    seen.add(said(player).replace(/.*\[Steve\]/s, ""));
  }
  assert.ok(seen.size > 1, "the bot must not repeat one sentence forever");
});

test("a stranger cannot talk to someone else's bot", async () => {
  const { registry, player } = fresh("Owner");
  const stranger = bedrock.addPlayer("Stranger");
  slash(registry, stranger, "aibot:talk", "follow me");
  bedrock.advance(2);
  assert.match(said(stranger), /No bot is assigned to you/);
  assert.doesNotMatch(said(stranger), /\[Steve\]/);
  // …and the owner's bot is untouched.
  assert.equal(player.id !== stranger.id, true);
});

test("the help text tells a chat-less build how to talk, and never to use the chat box", () => {
  const { registry, player } = fresh();
  slash(registry, player, "aibot:help");
  bedrock.advance(2);
  const text = said(player);
  assert.match(text, /\/aibot:talk how are you/, "help must name the command that reaches the bot");
  assert.match(text, /Talk to <name>/, "and the button that needs no commands");
  assert.match(text, /Typing in the game's chat box reaches nobody/);
  assert.doesNotMatch(text, /Steve, get me 32 oak logs/, "must not advertise chat mentions that cannot arrive");
});

test("the join message teaches how to talk to the bot on this build", () => {
  const player = bedrock.addPlayer("Newcomer");
  bedrock.world.afterEvents.playerSpawn.fire({ player, initialSpawn: true });
  bedrock.advance(80);
  const text = said(player);
  assert.match(text, /\/aibot:talk how are you/);
  assert.match(text, /compass/);
});

test("the bot's answers are readable in the error log the pack keeps", async () => {
  const { registry, player, agent } = fresh();
  slash(registry, player, "aibot:talk", "where are you");
  await flush();
  assert.ok(agent.memory.snapshot().shortTerm.some((entry) => /answered: position report/.test(entry.text)));
  assert.equal(agent.runtime.lastChat?.topic, "position");
});
