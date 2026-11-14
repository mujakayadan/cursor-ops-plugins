#!/usr/bin/env node
import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PLUGINS_DIR, listPlugins, providerPlugins } from "./lib.mjs";

const WHOAMI = { github: "github_whoami", digitalocean: "digitalocean_account_get", vercel: "vercel_whoami", aws: "aws_whoami" };
const rows = [];
const row = (area, check, ok, detail = "") => rows.push({ area, check, status: ok === null ? "WARN" : ok ? "OK" : "FAIL", detail });

const [major] = process.versions.node.split(".").map(Number);
row("runtime", "node >= 20", major >= 20, process.versions.node);

const localDir = join(process.env.CURSOR_HOME || join(homedir(), ".cursor"), "plugins", "local");
for (const p of listPlugins()) {
  const link = join(localDir, p);
  let linked = false;
  try {
    linked = lstatSync(link).isSymbolicLink() || existsSync(join(link, ".cursor-plugin", "plugin.json"));
  } catch {}
  row("install", p, linked || null, linked ? link : "not installed — run `npm run install-local`");
}

const anyProvider = providerPlugins()[0];
const coreUrl = (p, f) => pathToFileURL(join(PLUGINS_DIR, p, "lib", "core", f)).href;
const { loadConfig, configPath, privilegedEnabled } = await import(coreUrl(anyProvider, "config.mjs"));
let cfg;
try {
  cfg = loadConfig();
  row("config", configPath(), existsSync(configPath()) || null, existsSync(configPath()) ? "loaded" : "missing — using defaults");
} catch (err) {
  row("config", configPath(), false, err.message);
}

for (const p of providerPlugins()) {
  const provider = (await import(pathToFileURL(join(PLUGINS_DIR, p, "provider.mjs")).href)).default;
  const { resolveBinary } = await import(coreUrl(p, "cli.mjs"));
  const { makeContext } = await import(coreUrl(p, "mcp-server.mjs"));
  try {
    const bin = resolveBinary(provider.bin);
    row(provider.id, `${provider.bin} on PATH`, true, bin.prefixArgs[0] ?? bin.command);
  } catch (err) {
    row(provider.id, `${provider.bin} on PATH`, false, err.message);
    continue;
  }
  const probe = provider.tools.find((t) => t.name === WHOAMI[provider.id]);
  for (const tier of ["read", "write"]) {
    try {
      const out = await probe.run({}, makeContext(provider, { ...probe, tier }, cfg));
      const who = typeof out === "string" ? out : out?.login ?? out?.email ?? out?.Arn ?? out?.name ?? "authenticated";
      row(provider.id, `${tier} credentials`, true, String(who).slice(0, 80));
    } catch (err) {
      row(provider.id, `${tier} credentials`, false, err.message.split("\n")[0].slice(0, 120));
    }
  }
  row(provider.id, "privileged tools", privilegedEnabled(provider.id, cfg) ? null : true, privilegedEnabled(provider.id, cfg) ? "ENABLED" : "disabled (default)");
}

console.table(rows);
process.exitCode = rows.some((r) => r.status === "FAIL") ? 1 : 0;
