import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import architecture from "../plugins/ops-architecture/provider.ts";
import aws, { hideEnvValues } from "../plugins/ops-aws/provider.ts";
import control from "../plugins/ops-control/provider.ts";
import digitalocean from "../plugins/ops-digitalocean/provider.ts";
import github, {
  assertChecksGreen,
  mergeMethodFor,
  rulesetFor,
} from "../plugins/ops-github/provider.ts";
import latex from "../plugins/ops-latex/provider.ts";
import mermaid from "../plugins/ops-mermaid/provider.ts";
import msgraph, {
  outsideDomains,
  requestArgs,
  stripHtml,
} from "../plugins/ops-msgraph/provider.ts";
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
  mermaid,
  latex,
  architecture,
  control,
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
    it(`${p.id}: has at least one read and one write tool`, () => {
      assert.ok(p.tools.some((t) => t.tier === "read"));
      assert.ok(p.tools.some((t) => t.tier === "write"));
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
  it("flattens Teams HTML to text", () => {
    assert.equal(
      stripHtml("<p>Hi&nbsp;<b>Ana</b></p><p>a &lt;b&gt; &amp;amp;</p>"),
      "Hi Ana\na <b> &amp;",
    );
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
