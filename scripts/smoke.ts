#!/usr/bin/env node
/**
 * Live read-only smoke test: starts each provider's read server over stdio and calls
 * one or more read tools against the real accounts. Prints shapes, not data.
 * Usage: node scripts/smoke.ts [provider ...]
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGINS_DIR } from "./lib.ts";

interface McpFile {
  mcpServers: Record<string, { command: string; args: string[] }>;
}
interface RpcResponse {
  id: number;
  result: { isError?: boolean; content: { text: string }[] };
}

const CALLS: Record<string, [string, Record<string, unknown>][]> = {
  github: [
    ["github_whoami", {}],
    ["github_pr_list", { repo: "cli/cli", limit: 3 }],
  ],
  digitalocean: [
    ["digitalocean_account_get", {}],
    ["digitalocean_droplet_list", {}],
    ["digitalocean_app_list", {}],
  ],
  vercel: [["vercel_project_list", { limit: 5 }]],
  aws: [
    ["aws_whoami", {}],
    ["aws_s3_buckets", {}],
  ],
  scaffold: [["scaffold_list_templates", {}]],
};

function shape(text: string): string {
  try {
    const v: unknown = JSON.parse(text);
    if (Array.isArray(v))
      return `array(${v.length})${v[0] && typeof v[0] === "object" ? ` keys=${Object.keys(v[0]).join(",")}` : ""}`;
    if (v && typeof v === "object") return `object keys=${Object.keys(v).join(",")}`;
    return typeof v;
  } catch {
    return `text(${text.length} chars)`;
  }
}

async function smoke(id: string): Promise<void> {
  const root = join(PLUGINS_DIR, `ops-${id}`);
  const mcp = JSON.parse(readFileSync(join(root, "mcp.json"), "utf8")) as McpFile;
  const def = mcp.mcpServers[`ops-${id}-read`];
  if (!def) throw new Error(`ops-${id} has no read server in mcp.json`);
  const proc = spawn(
    def.command,
    def.args.map((a) => a.replaceAll("${CURSOR_PLUGIN_ROOT}", root)),
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  let buf = "";
  const waiters = new Map<number, (msg: RpcResponse) => void>();
  proc.stdout.on("data", (d: Buffer) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const msg = JSON.parse(buf.slice(0, i)) as RpcResponse;
      buf = buf.slice(i + 1);
      waiters.get(msg.id)?.(msg);
    }
  });
  let n = 0;
  const call = (method: string, params: unknown) =>
    new Promise<RpcResponse>((resolve) => {
      const id = ++n;
      waiters.set(id, resolve);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  for (const [tool, args] of CALLS[id] ?? []) {
    const started = Date.now();
    const res = await call("tools/call", { name: tool, arguments: args });
    const text = res.result.content[0]?.text ?? "";
    console.log(
      `${res.result.isError ? "ERR " : "OK  "} ${tool.padEnd(28)} ${String(Date.now() - started).padStart(5)}ms  ${res.result.isError ? (text.split("\n")[0] ?? "").slice(0, 140) : shape(text)}`,
    );
  }
  proc.stdin.end();
}

for (const id of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CALLS))
  await smoke(id);
