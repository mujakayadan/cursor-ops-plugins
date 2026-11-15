import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { loadConfig } from "../packages/core/config.ts";
import { makeContext } from "../packages/core/mcp-server.ts";
import { LOADER_SCRIPT, loaderCommand, SUITE_LOADED_ENV } from "../packages/core/suite.ts";
import control from "../plugins/ops-control/provider.ts";
import { PLUGINS_DIR, REPO_ROOT } from "../scripts/lib.ts";
import { loaderPaths } from "../scripts/workspace-plugins.ts";

const ENV = [
  "OPS_HOME",
  "OPS_CONFIG",
  "OPS_AUDIT_DIR",
  "OPS_REVIEW_DIR",
  "CURSOR_HOME",
  "OPS_MCP_TOKEN",
] as const;
let dir: string;

function call(name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  const t = control.tools.find((x) => x.name === name);
  assert.ok(t, name);
  const cfg = loadConfig({ reload: true });
  return t.run(args, makeContext(control, t, cfg)) as Record<string, unknown>;
}

const config = () => JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
const node = (script: string, ...args: string[]) =>
  execFileSync(process.execPath, [join(REPO_ROOT, "scripts", script), ...args], {
    env: { ...process.env },
    encoding: "utf8",
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ops-control-"));
  process.env.OPS_HOME = dir;
  process.env.OPS_CONFIG = join(dir, "config.json");
  process.env.OPS_AUDIT_DIR = join(dir, "audit");
  process.env.OPS_REVIEW_DIR = join(dir, "review");
  process.env.CURSOR_HOME = join(dir, "cursor");
  // A token no running server accepts, so uninstall can't stop a real read server.
  process.env.OPS_MCP_TOKEN = "test-token";
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ providers: { github: { allowPrivileged: false } }, review: { maxRounds: 1 } }),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV) delete process.env[key];
  loadConfig({ reload: true });
});

describe("config errors", () => {
  it("don't quote the config source, which can hold credentials", () => {
    writeFileSync(join(dir, "config.json"), '{ "env": { "GH_TOKEN": ghp_secret } }');
    assert.throws(
      () => loadConfig({ reload: true }),
      (err: Error) => err.message.endsWith(": not valid JSON") && !err.message.includes("ghp_"),
    );
  });
});

describe("suite loader", () => {
  it("ops install registers one loader entry and keeps other workspaceOpen hooks", () => {
    mkdirSync(join(dir, "cursor"), { recursive: true });
    writeFileSync(
      join(dir, "cursor", "hooks.json"),
      JSON.stringify({ version: 1, hooks: { workspaceOpen: [{ command: "node other.js" }] } }),
    );
    node("install.ts", "--no-user-env");
    node("install.ts", "--no-user-env");
    assert.ok(existsSync(join(dir, "serve.token")));
    const hooks = JSON.parse(readFileSync(join(dir, "cursor", "hooks.json"), "utf8"));
    assert.equal(hooks.hooks.workspaceOpen.length, 2);
    assert.ok(loaderCommand()?.includes(LOADER_SCRIPT));
    assert.ok(existsSync(join(dir, "bin", "ops.cmd")));
    node("install.ts", "--uninstall", "--no-user-env");
    assert.ok(!existsSync(join(dir, "bin", "ops.cmd")));
    assert.ok(!existsSync(join(dir, "serve.token")));
    assert.equal(loaderCommand(), undefined);
    assert.equal(
      JSON.parse(readFileSync(join(dir, "cursor", "hooks.json"), "utf8")).hooks.workspaceOpen
        .length,
      1,
    );
  });

  it("returns every enabled plugin path, never dropping ops-core", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ suite: { disabledPlugins: ["ops-latex", "ops-core"] } }),
    );
    const pluginPaths = loaderPaths();
    assert.ok(pluginPaths.includes(join(PLUGINS_DIR, "ops-core")));
    assert.ok(pluginPaths.includes(join(PLUGINS_DIR, "ops-control")));
    assert.ok(!pluginPaths.includes(join(PLUGINS_DIR, "ops-latex")));
  });

  it("loads everything when the config is broken", () => {
    writeFileSync(join(dir, "config.json"), "{ not json");
    assert.ok(loaderPaths().includes(join(PLUGINS_DIR, "ops-latex")));
  });

  it("loads nothing when ops agent already passed the plugins", () => {
    process.env[SUITE_LOADED_ENV] = "1";
    try {
      assert.deepEqual(loaderPaths(), []);
    } finally {
      delete process.env[SUITE_LOADED_ENV];
    }
  });
});

describe("ops-control tools", () => {
  it("status lists every plugin and the loader state", async () => {
    const status = (await call("control_status")) as {
      loader: { registered: boolean };
      plugins: { name: string; enabled: boolean; privileged?: boolean }[];
    };
    assert.equal(status.loader.registered, false);
    const github = status.plugins.find((p) => p.name === "ops-github");
    assert.deepEqual(github && { enabled: github.enabled, privileged: github.privileged }, {
      enabled: true,
      privileged: false,
    });
    assert.ok(status.plugins.some((p) => p.name === "ops-control"));
  });

  it("plugin_set edits only suite.disabledPlugins and refuses the always-on plugins", () => {
    call("control_plugin_set", { plugin: "ops-latex", enabled: false });
    assert.deepEqual(config().suite.disabledPlugins, ["ops-latex"]);
    assert.equal(config().providers.github.allowPrivileged, false);
    call("control_plugin_set", { plugin: "ops-latex", enabled: true });
    assert.deepEqual(config().suite.disabledPlugins, []);
    assert.throws(() => call("control_plugin_set", { plugin: "ops-core", enabled: false }));
    assert.throws(() => call("control_plugin_set", { plugin: "ops-nope", enabled: false }));
  });

  it("review_set changes only the review keys passed", () => {
    call("control_review_set", { lens: "docs", lensEnabled: false, minChangedLines: 5 });
    assert.deepEqual(config().review, {
      maxRounds: 1,
      lenses: { docs: false },
      minChangedLines: 5,
    });
    assert.throws(() => call("control_review_set", { lens: "docs" }));
  });

  it("audit returns newest-first records matching the filters", () => {
    mkdirSync(join(dir, "audit"));
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(
      join(dir, "audit", `${today}.jsonl`),
      [
        { source: "hook", decision: "deny", command: "git push --force" },
        { source: "hook", decision: "allow", command: "git status" },
        { source: "mcp", tool: "github_whoami" },
        { source: "hook", decision: "deny", command: "rm -rf /" },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    const { records } = call("control_audit", { days: 1, decision: "deny", limit: 10 }) as {
      records: { command: string }[];
    };
    assert.deepEqual(
      records.map((r) => r.command),
      ["rm -rf /", "git push --force"],
    );
  });

  it("reviews summarizes each conversation's lenses and requests", () => {
    mkdirSync(join(dir, "review"));
    writeFileSync(
      join(dir, "review", "c1.jsonl"),
      [
        { t: "edit", lens: "docs", file: "README.md", hints: [{}, {}] },
        { t: "edit", lens: "docs", file: "README.md", hints: [] },
        { t: "edit", lens: "security", file: "src/a.ts", hints: [] },
        { t: "request", message: "[ops-review] check this" },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    const { conversations } = call("control_reviews", { limit: 5 }) as {
      conversations: Record<string, unknown>[];
    };
    assert.deepEqual(conversations[0]?.lenses, {
      docs: { files: 1, hints: 2 },
      security: { files: 1, hints: 0 },
    });
    assert.equal(conversations[0]?.requests, 1);
  });
});
