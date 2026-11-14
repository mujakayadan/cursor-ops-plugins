import assert from "node:assert/strict";
import { describe, it } from "node:test";
import aws, { hideEnvValues } from "../plugins/ops-aws/provider.mjs";
import digitalocean from "../plugins/ops-digitalocean/provider.mjs";
import github from "../plugins/ops-github/provider.mjs";
import scaffold from "../plugins/ops-scaffold/provider.mjs";
import vercel from "../plugins/ops-vercel/provider.mjs";

const providers = [github, digitalocean, vercel, aws, scaffold];

describe("provider catalogs", () => {
  for (const p of providers) {
    it(`${p.id}: every privileged tool defines confirm + hint`, () => {
      for (const t of p.tools.filter((x) => x.tier === "privileged")) {
        assert.equal(typeof t.confirm, "function", t.name);
        assert.ok(t.confirmHint, t.name);
      }
    });
    it(`${p.id}: every mutating tool has a human summary`, () => {
      for (const t of p.tools.filter((x) => x.tier !== "read")) assert.equal(typeof t.summarize, "function", t.name);
    });
    it(`${p.id}: has at least one read and one write tool`, () => {
      assert.ok(p.tools.some((t) => t.tier === "read"));
      assert.ok(p.tools.some((t) => t.tier === "write"));
    });
    it(`${p.id}: shell rules are well-formed`, () => {
      for (const r of p.shellRules) {
        assert.ok(["ask", "deny"].includes(r.decision), r.id);
        assert.ok(r.re instanceof RegExp && r.reason, r.id);
        assert.ok(r.when === undefined || typeof r.when === "function", r.id);
      }
    });
  }
});

describe("aws hideEnvValues", () => {
  it("hides Lambda environment values and ECS container env values", () => {
    const input = {
      Configuration: { Environment: { Variables: { DB_PASSWORD: "x", MODE: "prod" } } },
      containerDefinitions: [{ environment: [{ name: "TOKEN", value: "y" }] }],
    };
    assert.deepEqual(hideEnvValues(input), {
      Configuration: { Environment: { Variables: { DB_PASSWORD: "[hidden]", MODE: "[hidden]" } } },
      containerDefinitions: [{ environment: [{ name: "TOKEN", value: "[hidden]" }] }],
    });
  });
});
