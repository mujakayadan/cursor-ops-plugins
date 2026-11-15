#!/usr/bin/env node
// Cursor `workspaceOpen` hook: starts the shared read server, then loads every enabled suite
// plugin straight from this checkout. Cursor loads the plugins (and connects their MCP servers)
// only after this returns, so the read server is up before anything connects to it.
import { pathToFileURL } from "node:url";
import { loadConfig } from "../packages/core/config.ts";
import { SUITE_LOADED_ENV, suitePlugins } from "../packages/core/suite.ts";
import { PLUGINS_DIR } from "./lib.ts";
import { ensureServer } from "./serve-client.ts";

/** Paths of the enabled plugins; none when `ops agent` already passed them to the CLI. */
export function loaderPaths(): string[] {
  if (process.env[SUITE_LOADED_ENV]) return [];
  let disabled: string[] = [];
  try {
    disabled = loadConfig({ reload: true }).suite.disabledPlugins;
  } catch (err) {
    // A broken config must not silently drop plugins, the guardrails included.
    process.stderr.write(`[ops-suite] ${(err as Error).message}; loading all plugins\n`);
  }
  return suitePlugins(PLUGINS_DIR, disabled)
    .filter((p) => p.enabled)
    .map((p) => p.path);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const pluginPaths = loaderPaths();
  if (pluginPaths.length && !(await ensureServer())) {
    process.stderr.write(
      "[ops-suite] the shared read server did not start; see ~/.ops/serve.log\n",
    );
  }
  process.stdout.write(JSON.stringify({ pluginPaths }));
}
