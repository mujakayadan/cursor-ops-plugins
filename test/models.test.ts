import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { parseAccount, parseModelList, parsePlan } from "../plugins/ops-models/account.ts";
import { type AccountView, route } from "../plugins/ops-models/route.ts";

const SUBAGENTS = [
  "grok-4.7-high-fast",
  "cursor-grok-4.6-high-fast",
  "claude-opus-5-5-medium",
  "gpt-5.6-sol-high",
];

const account = (over: Partial<AccountView> = {}): AccountView => ({
  plan: "plus",
  includedRemaining: 80,
  thirdParty: false,
  models: ["composer-2.5", "grok-4.7"],
  cli: "agent",
  ...over,
});

describe("cursor account parsing", () => {
  it("reads the plan and remaining pool and drops secrets", () => {
    const view = parseAccount(
      JSON.stringify({
        account: { membershipType: "premium", accessToken: "sekret-value" },
        usage: { totalPercentUsed: 22 },
      }),
      "composer-2.5\ngrok-4.7\nclaude-opus-5-5\n",
      true,
    );
    assert.equal(view.plan, "premium");
    assert.equal(view.includedRemaining, 78);
    assert.equal(view.thirdParty, true);
    assert.equal(JSON.stringify(view).includes("sekret"), false);
  });

  it("treats a missing model list as unknown third-party access", () => {
    const view = parseAccount("Plan: Plus", "", false);
    assert.equal(view.plan, "plus");
    assert.equal(view.thirdParty, null);
    assert.equal(view.cli, null);
  });

  it("classifies plan names", () => {
    assert.equal(parsePlan("Cursor Plus"), "plus");
    assert.equal(parsePlan("Pro+"), "legacy");
    assert.equal(parsePlan("Teams"), "teams");
    assert.equal(parsePlan(""), "unknown");
    assert.deepEqual(parseModelList("* composer-2.5  included\nmodel\n"), ["composer-2.5"]);
  });
});

describe("model routing", () => {
  it("keeps routine work on Composer and implementation on Grok medium", () => {
    const routine = route({ task: "routine", account: account(), subagents: SUBAGENTS });
    assert.equal(routine.model, "composer-2.5");
    assert.equal(routine.effort, "medium");
    assert.equal(routine.taskModel, null);
    assert.equal(routine.billing, "included");
    const impl = route({ task: "implementation", account: account(), subagents: SUBAGENTS });
    assert.equal(impl.model, "grok-4.7");
    assert.equal(impl.effort, "medium");
    assert.equal(impl.taskModel, null);
  });

  it("does not raise effort on Plus even for hard work", () => {
    const hard = route({ task: "hard", account: account(), subagents: SUBAGENTS });
    assert.equal(hard.effort, "medium");
    assert.equal(hard.taskModel, null);
    assert.equal(hard.billing, "included");
  });

  it("uses high effort on Premium when the included pool has room", () => {
    const hard = route({
      task: "hard",
      account: account({ plan: "premium", thirdParty: true, includedRemaining: 70 }),
      subagents: SUBAGENTS,
    });
    assert.equal(hard.model, "grok-4.7");
    assert.equal(hard.effort, "high");
    assert.equal(hard.taskModel, "grok-4.7-high-fast");
    assert.equal(hard.fast, false);
  });

  it("drops to Composer when the included pool is nearly spent", () => {
    const hard = route({
      task: "hard",
      account: account({ plan: "ultra", includedRemaining: 10 }),
      subagents: SUBAGENTS,
    });
    assert.equal(hard.model, "composer-2.5");
    assert.equal(hard.billing, "included");
  });

  it("spends credit only for a named third-party model the plan lists", () => {
    const named = route({
      task: "frontier",
      prefer: "claude-opus-5-5",
      account: account({ plan: "premium", thirdParty: true, includedRemaining: 70 }),
      subagents: SUBAGENTS,
    });
    assert.equal(named.billing, "credit");
    assert.equal(named.taskModel, "claude-opus-5-5-medium");
    const blocked = route({
      task: "frontier",
      prefer: "gpt-5.6-sol",
      account: account(),
      subagents: SUBAGENTS,
    });
    assert.equal(blocked.billing, "blocked");
    assert.equal(blocked.model, "grok-4.7");
  });

  it("stays on Grok when frontier work names no third-party model", () => {
    const routeResult = route({
      task: "frontier",
      account: account({ plan: "premium", thirdParty: true, includedRemaining: 70 }),
      subagents: SUBAGENTS,
    });
    assert.equal(routeResult.model, "grok-4.7");
    assert.equal(routeResult.effort, "high");
    assert.equal(routeResult.billing, "included");
  });

  it("allows credit on Premium when the model list is missing", () => {
    const named = route({
      task: "frontier",
      prefer: "claude-opus-5-5",
      account: account({ plan: "premium", thirdParty: null, models: [], includedRemaining: 70 }),
      subagents: SUBAGENTS,
    });
    assert.equal(named.billing, "credit");
  });
});
