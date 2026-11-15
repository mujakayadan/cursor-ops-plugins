import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { evaluateShell } from "../packages/core/policy.ts";
import type { Decision, ShellRule } from "../packages/core/types.ts";
import {
  currentBranch,
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

describe("gitops branch guardrails", () => {
  const IDENTITY = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  // Drop repo-pinning vars so a pre-push run in a worktree doesn't redirect these calls.
  const gitEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...IDENTITY };
    for (const k of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_OBJECT_DIRECTORY",
      "GIT_INDEX_FILE",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ])
      delete env[k];
    return env;
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "ignore", env: gitEnv() });
  const decideIn = (cwd: string, command: string) =>
    evaluateShell(normalizeCommand(command), SHELL_RULES, { cwd }).permission;

  it("blocks commits and pushes on env branches, not on feature branches", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-gitops-"));
    try {
      git(dir, "init", "-q", "-b", "main");
      assert.equal(currentBranch(dir), undefined);
      assert.equal(decideIn(dir, 'git commit -m "chore: initial commit"'), "allow");
      git(dir, "commit", "-q", "--allow-empty", "-m", "init");
      assert.equal(currentBranch(dir), "main");
      assert.equal(decideIn(dir, 'git commit -am "fix: x"'), "deny");
      assert.equal(decideIn(dir, "git push"), "deny");
      assert.equal(decideIn(dir, "git merge --abort"), "allow");
      assert.equal(decideIn(dir, "git push --tags"), "allow");
      git(dir, "switch", "-q", "-c", "t/feat/x");
      assert.equal(decideIn(dir, 'git commit -am "feat: x"'), "allow");
      assert.equal(decideIn(dir, "git push -u origin t/feat/x"), "allow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("honors cwd even when GIT_DIR points at another repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-gitops-"));
    const prev = process.env.GIT_DIR;
    try {
      git(dir, "init", "-q", "-b", "main");
      git(dir, "commit", "-q", "--allow-empty", "-m", "init");
      process.env.GIT_DIR = join(process.cwd(), ".git");
      assert.equal(currentBranch(dir), "main");
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("ignores the branch when the payload has no cwd", () => {
    assert.equal(decideIn("", "git commit -m x"), "allow");
  });
});
