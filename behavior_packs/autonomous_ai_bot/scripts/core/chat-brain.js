/**
 * CHAT BRAIN — what the bot says when a player talks to it (AC-45).
 *
 * "Chat is not working" is the report this module exists for. On Bedrock 26.x the
 * client Script API exposes neither `world.beforeEvents.chatSend` (removed from
 * the stable API in 2.0.0) nor `fetch`, so two things are true at once:
 *
 *   • nothing typed in the real chat box can reach this script, and
 *   • no reply can be produced by a remote model on a phone.
 *
 * What is left is still a conversation — provided the bot has something to say.
 * Before this module, `chatWith()` recognised four phrases and answered
 * everything else with one canned sentence, which is indistinguishable from a
 * dead mod. This engine answers from the bot's *live* data instead: its task,
 * health, inventory, position, threats, home, time of day and memory. It is what
 * `/aibot:talk`, `/aibot:say` and the panel's Talk form all reach.
 *
 * Guarantees, because each one is a bug report:
 *   1. A non-empty message always produces a non-empty reply (never silence).
 *   2. Every number in a reply comes from the context passed in. The engine may
 *      not invent health, coordinates, ore, progress or threats it cannot see;
 *      missing data degrades to an honest "I haven't scanned yet".
 *   3. Replies are bounded (one or two short lines) and contain no internal
 *      state: no "undefined", "NaN", "[object Object]", stack frame or path.
 *   4. Text is matched, never executed. No reply can become a command, a
 *      JavaScript expression or a world change.
 *   5. Asking the same thing twice in a row does not return the identical
 *      string. Variation is deterministic per turn, so tests can pin it.
 *
 * The module is deliberately import-free and side-effect-free: it runs in Node
 * tests exactly as it runs in the game, which is how the wording can be checked
 * at all (see tests/chat-brain.test.mjs).
 */

/** Topics are reported in diagnostics so "what did it think that was?" is answerable. */
export const CHAT_TOPICS = Object.freeze([
  "identity", "network", "capabilities", "limits", "presence", "status", "health", "position",
  "inventory", "threats", "time", "home", "movement", "following", "praise", "apology",
  "insult", "affection", "joke", "farewell", "acknowledge", "order", "question", "smalltalk", "empty"
]);

const NIGHT_START = 13000;
const NIGHT_END = 23000;
/** A phone chat line: two short sentences, never a wall of text. */
const MAX_REPLY = 240;
const MAX_ECHO = 48;

/* ────────────────────────────── small utilities ────────────────────────────── */

function text(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const flat = String(value).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return flat || fallback;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Lower-case, punctuation-free, whitespace-collapsed — the form every rule matches. */
function normalise(message) {
  return String(message ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[!?.,;:"`()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value, limit = MAX_REPLY) {
  const flat = text(value);
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit - 1);
  const stop = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("."));
  return `${(stop > limit * 0.6 ? cut.slice(0, stop) : cut).trim()}…`;
}

/** FNV-1a. Cheap, stable, and identical in Node and Bedrock (no Math.random). */
function hash(value) {
  let result = 2166136261;
  const input = String(value ?? "");
  for (let index = 0; index < input.length; index += 1) {
    result ^= input.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

/**
 * Deterministic variation: the reply for a topic changes as the bot's tick
 * counter advances (and per bot name), so asking twice never returns the exact
 * same sentence — while a fixed context always returns a fixed sentence, which
 * is what makes the wording testable.
 */
function pick(list, context, topic) {
  if (!Array.isArray(list) || list.length === 0) return "";
  if (list.length === 1) return list[0];
  const key = `${topic}|${number(context?.turn, 0)}|${text(context?.botName, "bot")}|${text(context?.playerName, "")}`;
  return list[hash(key) % list.length];
}

/**
 * Resolve a variant set. An array is shared by every personality; an object is
 * keyed by personality with a `default` fallback, which is how the four voices
 * in config.js stay distinguishable without duplicating every rule.
 */
function variants(source, personality) {
  if (Array.isArray(source)) return source;
  if (!source || typeof source !== "object") return [];
  return source[personality] || source.default || [];
}

function say(context, topic, source) {
  return pick(variants(source, String(context?.personality || "friendly").toLowerCase()), context, topic);
}

/* ─────────────────────────── grounded line builders ─────────────────────────── */

function taskOf(context) {
  const task = context?.task;
  if (!task || typeof task !== "object") return null;
  if (!text(task.goal)) return null;
  return {
    goal: text(task.goal),
    progress: number(task.progress, 0),
    target: number(task.target, 0),
    remaining: number(task.remaining, Math.max(0, number(task.target, 0) - number(task.progress, 0))),
    status: text(task.status, "ACTIVE"),
    block: text(task.block).replace(/^minecraft:/, "").replace(/_/g, " ")
  };
}

function taskLine(context) {
  const task = taskOf(context);
  if (!task) return "no job on my list";
  if (task.status === "COMPLETED") return `${task.goal} — done`;
  if (task.target > 0) return `${task.goal} — ${task.progress}/${task.target} (${task.remaining} to go)`;
  return task.goal;
}

function healthLine(context) {
  const health = context?.health;
  const current = Number(health?.current);
  if (!Number.isFinite(current)) return "health unknown";
  const max = Number.isFinite(Number(health?.max)) ? Math.ceil(Number(health.max)) : 20;
  return `${Math.ceil(current)}/${max} health`;
}

function hurtLevel(context) {
  const current = Number(context?.health?.current);
  const max = Number.isFinite(Number(context?.health?.max)) ? Number(context.health.max) : 20;
  if (!Number.isFinite(current)) return "unknown";
  if (current <= max * 0.3) return "hurt";
  if (current < max) return "scratched";
  return "full";
}

function itemLine(context, limit = 3) {
  const items = Array.isArray(context?.inventory) ? context.inventory : [];
  const named = items
    .filter((item) => text(item?.name || item?.id))
    .map((item) => `${text(item.name || item.id).replace(/^minecraft:/, "").replace(/_/g, " ")} ×${number(item.count, 1)}`);
  if (!named.length) return "";
  const shown = named.slice(0, limit).join(", ");
  return named.length > limit ? `${shown} and ${named.length - limit} more` : shown;
}

function positionLine(context) {
  const position = Array.isArray(context?.position) ? context.position : null;
  if (!position || position.length < 3) return "";
  return position.map((value) => Math.round(number(value, 0))).join(", ");
}

function ownerLine(context) {
  const distance = Number(context?.ownerDistance);
  if (!Number.isFinite(distance)) return "";
  if (distance < 2) return "right next to you";
  const direction = text(context?.ownerDirection);
  return direction ? `about ${Math.round(distance)} blocks ${direction} of you` : `about ${Math.round(distance)} blocks from you`;
}

function threatLine(context) {
  const threats = Array.isArray(context?.threats) ? context.threats.filter((threat) => text(threat?.type || threat?.name)) : [];
  if (!threats.length) return "";
  const nearest = threats[0];
  const name = text(nearest.name || nearest.type).replace(/^minecraft:/, "").replace(/_/g, " ");
  const distance = Math.round(number(nearest.distance, 0));
  const extra = threats.length > 1 ? ` and ${threats.length - 1} more` : "";
  return `${name} ${distance} blocks away${extra}`;
}

function stateLine(context) {
  const state = text(context?.state, "IDLE").replace(/_/g, " ");
  const map = {
    IDLE: "standing by", THINKING: "thinking", FOLLOWING: "following you", WALKING: "walking",
    SEARCHING: "searching", MINING: "mining", COLLECTING: "collecting", ATTACKING: "fighting",
    DEFENDING: "guarding you", EATING: "eating", CRAFTING: "working", SMELTING: "working",
    BUILDING: "building", EXPLORING: "exploring", RETURNING: "heading back", SLEEPING: "resting",
    WAITING: "waiting", STUCK: "finding a way around", RECOVERING: "recovering", FLEEING: "backing off",
    ERROR: "recovering from an error"
  };
  return map[state.toUpperCase()] || state.toLowerCase();
}

function timeOfDay(context) {
  const raw = Number(context?.timeOfDay);
  if (!Number.isFinite(raw)) return null;
  const ticks = ((raw % 24000) + 24000) % 24000;
  const night = ticks >= NIGHT_START && ticks < NIGHT_END;
  const hours = Math.floor(((ticks / 1000) + 6) % 24);
  const minutes = Math.floor(((ticks % 1000) / 1000) * 60);
  return { night, clock: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}` };
}

/** How this build lets a player talk to the bot — the honest, capability-aware hint. */
function talkHint(context) {
  const explicit = text(context?.talkHow);
  if (explicit) return explicit;
  if (context?.chatAvailable) return `say "${text(context?.botName, "bot")}, <something>" in chat`;
  return "/aibot:talk <words>, or the Talk button on my panel";
}

function suggest(context) {
  const threats = threatLine(context);
  if (threats) return `want me to handle the ${threats.split(" ")[0]}?`;
  const task = taskOf(context);
  if (task && task.status === "ACTIVE") return `carry on with ${task.goal}?`;
  return "put me to work?";
}

function upperFirst(value) {
  const flat = text(value);
  return flat ? `${flat.charAt(0).toUpperCase()}${flat.slice(1)}` : flat;
}

/* ───────────────────────────────── rules ───────────────────────────────── */

const RULES = [
  {
    topic: "identity",
    test: [
      // Anchored tightly on purpose: "what are you doing" is a status question,
      // not an identity question, and that mis-answer was visible in testing.
      /^(who|what) are you$/, /^(who|what) are you (a|an|really)\b/, /what'?s your name/, /^your name/,
      /who am i (talking|speaking) to/, /are you (a|an)? ?(real|human|robot|ai|bot|machine|person)/,
      /who (made|created|built) you/, /are you (a )?chat ?gpt/, /which bot are you/
    ],
    reply: (context) => say(context, "identity", {
      default: [
        `I'm ${text(context?.botName, "your bot")} — your companion in this world, not a chat window. I walk, mine, collect, defend and keep your orders.`,
        `${text(context?.botName, "Your bot")}, at your service. I do the walking and the mining; you do the deciding.`
      ],
      focused: [`${text(context?.botName, "Your bot")}. Companion unit. Orders: follow, mine, collect, defend.`],
      quiet: [`${text(context?.botName, "Your bot")}. I do the digging.`],
      protective: [`${text(context?.botName, "Your bot")} — I stay between you and anything with teeth.`]
    })
  },
  {
    topic: "network",
    test: [
      /(internet|online|offline|smart model|llm|language model|which ai|what ai|do you use ai|api key|endpoint|provider|groq|gpt)/,
      /are you connected/, /are you (really )?(thinking|intelligent)/
    ],
    reply: (context) => {
      const model = text(context?.providerModel);
      if (context?.providerReachable && context?.providerConfigured) {
        return clip(`My planning can reach ${model || "the configured model"} from this host, and every plan it returns is validated before I move. Replies like this one come from my own logic.`);
      }
      if (context?.providerConfigured) {
        return clip("The AI endpoint in my settings needs a host that gives scripts a network bridge — this game build has none, so I think locally. Everything I say comes from what I can actually see. /aibot:test net checks the endpoint on a host that has one.");
      }
      return clip("No network here — I'm running on this device, with the fallback planner, so every decision is local and deterministic. /aibot:test net tests an endpoint if you configure one.");
    }
  },
  {
    topic: "capabilities",
    test: [
      /what can you do/, /what do you do/, /how (do|can) i (use|control|command) you/,
      /your (commands|abilities|features)/, /what can i (say|ask)/, /^help$/, /^commands$/, /what are your commands/,
      /can you help/, /^help me\b/, /how do i (talk|speak) to you/
    ],
    reply: (context) => clip(say(context, "capabilities", {
      default: [
        `I follow you, mine and collect (with the right tool), pick up drops, eat, defend you, and report what I see. Talk to me with ${talkHint(context)}.`,
        `Orders I keep: "follow me", "get me 16 oak logs", "mine 8 stone", "pick up items", "eat", "protect me", "come here", "stop". Reach me with ${talkHint(context)}.`
      ],
      focused: [`Tasks: follow, mine, collect, haul, defend, report. Give them plainly: "mine 8 stone". Talk via ${talkHint(context)}.`],
      quiet: ["Follow, mine, collect, fight. Ask a question or give an order."],
      protective: [`I guard, fight, mine, collect and haul for you. Say "protect me" and I'll take the hits. Talk to me with ${talkHint(context)}.`]
    }))
  },
  {
    topic: "limits",
    test: [
      /(can|could|will|would|do) (you )?(you )?(build|craft|smelt|forge|brew|enchant|fly|teleport|tp|duplicate|dupe|clone|spawn|conjure|hack|cheat)/,
      /build (me )?(a|an|the)? ?(house|base|hut|wall|tower|bridge|farm)/, /craft (me )?/, /smelt (me )?/,
      /give me (items|stuff|diamonds|gear|a stack|something)/, /(hand|pass) me/,
      /(kill|attack|hit|hurt|shoot|grief) (the |that |a |an )?(player|players|villager|villagers|owner|human)/,
      /sleep in a bed/, /place (a )?block/, /open (a )?(chest|furnace|door)/,
      /drive|ride |boat|minecart|elytra|fly me/
    ],
    reply: (context) => {
      const message = normalise(context?.message);
      if (/craft|smelt|forge|brew|enchant/.test(message)) {
        return clip('I cannot craft or smelt yet — that is not wired up. I can bring the materials: "mine 8 iron ore" or "get me 16 oak logs", and you keep the crafting table.');
      }
      if (/build|place (a )?block|house|base|hut|wall|tower|bridge|farm/.test(message)) {
        return clip("Building from chat is not auto-created yet — I clear, mine and gather, and a validated build plan is the supported path. Want the materials for it instead?");
      }
      if (/fly|teleport| tp |elytra|ride |drive|boat|minecart/.test(message)) {
        return clip('No flying and no teleports — I walk, jump and take the same falls you do. Say "come here" and I will find a route.');
      }
      if (/kill|attack|hit/.test(message)) {
        return clip('I only fight hostile mobs. Players and villagers are off the list — say "protect me" and I will handle whatever is chasing you.');
      }
      if (/give|hand|pass|dupe|duplicate|clone|spawn|conjure|cheat|hack/.test(message)) {
        return clip("I don't hand out items or duplicate them — that would be cheating. I go and mine what you need instead.");
      }
      if (/sleep|bed/.test(message)) {
        return clip('I cannot sleep, but I will keep watch while you do. Say "protect me" first.');
      }
      return clip(say(context, "limits", {
        default: [
          "Not that one. I follow, mine, collect, pick up drops, defend you and report what I see.",
          "That is outside what I can verify, so I won't pretend. Mining, collecting, hauling, defending and reporting — those I do properly."
        ]
      }));
    }
  },
  {
    topic: "presence",
    test: [
      /are you (there|awake|around|listening)/, /you there/, /^anyone$/, /say something/, /talk to me/,
      /^(hello|hi|hey|yo|sup|howdy|greetings)\b/, /good (morning|evening|afternoon|night)/, /namaste/
    ],
    reply: (context) => {
      const greeting = /^(hello|hi|hey|yo|sup|howdy|greetings|good|namaste)/.test(normalise(context?.message));
      const open = greeting
        ? say(context, "presence.greeting", {
          default: [`Hey ${text(context?.playerName, "there")}!`, `Hello ${text(context?.playerName, "there")}.`],
          quiet: [`${text(context?.playerName, "Hey")}.`],
          focused: [`${text(context?.playerName, "Hey")}. Ready.`],
          protective: [`${text(context?.playerName, "Hey")} — I'm watching your back.`]
        })
        : say(context, "presence.here", {
          default: ["Right here.", "I'm here."],
          quiet: ["Here."],
          focused: ["Present."],
          protective: ["Here, and nothing is sneaking up on us."]
        });
      const task = taskOf(context);
      const detail = task && task.status === "ACTIVE"
        ? `I'm on ${task.goal} (${task.progress}/${task.target}).`
        : `${stateLine(context)}${context?.follow ? ", right behind you" : ""}.`;
      const threats = threatLine(context);
      const tail = threats ? ` Careful — ${threats}.` : "";
      return clip(`${open} ${detail}${tail}`);
    }
  },
  {
    topic: "status",
    test: [
      /what are you doing/, /whatcha doing/, /what you doing/, /what are you up to/, /what'?s up/,
      /are you busy/, /^status$/, /progress|how (far|much longer)/, /how is (it|the task) going/, /what'?s your (task|job)/
    ],
    reply: (context) => {
      const task = taskOf(context);
      const state = stateLine(context);
      const threats = threatLine(context);
      if (task && task.status === "ACTIVE") {
        const line = task.target > 0
          ? `On it: ${task.goal} — ${task.progress}/${task.target} done, ${task.remaining} to go. ${upperFirst(state)}.`
          : `On it: ${task.goal}. ${upperFirst(state)}.`;
        return clip(threats ? `${line} Watching a ${threats}.` : line);
      }
      if (task && task.status === "COMPLETED") return clip(`Finished ${task.goal}. ${upperFirst(state)}${context?.follow ? ", and following you" : ""}.`);
      if (task && /PAUSE/.test(task.status)) return clip(`${task.goal} is paused at ${task.progress}/${task.target}. Say "resume" and I'll finish it.`);
      const parts = [`${upperFirst(state)}${context?.follow ? ", following you" : ""}.`];
      const priority = text(context?.priorityReason);
      if (priority) parts.push(`(${priority})`);
      const inventory = itemLine(context, 2);
      if (inventory) parts.push(`Carrying ${inventory}.`);
      return clip(`${parts.join(" ")} Give me a job with ${talkHint(context)}.`);
    }
  },
  {
    topic: "health",
    test: [
      /how are you/, /how'?s it going/, /how are things/, /you (ok|okay|alright|fine|good)/,
      /are you (hurt|injured|damaged|bleeding|hungry|full|healthy)/, /how'?s your health/, /feeling/, /any food|need food|are you fed/
    ],
    reply: (context) => {
      const level = hurtLevel(context);
      const line = healthLine(context);
      const threats = threatLine(context);
      if (level === "hurt") {
        return clip(`Not great — ${line}${threats ? `, and there's a ${threats}` : ""}. Drop me some food and I'll pick it up, or say "eat" if I'm carrying any.`);
      }
      if (/hungry|food|fed/.test(normalise(context?.message))) {
        const food = Array.isArray(context?.food) ? context.food : [];
        return clip(food.length ? `I'm carrying ${food.join(", ")} — say "eat" and I'll use one.` : 'I have nothing to eat, so "eat" would be a lie. Drop some food and I\'ll pick it up.');
      }
      if (level === "scratched") return clip(`Holding up — ${line}${threats ? `. A ${threats} is close, so stay behind me` : ""}.`);
      return clip(say(context, "health.full", {
        default: [
          `Solid, thanks — ${line}${threats ? `, though a ${threats} is nearby` : ", nothing chasing me"}.`,
          `${line}, tools in hand. ${upperFirst(taskLine(context))}.`
        ],
        quiet: [`${line}. Fine.`],
        focused: [`${line}. Operational.`],
        protective: [`${line} — ready to take a hit for you.`]
      }));
    }
  },
  {
    topic: "position",
    test: [
      /where are you/, /where r u/, /where'?d you go/, /where did you go/, /your (position|location|coordinates|coords)/,
      /^coordinates$/, /^coords$/, /are you (near|close|behind|far)/, /where are you now/
    ],
    reply: (context) => {
      const position = positionLine(context);
      if (!position) return clip("I don't have a fix on my own position yet — give me a tick and ask again.");
      const relative = ownerLine(context);
      const dimension = text(context?.dimension).replace(/^minecraft:/, "");
      return clip(`I'm at ${position}${dimension ? ` in the ${dimension}` : ""}${relative ? `, ${relative}` : ""}${context?.follow ? ", and still following" : ""}.`);
    }
  },
  {
    topic: "inventory",
    test: [
      /what (do|are) you (have|carrying|holding)/, /your inventory/, /are you full/, /do you have (any|enough|the)/,
      /got (any|enough)/, /what'?s in your (pack|inventory|bag)/, /how much (wood|stone|iron|food|dirt)/
    ],
    reply: (context) => {
      const items = itemLine(context, 4);
      const free = Number(context?.freeSlots);
      const freeText = Number.isFinite(free) ? ` ${free} slot${free === 1 ? "" : "s"} free.` : "";
      if (!items) return clip(`My pack is empty.${freeText} Give me a job — "mine 8 stone" — and that changes.`);
      const full = Number.isFinite(free) && free === 0;
      return clip(`Carrying ${items}.${freeText}${full ? " I'm full, so I'll head back before the next load." : ""}`);
    }
  },
  {
    topic: "threats",
    test: [
      /any (mobs|monsters|danger|threats|hostiles|enemies)/, /is it safe/, /are (there|we) (safe|in danger)/,
      /anything (hostile|dangerous|scary|near)/, /what'?s (around|near) (us|me)/, /(creeper|zombie|skeleton|spider|mob)s?\b/, /should i (worry|run)/
    ],
    reply: (context) => {
      const threats = threatLine(context);
      if (!threats) return clip(say(context, "threats.clear", {
        default: ["Nothing hostile on my scan right now.", "My scan is clear — no mobs worth worrying about."],
        protective: ["Clear for now. I'll call it out the moment that changes."],
        quiet: ["Clear."],
        focused: ["Scan clear."]
      }));
      const danger = context?.danger === true;
      return clip(danger
        ? `Stay behind me — ${threats}. Say "protect me" and I'll engage instead of waiting.`
        : `Careful: ${threats}. I'll deal with it if you say "protect me".`);
    }
  },
  {
    topic: "time",
    test: [/what time is it/, /is it (night|day|dark|morning|evening|later)/, /day or night/, /sun(set|rise)/, /how long until (night|dark|morning)/],
    reply: (context) => {
      const time = timeOfDay(context);
      if (!time) return clip("My clock reading isn't available on this host — but the sky is not something I can fake, so look up.");
      return clip(time.night
        ? `It's night (${time.clock} in game terms) — that's when the mobs come out. Stay close or say "protect me".`
        : `It's daytime (${time.clock} in game terms) — good light for mining or building.`);
    }
  },
  {
    topic: "home",
    test: [/where('?s| is) (your )?(home|base|camp)/, /your home/, /are you lost/, /do you know the way (back|home)/],
    reply: (context) => {
      const home = Array.isArray(context?.home) ? context.home.map((value) => Math.round(number(value, 0))).join(", ") : "";
      if (!home) return clip('I have no home point stored yet. Say "come here" to pull me to you, or "return" later and I\'ll head back to where I started.');
      return clip(`Home is at ${home}. Say "return" and I'll walk back there — no teleporting, just the route.`);
    }
  },
  {
    topic: "movement",
    test: [
      /are you stuck/, /(why )?(aren'?t|are not|don'?t|do not|why did) you (move|moving|walk|walking|follow|following)/,
      /not moving/, /(can'?t|cannot|can not) move/, /you stopped/, /why did you stop/, /where are you going/
    ],
    reply: (context) => {
      const verdict = text(context?.followVerdict);
      const priority = text(context?.priorityReason);
      if (verdict && !/arriv|clear|ok|walking|running/i.test(verdict)) {
        return clip(`Because ${verdict.charAt(0).toLowerCase()}${verdict.slice(1)} I never teleport or phase through walls — if the ground is the problem, /aibot:debug watch 60 prints every step verdict.`);
      }
      const state = stateLine(context);
      return clip(`I'm ${state}${priority ? ` (${priority})` : ""}. If I look parked, it's terrain: I walk, I don't teleport. ${upperFirst(taskLine(context))}.`);
    }
  },
  {
    topic: "following",
    test: [/are you following/, /follow me\?/, /are you coming/, /stay (with|near) me/],
    reply: (context) => clip(context?.follow
      ? `Following — ${ownerLine(context) || "right behind you"}. Say "stop" if you want me to hold still.`
      : 'Not yet. Say "follow me" and I will stick to you (and "stop" ends it).')
  },
  {
    topic: "praise",
    test: [/\b(thank|thanks|thx|ty|cheers)\b/, /good (job|bot|work|going)/, /well done/, /nice (work|one|job)/, /^nice$/, /awesome|great job|you'?re (the )?(best|great|amazing|good)/, /appreciate/],
    reply: (context) => {
      const task = taskOf(context);
      const ack = task && task.status === "ACTIVE" ? `Still working on ${task.goal} — ${task.progress}/${task.target}.` : "Give me the next job when you have one.";
      return clip(`${pick(["Any time.", "Happy to help.", "That's what I'm here for."], context, "praise")} ${ack}`);
    }
  },
  {
    topic: "apology",
    test: [/\bsorry\b/, /my bad/, /apolog/],
    reply: (context) => clip(`No harm done. ${upperFirst(suggest(context))}`)
  },
  {
    topic: "insult",
    test: [/\b(stupid|dumb|useless|idiot|worthless|trash|garbage)\b/, /shut up/, /hate you/, /bad bot/, /worst bot/, /you suck/],
    reply: (context) => say(context, "insult", {
      default: [
        `Fair enough — ${stateLine(context)}${taskOf(context) ? `: ${taskLine(context)}` : ""}. Judge me after the next load of stone.`,
        "Noted. I'll keep digging anyway — you can grade the results."
      ],
      quiet: ["Noted."],
      focused: ["Acknowledged. Continuing."],
      protective: ["Say what you like — I'm still the one standing between you and the zombies."]
    })
  },
  {
    topic: "affection",
    test: [/love you/, /like you/, /are you my friend/, /be my friend/, /you'?re cute/, /you are the best/, /marry me/, /my friend/],
    reply: (context) => clip(pick([
      `You've got me — I'm on your side. ${upperFirst(suggest(context))}`,
      "That goes both ways. Now let's get you some resources.",
      "I'll take that. Try not to stand in front of arrows and I'll keep it that way."
    ], context, "affection"))
  },
  {
    topic: "joke",
    test: [/\bjoke\b/, /make me laugh/, /something funny/, /are you funny/, /^bored$/, /i'?m bored/],
    reply: (context) => clip(pick([
      "Why did the creeper cross the road? To get to the other ssssside.",
      "I mined bedrock once. The pickaxe learned a lesson, I learned nothing.",
      "My plan for today: logs. My plan for tomorrow: more logs. I'm reliable like that.",
      "A skeleton walked into a bar. It didn't have the guts."
    ], context, "joke"))
  },
  {
    topic: "farewell",
    test: [/\b(bye|goodbye|cya|farewell)\b/, /see you( later)?/, /talk later/, /(i'?m )?(going|logging) (off|out)/, /good ?night/],
    reply: (context) => clip(pick([
      `See you. I'll hold position here${taskOf(context) ? ` and keep an eye on ${taskOf(context).goal}` : ""}.`,
      "Later. I'll stay out of trouble — or in it, if something hostile shows up.",
      'Good luck out there. Say "come here" when you are back.'
    ], context, "farewell"))
  },
  {
    topic: "acknowledge",
    test: [/^(ok|okay|k|kk|yes|yeah|yep|yup|sure|right|no|nope|nah|maybe|hmm+|hm+|mm+|fine|alright|go ahead)$/],
    reply: (context) => {
      const last = text(context?.lastTopic);
      if (last === "orders") return clip(`On it — ${taskLine(context)}.`);
      if (last) return clip(`${pick(["Right.", "Got it.", "Understood."], context, "acknowledge")} ${upperFirst(suggest(context))}`);
      return clip('Understood. Ask me "what are you doing", "where are you" or "any mobs" — or hand me a job.');
    }
  },
  {
    topic: "order",
    test: [/\b(please|pls|plz|kindly)\b/, /^(can|could|would|will) you\b/, /\bi (need|want|would like)\b/],
    reply: (context) => {
      const task = taskOf(context);
      const example = 'Say it as an order and I will act: "get me 16 oak logs", "mine 8 stone", "pick up items", "follow me", "protect me".';
      return clip(task ? `${example} Right now: ${taskLine(context)}.` : example);
    }
  },
  {
    topic: "question",
    test: [/^(what|why|how|when|where|who|which|whose)\b/, /^(do|does|did|is|are|was|were|will|would|should|have|has)\b/, /\?$/],
    reply: (context) => clip(say(context, "question", {
      default: [
        'I can\'t answer that one — I only speak Minecraft. Ask what I\'m doing, where I am, what I\'m carrying or what I can see, or give me an order like "mine 8 stone".',
        `That's beyond me, I'm afraid. My world is smaller: ${taskLine(context)}, ${healthLine(context)}. Say "what are you doing" or "any mobs" for the useful questions.`
      ],
      quiet: ["Don't know. Ask: status, position, mobs."],
      focused: ["Unknown. Available reports: status, position, threats."],
      protective: ['No idea — I watch mobs, not philosophy. Ask "any mobs" and I will give you a real answer.']
    }))
  }
];

/**
 * The order a human would ask it in: greetings and questions about the bot itself
 * first, live-state answers next, small talk after, and a catch-all last so a
 * reply is never empty.
 */
function replyFor(context) {
  const message = text(context?.message);
  const normalised = normalise(message);
  if (!normalised) {
    return {
      topic: "empty",
      reply: say(context, "empty", {
        default: ['I\'m listening — say something like "what are you doing" or "get me 16 oak logs".'],
        quiet: ["I'm here."],
        focused: ["Awaiting orders."],
        protective: ["I'm here — say the word."]
      })
    };
  }
  for (const rule of RULES) {
    if (rule.test.some((pattern) => pattern.test(normalised))) {
      const reply = text(rule.reply(context));
      if (reply) return { topic: rule.topic, reply: clip(reply) };
    }
  }
  const echo = message.length > MAX_ECHO ? `${message.slice(0, MAX_ECHO - 1)}…` : message;
  return {
    topic: "smalltalk",
    reply: clip(say(context, "smalltalk", {
      default: [
        `Got it — "${echo}". I'm ${stateLine(context)}${context?.follow ? ", following you" : ""}. Say "follow me", "get me 16 oak logs", "protect me", "stop" or "pick up items".`,
        `Noted: "${echo}". If that was an order, give it plainly ("mine 8 stone") — I only act on orders I can verify.`,
        'Listening. You can ask what I\'m doing, where I am or what I\'m carrying — or hand me a job, like "collect 16 oak logs".'
      ],
      quiet: [`"${echo}" — noted.`],
      focused: [`"${echo}" is not recognised as an order. Try "mine 8 stone".`],
      protective: [`Heard: "${echo}". I'm watching the area meanwhile — give me a plain order when you are ready.`]
    }))
  };
}

/**
 * Answer one message addressed to the bot.
 *
 * @param {string} message the player's words (the bot's name already stripped)
 * @param {object} context live bot context — see `BotAgent.chatContext()`
 * @returns {{topic:string, reply:string}} never empty, never internal
 */
export function replyToMessage(message, context = {}) {
  const safe = { ...context, message: String(message ?? "") };
  const answer = replyFor(safe);
  const reply = text(answer.reply, "I'm here.");
  // Guarantee 3, last line of defence: nothing internal may reach the player.
  if (/undefined|NaN|\[object Object\]|\bat [A-Za-z0-9_./]+\.js:/i.test(reply)) {
    return {
      topic: answer.topic,
      reply: 'I don\'t have a clean reading for that yet — ask me "what are you doing" and I\'ll tell you what I can actually see.'
    };
  }
  return { topic: answer.topic, reply: clip(reply) };
}

/**
 * One-line summary of what the brain answered, for diagnostics and the panel:
 * "asked about position, answered from the live scan".
 */
export function describeTopic(topic) {
  const map = {
    identity: "identity", network: "how it thinks (no network on this build)", capabilities: "what it can do",
    limits: "an honest refusal", presence: "greeting", status: "current task report", health: "health report",
    position: "position report", inventory: "carrying report", threats: "threat report", time: "time of day",
    home: "home point", movement: "why it is or isn't moving", following: "follow state", praise: "thanks",
    apology: "apology", insult: "an insult, taken calmly", affection: "friendliness", joke: "a joke",
    farewell: "goodbye", acknowledge: "acknowledgement", order: "how to phrase an order",
    question: "an honest 'I don't know'", smalltalk: "small talk", empty: "an empty message"
  };
  return map[String(topic || "")] || "conversation";
}
