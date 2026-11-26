#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  listPlugins,
  PLUGINS_DIR,
  pluginVersionFile,
  REPO_ROOT,
  type ReleaseConfig,
} from "./lib.ts";

interface Marketplace {
  metadata: { version: string };
  plugins: { name: string }[];
}
interface PluginManifest {
  name: string;
  version?: string;
  license?: string;
}

const REPO_LICENSE = "MIT";
interface HooksFile {
  version: number;
  hooks: Record<string, { command: string; matcher?: string }[]>;
}
interface McpFile {
  mcpServers: Record<string, { command?: string; args?: string[]; url?: string }>;
}
interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

const errors: string[] = [];
const fail = (where: string, msg: string) => errors.push(`${where}: ${msg}`);
const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

function frontmatter(path: string): Frontmatter | null {
  const text = readFileSync(path, "utf8");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fields: Record<string, string> = {};
  let lastKey: string | undefined;
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) {
      lastKey = kv[1] ?? "";
      fields[lastKey] = (kv[2] ?? "").replace(/^>-?\s*$/, "").trim();
    } else if (lastKey && /^\s+/.test(line)) {
      fields[lastKey] = `${fields[lastKey]} ${line.trim()}`.trim();
    }
  }
  return { fields, body: text.slice(m[0].length) };
}

const licensePath = join(REPO_ROOT, "LICENSE");
if (!existsSync(licensePath) || !readFileSync(licensePath, "utf8").startsWith("MIT License")) {
  fail("LICENSE", `repository LICENSE file must contain the ${REPO_LICENSE} license`);
}
if (json<{ license?: string }>(join(REPO_ROOT, "package.json")).license !== REPO_LICENSE) {
  fail("package.json", `license must be "${REPO_LICENSE}"`);
}

const market = json<Marketplace>(join(REPO_ROOT, ".cursor-plugin", "marketplace.json"));
const listed = new Set(market.plugins.map((p) => p.name));

// One suite version, bumped by release-please in package.json, the marketplace and every plugin.
const suiteVersion = json<{ version: string }>(join(REPO_ROOT, "package.json")).version;
if (market.metadata.version !== suiteVersion) {
  fail("marketplace.json", `metadata.version must equal package.json version ${suiteVersion}`);
}
const releaseFiles = new Set(
  json<ReleaseConfig>(join(REPO_ROOT, "release-please-config.json")).packages["."][
    "extra-files"
  ].map((f) => `${f.path}#${f.jsonpath}`),
);
if (!releaseFiles.has(".cursor-plugin/marketplace.json#$.metadata.version")) {
  fail("release-please-config.json", "extra-files must bump the marketplace version");
}
const manifestVersion = json<Record<string, string>>(
  join(REPO_ROOT, ".release-please-manifest.json"),
)["."];
if (manifestVersion !== suiteVersion) {
  fail(".release-please-manifest.json", `"." must equal package.json version ${suiteVersion}`);
}

// The repo runs the same GitOps workflows and community files that scaffolded projects get.
const SHARED_GITHUB: Record<string, string> = {
  "pr-policy.yml.jinja": ".github/workflows/pr-policy.yml",
  "sync-main-to-dev.yml.jinja": ".github/workflows/sync-main-to-dev.yml",
  "bug.yml.jinja": ".github/ISSUE_TEMPLATE/bug.yml",
  "feature.yml.jinja": ".github/ISSUE_TEMPLATE/feature.yml",
  "issue-config.yml.jinja": ".github/ISSUE_TEMPLATE/config.yml",
  "pull_request_template.md.jinja": ".github/pull_request_template.md",
};
const lf = (s: string) => s.replace(/\r\n/g, "\n");
for (const [fragment, copy] of Object.entries(SHARED_GITHUB)) {
  const source = readFileSync(join(REPO_ROOT, "templates", "_shared", "github", fragment), "utf8");
  const expected = lf(source.replace(/\{% (?:end)?raw %\}/g, ""));
  const path = join(REPO_ROOT, copy);
  if (!existsSync(path) || lf(readFileSync(path, "utf8")) !== expected) {
    fail(copy, `must match templates/_shared/github/${fragment} (without raw tags)`);
  }
}

for (const plugin of listPlugins()) {
  const root = join(PLUGINS_DIR, plugin);
  const manifest = json<PluginManifest>(join(root, ".cursor-plugin", "plugin.json"));
  if (manifest.name !== plugin) {
    fail(plugin, `plugin.json name "${manifest.name}" must match folder`);
  }
  if (manifest.version !== suiteVersion) {
    fail(plugin, `plugin.json version must equal the suite version ${suiteVersion}`);
  }
  if (!releaseFiles.has(`${pluginVersionFile(plugin).path}#$.version`)) {
    fail(plugin, "missing from release-please-config.json extra-files");
  }
  if (manifest.license !== REPO_LICENSE) {
    fail(plugin, `plugin.json license must be "${REPO_LICENSE}" like the repository`);
  }
  if (!listed.has(plugin)) fail(plugin, "missing from .cursor-plugin/marketplace.json");

  const skillsDir = join(root, "skills");
  for (const skill of existsSync(skillsDir) ? readdirSync(skillsDir) : []) {
    const path = join(skillsDir, skill, "SKILL.md");
    const fm = existsSync(path) ? frontmatter(path) : null;
    const where = `${plugin}/skills/${skill}`;
    if (!fm) {
      fail(where, "SKILL.md with frontmatter required");
      continue;
    }
    if (fm.fields.name !== skill) fail(where, "frontmatter name must match folder");
    const description = fm.fields.description;
    if (!description || description.length > 1024) {
      fail(where, "description required (<=1024 chars)");
    }
    if (fm.body.split("\n").length > 500) fail(where, "SKILL.md must stay under 500 lines");
  }

  const rulesDir = join(root, "rules");
  for (const rule of existsSync(rulesDir) ? readdirSync(rulesDir) : []) {
    const fm = frontmatter(join(rulesDir, rule));
    if (!rule.endsWith(".mdc") || !fm?.fields.description) {
      fail(`${plugin}/rules/${rule}`, ".mdc with description frontmatter required");
    }
  }

  const agentsDir = join(root, "agents");
  for (const agent of existsSync(agentsDir) ? readdirSync(agentsDir) : []) {
    const fm = frontmatter(join(agentsDir, agent));
    if (!fm?.fields.name || !fm.fields.description) {
      fail(`${plugin}/agents/${agent}`, "name and description frontmatter required");
    }
  }

  const hooksPath = join(root, "hooks", "hooks.json");
  if (existsSync(hooksPath)) {
    const hooks = json<HooksFile>(hooksPath);
    if (hooks.version !== 1) fail(`${plugin}/hooks`, "hooks.json version must be 1");
    for (const [event, defs] of Object.entries(hooks.hooks)) {
      for (const def of defs) {
        const script = def.command.match(/hooks\/[\w.-]+\.ts/)?.[0];
        if (script && !existsSync(join(root, script))) {
          fail(`${plugin}/hooks`, `${event} references missing ${script}`);
        }
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
    const isProvider = existsSync(join(root, "provider.ts"));
    for (const [name, def] of Object.entries(json<McpFile>(mcpPath).mcpServers)) {
      if (!isProvider) {
        // Bridge plugin: pin an external MCP (command + args), not ops-<id>-read/write.
        if (!("command" in def) || typeof def.command !== "string" || !def.command) {
          fail(`${plugin}/mcp.json`, `${name}: bridge servers need a command`);
        }
        if (!Array.isArray(def.args) || def.args.length === 0) {
          fail(`${plugin}/mcp.json`, `${name}: bridge servers need args`);
        }
        continue;
      }
      if (!/^ops-[a-z0-9]+-(read|write)$/.test(name)) {
        fail(`${plugin}/mcp.json`, `server "${name}" must be named ops-<provider>-<read|write>`);
      }
      if (name.endsWith("-read") !== "url" in def) {
        fail(`${plugin}/mcp.json`, `${name}: read servers use the shared url, write servers stdio`);
      }
      const entry = def.args?.find((a) => a.endsWith(".ts"));
      if (entry && !existsSync(entry.replace("${CURSOR_PLUGIN_ROOT}", root))) {
        fail(`${plugin}/mcp.json`, `${name} entry ${entry} missing`);
      }
    }
  }
}

for (const name of listed) {
  if (!listPlugins().includes(name)) fail("marketplace.json", `lists unknown plugin ${name}`);
}

if (errors.length) {
  console.error(errors.map((e) => `- ${e}`).join("\n"));
  process.exit(1);
}
console.log(`validated ${listPlugins().length} plugins`);
