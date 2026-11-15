#!/usr/bin/env node
// The shared read-tier MCP server: every provider's read tools over Streamable HTTP on loopback.
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHandler, type RpcMessage } from "../packages/core/mcp-server.ts";
import { gitHead, SERVE_PORT, SERVE_TOKEN_ENV, serveToken } from "../packages/core/suite.ts";
import type { Provider } from "../packages/core/types.ts";
import { PLUGINS_DIR, providerPlugins, REPO_ROOT } from "./lib.ts";

const MAX_BODY = 1_000_000;

export interface ServeOptions {
  token: string;
  providers: Provider[];
  head: string | null;
  onShutdown?: () => void;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createServeServer(options: ServeOptions): Server {
  const handlers = new Map(options.providers.map((p) => [p.id, createHandler(p, "read")]));
  const expected = Buffer.from(`Bearer ${options.token}`);
  const loopbackHost = (req: IncomingMessage) => {
    const port = req.socket.localPort;
    return [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? "");
  };
  const authorized = (req: IncomingMessage) => {
    const got = Buffer.from(req.headers.authorization ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  return createServer(async (req, res) => {
    // Loopback Host names only (defeats DNS rebinding), and never a web page's request.
    const origin = req.headers.origin ?? "";
    if (!loopbackHost(req) || /^https?:/i.test(origin)) {
      send(res, 403, { error: "forbidden" });
      return;
    }
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (req.method === "GET" && path === "/health") {
      send(res, 200, { pid: process.pid, head: options.head, providers: [...handlers.keys()] });
      return;
    }
    if (!authorized(req)) {
      send(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method === "POST" && path === "/shutdown") {
      send(res, 200, { ok: true });
      options.onShutdown?.();
      return;
    }
    const handle = handlers.get(/^\/mcp\/([a-z0-9]+)$/.exec(path)?.[1] ?? "");
    if (!handle) {
      send(res, 404, { error: "unknown server" });
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const batch = Array.isArray(body);
    const messages = (batch ? body : [body]) as RpcMessage[];
    const replies = (await Promise.all(messages.map((m) => handle(m)))).filter(
      (r) => r !== undefined,
    );
    if (replies.length === 0) send(res, 202);
    else send(res, 200, batch ? replies : replies[0]);
  });
}

async function loadProviders(): Promise<Provider[]> {
  const providers: Provider[] = [];
  for (const plugin of providerPlugins()) {
    const href = pathToFileURL(join(PLUGINS_DIR, plugin, "provider.ts")).href;
    providers.push(((await import(href)) as { default: Provider }).default);
  }
  return providers;
}

async function main(): Promise<void> {
  const token = serveToken();
  if (!token) {
    console.error(`No ${SERVE_TOKEN_ENV} and no token file; run \`ops install\` first.`);
    process.exit(1);
  }
  const providers = await loadProviders();
  const server = createServeServer({
    token,
    providers,
    head: gitHead(REPO_ROOT).head,
    onShutdown: () => server.close(() => process.exit(0)),
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(
      err.code === "EADDRINUSE"
        ? `Port ${SERVE_PORT} is in use; is another \`ops serve\` running? (\`ops serve --stop\`)`
        : err.message,
    );
    process.exit(1);
  });
  server.listen(SERVE_PORT, "127.0.0.1", () => {
    console.error(
      `[ops-serve] ${new Date().toISOString()} pid ${process.pid} on 127.0.0.1:${SERVE_PORT}: ${providers.map((p) => p.id).join(", ")}`,
    );
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
