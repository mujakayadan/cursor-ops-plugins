#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGINS_DIR, REPO_ROOT } from "./lib.ts";

const [id, bin, displayName = id] = process.argv.slice(2);
if (!id || !/^[a-z][a-z0-9]{1,30}$/.test(id) || !bin) {
  console.error(
    'Usage: pnpm run new-plugin -- <provider-id> <cli-binary> "<Display Name>"\n  e.g. pnpm run new-plugin -- cloudflare wrangler "Cloudflare"',
  );
  process.exit(64);
}
const name = `ops-${id}`;
const root = join(PLUGINS_DIR, name);
if (existsSync(root)) {
  console.error(`${root} already exists`);
  process.exit(1);
}

const files: Record<string, string> = {
  ".cursor-plugin/plugin.json": JSON.stringify(
    {
      name,
      displayName: `Ops: ${displayName}`,
      version: "0.1.0",
      description: `${displayName} operations with separate read and write MCP servers and ${bin} guardrails.`,
      author: { name: "Muja Kayadan" },
      license: "MIT",
      keywords: [id],
      category: "developer-tools",
    },
    null,
    2,
  ),
  "mcp.json": JSON.stringify(
    {
      mcpServers: {
        [`ops-${id}-read`]: {
          command: "node",
          args: ["${CURSOR_PLUGIN_ROOT}/lib/core/run-mcp.ts", "--tier", "read"],
        },
        [`ops-${id}-write`]: {
          command: "node",
          args: ["${CURSOR_PLUGIN_ROOT}/lib/core/run-mcp.ts", "--tier", "write"],
        },
      },
    },
    null,
    2,
  ),
  "hooks/hooks.json": JSON.stringify(
    {
      version: 1,
      hooks: {
        beforeMCPExecution: [
          {
            command: "node ./lib/core/run-guard.ts beforeMCPExecution",
            timeout: 10,
            failClosed: true,
          },
        ],
        beforeShellExecution: [
          {
            command: "node ./lib/core/run-guard.ts beforeShellExecution",
            matcher: `\\b${bin}(\\.exe|\\.cmd)?\\s`,
            timeout: 10,
            failClosed: true,
          },
        ],
      },
    },
    null,
    2,
  ),
  "provider.ts": `import { obj, str, tool } from "./lib/core/schema-helpers.ts";
import type { Provider, ShellRule } from "./lib/core/types.ts";

const tools = [
  tool({
    name: "${id}_whoami",
    title: "Current ${displayName} identity",
    tier: "read",
    description: "Return the authenticated ${displayName} identity for this tier's credentials.",
    run: (_a, { cli }) => cli(["whoami"], { parse: "auto" }),
  }),
  tool({
    name: "${id}_example_write",
    title: "Example write",
    tier: "write",
    description: "Replace with a real, narrowly scoped write operation.",
    input: obj({ target: str("Resource identifier.", { pattern: "^[A-Za-z0-9_.-]{1,100}$" }) }, [
      "target",
    ]),
    summarize: (a) => \`example write on \${a.target}\`,
    run: (a, { cli }) => cli(["example", a.target], { parse: "text" }),
  }),
];

const cli = String.raw\`\\b${bin}(\\.exe|\\.cmd)?\\s+\`;
const shellRules: ShellRule[] = [
  {
    id: "${id}-delete",
    decision: "ask",
    re: new RegExp(\`\${cli}.*\\\\b(delete|rm|destroy)\\\\b\`, "i"),
    reason: "Deleting ${displayName} resources.",
  },
];

const provider: Provider = {
  id: "${id}",
  displayName: "${displayName}",
  version: "0.1.0",
  bin: "${bin}",
  baseEnv: { NO_COLOR: "1" },
  instructions: {
    read: "Read-only ${displayName} access.",
    write: "${displayName} write access; every call requires approval.",
  },
  tools,
  shellRules,
};

export default provider;
`,
  "evals/policy.json": JSON.stringify(
    [
      {
        name: "read tool allowed",
        event: "beforeMCPExecution",
        input: { mcp_server_name: `ops-${id}-read`, tool_name: `${id}_whoami`, tool_input: "{}" },
        expect: { permission: "allow" },
      },
      {
        name: "write tool asks",
        event: "beforeMCPExecution",
        input: {
          mcp_server_name: `ops-${id}-write`,
          tool_name: `${id}_example_write`,
          tool_input: '{"target":"x"}',
        },
        expect: { permission: "ask" },
      },
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
const market = JSON.parse(readFileSync(marketPath, "utf8")) as {
  plugins: { name: string; source: string }[];
};
market.plugins.push({ name, source: `./plugins/${name}` });
writeFileSync(marketPath, `${JSON.stringify(market, null, 2)}\n`);

console.log(
  `Created plugins/${name}. Next: edit provider.ts, add skills/, then run \`pnpm run sync && pnpm run ci\`.`,
);
