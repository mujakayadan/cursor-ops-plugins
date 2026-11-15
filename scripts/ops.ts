#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { resolveBinary } from "../packages/core/cli.ts";
import { loadConfig } from "../packages/core/config.ts";
import { makeContext } from "../packages/core/mcp-server.ts";
import { SUITE_LOADED_ENV, suitePlugins } from "../packages/core/suite.ts";
import control from "../plugins/ops-control/provider.ts";
import { PLUGINS_DIR, REPO_ROOT } from "./lib.ts";
import { ensureServer, serveLogPath, stopServer } from "./serve-client.ts";
import { worktree } from "./worktree.ts";

const USAGE = `ops — the ops plugin suite from the terminal

  ops status              loader, read server, plugins, review settings (refreshes a stale read server)
  ops setup [options]     install the CLIs the enabled plugins need (ops setup --help)
  ops doctor [--json]     check CLIs, loader, config and sign-in per tier, with a fix for each failure
  ops serve [--background|--stop|--restart]
                          the shared read-tier MCP server (foreground by default)
  ops worktree add|list|remove …
                          linked checkouts for concurrent agents (ops worktree --help)
  ops agent [args...]     the Cursor CLI agent with every enabled suite plugin
  ops install             register the suite loader, the ops command and the read server token
  ops uninstall           remove them`;

const SCRIPTS = {
  setup: "setup.ts",
  doctor: "doctor.ts",
  install: "install.ts",
  uninstall: "install.ts",
} as const;

type Command = keyof typeof SCRIPTS | "status" | "serve" | "worktree" | "agent";
const COMMANDS: readonly string[] = [
  ...Object.keys(SCRIPTS),
  "status",
  "serve",
  "worktree",
  "agent",
];

function script(file: string, args: string[]): number {
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", file), ...args], {
    stdio: "inherit",
  });
  return result.status ?? 1;
}

interface Status {
  suite: { root: string; branch: string | null; head: string | null };
  loader: { registered: boolean; command: string | null; fix?: string };
  readServer: { url: string; running: boolean; pid?: number; current?: boolean; fix?: string };
  plugins: { name: string; version: string; enabled: boolean; privileged?: boolean }[];
  review: { enabled: boolean; lenses: Record<string, boolean> };
}

async function status(): Promise<number> {
  // Refresh when HEAD moved (merge, pull) so read tools match this checkout without a window reload.
  await ensureServer();
  const tool = control.tools.find((t) => t.name === "control_status");
  if (!tool) return 1;
  const s = (await tool.run({}, makeContext(control, tool, loadConfig()))) as Status;
  const server = s.readServer;
  console.log(`suite   ${s.suite.root} (${s.suite.branch ?? "detached"} @ ${s.suite.head ?? "?"})`);
  console.log(
    `loader  ${s.loader.registered ? s.loader.command : `not registered. ${s.loader.fix}`}`,
  );
  console.log(
    `server  ${server.running ? `${server.url} pid ${server.pid}${server.current ? "" : " (older commit; run ops serve --restart)"}` : `down. ${server.fix}`}`,
  );
  const lenses = Object.entries(s.review.lenses)
    .map(([id, on]) => `${id}${on ? "" : " (off)"}`)
    .join(", ");
  console.log(`review  ${s.review.enabled ? lenses : "off"}\n`);
  for (const p of s.plugins) {
    const flags = [p.enabled ? "" : "disabled", p.privileged ? "PRIVILEGED" : ""].filter(Boolean);
    console.log(`  ${p.name.padEnd(18)} ${p.version.padEnd(8)} ${flags.join(", ")}`);
  }
  return 0;
}

async function stopOrReport(): Promise<boolean> {
  const stopped = await stopServer();
  if (!stopped) console.error(`the read server did not stop; see ${serveLogPath()}`);
  return stopped;
}

async function serve(args: string[]): Promise<number> {
  const [mode] = args;
  switch (mode) {
    case undefined:
      return script("serve.ts", []);
    case "--stop":
      return (await stopOrReport()) ? 0 : 1;
    case "--restart":
    case "--background": {
      if (mode === "--restart" && !(await stopOrReport())) return 1;
      const health = await ensureServer();
      console.log(
        health ? `read server pid ${health.pid}` : `did not start; see ${serveLogPath()}`,
      );
      return health ? 0 : 1;
    }
    default:
      console.error(USAGE);
      return 64;
  }
}

async function agent(args: string[]): Promise<number> {
  let bin: ReturnType<typeof resolveBinary>;
  try {
    bin = resolveBinary("agent");
  } catch {
    console.error(
      "The Cursor CLI (`agent`) is not installed. Windows: irm 'https://cursor.com/install?win32=true' | iex; macOS/Linux: curl https://cursor.com/install -fsS | bash",
    );
    return 1;
  }
  if (!(await ensureServer())) console.error(`read server did not start; see ${serveLogPath()}`);
  const plugins = suitePlugins(PLUGINS_DIR, loadConfig().suite.disabledPlugins).filter(
    (p) => p.enabled,
  );
  const result = spawnSync(
    bin.command,
    [...bin.prefixArgs, ...plugins.flatMap((p) => ["--plugin-dir", p.path]), ...args],
    { stdio: "inherit", env: { ...process.env, [SUITE_LOADED_ENV]: "1" } },
  );
  return result.status ?? 1;
}

async function main(command: Command, args: string[]): Promise<number> {
  switch (command) {
    case "status":
      return status();
    case "serve":
      return serve(args);
    case "worktree":
      return worktree(args);
    case "agent":
      return agent(args);
    case "uninstall":
      return script(SCRIPTS.uninstall, ["--uninstall", ...args]);
    case "setup":
    case "doctor":
    case "install":
      return script(SCRIPTS[command], args);
    default: {
      const unhandled: never = command;
      return unhandled;
    }
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command !== undefined && COMMANDS.includes(command)) {
  process.exitCode = await main(command as Command, rest);
} else {
  console.log(USAGE);
  process.exitCode = command === undefined || command === "help" || command === "--help" ? 0 : 64;
}
