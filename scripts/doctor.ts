#!/usr/bin/env node
import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveBinary } from "../packages/core/cli.ts";
import { configPath, loadConfig, privilegedEnabled } from "../packages/core/config.ts";
import { makeContext } from "../packages/core/mcp-server.ts";
import type { Config, Provider, ServerTier } from "../packages/core/types.ts";
import { listPlugins, PLUGINS_DIR, providerPlugins } from "./lib.ts";

type Status = "OK" | "WARN" | "FAIL";

const WHOAMI: Partial<Record<string, string>> = {
  github: "github_whoami",
  digitalocean: "digitalocean_account_get",
  vercel: "vercel_whoami",
  aws: "aws_whoami",
  msgraph: "msgraph_whoami",
};
const TIERS: ServerTier[] = ["read", "write"];

const rows: { area: string; check: string; status: Status; detail: string }[] = [];
const row = (area: string, check: string, ok: boolean | null, detail = "") =>
  rows.push({ area, check, status: ok === null ? "WARN" : ok ? "OK" : "FAIL", detail });
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const [major = 0] = process.versions.node.split(".").map(Number);
row("runtime", "node >= 24", major >= 24, process.versions.node);
row(
  "runtime",
  "TypeScript type stripping",
  process.features.typescript !== false,
  String(process.features.typescript),
);

const localDir = join(process.env.CURSOR_HOME || join(homedir(), ".cursor"), "plugins", "local");
for (const p of listPlugins()) {
  const link = join(localDir, p);
  let linked = false;
  try {
    linked =
      lstatSync(link).isSymbolicLink() || existsSync(join(link, ".cursor-plugin", "plugin.json"));
  } catch {}
  row("install", p, linked || null, linked ? link : "not installed — run `pnpm run install-local`");
}

let cfg: Config | undefined;
try {
  cfg = loadConfig();
  const found = existsSync(configPath());
  row("config", configPath(), found || null, found ? "loaded" : "missing — using defaults");
} catch (err) {
  row("config", configPath(), false, message(err));
}

/** Pick a human-readable identity out of a whoami-style response. */
function identity(out: unknown): string {
  if (typeof out === "string") return out;
  if (out && typeof out === "object") {
    const o = out as Record<string, unknown>;
    return String(o.login ?? o.email ?? o.Arn ?? o.name ?? "authenticated");
  }
  return "authenticated";
}

for (const p of providerPlugins()) {
  const module = (await import(pathToFileURL(join(PLUGINS_DIR, p, "provider.ts")).href)) as {
    default: Provider;
  };
  const provider = module.default;
  try {
    const bin = resolveBinary(provider.bin);
    row(provider.id, `${provider.bin} on PATH`, true, bin.prefixArgs[0] ?? bin.command);
  } catch (err) {
    row(provider.id, `${provider.bin} on PATH`, false, message(err));
    continue;
  }
  for (const extra of (provider.requires ?? []).filter((b) => b !== provider.bin)) {
    try {
      resolveBinary(extra);
      row(provider.id, `${extra} on PATH`, true);
    } catch (err) {
      row(provider.id, `${extra} on PATH`, false, message(err));
    }
  }
  const probe = provider.tools.find((t) => t.name === WHOAMI[provider.id]);
  if (!probe) continue;
  for (const tier of TIERS) {
    try {
      const out = await probe.run({}, makeContext(provider, { ...probe, tier }, cfg));
      row(provider.id, `${tier} credentials`, true, identity(out).slice(0, 80));
    } catch (err) {
      row(
        provider.id,
        `${tier} credentials`,
        false,
        (message(err).split("\n")[0] ?? "").slice(0, 120),
      );
    }
  }
  const privileged = privilegedEnabled(provider.id, cfg);
  row(
    provider.id,
    "privileged tools",
    privileged ? null : true,
    privileged ? "ENABLED" : "disabled (default)",
  );
}

console.table(rows);
process.exitCode = rows.some((r) => r.status === "FAIL") ? 1 : 0;
