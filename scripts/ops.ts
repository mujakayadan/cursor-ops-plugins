#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadConfig } from "../packages/core/config.ts";
import { makeContext } from "../packages/core/mcp-server.ts";
import control from "../plugins/ops-control/provider.ts";
import { REPO_ROOT } from "./lib.ts";

const USAGE = `ops — the ops plugin suite from the terminal

  ops status              loader, plugins, review settings
  ops setup [options]     install the CLIs the enabled plugins need (ops setup --help)
  ops doctor              check CLIs, loader, config and sign-in per tier
  ops install             register the suite loader in Cursor and create ~/.ops/config.json
  ops uninstall           remove the suite loader`;

const SCRIPTS = {
  setup: "setup.ts",
  doctor: "doctor.ts",
  install: "install-local.ts",
  uninstall: "install-local.ts",
} as const;

type Command = keyof typeof SCRIPTS | "status";

function script(file: string, args: string[]): number {
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", file), ...args], {
    stdio: "inherit",
  });
  return result.status ?? 1;
}

interface Status {
  suite: { root: string; branch: string | null; head: string | null };
  loader: { registered: boolean; command: string | null; fix?: string };
  plugins: { name: string; version: string; enabled: boolean; privileged?: boolean }[];
  review: { enabled: boolean; lenses: Record<string, boolean> };
}

function status(): number {
  const tool = control.tools.find((t) => t.name === "control_status");
  if (!tool) return 1;
  const s = tool.run({}, makeContext(control, tool, loadConfig())) as Status;
  console.log(`suite   ${s.suite.root} (${s.suite.branch ?? "detached"} @ ${s.suite.head ?? "?"})`);
  console.log(
    `loader  ${s.loader.registered ? s.loader.command : `not registered. ${s.loader.fix}`}`,
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

function main(command: Command, args: string[]): number {
  switch (command) {
    case "status":
      return status();
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
if (command === "status" || (command !== undefined && Object.hasOwn(SCRIPTS, command))) {
  process.exitCode = main(command as Command, rest);
} else {
  console.log(USAGE);
  process.exitCode = command === undefined || command === "help" || command === "--help" ? 0 : 64;
}
