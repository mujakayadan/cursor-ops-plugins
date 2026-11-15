/** How heavy the next piece of work is. The route picks a cheaper included model when it can. */
export const TASKS = ["routine", "implementation", "parallel", "hard", "frontier"] as const;
export type Task = (typeof TASKS)[number];

export const PLANS = [
  "free",
  "plus",
  "premium",
  "super",
  "ultra",
  "teams",
  "enterprise",
  "legacy",
  "unknown",
] as const;
export type Plan = (typeof PLANS)[number];

export interface AccountView {
  plan: Plan;
  /** Percent of the included Cursor-model pool still unused. Null when it was not reported. */
  includedRemaining: number | null;
  /** True when this account's model list contains a third-party model. Null when the list is unknown. */
  thirdParty: boolean | null;
  models: string[];
  /** `agent` when the Cursor CLI answered, otherwise null. */
  cli: string | null;
}

export interface RouteInput {
  task: Task;
  account: AccountView;
  /** Model ids this session may pass to a subagent. */
  subagents: string[];
  /** Set when the user named a model. */
  prefer?: string;
  longContext?: boolean;
}

export interface Route {
  model: string;
  effort: "medium" | "high";
  fast: false;
  context: "256k" | "500k";
  /** Subagent model id, or null to inherit the current chat model. */
  taskModel: string | null;
  billing: "included" | "credit" | "blocked";
  reason: string;
}

interface Caps {
  high: boolean;
  long: boolean;
  third: boolean;
}

function caps(plan: Plan): Caps {
  switch (plan) {
    case "free":
    case "plus":
    case "unknown":
      return { high: false, long: false, third: false };
    case "premium":
    case "super":
    case "ultra":
    case "teams":
    case "enterprise":
    case "legacy":
      return { high: true, long: true, third: true };
    default: {
      const unknown: never = plan;
      return unknown;
    }
  }
}

function pressure(remaining: number | null): "ok" | "tight" | "low" {
  if (remaining !== null && remaining < 15) return "low";
  if (remaining === null || remaining < 40) return "tight";
  return "ok";
}

const includedFamily = (id: string) => /grok|composer/i.test(id);
const compact = (id: string) => id.toLowerCase().replace(/[^a-z0-9]+/g, "");

function matchSlug(prefer: string, available: string[]): string | null {
  const needle = compact(prefer);
  const hits = available.filter((id) => {
    const hay = compact(id);
    return hay.includes(needle) || needle.includes(hay);
  });
  return hits.find((id) => !/fast/i.test(id)) ?? hits[0] ?? null;
}

/** High effort only. A medium slug must not be upgraded to the high-fast variant. */
function highSlug(
  family: "grok-4.7" | "grok-4.6",
  available: string[],
  allowFast: boolean,
): string | null {
  const hits = available.filter((id) => compact(id).includes(compact(family)));
  const high = hits.find((id) => /high/i.test(id) && !/fast/i.test(id));
  if (high) return high;
  if (!allowFast) return null;
  return hits.find((id) => /high/i.test(id)) ?? null;
}

function includedRoute(
  task: Task,
  account: AccountView,
  subagents: string[],
  long: boolean,
): Route {
  const planCaps = caps(account.plan);
  const level = pressure(account.includedRemaining);
  const grok =
    level === "low" ? false : task === "implementation" || task === "hard" || task === "frontier";
  const wantHigh = grok && task !== "implementation" && planCaps.high && level === "ok";
  const model = grok ? "grok-4.7" : "composer-2.5";
  const effort = wantHigh ? "high" : "medium";
  const context = long && planCaps.long && level === "ok" ? "500k" : "256k";
  const taskModel = effort === "high" ? highSlug("grok-4.7", subagents, true) : null;
  const reason =
    level === "low"
      ? "Included pool is nearly spent, so this stays on Composer 2.5."
      : effort === "high"
        ? "Hard task on Grok 4.7 at high effort; the included pool has room."
        : model === "composer-2.5"
          ? "Routine work stays on Composer 2.5, which draws least from the included pool."
          : "Implementation stays on Grok 4.7 at medium effort. High effort and fast mode stay off.";
  return { model, effort, fast: false, context, taskModel, billing: "included", reason };
}

/** Pick the model, effort and subagent id for one task given this account. */
export function route(input: RouteInput): Route {
  const planCaps = caps(input.account.plan);
  const third = input.account.thirdParty === null ? planCaps.third : input.account.thirdParty;
  const fallback = includedRoute(
    input.task,
    input.account,
    input.subagents,
    input.longContext === true,
  );

  if (input.prefer && !includedFamily(input.prefer)) {
    if (!third || pressure(input.account.includedRemaining) === "low") {
      return {
        ...fallback,
        billing: "blocked",
        reason: `${input.prefer} is a third-party model. This account stays on ${fallback.model}, which the subscription includes.`,
      };
    }
    return {
      model: input.prefer,
      effort: planCaps.high ? "high" : "medium",
      fast: false,
      context: input.longContext && planCaps.long ? "500k" : "256k",
      taskModel: matchSlug(input.prefer, input.subagents),
      billing: "credit",
      reason: `${input.prefer} bills from prepaid credit, not the included pool. Fast mode stays off.`,
    };
  }

  if (input.prefer && includedFamily(input.prefer)) {
    const family = /composer/i.test(input.prefer) ? "composer-2.5" : "grok-4.7";
    return {
      ...fallback,
      model: family,
      effort: family === "composer-2.5" ? "medium" : fallback.effort,
      taskModel:
        family === "grok-4.7" && fallback.effort === "high"
          ? highSlug("grok-4.7", input.subagents, true)
          : null,
      reason: `Using ${family} as requested. It draws from the included pool.`,
    };
  }

  if (input.task === "frontier") {
    const level = pressure(input.account.includedRemaining);
    if (level === "low") {
      return {
        ...fallback,
        reason: "Included pool is nearly spent, so this stays on Composer 2.5.",
      };
    }
    const high = planCaps.high && level === "ok";
    return {
      ...fallback,
      model: "grok-4.7",
      effort: high ? "high" : "medium",
      taskModel: high ? highSlug("grok-4.7", input.subagents, true) : null,
      reason: third
        ? "No third-party model was named, so this stays on Grok 4.7. Name one to spend prepaid credit."
        : "Third-party models are not on this plan. Grok 4.7 is the included model for hard work.",
    };
  }

  return fallback;
}
