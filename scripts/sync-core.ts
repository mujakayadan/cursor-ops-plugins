#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_DIR, listPlugins, PLUGINS_DIR } from "./lib.ts";

const PROVIDER_ONLY = new Set(["run-mcp.ts", "run-guard.ts"]);
const REVIEW_ONLY = new Set(["review.ts", "review-scan.ts"]);
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
    (f) => (isProvider || !PROVIDER_ONLY.has(f)) && (isReviewer || !REVIEW_ONLY.has(f)),
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

if (check && drift) {
  console.error(`\n${drift} vendored core file(s) out of date. Run \`pnpm run sync\`.`);
  process.exit(1);
}
console.log(
  check
    ? "vendored core is in sync"
    : `synced core into ${listPlugins().length} plugins (${drift} file(s) updated)`,
);
