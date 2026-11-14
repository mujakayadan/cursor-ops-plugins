#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGINS_DIR, REPO_ROOT } from "./lib.mjs";

const [id, bin, displayName = id] = process.argv.slice(2);
if (!/^[a-z][a-z0-9]{1,30}$/.test(id ?? "") || !bin) {
  console.error('Usage: npm run new-plugin -- <provider-id> <cli-binary> "<Display Name>"\n  e.g. npm run new-plugin -- cloudflare wrangler "Cloudflare"');
  process.exit(64);
}
const name = `ops-${id}`;
const root = join(PLUGINS_DIR, name);
if (existsSync(root)) {
  console.error(`${root} already exists`);
  process.exit(1);
}

const files = {
  ".cursor-plugin/plugin.json": JSON.stringify(
    { name, displayName: `Ops: ${displayName}`, version: "0.1.0", description: `${displayName} operations with separate read and write MCP servers and ${bin} guardrails.`, author: { name: "mujak" }, license: "UNLICENSED", keywords: [id], category: "developer-tools" },
    null,
    2,
  ),
  "mcp.json": JSON.stringify(
    {
      mcpServers: {
        [`ops-${id}-read`]: { command: "node", args: ["${CURSOR_PLUGIN_ROOT}/lib/core/run-mcp.mjs", "--tier", "read"] },
        [`ops-${id}-write`]: { command: "node", args: ["${CURSOR_PLUGIN_ROOT}/lib/core/run-mcp.mjs", "--tier", "write"] },
      },
    },
    null,
    2,
  ),
  "hooks/hooks.json": JSON.stringify(
    {
      version: 1,
      hooks: {
        beforeMCPExecution: [{ command: "node ./lib/core/run-guard.mjs beforeMCPExecution", timeout: 10, failClosed: true }],
        beforeShellExecution: [{ command: "node ./lib/core/run-guard.mjs beforeShellExecution", matcher: `\\b${bin}(\\.exe|\\.cmd)?\\s`, timeout: 10, failClosed: true }],
      },
    },
    null,
    2,
  ),
  "provider.mjs": `import { obj, str } from "./lib/core/schema-helpers.mjs";

const tools = [
  {
    name: "${id}_whoami",
    title: "Current ${displayName} identity",
    tier: "read",
    description: "Return the authenticated ${displayName} identity for this tier's credentials.",
    run: (_a, { cli }) => cli(["whoami"], { parse: "auto" }),
  },
  {
    name: "${id}_example_write",
    title: "Example write",
    tier: "write",
    description: "Replace with a real, narrowly scoped write operation.",
    input: obj({ target: str("Resource identifier.", { pattern: "^[A-Za-z0-9_.-]{1,100}$" }) }, ["target"]),
    summarize: (a) => \`example write on \${a.target}\`,
    run: (a, { cli }) => cli(["example", a.target], { parse: "text" }),
  },
];

const cli = String.raw\`\\b${bin}(\\.exe|\\.cmd)?\\s+\`;
const shellRules = [
  { id: "${id}-delete", decision: "ask", re: new RegExp(\`\${cli}.*\\\\b(delete|rm|destroy)\\\\b\`, "i"), reason: "Deleting ${displayName} resources." },
];

export default {
  id: "${id}",
  displayName: "${displayName}",
  version: "0.1.0",
  bin: "${bin}",
  baseEnv: { NO_COLOR: "1" },
  instructions: { read: "Read-only ${displayName} access.", write: "${displayName} write access; every call requires approval." },
  tools,
  shellRules,
};
`,
  "evals/policy.json": JSON.stringify(
    [
      { name: "read tool allowed", event: "beforeMCPExecution", input: { mcp_server_name: `ops-${id}-read`, tool_name: `${id}_whoami`, tool_input: "{}" }, expect: { permission: "allow" } },
      { name: "write tool asks", event: "beforeMCPExecution", input: { mcp_server_name: `ops-${id}-write`, tool_name: `${id}_example_write`, tool_input: '{"target":"x"}' }, expect: { permission: "ask" } },
    ],
    null,
    2,
  ),
};

for (const [rel, content] of Object.entries(files)) {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${content}\n`);
}

const marketPath = join(REPO_ROOT, ".cursor-plugin", "marketplace.json");
const market = JSON.parse(readFileSync(marketPath, "utf8"));
market.plugins.push({ name, source: `./plugins/${name}` });
writeFileSync(marketPath, `${JSON.stringify(market, null, 2)}\n`);

console.log(`Created plugins/${name}. Next: edit provider.mjs, add skills/, then run \`npm run sync && npm run ci\`.`);
