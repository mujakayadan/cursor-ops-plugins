// GENERATED from packages/core/suite.ts by scripts/sync-core.ts. Edit the source, then run `pnpm run sync`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { opsHome } from "./config.ts";

/** Plugins that always load: the guardrails, and the control plane that turns the others back on. */
export const ALWAYS_ON: readonly string[] = ["ops-core", "ops-control"];

/** Identifies the suite's entry in the user-level `hooks.json`. */
export const LOADER_SCRIPT = "workspace-plugins.ts";

/** The shared read-tier server; plugin `mcp.json` files point their read servers here. */
export const SERVE_PORT = 47821;
export const SERVE_ORIGIN = `http://127.0.0.1:${SERVE_PORT}`;
/** Cursor sends `Authorization: Bearer ${env:OPS_MCP_TOKEN}`; the server rejects anything else. */
export const SERVE_TOKEN_ENV = "OPS_MCP_TOKEN";
/** Set by `ops agent`, which passes the plugins itself, so the loader returns none. */
export const SUITE_LOADED_ENV = "OPS_SUITE_LOADED";

export function serveTokenPath(): string {
  return join(opsHome(), "serve.token");
}

/** The token the server accepts: the environment's (what Cursor interpolates), else the token file. */
export function serveToken(): string | undefined {
  const fromEnv = process.env[SERVE_TOKEN_ENV];
  if (fromEnv) return fromEnv;
  return existsSync(serveTokenPath()) ? readFileSync(serveTokenPath(), "utf8").trim() : undefined;
}

export interface ServeHealth {
  pid: number;
  head: string | null;
  providers: string[];
}

export async function serveHealth(timeoutMs = 500): Promise<ServeHealth | undefined> {
  try {
    const res = await fetch(`${SERVE_ORIGIN}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? ((await res.json()) as ServeHealth) : undefined;
  } catch {
    return undefined;
  }
}

/** Short commit of a checkout's HEAD, read from `.git` without running git. */
export function gitHead(repoRoot: string): { branch: string | null; head: string | null } {
  const headFile = join(repoRoot, ".git", "HEAD");
  if (!existsSync(headFile)) return { branch: null, head: null };
  const head = readFileSync(headFile, "utf8").trim();
  const ref = /^ref: (refs\/heads\/(.+))$/.exec(head);
  if (!ref?.[1]) return { branch: null, head: head.slice(0, 12) };
  const refFile = join(repoRoot, ".git", ref[1]);
  const packed = join(repoRoot, ".git", "packed-refs");
  const sha = existsSync(refFile)
    ? readFileSync(refFile, "utf8").trim()
    : existsSync(packed)
      ? readFileSync(packed, "utf8")
          .split("\n")
          .find((l) => l.endsWith(` ${ref[1]}`))
          ?.split(" ")[0]
      : undefined;
  return { branch: ref[2] ?? null, head: sha ? sha.slice(0, 12) : null };
}

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
