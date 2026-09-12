import { validatePlan } from "./action-validator.js";

export function fallbackPlan(task) {
  if (!task) return { thought: "No task is active.", goal: "idle", actions: [{ type: "stop" }] };
  if (task.kind === "collect" && task.block) {
    return {
      thought: "Use the bounded local scanner, approach a matching block, mine it, and verify the drop.",
      goal: task.goal,
      actions: [
        { type: "find_block", block: task.block },
        { type: "move_to_target" },
        { type: "mine_block", block: task.block },
        { type: "collect_item", count: 1 }
      ]
    };
  }
  if (task.kind === "follow") return { thought: "Follow the owner using deterministic movement.", goal: task.goal, actions: [{ type: "follow_player" }] };
  if (task.kind === "protect") return { thought: "Defend the owner from nearby hostile entities.", goal: task.goal, actions: [{ type: "defend_player" }] };
  if (task.kind === "return") return { thought: "Return to the owner's current position.", goal: task.goal, actions: [{ type: "return_home" }] };
  return { thought: "No deterministic implementation exists for this task yet.", goal: task.goal, actions: [{ type: "stop" }] };
}

export function safeFallback(task, context) {
  const checked = validatePlan(fallbackPlan(task), context);
  return checked.ok ? checked.plan : { thought: "Fallback validation failed.", goal: "error", actions: [{ type: "stop" }] };
}
