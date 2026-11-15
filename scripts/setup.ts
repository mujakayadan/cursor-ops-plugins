#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { resolveBinary } from "../packages/core/cli.ts";
import { loadConfig, toolsDir } from "../packages/core/config.ts";
import { suitePlugins } from "../packages/core/suite.ts";
import type { Install, Provider } from "../packages/core/types.ts";
import { PLUGINS_DIR } from "./lib.ts";

const USAGE = `Usage: ops setup [--optional] [--yes] [--dry-run] [plugin...]

Installs the CLIs the enabled plugins need and that are missing on this machine.
  --optional  also install tools only some features need
  --yes       install without asking
  --dry-run   print the plan only
  plugin...   limit to these plugins (e.g. ops-latex)`;

export type Method = "pnpm" | "winget" | "brew";

export interface Step {
  plugin: string;
  install: Install;
  method?: { kind: Method; argv: string[] };
}

function has(bin: string): boolean {
  try {
    resolveBinary(bin);
    return true;
  } catch {
    return false;
  }
}

/** The command that installs `install` here: pnpm into the tools dir, else the OS package manager. */
export function methodFor(
  install: Install,
  platform: NodeJS.Platform,
  available: (bin: string) => boolean,
): Step["method"] {
  if (install.pnpm && available("pnpm")) {
    return { kind: "pnpm", argv: ["pnpm", "add", "--dir", toolsDir(), install.pnpm] };
  }
  if (platform === "win32" && install.winget && available("winget")) {
    return {
      kind: "winget",
      argv: [
        "winget",
        "install",
        "--id",
        install.winget,
        "--exact",
        "--source",
        "winget",
        "--accept-source-agreements",
        "--accept-package-agreements",
        "--disable-interactivity",
      ],
    };
  }
  if (platform !== "win32" && install.brew && available("brew")) {
    return { kind: "brew", argv: ["brew", "install", ...install.brew.split(" ")] };
  }
  return undefined;
}

async function plan(only: string[], optional: boolean): Promise<Step[]> {
  const cfg = loadConfig();
  const steps: Step[] = [];
  const seen = new Set<string>();
  for (const plugin of suitePlugins(PLUGINS_DIR, cfg.suite.disabledPlugins)) {
    if (!plugin.enabled || !plugin.provider) continue;
    if (only.length && !only.includes(plugin.name)) continue;
    const { default: provider } = (await import(
      pathToFileURL(join(plugin.path, "provider.ts")).href
    )) as { default: Provider };
    for (const install of provider.setup ?? []) {
      if (seen.has(install.bin) || (install.optional && !optional) || has(install.bin)) continue;
      seen.add(install.bin);
      const method = methodFor(install, process.platform, has);
      steps.push({ plugin: plugin.name, install, ...(method ? { method } : {}) });
    }
  }
  return steps;
}

function run(argv: string[]): boolean {
  const [bin = "", ...args] = argv;
  const { command, prefixArgs } = resolveBinary(bin);
  const result = spawnSync(command, [...prefixArgs, ...args], { stdio: "inherit" });
  return result.status === 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const unknown = [...flags].filter((f) => !["--optional", "--yes", "--dry-run"].includes(f));
  if (unknown.length) {
    console.error(`Unknown option ${unknown.join(", ")}\n\n${USAGE}`);
    process.exit(64);
  }
  const steps = await plan(
    args.filter((a) => !a.startsWith("--")),
    flags.has("--optional"),
  );
  if (steps.length === 0) {
    console.log("Everything the enabled plugins need is installed.");
    return;
  }
  for (const s of steps) {
    const how = s.method ? s.method.argv.join(" ") : `manual: ${s.install.docs}`;
    const note = s.install.optional ? ` (optional: ${s.install.optional})` : "";
    console.log(`${s.plugin.padEnd(18)} ${s.install.bin.padEnd(10)} ${how}${note}`);
  }
  const runnable = steps.filter((s) => s.method);
  if (flags.has("--dry-run") || runnable.length === 0) return;
  if (!flags.has("--yes")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nInstall ${runnable.length} tool(s)? [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) return;
  }
  if (
    runnable.some((s) => s.method?.kind === "pnpm") &&
    !existsSync(join(toolsDir(), "package.json"))
  ) {
    mkdirSync(toolsDir(), { recursive: true });
    writeFileSync(
      join(toolsDir(), "package.json"),
      `${JSON.stringify({ private: true }, null, 2)}\n`,
    );
  }
  let failed = 0;
  for (const s of runnable) {
    console.log(`\n> ${s.method?.argv.join(" ")}`);
    if (!(s.method && run(s.method.argv)) || !has(s.install.bin)) {
      failed++;
      console.error(`${s.install.bin}: not available after install; see ${s.install.docs}`);
    }
  }
  console.log(
    failed
      ? `\n${failed} tool(s) failed.`
      : "\nDone. Running MCP servers find the new tools on their next call; `ops doctor` checks sign-in.",
  );
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
