import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CORE_DIR = join(REPO_ROOT, "packages", "core");
export const PLUGINS_DIR = join(REPO_ROOT, "plugins");

export function listPlugins(): string[] {
  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() && existsSync(join(PLUGINS_DIR, d.name, ".cursor-plugin", "plugin.json")),
    )
    .map((d) => d.name)
    .sort();
}

/** release-please `extra-files` entry; the suite releases all manifests with one version. */
export interface VersionFile {
  type: "json";
  path: string;
  jsonpath: string;
}

export interface ReleaseConfig {
  packages: { ".": { "extra-files": VersionFile[] } };
}

export const pluginVersionFile = (plugin: string): VersionFile => ({
  type: "json",
  path: `plugins/${plugin}/.cursor-plugin/plugin.json`,
  jsonpath: "$.version",
});

export function providerPlugins(): string[] {
  return listPlugins().filter((p) => existsSync(join(PLUGINS_DIR, p, "provider.ts")));
}
