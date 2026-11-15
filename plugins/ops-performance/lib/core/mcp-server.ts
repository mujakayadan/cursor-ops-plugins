// GENERATED from packages/core/mcp-server.ts by scripts/sync-core.ts. Edit the source, then run `pnpm run sync`.
import { createInterface } from "node:readline";
import { audit } from "./audit.ts";
import { runCommand, tryParseJson } from "./cli.ts";
import { loadConfig, privilegedEnabled, providerConfig, tierCredentials } from "./config.ts";
import { redact, redactDeep, truncate } from "./redact.ts";
import { validate } from "./schema.ts";
import type { JsonSchema } from "./schema-helpers.ts";
import { ToolError } from "./schema-helpers.ts";
import type {
  Args,
  Cli,
  CliOptions,
  Config,
  Provider,
  ServerTier,
  Tool,
  ToolContext,
} from "./types.ts";

export { ToolError };

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { protocolVersion?: string; name?: string; arguments?: unknown };
}

/** Tools a server instance for `tier` exposes. The write server also carries privileged tools when enabled. */
export function toolsForTier(
  provider: Provider,
  tier: ServerTier,
  cfg: Config = loadConfig(),
): Tool[] {
  if (tier === "read") return provider.tools.filter((t) => t.tier === "read");
  const allowPrivileged = privilegedEnabled(provider.id, cfg);
  return provider.tools.filter(
    (t) => t.tier === "write" || (t.tier === "privileged" && allowPrivileged),
  );
}

function inputSchema(tool: Tool): JsonSchema {
  const schema: JsonSchema = structuredClone(tool.input ?? { type: "object", properties: {} });
  schema.type = "object";
  schema.properties ??= {};
  schema.additionalProperties ??= false;
  if (tool.tier === "privileged") {
    schema.properties.confirm = {
      type: "string",
      description: `Typed confirmation. Must exactly equal ${tool.confirmHint}. Ask the user to confirm the exact target before calling.`,
    };
    schema.required = [...new Set([...(schema.required ?? []), "confirm"])];
  }
  return schema;
}

function describeTool(tool: Tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: `[${tool.tier.toUpperCase()}] ${tool.description}`,
    inputSchema: inputSchema(tool),
    annotations: {
      title: tool.title,
      readOnlyHint: tool.tier === "read",
      destructiveHint: tool.tier === "privileged",
      idempotentHint: tool.tier === "read",
      openWorldHint: true,
    },
  };
}

export function makeContext(
  provider: Provider,
  tool: Tool,
  cfg: Config = loadConfig(),
): ToolContext {
  const creds = tierCredentials(provider.id, tool.tier, cfg);
  const pcfg = providerConfig(provider.id, cfg);
  const run = async (args: string[], options: CliOptions = {}): Promise<unknown> => {
    const {
      okCodes = [0],
      input,
      parse = "auto",
      withBaseArgs = true,
      timeoutMs = cfg.execution.timeoutMs,
      cwd,
    } = options;
    const base = withBaseArgs ? (provider.baseArgs ?? []) : [];
    const result = await runCommand(provider.bin, [...creds.args, ...base, ...args], {
      env: { ...(provider.baseEnv ?? {}), ...creds.env },
      timeoutMs,
      input,
      cwd,
    });
    if (result.timedOut) throw new ToolError(`${provider.bin} timed out after ${timeoutMs}ms`);
    if (result.code === null || !okCodes.includes(result.code)) {
      const detail = redact((result.stderr || result.stdout || "").trim()).slice(0, 2000);
      throw new ToolError(`${provider.bin} exited with code ${result.code}: ${detail}`);
    }
    if (parse === "text") return result.stdout;
    const parsed = tryParseJson(result.stdout);
    if (parse === "json" && parsed === undefined) {
      throw new ToolError(`${provider.bin} did not return JSON`);
    }
    return parsed ?? result.stdout;
  };
  return { tier: tool.tier, cfg, provider: pcfg, cli: run as Cli };
}

function render(result: unknown, maxChars: number): string {
  const text =
    typeof result === "string" ? result : (JSON.stringify(redactDeep(result), null, 2) ?? "");
  return truncate(redact(text), maxChars);
}

export async function callTool(
  provider: Provider,
  tools: Tool[],
  name: string | undefined,
  rawArgs: unknown,
  cfg: Config = loadConfig(),
): Promise<unknown> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new ToolError(`Tool "${name}" is not available on this server`);
  const { value, errors } = validate(inputSchema(tool), rawArgs ?? {});
  if (errors.length) throw new ToolError(`Invalid arguments: ${errors.join("; ")}`);
  const args = value as Args;

  if (tool.tier === "privileged") {
    if (!tool.confirm) throw new ToolError(`${tool.name} has no confirmation rule`);
    const expected = tool.confirm(args);
    if (args.confirm !== expected) {
      throw new ToolError(
        `Confirmation mismatch. Re-run with confirm="${expected}" only after the user explicitly approves this exact target.`,
      );
    }
  }
  const ctx = makeContext(provider, tool, cfg);
  const scopeError = await tool.scope?.(args, ctx.provider, ctx);
  if (scopeError) throw new ToolError(`Scope policy: ${scopeError}`);

  return tool.run(args, ctx);
}

/** Start a newline-delimited JSON-RPC MCP server over stdio for one provider tier. */
export function startServer(provider: Provider, tier: ServerTier): void {
  const cfg = loadConfig();
  const tools = toolsForTier(provider, tier, cfg);
  const serverName = `ops-${provider.id}-${tier}`;

  const send = (msg: object) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const reply = (id: RpcMessage["id"], result: object) => send({ jsonrpc: "2.0", id, result });
  const fail = (id: RpcMessage["id"], code: number, message: string) =>
    send({ jsonrpc: "2.0", id, error: { code, message } });

  async function handle(msg: RpcMessage): Promise<void> {
    const { id, method, params } = msg;
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        reply(id, {
          protocolVersion:
            requested && SUPPORTED_PROTOCOLS.includes(requested)
              ? requested
              : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: serverName, version: provider.version },
          instructions: provider.instructions?.[tier],
        });
        return;
      }
      case "ping":
        reply(id, {});
        return;
      case "tools/list":
        reply(id, { tools: tools.map(describeTool) });
        return;
      case "tools/call": {
        const started = Date.now();
        const name = params?.name;
        const tool = tools.find((t) => t.name === name);
        const base = {
          source: "mcp",
          server: serverName,
          tool: name,
          tier: tool?.tier,
          args: params?.arguments,
        };
        try {
          const result = await callTool(provider, tools, name, params?.arguments, cfg);
          audit({ ...base, ok: true, ms: Date.now() - started });
          reply(id, {
            content: [{ type: "text", text: render(result, cfg.execution.maxOutputChars) }],
          });
        } catch (err) {
          const message =
            err instanceof ToolError ? err.message : `Unexpected error: ${(err as Error).message}`;
          audit({ ...base, ok: false, error: message, ms: Date.now() - started });
          reply(id, { content: [{ type: "text", text: redact(message) }], isError: true });
        }
        return;
      }
      default:
        if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
    }
  }

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      fail(null, -32700, "Parse error");
      return;
    }
    handle(msg).catch((err: Error) => {
      if (msg.id !== undefined) fail(msg.id, -32603, redact(err.message));
    });
  });
  rl.on("close", () => process.exit(0));
  process.stderr.write(`[${serverName}] ready with ${tools.length} tools\n`);
}
