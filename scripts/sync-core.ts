#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SERVE_ORIGIN, SERVE_TOKEN_ENV } from "../packages/core/suite.ts";
import type { Provider } from "../packages/core/types.ts";
import { CORE_DIR, listPlugins, PLUGINS_DIR, providerPlugins } from "./lib.ts";

/**
 * Read tier on the shared loopback server; write tier on stdio so only Cursor, behind its hooks,
 * reaches it. Providers without write tools get no write server.
 */
function mcpJson(id: string, writes: boolean): string {
  const servers = {
    [`ops-${id}-read`]: {
      url: `${SERVE_ORIGIN}/mcp/${id}`,
      headers: { Authorization: `Bearer \${env:${SERVE_TOKEN_ENV}}` },
    },
    ...(writes
      ? {
          [`ops-${id}-write`]: {
            command: "node",
            args: ["${CURSOR_PLUGIN_ROOT}/lib/core/run-mcp.ts", "--tier", "write"],
          },
        }
      : {}),
  };
  return `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
}

const PROVIDER_ONLY = new Set(["run-mcp.ts", "run-guard.ts"]);
const REVIEW_ONLY = new Set(["review.ts", "review-scan.ts", "review-docs.ts"]);
const MEMORY_ONLY = new Set(["memory-harvest.ts", "memory-digest.ts"]);
const CONTROL_ONLY = new Set(["suite.ts"]);
const PROFILE_PLUGINS = new Set(["ops-core", "ops-control"]);
const check = process.argv.includes("--check");
const sources = readdirSync(CORE_DIR).filter((f) => f.endsWith(".ts"));
const header = (file: string) =>
  `// GENERATED from packages/core/${file} by scripts/sync-core.ts. Edit the source, then run \`pnpm run sync\`.\n`;

let drift = 0;
for (const plugin of listPlugins()) {
  const dest = join(PLUGINS_DIR, plugin, "lib", "core");
  const isProvider = existsSync(join(PLUGINS_DIR, plugin, "provider.ts"));
  const isReviewer = existsSync(join(PLUGINS_DIR, plugin, "hooks", "review.ts"));
  const wanted = sources.filter(
    (f) =>
      (isProvider || !PROVIDER_ONLY.has(f)) &&
      (isReviewer || !REVIEW_ONLY.has(f)) &&
      (plugin === "ops-memory" || !MEMORY_ONLY.has(f)) &&
      (plugin === "ops-control" || !CONTROL_ONLY.has(f)) &&
      (PROFILE_PLUGINS.has(plugin) || f !== "profile.ts"),
  );
  if (!check) mkdirSync(dest, { recursive: true });

  for (const file of wanted) {
    const expected = header(file) + readFileSync(join(CORE_DIR, file), "utf8");
    const target = join(dest, file);
    const actual = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (actual === expected) continue;
    drift++;
    if (check) console.error(`drift: plugins/${plugin}/lib/core/${file}`);
    else writeFileSync(target, expected);
  }
  if (existsSync(dest)) {
    for (const stale of readdirSync(dest).filter((f) => !wanted.includes(f))) {
      drift++;
      if (check) console.error(`stale: plugins/${plugin}/lib/core/${stale}`);
      else rmSync(join(dest, stale));
    }
  }
}

for (const plugin of providerPlugins()) {
  const target = join(PLUGINS_DIR, plugin, "mcp.json");
  const { default: provider } = (await import(
    pathToFileURL(join(PLUGINS_DIR, plugin, "provider.ts")).href
  )) as { default: Provider };
  const expected = mcpJson(
    provider.id,
    provider.tools.some((t) => t.tier !== "read"),
  );
  const actual = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (actual === expected) continue;
  drift++;
  if (check) console.error(`drift: plugins/${plugin}/mcp.json`);
  else writeFileSync(target, expected);
}

if (check && drift) {
  console.error(`\n${drift} generated file(s) out of date. Run \`pnpm run sync\`.`);
  process.exit(1);
}
console.log(
  check
    ? "vendored core is in sync"
    : `synced core into ${listPlugins().length} plugins (${drift} file(s) updated)`,
);
