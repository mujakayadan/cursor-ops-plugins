import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { resolveBinary, runCommand, tryParseJson } from "../packages/core/cli.ts";
import { deepMerge } from "../packages/core/config.ts";
import { classifyToolName, evaluateShell, strictest } from "../packages/core/policy.ts";
import { findSecrets, redact, truncate } from "../packages/core/redact.ts";
import { validate } from "../packages/core/schema.ts";
import type { JsonSchema } from "../packages/core/schema-helpers.ts";
import type { ShellRule } from "../packages/core/types.ts";

describe("redact", () => {
  it("masks provider tokens and keeps surrounding text", () => {
    const out = redact("token=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 ok");
    assert.equal(out, "token=[REDACTED:github-token] ok");
  });
  it("masks secret-looking JSON fields but keeps the key", () => {
    assert.equal(redact('{"password": "hunter22"}'), '{"password": "[REDACTED:secret-field]"}');
  });
  it("masks credentials in URLs", () => {
    assert.equal(
      redact("postgres://app:s3cr3t@db:5432/x"),
      "postgres://app:[REDACTED:url-credentials]@db:5432/x",
    );
  });
  it("detects secret kinds without flagging normal text", () => {
    assert.deepEqual(findSecrets("AKIAIOSFODNN7EXAMPLE"), ["aws-access-key-id"]);
    assert.deepEqual(findSecrets("deploy the api to staging"), []);
  });
  it("truncates long output with a marker", () => {
    assert.match(truncate("x".repeat(20), 5), /^x{5}\n…\[truncated 15 chars\]$/);
  });
});

describe("policy", () => {
  it("ranks decisions deny > ask > allow", () => {
    assert.equal(strictest("allow", "ask"), "ask");
    assert.equal(strictest("ask", "deny", "allow"), "deny");
    assert.equal(strictest(), "allow");
  });
  it("classifies third-party MCP tool names", () => {
    assert.equal(classifyToolName("list_deployments"), "read");
    assert.equal(classifyToolName("pull_request_read"), "read");
    assert.equal(classifyToolName("issue_write"), "write");
    assert.equal(classifyToolName("createDeployment"), "write");
    assert.equal(classifyToolName("merge_pull_request"), "privileged");
    assert.equal(classifyToolName("request_rollback"), "privileged");
    assert.equal(classifyToolName("browser_click"), "unknown");
  });
  it("evaluates shell rules with the strictest match", () => {
    const rules: ShellRule[] = [
      { id: "a", decision: "ask", re: /foo/, reason: "" },
      { id: "d", decision: "deny", re: /foo bar/, reason: "" },
    ];
    assert.equal(evaluateShell("foo   bar", rules).permission, "deny");
    assert.equal(evaluateShell("foo", rules).permission, "ask");
    assert.equal(evaluateShell("baz", rules).permission, "allow");
  });
});

describe("schema", () => {
  const schema: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["repo"],
    properties: {
      repo: { type: "string", pattern: "^[a-z]+/[a-z]+$" },
      limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
    },
  };
  it("applies defaults", () =>
    assert.deepEqual(validate(schema, { repo: "a/b" }), {
      value: { repo: "a/b", limit: 5 },
      errors: [],
    }));
  it("rejects bad patterns, ranges and unknown fields", () => {
    const { errors } = validate(schema, { repo: "-rf", limit: 50, x: 1 });
    assert.equal(errors.length, 3);
  });
  it("requires required fields", () =>
    assert.match(validate(schema, {}).errors[0] ?? "", /repo is required/));
});

describe("config", () => {
  it("deep merges objects and replaces arrays", () => {
    assert.deepEqual(deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2] } }), {
      a: { b: 1, c: [2] },
    });
  });
});

describe("cli", () => {
  it("runs binaries without a shell and captures output", async () => {
    const r = await runCommand("node", ["-e", "process.stdout.write(JSON.stringify({ok:1}))"]);
    assert.equal(r.code, 0);
    assert.deepEqual(tryParseJson(r.stdout), { ok: 1 });
  });
  it("passes shell metacharacters through literally", async () => {
    const r = await runCommand("node", [
      "-e",
      "process.stdout.write(process.argv[1])",
      "a; echo pwned && $(x)",
    ]);
    assert.equal(r.stdout, "a; echo pwned && $(x)");
  });
  it("throws a helpful error for missing binaries", () => {
    assert.throws(() => resolveBinary("definitely-not-a-real-cli-xyz"), /not found on PATH/);
  });
});
