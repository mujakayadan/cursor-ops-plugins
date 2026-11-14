import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { evaluateShell } from "../packages/core/policy.mjs";
import scaffold, { CATALOG, buildAnswers, parseAnswers } from "../plugins/ops-scaffold/provider.mjs";
import { REPO_ROOT } from "../scripts/lib.mjs";

const copierYml = readFileSync(join(REPO_ROOT, "copier.yml"), "utf8");

/** Values of a top-level Copier question's `choices` (both list and mapping forms). */
function copierChoices(question) {
  const block = copierYml.split(/\n(?=[A-Za-z_]+:)/).find((b) => b.startsWith(`${question}:`));
  assert.ok(block, `copier.yml has no ${question} question`);
  const inline = block.match(/choices:\s*\[([^\]]*)\]/);
  if (inline) return inline[1].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
  const lines = block.split("choices:")[1].split("\n").slice(1);
  const values = [];
  for (const line of lines) {
    const m = line.match(/^ {4}.+:\s*(\S+)\s*$/);
    if (!m) break;
    values.push(m[1]);
  }
  return values;
}

/** Default of a computed (never asked) Copier question. */
function copierDefault(question) {
  const block = copierYml.split(/\n(?=[A-Za-z_]+:)/).find((b) => b.startsWith(`${question}:`));
  assert.ok(block, `copier.yml has no ${question} question`);
  assert.match(block, /\n {2}when: false\n/, `${question} must be computed, not asked`);
  return block.match(/\n {2}default: "?([^"\n]*)"?/)[1];
}

describe("scaffold catalog", () => {
  it("languages match copier.yml", () => {
    assert.deepEqual(copierChoices("language").sort(), Object.keys(CATALOG).sort());
  });
  for (const [language, entry] of Object.entries(CATALOG)) {
    it(`${language} profiles match copier.yml`, () => {
      assert.deepEqual(copierChoices(`${language}_profile`).sort(), Object.keys(entry.profiles).sort());
    });
    for (const [key, version] of Object.entries(entry.runtime)) {
      it(`${language} ${key} is pinned to the copier.yml value`, () => {
        assert.equal(copierDefault(key), version);
      });
    }
  }
});

describe("scaffold buildAnswers", () => {
  const base = { destination: "/tmp/x", language: "python", profile: "backend", project_name: "Billing API", license: "MIT", agents: ["cursor"], mcp_servers: [], github_ci: true, initialize_git: false, install_deps: false };

  it("maps the profile to the language-specific question and drops unset values", () => {
    const data = buildAnswers({ ...base, package_name: "billing" });
    assert.equal(data.python_profile, "backend");
    assert.equal(data.package_name, "billing");
    assert.equal("destination" in data, false);
    assert.equal("docker" in data, false);
  });
  it("rejects a profile from another language", () => {
    assert.throws(() => buildAnswers({ ...base, language: "typescript", profile: "backend" }), /not available for typescript/);
  });
  it("rejects options for another language", () => {
    assert.throws(() => buildAnswers({ ...base, group_id: "com.acme" }), /only applies to java/);
  });
});

describe("scaffold parseAnswers", () => {
  it("parses copier's flat YAML", () => {
    const parsed = parseAnswers(
      "# Changes here will be overwritten by Copier\n_commit: v1.2.0\n_src_path: https://github.com/acme/t.git\nagents:\n- cursor\n- claude\nmcp_servers: []\nproject_name: Billing API\ndescription: 'It''s billing.'\ngithub_ci: true\n",
    );
    assert.deepEqual(parsed, {
      _commit: "v1.2.0",
      _src_path: "https://github.com/acme/t.git",
      agents: ["cursor", "claude"],
      mcp_servers: [],
      project_name: "Billing API",
      description: "It's billing.",
      github_ci: true,
    });
  });
});

describe("scaffold project-aware shell rules", () => {
  const fixture = (name) => join(REPO_ROOT, "evals", "fixtures", "projects", name);
  const decide = (command, payload) => evaluateShell(command, scaffold.shellRules, payload).permission;

  it("applies rules only inside matching projects", () => {
    assert.equal(decide("pip install x", { cwd: fixture("uv-app") }), "deny");
    assert.equal(decide("pip install x", { cwd: fixture("pnpm-app") }), "allow");
    assert.equal(decide("pip install x", {}), "allow");
  });
  it("finds markers in parent directories", () => {
    assert.equal(decide("pip install x", { cwd: join(fixture("uv-app"), "src") }), "deny");
  });
  it("leaves rules without `when` unconditional", () => {
    assert.equal(decide("copier recopy --trust", {}), "ask");
  });
});
