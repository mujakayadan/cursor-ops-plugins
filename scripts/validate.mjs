#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PLUGINS_DIR, REPO_ROOT, listPlugins } from "./lib.mjs";

const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

function frontmatter(path) {
  const text = readFileSync(path, "utf8");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fields = {};
  let lastKey;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) {
      lastKey = kv[1];
      fields[lastKey] = kv[2].replace(/^>-?\s*$/, "").trim();
    } else if (lastKey && /^\s+/.test(line)) {
      fields[lastKey] = `${fields[lastKey]} ${line.trim()}`.trim();
    }
  }
  return { fields, body: text.slice(m[0].length) };
}

const market = json(join(REPO_ROOT, ".cursor-plugin", "marketplace.json"));
const listed = new Set(market.plugins.map((p) => p.name));

for (const plugin of listPlugins()) {
  const root = join(PLUGINS_DIR, plugin);
  const manifest = json(join(root, ".cursor-plugin", "plugin.json"));
  if (manifest.name !== plugin) fail(plugin, `plugin.json name "${manifest.name}" must match folder`);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) fail(plugin, "plugin.json version must be semver");
  if (!listed.has(plugin)) fail(plugin, "missing from .cursor-plugin/marketplace.json");

  const skillsDir = join(root, "skills");
  for (const skill of existsSync(skillsDir) ? readdirSync(skillsDir) : []) {
    const path = join(skillsDir, skill, "SKILL.md");
    const fm = existsSync(path) && frontmatter(path);
    if (!fm) {
      fail(`${plugin}/skills/${skill}`, "SKILL.md with frontmatter required");
      continue;
    }
    if (fm.fields.name !== skill) fail(`${plugin}/skills/${skill}`, "frontmatter name must match folder");
    if (!fm.fields.description || fm.fields.description.length > 1024) fail(`${plugin}/skills/${skill}`, "description required (<=1024 chars)");
    if (fm.body.split("\n").length > 500) fail(`${plugin}/skills/${skill}`, "SKILL.md must stay under 500 lines");
  }

  const rulesDir = join(root, "rules");
  for (const rule of existsSync(rulesDir) ? readdirSync(rulesDir) : []) {
    const fm = frontmatter(join(rulesDir, rule));
    if (!rule.endsWith(".mdc") || !fm?.fields.description) fail(`${plugin}/rules/${rule}`, ".mdc with description frontmatter required");
  }

  const agentsDir = join(root, "agents");
  for (const agent of existsSync(agentsDir) ? readdirSync(agentsDir) : []) {
    const fm = frontmatter(join(agentsDir, agent));
    if (!fm?.fields.name || !fm.fields.description) fail(`${plugin}/agents/${agent}`, "name and description frontmatter required");
  }

  const hooksPath = join(root, "hooks", "hooks.json");
  if (existsSync(hooksPath)) {
    const hooks = json(hooksPath);
    if (hooks.version !== 1) fail(`${plugin}/hooks`, "hooks.json version must be 1");
    for (const [event, defs] of Object.entries(hooks.hooks)) {
      for (const def of defs) {
        const script = def.command.split(" ").find((p) => p.endsWith(".mjs"));
        if (script && !existsSync(join(root, script))) fail(`${plugin}/hooks`, `${event} references missing ${script}`);
        if (def.matcher) {
          try {
            new RegExp(def.matcher);
          } catch {
            fail(`${plugin}/hooks`, `${event} matcher is not a valid regex`);
          }
        }
      }
    }
  }

  const mcpPath = join(root, "mcp.json");
  if (existsSync(mcpPath)) {
    for (const [name, def] of Object.entries(json(mcpPath).mcpServers)) {
      if (!new RegExp(`^ops-[a-z0-9]+-(read|write)$`).test(name)) fail(`${plugin}/mcp.json`, `server "${name}" must be named ops-<provider>-<read|write>`);
      const entry = def.args?.find((a) => a.endsWith(".mjs"));
      if (entry && !existsSync(entry.replace("${CURSOR_PLUGIN_ROOT}", root))) fail(`${plugin}/mcp.json`, `${name} entry ${entry} missing`);
    }
  }
}

for (const name of listed) if (!listPlugins().includes(name)) fail("marketplace.json", `lists unknown plugin ${name}`);

if (errors.length) {
  console.error(errors.map((e) => `- ${e}`).join("\n"));
  process.exit(1);
}
console.log(`validated ${listPlugins().length} plugins`);
