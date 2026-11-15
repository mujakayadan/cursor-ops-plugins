#!/usr/bin/env node
// Cursor `workspaceOpen` hook: loads every enabled suite plugin straight from this checkout.
import { loadConfig } from "../packages/core/config.ts";
import { suitePlugins } from "../packages/core/suite.ts";
import { PLUGINS_DIR } from "./lib.ts";

let disabled: string[] = [];
try {
  disabled = loadConfig().suite.disabledPlugins;
} catch (err) {
  // A broken config must not silently drop plugins, the guardrails included.
  process.stderr.write(`[ops-suite] ${(err as Error).message}; loading all plugins\n`);
}

const pluginPaths = suitePlugins(PLUGINS_DIR, disabled)
  .filter((p) => p.enabled)
  .map((p) => p.path);
process.stdout.write(JSON.stringify({ pluginPaths }));
