#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_DIR, PLUGINS_DIR, listPlugins } from "./lib.mjs";

const PROVIDER_ONLY = new Set(["run-mcp.mjs", "run-guard.mjs"]);
const check = process.argv.includes("--check");
const sources = readdirSync(CORE_DIR).filter((f) => f.endsWith(".mjs"));
const header = (file) => `// GENERATED from packages/core/${file} by scripts/sync-core.mjs. Edit the source, then run \`npm run sync\`.\n`;

let drift = 0;
for (const plugin of listPlugins()) {
  const dest = join(PLUGINS_DIR, plugin, "lib", "core");
  const isProvider = existsSync(join(PLUGINS_DIR, plugin, "provider.mjs"));
  const wanted = sources.filter((f) => isProvider || !PROVIDER_ONLY.has(f));
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
  console.error(`\n${drift} vendored core file(s) out of date. Run \`npm run sync\`.`);
  process.exit(1);
}
console.log(check ? "vendored core is in sync" : `synced core into ${listPlugins().length} plugins (${drift} file(s) updated)`);
