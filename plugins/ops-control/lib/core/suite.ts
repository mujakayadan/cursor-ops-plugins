// GENERATED from packages/core/suite.ts by scripts/sync-core.ts. Edit the source, then run `pnpm run sync`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Plugins that always load: the guardrails, and the control plane that turns the others back on. */
export const ALWAYS_ON: readonly string[] = ["ops-core", "ops-control"];

/** Identifies the suite's entry in the user-level `hooks.json`. */
export const LOADER_SCRIPT = "workspace-plugins.ts";

export interface SuitePlugin {
  name: string;
  version: string;
  path: string;
  enabled: boolean;
  provider: boolean;
}

export function cursorHome(): string {
  return process.env.CURSOR_HOME || join(homedir(), ".cursor");
}

export function userHooksPath(): string {
  return join(cursorHome(), "hooks.json");
}

export function suitePlugins(pluginsDir: string, disabledPlugins: string[]): SuitePlugin[] {
  const disabled = new Set(disabledPlugins);
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() && existsSync(join(pluginsDir, d.name, ".cursor-plugin", "plugin.json")),
    )
    .map((d) => {
      const path = join(pluginsDir, d.name);
      const manifest = JSON.parse(
        readFileSync(join(path, ".cursor-plugin", "plugin.json"), "utf8"),
      ) as { version: string };
      return {
        name: d.name,
        version: manifest.version,
        path,
        enabled: ALWAYS_ON.includes(d.name) || !disabled.has(d.name),
        provider: existsSync(join(path, "provider.ts")),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

interface HookEntry {
  command: string;
  [key: string]: unknown;
}

export interface HooksFile {
  version: number;
  hooks: Record<string, HookEntry[]>;
}

export function readUserHooks(): HooksFile {
  const path = userHooksPath();
  if (!existsSync(path)) return { version: 1, hooks: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<HooksFile>;
  return { version: parsed.version ?? 1, hooks: parsed.hooks ?? {} };
}

/** The registered `workspaceOpen` loader command, if any. */
export function loaderCommand(hooks: HooksFile = readUserHooks()): string | undefined {
  return hooks.hooks.workspaceOpen?.find((h) => h.command.includes(LOADER_SCRIPT))?.command;
}
