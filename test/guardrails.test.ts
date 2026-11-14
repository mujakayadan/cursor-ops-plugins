import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { evaluateShell } from "../packages/core/policy.ts";
import type { Decision, ShellRule } from "../packages/core/types.ts";
import {
  EXEC_TOOL,
  inputStrings,
  isTextOnly,
  normalizeCommand,
  SHELL_RULES,
  TAMPER_RULES,
  withOverrides,
} from "../plugins/ops-core/hooks/guardrails.ts";

const decide = (command: string, rules: ShellRule[] = SHELL_RULES) =>
  isTextOnly(command) ? "allow" : evaluateShell(normalizeCommand(command), rules).permission;

describe("guardrail rules", () => {
  it("have unique ids, a decision and a reason", () => {
    const ids = SHELL_RULES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const r of SHELL_RULES) {
      assert.ok(["ask", "deny"].includes(r.decision), r.id);
      assert.ok(r.reason.length > 10, r.id);
      assert.ok(r.re instanceof RegExp, r.id);
    }
  });
});

describe("guardrail overrides", () => {
  it("relaxes a rule by id and drops rules set to allow", () => {
    const rules = withOverrides(SHELL_RULES, {
      "git-reset-hard": "ask",
      "git-stash-destroy": "allow",
    });
    assert.equal(decide("git reset --hard", rules), "ask");
    assert.equal(decide("git stash drop", rules), "allow");
    assert.equal(decide("git clean -fd", rules), "deny");
  });
  it("never relaxes tamper rules and ignores invalid values", () => {
    const overrides = Object.fromEntries(TAMPER_RULES.map((r) => [r.id, "allow" as const]));
    const invalid: Record<string, Decision> = JSON.parse('{ "git-reset-hard": "maybe" }');
    const rules = withOverrides(SHELL_RULES, { ...overrides, ...invalid });
    assert.equal(decide("rm ~/.ops/config.json", rules), "deny");
    assert.equal(decide("git reset --hard", rules), "deny");
  });
});

describe("guardrail command handling", () => {
  it("treats search and print commands as text only", () => {
    assert.equal(isTextOnly('rg -n "DROP TABLE" migrations'), true);
    assert.equal(isTextOnly('git log --grep "reset --hard" | rg fix'), true);
    assert.equal(isTextOnly('echo "DROP TABLE x" | psql'), false);
    assert.equal(isTextOnly("echo {} > ~/.ops/config.json"), false);
    assert.equal(isTextOnly("rg $(git reset --hard)"), false);
  });
  it("blanks message arguments and splits lines", () => {
    assert.equal(normalizeCommand('git commit -m "drop user table"'), 'git commit -m ""');
    assert.equal(normalizeCommand("a\nb"), "a ; b");
    assert.equal(decide('gh pr create --title "Reboot flow" --body "shutdown cleanly"'), "allow");
  });
  it("collects every string from MCP inputs", () => {
    assert.equal(inputStrings({ a: "x", b: [1, "y", { c: "z" }] }), "x ; y ; z");
  });
  it("recognizes command and SQL executing MCP tools", () => {
    for (const name of [
      "execute_sql",
      "run_query",
      "run_session_command",
      "exec",
      "apply_migration",
    ])
      assert.ok(EXEC_TOOL.test(name), name);
    for (const name of ["list_projects", "get_deployment", "create_issue"])
      assert.ok(!EXEC_TOOL.test(name), name);
  });
});
