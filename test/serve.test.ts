import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import control from "../plugins/ops-control/provider.ts";
import github from "../plugins/ops-github/provider.ts";
import { createServeServer } from "../scripts/serve.ts";

const TOKEN = "test-token-0123456789";
let server: Server;
let base: string;
let shutdowns = 0;

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  server = createServeServer({
    token: TOKEN,
    providers: [github, control],
    head: "abc123",
    onShutdown: () => shutdowns++,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("shared read server", () => {
  it("reports health without a token", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { providers: string[] }).providers, [
      "github",
      "control",
    ]);
  });

  it("rejects a missing or wrong token", async () => {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    assert.equal((await post("/mcp/github", body, { authorization: "" })).status, 401);
    assert.equal((await post("/mcp/github", body, { authorization: "Bearer nope" })).status, 401);
  });

  it("logs a burst of identical refusals once, without the token", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      for (let i = 0; i < 5; i++) {
        const res = await post("/mcp/nope", { jsonrpc: "2.0", id: 1, method: "tools/list" });
        assert.equal(res.status, 404);
      }
    } finally {
      spy.mockRestore();
    }
    const refused = lines.filter((l) => l.includes("unknown server"));
    assert.equal(refused.length, 1);
    assert.match(refused[0] ?? "", /auth=ok/);
    assert.ok(!refused[0]?.includes(TOKEN));
  });

  it("rejects web pages and rebound host names", async () => {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    assert.equal((await post("/mcp/github", body, { origin: "https://evil.example" })).status, 403);
    const rebound = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        `${base}/mcp/github`,
        { method: "POST", headers: { host: "evil.example", authorization: `Bearer ${TOKEN}` } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
    assert.equal(rebound, 403);
  });

  it("serves only read tools per provider", async () => {
    const res = await post("/mcp/github", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const { result } = (await res.json()) as { result: { tools: { name: string }[] } };
    const names = result.tools.map((t) => t.name);
    const reads = github.tools.filter((t) => t.tier === "read").map((t) => t.name);
    assert.deepEqual(names.sort(), reads.sort());
  });

  it("refuses write tools on the read server", async () => {
    const write = github.tools.find((t) => t.tier === "write");
    const res = await post("/mcp/github", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: write?.name, arguments: {} },
    });
    const { result } = (await res.json()) as { result: { isError: boolean } };
    assert.equal(result.isError, true);
  });

  it("answers batches, accepts notifications and 404s unknown servers", async () => {
    const batch = await post("/mcp/control", [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
    assert.equal(((await batch.json()) as unknown[]).length, 1);
    const note = await post("/mcp/control", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(note.status, 202);
    assert.equal((await post("/mcp/nope", { jsonrpc: "2.0", id: 1, method: "ping" })).status, 404);
  });

  it("shuts down only with the token", async () => {
    assert.equal((await post("/shutdown", {}, { authorization: "" })).status, 401);
    assert.equal((await post("/shutdown", {})).status, 200);
    assert.equal(shutdowns, 1);
  });
});
