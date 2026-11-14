#!/usr/bin/env node
/**
 * Eval harness.
 *   policy   – black-box hook decisions using each plugin's real hooks.json wiring (incl. matchers)
 *   contract – MCP protocol + tier invariants for every read/write server
 *   agent    – live agent scenarios graded from the audit log (needs a headless agent CLI)
 * Usage: node evals/run.mjs [policy|contract|agent ...]
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PLUGINS_DIR, REPO_ROOT, listPlugins, providerPlugins } from "../scripts/lib.mjs";

const FIXTURE_CONFIG = join(REPO_ROOT, "evals", "fixtures", "config.json");
const suites = process.argv.slice(2).length ? process.argv.slice(2) : ["policy", "contract"];
const results = [];
const record = (suite, name, pass, detail = "") => results.push({ suite, name, pass, detail });

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Replace ${REPO_ROOT} and ${TMP} placeholders inside eval inputs. */
function expandPlaceholders(value) {
  const esc = (s) => JSON.stringify(s).slice(1, -1);
  return JSON.parse(JSON.stringify(value).replaceAll("${REPO_ROOT}", esc(REPO_ROOT)).replaceAll("${TMP}", esc(tmpdir())));
}

function baseEnv(extra = {}) {
  return { ...process.env, OPS_CONFIG: FIXTURE_CONFIG, OPS_AUDIT_DIR: auditDir, OPS_ALLOW_PRIVILEGED: "", ...extra };
}

const auditDir = mkdtempSync(join(tmpdir(), "ops-evals-"));

// ---------- policy ----------
function runPolicy() {
  for (const plugin of listPlugins()) {
    const casesPath = join(PLUGINS_DIR, plugin, "evals", "policy.json");
    if (!existsSync(casesPath)) continue;
    const hooks = readJson(join(PLUGINS_DIR, plugin, "hooks", "hooks.json")).hooks;
    for (const c of readJson(casesPath)) {
      const name = `${plugin} › ${c.name}`;
      const defs = hooks[c.event] ?? [];
      const subject = c.event.endsWith("ShellExecution") ? c.input.command : undefined;
      const applicable = defs.filter((d) => !d.matcher || subject === undefined || new RegExp(d.matcher).test(subject));
      let response = {};
      for (const def of applicable) {
        const [cmd, ...args] = def.command.split(" ");
        const proc = spawnSync(cmd, args, {
          cwd: join(PLUGINS_DIR, plugin),
          input: JSON.stringify({ hook_event_name: c.event, conversation_id: "eval", ...expandPlaceholders(c.input) }),
          env: baseEnv({ CURSOR_PLUGIN_ROOT: join(PLUGINS_DIR, plugin), ...(c.env ?? {}) }),
          encoding: "utf8",
          timeout: (def.timeout ?? 10) * 1000,
        });
        if (proc.status === 2) response = { permission: "deny", exit: 2 };
        else if (proc.status !== 0) response = { error: `exit ${proc.status}: ${proc.stderr.slice(0, 300)}` };
        else response = JSON.parse(proc.stdout || "{}");
      }
      if (!applicable.length && c.event.startsWith("before") && c.event !== "beforeSubmitPrompt") response = { permission: "allow", note: "no matching hook" };
      const mismatches = Object.entries(c.expect).filter(([k, v]) => response[k] !== v);
      record("policy", name, mismatches.length === 0, mismatches.length ? `expected ${JSON.stringify(c.expect)} got ${JSON.stringify(response).slice(0, 200)}` : "");
    }
  }
}

// ---------- contract ----------
class McpClient {
  constructor(command, args, env, cwd) {
    this.proc = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = "";
    this.proc.stdout.on("data", (d) => {
      this.buffer += d;
      let i;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      }
    });
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

async function startServer(plugin, serverName, extraEnv = {}) {
  const root = join(PLUGINS_DIR, plugin);
  const def = readJson(join(root, "mcp.json")).mcpServers[serverName];
  const args = def.args.map((a) => a.replaceAll("${CURSOR_PLUGIN_ROOT}", root));
  const client = new McpClient(def.command, args, baseEnv(extraEnv), root);
  const init = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ops-evals", version: "1" } });
  client.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const list = await client.request("tools/list", {});
  return { client, init: init.result, tools: list.result.tools };
}

const errorText = (res) => (res.result?.isError ? res.result.content[0].text : "");

async function runContract() {
  const seen = new Map();
  for (const plugin of providerPlugins()) {
    const provider = (await import(pathToFileURL(join(PLUGINS_DIR, plugin, "provider.mjs")).href)).default;
    const cases = existsSync(join(PLUGINS_DIR, plugin, "evals", "contract.json")) ? readJson(join(PLUGINS_DIR, plugin, "evals", "contract.json")) : [];

    const read = await startServer(plugin, `ops-${provider.id}-read`);
    const write = await startServer(plugin, `ops-${provider.id}-write`);
    const writePriv = await startServer(plugin, `ops-${provider.id}-write`, { OPS_ALLOW_PRIVILEGED: "1" });
    const tiers = Object.fromEntries(provider.tools.map((t) => [t.name, t.tier]));
    const p = (n) => `${plugin} › ${n}`;

    record("contract", p("initialize returns server info"), read.init?.serverInfo?.name === `ops-${provider.id}-read`);
    record("contract", p("read server exposes only read tools"), read.tools.length > 0 && read.tools.every((t) => tiers[t.name] === "read" && t.annotations.readOnlyHint === true), read.tools.map((t) => t.name).join(","));
    record("contract", p("write server exposes no read tools"), write.tools.every((t) => tiers[t.name] !== "read"));
    record("contract", p("privileged tools hidden by default"), write.tools.every((t) => tiers[t.name] !== "privileged"));
    const priv = writePriv.tools.filter((t) => tiers[t.name] === "privileged");
    record("contract", p("privileged tools require typed confirm when enabled"), priv.every((t) => t.inputSchema.required.includes("confirm") && t.annotations.destructiveHint === true));

    const unhygienic = [];
    for (const t of [...read.tools, ...writePriv.tools]) {
      const ok = t.name.startsWith(`${provider.id}_`) && t.inputSchema.type === "object" && t.description.length >= 30 && /^[a-z0-9_]{3,64}$/.test(t.name);
      if (!ok) unhygienic.push(t.name);
      if (seen.has(t.name) && seen.get(t.name) !== plugin) unhygienic.push(`${t.name} (duplicate of ${seen.get(t.name)})`);
      seen.set(t.name, plugin);
    }
    record("contract", p("tool hygiene (prefix, schema, descriptions, unique names)"), unhygienic.length === 0, unhygienic.join(", "));

    const writeOnly = provider.tools.find((t) => t.tier === "write");
    if (writeOnly) {
      const res = await read.client.request("tools/call", { name: writeOnly.name, arguments: {} });
      record("contract", p("read server refuses write tool calls"), /not available/.test(errorText(res)), errorText(res));
    }
    for (const t of priv) {
      const res = await writePriv.client.request("tools/call", { name: t.name, arguments: { ...(cases.find((c) => c.tool === t.name)?.arguments ?? {}), confirm: "wrong" } });
      const msg = errorText(res);
      record("contract", p(`${t.name} rejects wrong confirmation`), /Confirmation mismatch|Invalid arguments/.test(msg), msg.slice(0, 160));
    }
    for (const c of cases.filter((x) => x.expectError)) {
      const server = c.server === "write" ? writePriv : read;
      const res = await server.client.request("tools/call", { name: c.tool, arguments: expandPlaceholders(c.arguments) });
      const msg = errorText(res);
      record("contract", p(c.name), new RegExp(c.expectError).test(msg), msg.slice(0, 160));
    }
    for (const s of [read, write, writePriv]) s.client.close();
  }
}

// ---------- agent ----------
function auditRecords() {
  return readdirSync(auditDir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(auditDir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

function runAgent() {
  const template = (process.env.OPS_AGENT_CMD || "cursor-agent -p --force {prompt}").split(" ");
  const probe = spawnSync(template[0], ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
  if (probe.status !== 0) {
    record("agent", "agent CLI available", null, `"${template[0]}" not found; install the Cursor CLI or set OPS_AGENT_CMD`);
    return;
  }
  for (const plugin of listPlugins()) {
    const path = join(PLUGINS_DIR, plugin, "evals", "agent.json");
    if (!existsSync(path)) continue;
    for (const s of readJson(path)) {
      rmSync(auditDir, { recursive: true, force: true });
      const args = template.slice(1).map((a) => (a === "{prompt}" ? s.prompt : a));
      const proc = spawnSync(template[0], args, { env: { ...process.env, OPS_AUDIT_DIR: auditDir }, encoding: "utf8", timeout: (s.timeoutSec ?? 300) * 1000 });
      const called = new Set(auditRecords().map((r) => r.tool).filter(Boolean));
      const missing = (s.expectTools ?? []).filter((t) => !called.has(t));
      const forbidden = (s.forbidTools ?? []).filter((t) => called.has(t));
      const textOk = !s.expectOutput || new RegExp(s.expectOutput, "i").test(proc.stdout ?? "");
      record("agent", `${plugin} › ${s.name}`, !missing.length && !forbidden.length && textOk, [missing.length && `missing ${missing}`, forbidden.length && `forbidden ${forbidden}`, !textOk && "output mismatch"].filter(Boolean).join("; "));
    }
  }
}

for (const suite of suites) {
  if (suite === "policy") runPolicy();
  else if (suite === "contract") await runContract();
  else if (suite === "agent") runAgent();
  else throw new Error(`unknown suite ${suite}`);
}
rmSync(auditDir, { recursive: true, force: true });

const failed = results.filter((r) => r.pass === false);
const skipped = results.filter((r) => r.pass === null);
for (const r of results) {
  const tag = r.pass === null ? "SKIP" : r.pass ? "PASS" : "FAIL";
  if (r.pass !== true || process.env.VERBOSE) console.log(`${tag}  [${r.suite}] ${r.name}${r.detail ? `\n      ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
process.exitCode = failed.length ? 1 : 0;
