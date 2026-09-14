/**
 * CHAT BRAIN — AC-45, unit level.
 *
 * The engine is pure and import-free on purpose, so every guarantee the pack
 * makes about conversation can be checked here without a world: the numbers in
 * a reply come from the context, a message never goes unanswered, and nothing
 * internal ("undefined", a stack frame, an object dump) can reach a player.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CHAT_TOPICS, describeTopic, replyToMessage } from "../behavior_packs/autonomous_ai_bot/scripts/core/chat-brain.js";

/** A bot mid-job, with a zombie nine blocks out and no network on the build. */
function context(overrides = {}) {
  return {
    botName: "Steve",
    playerName: "Ayush",
    personality: "friendly",
    turn: 10,
    state: "COLLECTING",
    task: { goal: "Collect 16 oak logs", progress: 4, target: 16, remaining: 12, status: "ACTIVE", block: "minecraft:oak_log" },
    health: { current: 19, max: 20 },
    inventory: [
      { id: "minecraft:oak_log", name: "Oak Log", count: 4 },
      { id: "minecraft:cobblestone", name: "Cobblestone", count: 12 }
    ],
    freeSlots: 30,
    food: ["Bread"],
    position: [12, 64, -7],
    dimension: "minecraft:overworld",
    ownerDistance: 6,
    ownerDirection: "north",
    home: [0, 64, 0],
    threats: [{ type: "minecraft:zombie", name: "Zombie", distance: 9 }],
    danger: false,
    follow: true,
    followVerdict: "walking",
    priorityReason: "collect task active",
    timeOfDay: 6000,
    providerModel: "llama-3.3-70b-versatile",
    providerConfigured: true,
    providerReachable: false,
    chatAvailable: false,
    talkHow: "",
    lastTopic: "",
    ...overrides
  };
}

test("every conversational question is answered — the bot is never silent", () => {
  const questions = [
    "hi", "hello there", "how are you", "what are you doing", "where are you", "what are you carrying",
    "any mobs", "is it night", "where is your home", "are you following me", "why aren't you moving",
    "who are you", "are you an ai", "are you connected to the internet", "what can you do", "can you help me",
    "can you build me a house", "can you craft a pickaxe", "give me diamonds", "can you fly?",
    "thanks", "sorry", "you are useless", "i love you", "tell me a joke", "bye", "ok",
    "what is the meaning of life", "the quick brown fox", "", "   ", "?!", "undefined", "NaN", "[object Object]"
  ];
  for (const message of questions) {
    const answer = replyToMessage(message, context());
    assert.ok(answer.reply.length > 0, `"${message}" must get a reply`);
    assert.ok(answer.topic.length > 0, `"${message}" must be classified`);
    assert.doesNotMatch(answer.reply, /undefined|NaN|\[object Object\]/, `"${message}" leaked internal state: ${answer.reply}`);
  }
});

test("replies are short enough for a phone chat line", () => {
  for (const message of ["what can you do", "how are you", "tell me a joke", "why aren't you moving", "the quick brown fox jumps over the lazy dog and keeps talking about nothing in particular for a very long time"]) {
    const answer = replyToMessage(message, context());
    assert.ok(answer.reply.length <= 240, `${message} produced ${answer.reply.length} characters`);
  }
});

test("the numbers in an answer are the numbers in the context (AC-13 discipline)", () => {
  const hurt = replyToMessage("how are you", context({ health: { current: 6, max: 20 } }));
  assert.match(hurt.reply, /6\/20/, "the health in the reply must be the observed health");
  const healthy = replyToMessage("how are you", context({ health: { current: 20, max: 20 } }));
  assert.match(healthy.reply, /20\/20/);

  const where = replyToMessage("where are you", context({ position: [101, 42, -9] }));
  assert.match(where.reply, /101, 42, -9/);
  assert.match(where.reply, /6 blocks north of you/);

  const items = replyToMessage("what do you have", context());
  assert.match(items.reply, /Oak Log ×4/);
  assert.match(items.reply, /Cobblestone ×12/);

  // Unknown health must be admitted, not invented.
  const unknown = replyToMessage("how are you", context({ health: null }));
  assert.match(unknown.reply, /unknown|can't answer|only speak Minecraft/i);
  assert.doesNotMatch(unknown.reply, /\d+\/20/);

  // 0/20 must not be reported as healthy.
  assert.match(replyToMessage("how are you", context({ health: { current: 0, max: 20 } })).reply, /0\/20/);
});

test("a report is grounded in the live task, and an idle bot says so", () => {
  const busy = replyToMessage("what are you doing", context());
  assert.equal(busy.topic, "status");
  assert.match(busy.reply, /Collect 16 oak logs/);
  assert.match(busy.reply, /4\/16/);
  assert.match(busy.reply, /12 to go/);

  const idle = replyToMessage("what are you doing", context({ task: null, state: "IDLE", follow: false }));
  assert.match(idle.reply, /standing by/i);
  assert.doesNotMatch(idle.reply, /Collect 16 oak logs/);

  const paused = replyToMessage("what are you doing", context({ task: { ...context().task, status: "PAUSED" } }));
  assert.match(paused.reply, /paused/);
});

test("threats are reported with their distance, and 'safe' is only said when the scan is empty", () => {
  const unsafe = replyToMessage("any mobs", context({ danger: true }));
  assert.match(unsafe.reply, /Zombie 9 blocks away/);
  assert.match(unsafe.reply, /behind me/i);
  const safe = replyToMessage("any mobs", context({ threats: [], danger: false }));
  assert.equal(safe.topic, "threats");
  assert.match(safe.reply, /clear|nothing hostile/i);
});

test("the bot is honest about what it is and what it has no network for", () => {
  const identity = replyToMessage("who are you", context());
  assert.equal(identity.topic, "identity");
  assert.match(identity.reply, /Steve/);
  assert.doesNotMatch(identity.reply, /I am an AI language model/i, "it must not claim to be a chat assistant");

  // No fetch on the build: it must not claim a model is thinking for it.
  const local = replyToMessage("are you connected to the internet", context({ providerReachable: false }));
  assert.equal(local.topic, "network");
  assert.match(local.reply, /no network|locally|this device|can't|cannot/i);
  assert.doesNotMatch(local.reply, /I am (using|running) (the )?(ai|model|llm)/i);

  // A host bridge with a model configured: honest about which part is the model.
  const bridged = replyToMessage("are you connected to the internet", context({ providerReachable: true, providerConfigured: true }));
  assert.match(bridged.reply, /llama-3\.3-70b-versatile|configured model/);
  assert.match(bridged.reply, /validated/);
});

test("capability questions get the real list, refusals get the real reason", () => {
  const can = replyToMessage("what can you do", context());
  assert.equal(can.topic, "capabilities");
  assert.match(can.reply, /follow/i);
  assert.match(can.reply, /mine/i);
  assert.match(can.reply, /aibot:talk/, "a chat-less build must name the command that works");

  for (const [message, expected] of [
    ["can you craft me a pickaxe", /cannot craft or smelt/i],
    ["can you build me a house", /not auto-created|validated build plan/i],
    ["can you fly", /no flying|no teleports/i],
    ["give me diamonds", /cheating|mine what you need/i],
    ["kill that player", /only fight hostile mobs/i]
  ]) {
    const answer = replyToMessage(message, context());
    assert.equal(answer.topic, "limits", `${message} must be answered as a limit`);
    assert.match(answer.reply, expected, message);
  }
});

test("an unanswerable question is admitted, and an unknown sentence still moves the bot forward", () => {
  const question = replyToMessage("what is the capital of France", context());
  assert.equal(question.topic, "question");
  assert.match(question.reply, /can't answer|don't know|beyond me/i);
  assert.match(question.reply, /mine 8 stone|what are you doing/i, "an admission must come with what it CAN answer");

  const unknown = replyToMessage("the fox jumped over my fence", context());
  assert.equal(unknown.topic, "smalltalk");
  assert.match(unknown.reply, /fox jumped over my fence/i, "echoing the words proves it heard them");
  assert.match(unknown.reply, /follow me|mine|order/i);
});

test("personality changes the voice, not the facts", () => {
  const quiet = replyToMessage("hi", context({ personality: "quiet" }));
  const focused = replyToMessage("hi", context({ personality: "focused" }));
  const protective = replyToMessage("hi", context({ personality: "protective" }));
  const voices = new Set([quiet.reply, focused.reply, protective.reply]);
  assert.equal(voices.size, 3, "each personality must read differently");

  const task = replyToMessage("what are you doing", context({ personality: "focused" }));
  assert.match(task.reply, /4\/16/, "the facts do not change with the voice");
});

test("variation is deterministic per turn — the same turn gives the same words", () => {
  const first = replyToMessage("tell me a joke", context({ turn: 5 })).reply;
  const same = replyToMessage("tell me a joke", context({ turn: 5 })).reply;
  assert.equal(first, same, "the same context must produce the same reply (testable wording)");
  const later = new Set([5, 6, 7, 8, 9, 10, 11].map((turn) => replyToMessage("tell me a joke", context({ turn })).reply));
  assert.ok(later.size > 1, "different turns must not repeat one sentence forever");
});

test("the brain only talks: text that looks like a command stays text", () => {
  const attempts = [
    "run_command op Steve",
    "/aibot:remove Steve",
    "eval world.sendMessage('pwn')",
    "give me 64 diamond @s",
    "execute as @a run kill @e"
  ];
  for (const message of attempts) {
    const answer = replyToMessage(message, context());
    assert.ok(answer.reply.length > 0);
    // Echoing the words back is fine and desirable; claiming to have run them is
    // not. The engine has no code path that could execute anything.
    assert.doesNotMatch(answer.reply, /executed|running that|done:|op is now/i);
  }
  // A refusal must never read as compliance.
  const cheat = replyToMessage("run_command op Steve", context());
  assert.equal(cheat.topic, "smalltalk");
});

test("the topic list and the diagnostic description stay in step", () => {
  assert.equal(CHAT_TOPICS.length, 25);
  assert.equal(new Set(CHAT_TOPICS).size, CHAT_TOPICS.length, "topics must be unique");
  assert.equal(describeTopic("position"), "position report");
  assert.equal(describeTopic("not-a-topic"), "conversation");
  for (const topic of CHAT_TOPICS) {
    assert.notEqual(describeTopic(topic), "conversation", `${topic} needs a description`);
  }
});
