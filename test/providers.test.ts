import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import type { ProviderConfig, ToolContext } from "../packages/core/types.ts";
import architecture from "../plugins/ops-architecture/provider.ts";
import aws, { hideEnvValues } from "../plugins/ops-aws/provider.ts";
import control from "../plugins/ops-control/provider.ts";
import digitalocean from "../plugins/ops-digitalocean/provider.ts";
import github, {
  assertChecksGreen,
  mergeMethodFor,
  planKeyOf,
  resolveKeys,
  rulesetFor,
  updatedBody,
} from "../plugins/ops-github/provider.ts";
import google, {
  outsideDomains as googleOutsideDomains,
  pickGoogleAccount,
} from "../plugins/ops-google/provider.ts";
import latex from "../plugins/ops-latex/provider.ts";
import memory from "../plugins/ops-memory/provider.ts";
import mermaid from "../plugins/ops-mermaid/provider.ts";
import models from "../plugins/ops-models/provider.ts";
import msgraph, {
  outsideDomains,
  requestArgs,
  stripHtml,
} from "../plugins/ops-msgraph/provider.ts";
import oss from "../plugins/ops-oss/provider.ts";
import research from "../plugins/ops-research/provider.ts";
import scaffold from "../plugins/ops-scaffold/provider.ts";
import vercel from "../plugins/ops-vercel/provider.ts";
import { PLUGINS_DIR, providerPlugins } from "../scripts/lib.ts";

const providers = [
  github,
  digitalocean,
  vercel,
  aws,
  scaffold,
  msgraph,
  google,
  mermaid,
  latex,
  architecture,
  control,
  memory,
  oss,
  models,
  research,
];

describe("provider list", () => {
  it("covers every provider plugin", () => {
    assert.deepEqual(providers.map((p) => `ops-${p.id}`).sort(), providerPlugins());
  });
});

describe("provider catalogs", () => {
  for (const p of providers) {
    it(`${p.id}: every privileged tool defines confirm + hint`, () => {
      for (const t of p.tools.filter((x) => x.tier === "privileged")) {
        assert.equal(typeof t.confirm, "function", t.name);
        assert.ok(t.confirmHint, t.name);
      }
    });
    it(`${p.id}: every mutating tool has a human summary`, () => {
      for (const t of p.tools.filter((x) => x.tier !== "read"))
        assert.equal(typeof t.summarize, "function", t.name);
    });
    it(`${p.id}: every binary it needs has an install recipe`, () => {
      const recipes = new Set((p.setup ?? []).map((s) => s.bin));
      for (const bin of [p.bin, ...(p.requires ?? [])].filter((b) => b !== "node")) {
        assert.ok(recipes.has(bin), bin);
      }
    });
    it(`${p.id}: onboarding names read tools, a sign-in for credentials, and its own skill`, () => {
      const { whoami, status, signIn, skill } = p.onboarding ?? {};
      const reads = new Set(p.tools.filter((t) => t.tier === "read").map((t) => t.name));
      for (const name of [whoami, status].filter((n) => n !== undefined)) {
        assert.ok(reads.has(name), name);
      }
      if (whoami) assert.ok(signIn?.command, "whoami needs signIn");
      if (skill) {
        assert.ok(existsSync(join(PLUGINS_DIR, `ops-${p.id}`, "skills", skill, "SKILL.md")), skill);
      }
    });
    it(`${p.id}: has at least one read tool`, () => {
      assert.ok(p.tools.some((t) => t.tier === "read"));
    });
    it(`${p.id}: shell rules are well-formed`, () => {
      for (const r of p.shellRules ?? []) {
        assert.ok(["ask", "deny"].includes(r.decision), r.id);
        assert.ok(r.re instanceof RegExp && r.reason, r.id);
        assert.ok(r.when === undefined || typeof r.when === "function", r.id);
      }
    });
  }
});

describe("github gitops merge rules", () => {
  it("squashes features into dev and merges promotions", () => {
    assert.equal(mergeMethodFor("dev", "muja/feat/login", "auto"), "squash");
    assert.equal(mergeMethodFor("dev", "muja/feat/login", "merge"), "merge");
    assert.equal(mergeMethodFor("main", "dev", "auto"), "merge");
    assert.equal(mergeMethodFor("dev", "main", "auto"), "merge");
    assert.equal(mergeMethodFor("main", "dependabot/npm_and_yarn/x-1.2.3", "auto"), "merge");
    assert.equal(mergeMethodFor("main", "release-please--branches--main", "auto"), "merge");
  });
  it("refuses feature branches into main and squashed promotions", () => {
    assert.throws(() => mergeMethodFor("main", "muja/feat/login", "auto"), /must target dev/);
    assert.throws(() => mergeMethodFor("main", "dev", "squash"), /merge commit/);
    assert.throws(() => mergeMethodFor("dev", "main", "squash"), /merge commit/);
  });
  it("requires every check to pass", () => {
    assertChecksGreen([
      { name: "pr-policy", bucket: "pass" },
      { name: "docs", bucket: "skipping" },
    ]);
    assert.throws(() => assertChecksGreen([]), /No CI checks/);
    assert.throws(
      () => assertChecksGreen([{ name: "verify", bucket: "pending" }]),
      /verify \(pending\)/,
    );
  });
  it("builds branch rulesets with merge methods per branch", () => {
    const methods = (b: string) =>
      JSON.stringify(rulesetFor(b, ["pr-policy"])).match(
        /"allowed_merge_methods":(\[[^\]]*\])/,
      )?.[1];
    assert.equal(methods("main"), '["merge"]');
    assert.equal(methods("dev"), '["squash","merge"]');
    assert.match(JSON.stringify(rulesetFor("dev", ["pr-policy", "ci"])), /"context":"ci"/);
  });
});

describe("github plan import", () => {
  it("reads plan keys from issue titles", () => {
    assert.equal(planKeyOf("T-012 Build the order API"), "T-012");
    assert.equal(planKeyOf("E-3 Ordering"), "E-3");
    assert.equal(planKeyOf("Fix T-012 later"), undefined);
  });
  it("links the keys that have issues and reports the rest", () => {
    const refs = new Map([
      ["T-001", { key: "T-001", number: 45, url: "https://github.com/acme/app/issues/45" }],
    ]);
    assert.deepEqual(resolveKeys("- [ ] {{T-001}}\n- [ ] {{T-002}}", refs), {
      text: "- [ ] #45\n- [ ] {{T-002}}",
      unresolved: ["T-002"],
    });
  });
  it("appends lines naming new tasks to an existing epic and keeps its edits", () => {
    const ref = (key: string, number: number) =>
      [key, { key, number, url: `https://github.com/acme/app/issues/${number}` }] as const;
    const refs = new Map([ref("T-001", 45), ref("T-002", 46), ref("T-003", 47)]);
    const plan = "Tasks:\n- [ ] {{T-001}}\n- [ ] {{T-002}}\n- [ ] {{T-003}}";
    const current = "Tasks:\n- [x] #45 done early\n- [ ] {{T-002}}";
    assert.equal(
      updatedBody(current, plan, refs, new Set(["T-002", "T-003"])),
      "Tasks:\n- [x] #45 done early\n- [ ] #46\n- [ ] #47",
    );
    assert.equal(updatedBody("- [ ] #46\n- [ ] #47", plan, refs, new Set(["T-003"])), undefined);
    assert.equal(
      updatedBody("- [ ] #470", "- [ ] {{T-003}}", refs, new Set(["T-003"])),
      "- [ ] #470\n- [ ] #47",
    );
  });
  it("keeps the project board inside the owner scope", async () => {
    const scoped = { scope: { owners: ["acme"] } } as unknown as ProviderConfig;
    const scope = async (name: string, args: Record<string, unknown>) =>
      (await github.tools
        .find((t) => t.name === name)
        ?.scope?.(args as never, scoped, {} as ToolContext)) ?? "";
    const issues = [{ key: "T-001", title: "x", body: "y" }];
    assert.equal(await scope("github_issues_import", { repo: "acme/app", issues }), "");
    assert.match(
      await scope("github_issues_import", {
        repo: "acme/app",
        issues,
        project: { owner: "other", number: 1 },
      }),
      /"other" is not in/,
    );
    const url = "https://github.com/acme/app/issues/1";
    assert.equal(await scope("github_project_item_add", { owner: "acme", project: 1, url }), "");
    assert.match(
      await scope("github_project_item_add", { owner: "other", project: 1, url }),
      /"other" is not in/,
    );
  });
});

describe("msgraph requests", () => {
  it("builds m365 request argv with literal OData keys and encoded values", () => {
    assert.deepEqual(
      requestArgs({
        path: "/me/mailFolders/inbox/messages",
        query: { $top: 5, $filter: "isRead eq false", $search: undefined },
        headers: { prefer: 'outlook.timezone="UTC"' },
      }),
      [
        "request",
        "--url",
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=5&$filter=isRead%20eq%20false",
        "--method",
        "get",
        "--prefer",
        'outlook.timezone="UTC"',
        "--output",
        "json",
      ],
    );
  });
  it("sends JSON bodies with a content type", () => {
    const args = requestArgs({ method: "post", path: "/me/sendMail", body: { a: 1 } });
    assert.deepEqual(args.slice(args.indexOf("--body"), args.indexOf("--body") + 4), [
      "--body",
      '{"a":1}',
      "--content-type",
      "application/json",
    ]);
  });
  it("fences recipients to allowed domains and their subdomains", () => {
    const pcfg = {
      allowPrivileged: false,
      credentials: { read: { env: {}, args: [] }, write: { env: {}, args: [] } },
      scope: { allowedRecipientDomains: ["Contoso.com"] },
    };
    assert.deepEqual(
      outsideDomains(["ana@contoso.com", "bo@eu.contoso.com", "x@evilcontoso.com"], pcfg),
      ["x@evilcontoso.com"],
    );
    assert.deepEqual(outsideDomains(["x@anything.io"], { ...pcfg, scope: {} }), []);
  });
  it("whoami accepts personal accounts, whose status has no connectedAs", async () => {
    const whoami = msgraph.tools.find((t) => t.name === "msgraph_whoami");
    assert.ok(whoami);
    const ctx = (status: unknown) =>
      ({
        cli: async (args: string[]) =>
          args[0] === "status" ? status : { displayName: "Ana", mail: "ana@outlook.com" },
      }) as unknown as ToolContext;
    const personal = { connectionName: "personal", connectedAs: "", appTenant: "consumers" };
    assert.deepEqual(((await whoami.run({}, ctx(personal))) as { user: unknown }).user, {
      displayName: "Ana",
      mail: "ana@outlook.com",
    });
    await assert.rejects(async () => whoami.run({}, ctx("Logged out")), /not logged in/);
  });
  it("flattens Teams HTML to text", () => {
    assert.equal(
      stripHtml("<p>Hi&nbsp;<b>Ana</b></p><p>a &lt;b&gt; &amp;amp;</p>"),
      "Hi Ana\na <b> &amp;",
    );
  });
});

describe("google recipient scope", () => {
  it("fences recipients to allowed domains and their subdomains", () => {
    const pcfg = {
      allowPrivileged: false,
      credentials: { read: { env: {}, args: [] }, write: { env: {}, args: [] } },
      scope: { allowedRecipientDomains: ["Example.com"] },
    };
    assert.deepEqual(
      googleOutsideDomains(["ana@example.com", "bo@eu.example.com", "x@evilexample.com"], pcfg),
      ["x@evilexample.com"],
    );
    assert.deepEqual(googleOutsideDomains(["x@anything.io"], { ...pcfg, scope: {} }), []);
  });
});

describe("google pickGoogleAccount", () => {
  it("prefers a configured account, else first by email, and skips invalid", () => {
    const accounts = [
      { email: "zeta@example.com", valid: true },
      { email: "alpha@example.com", valid: true },
      { email: "bad@example.com", valid: false },
    ];
    assert.equal(pickGoogleAccount(accounts, "zeta@example.com"), "zeta@example.com");
    assert.equal(pickGoogleAccount(accounts), "alpha@example.com");
    assert.equal(pickGoogleAccount([{ email: "only@example.com", valid: false }]), undefined);
  });
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
