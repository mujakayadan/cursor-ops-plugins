#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveBinary } from "../packages/core/cli.ts";
import { configPath, loadConfig, privilegedEnabled } from "../packages/core/config.ts";
import { makeContext } from "../packages/core/mcp-server.ts";
import {
  gitHead,
  loaderCommand,
  SERVE_ORIGIN,
  SERVE_TOKEN_ENV,
  serveHealth,
  serveTokenPath,
  suitePlugins,
  userHooksPath,
} from "../packages/core/suite.ts";
import type { Config, Provider, ServerTier } from "../packages/core/types.ts";
import { PLUGINS_DIR, providerPlugins, REPO_ROOT } from "./lib.ts";

type Status = "OK" | "WARN" | "FAIL";

const WHOAMI: Partial<Record<string, string>> = {
  github: "github_whoami",
  digitalocean: "digitalocean_account_get",
  vercel: "vercel_whoami",
  aws: "aws_whoami",
  msgraph: "msgraph_whoami",
};
/** Local authoring toolchains: no credentials, one status call that reports readiness. */
const TOOLCHAIN: Partial<Record<string, string>> = {
  mermaid: "mermaid_status",
  latex: "latex_status",
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

try {
  const loader = loaderCommand();
  const current = loader?.includes(join(REPO_ROOT, "scripts").replaceAll("\\", "/")) ?? false;
  row(
    "install",
    "workspaceOpen loader",
    loader ? current || null : false,
    loader
      ? current
        ? loader
        : `points at another checkout: ${loader}`
      : "not registered — run `pnpm run install-local`",
  );
} catch (err) {
  row("install", userHooksPath(), false, message(err));
}

const fileToken = existsSync(serveTokenPath())
  ? readFileSync(serveTokenPath(), "utf8").trim()
  : undefined;
row(
  "install",
  `${SERVE_TOKEN_ENV} in this environment`,
  !fileToken ? false : process.env[SERVE_TOKEN_ENV] === fileToken || null,
  !fileToken
    ? "no token — run `ops install`"
    : process.env[SERVE_TOKEN_ENV] === fileToken
      ? "matches the token file"
      : "missing or different — open a new terminal; quit and reopen Cursor",
);
const health = await serveHealth();
const head = gitHead(REPO_ROOT).head;
row(
  "install",
  `read server ${SERVE_ORIGIN}`,
  health ? health.head === head || null : null,
  health
    ? `pid ${health.pid}${health.head === head ? "" : ", older commit (`ops serve --restart`)"}`
    : "down — opening a workspace starts it, or `ops serve --background`",
);

let cfg: Config | undefined;
try {
  cfg = loadConfig();
  const found = existsSync(configPath());
  row("config", configPath(), found || null, found ? "loaded" : "missing — using defaults");
} catch (err) {
  row("config", configPath(), false, message(err));
}

for (const p of suitePlugins(PLUGINS_DIR, cfg?.suite.disabledPlugins ?? [])) {
  row("plugins", p.name, p.enabled || null, p.enabled ? p.version : "disabled in config");
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
  const status = provider.tools.find((t) => t.name === TOOLCHAIN[provider.id]);
  if (status) {
    try {
      const out = (await status.run({}, makeContext(provider, status, cfg))) as Record<
        string,
        unknown
      >;
      const ready = out.ready ?? Object.values(out.engines ?? {}).some(Boolean);
      const detail = String(out.distribution ?? out.mmdc ?? "");
      row(provider.id, "toolchain", ready === true || null, detail.slice(0, 120));
    } catch (err) {
      row(provider.id, "toolchain", false, message(err).slice(0, 120));
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
