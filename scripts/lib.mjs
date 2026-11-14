import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CORE_DIR = join(REPO_ROOT, "packages", "core");
export const PLUGINS_DIR = join(REPO_ROOT, "plugins");

export function listPlugins() {
  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(PLUGINS_DIR, d.name, ".cursor-plugin", "plugin.json")))
    .map((d) => d.name)
    .sort();
}

export function providerPlugins() {
  return listPlugins().filter((p) => existsSync(join(PLUGINS_DIR, p, "provider.mjs")));
}
