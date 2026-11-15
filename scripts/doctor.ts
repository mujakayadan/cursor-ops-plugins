#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveBinary } from "../packages/core/cli.ts";
import {
  configPath,
  loadConfig,
  privilegedEnabled,
  tierCredentials,
} from "../packages/core/config.ts";
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

const USAGE = `Usage: ops doctor [--json]

Checks the runtime, the suite install, the read server, the config, and per provider its CLIs,
toolchain and sign-in for each credential tier. Every check that isn't OK comes with a fix.
  --json  machine-readable output: { ok, rows: [{ area, check, status, detail, fix? }] }`;

type Status = "OK" | "WARN" | "FAIL";
interface Row {
  area: string;
  check: string;
  status: Status;
  detail: string;
  fix?: string;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const unknown = args.filter((a) => a !== "--json");
if (unknown.length) {
  console.error(`Unknown option ${unknown.join(", ")}\n\n${USAGE}`);
  process.exit(64);
}

const TIERS: ServerTier[] = ["read", "write"];
/** Sign-in and toolchain probes; a CLI waiting for input fails the check instead of stalling. */
const PROBE_TIMEOUT_MS = 20_000;
const rows: Row[] = [];
function toRow(area: string, check: string, ok: boolean | null, detail = "", fix?: string): Row {
  const status: Status = ok === null ? "WARN" : ok ? "OK" : "FAIL";
  return { area, check, status, detail, ...(status !== "OK" && fix ? { fix } : {}) };
}
function row(...args: Parameters<typeof toRow>): void {
  rows.push(toRow(...args));
}
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const firstLine = (err: unknown) => (message(err).split("\n")[0] ?? "").slice(0, 120);

const [major = 0] = process.versions.node.split(".").map(Number);
row(
  "runtime",
  "node >= 24",
  major >= 24,
  process.versions.node,
  "winget install --id OpenJS.NodeJS.LTS --exact (Windows) or brew install node",
);
row(
  "runtime",
  "TypeScript type stripping",
  process.features.typescript !== false,
  String(process.features.typescript),
  "use a Node 24+ build without --no-experimental-strip-types",
);

try {
  const loader = loaderCommand();
  const current = loader?.includes(join(REPO_ROOT, "scripts").replaceAll("\\", "/")) ?? false;
  row(
    "install",
    "workspaceOpen loader",
    loader ? current || null : false,
    loader ? (current ? loader : `points at another checkout: ${loader}`) : "not registered",
    "node scripts/ops.ts install in this checkout, then Developer: Reload Window",
  );
} catch (err) {
  row("install", userHooksPath(), false, message(err), `fix the JSON in ${userHooksPath()}`);
}

const fileToken = existsSync(serveTokenPath())
  ? readFileSync(serveTokenPath(), "utf8").trim()
  : undefined;
const tokenMatches = fileToken !== undefined && process.env[SERVE_TOKEN_ENV] === fileToken;
row(
  "install",
  `${SERVE_TOKEN_ENV} in this environment`,
  !fileToken ? false : tokenMatches || null,
  !fileToken ? "no token file" : tokenMatches ? "matches the token file" : "missing or different",
  !fileToken
    ? "ops install"
    : "quit and reopen Cursor so it inherits the variable (terminals: open a new one)",
);
const health = await serveHealth();
const head = gitHead(REPO_ROOT).head;
row(
  "install",
  `read server ${SERVE_ORIGIN}`,
  health ? health.head === head || null : null,
  health ? `pid ${health.pid}${health.head === head ? "" : ", older commit"}` : "down",
  health ? "ops serve --restart" : "ops serve --background (opening a workspace also starts it)",
);

let cfg: Config | undefined;
try {
  cfg = loadConfig();
  const found = existsSync(configPath());
  row(
    "config",
    configPath(),
    found || null,
    found ? "loaded" : "missing, using defaults",
    "ops install",
  );
} catch (err) {
  row("config", configPath(), false, message(err), `fix the JSON in ${configPath()}`);
}

for (const p of suitePlugins(PLUGINS_DIR, cfg?.suite.disabledPlugins ?? [])) {
  row(
    "plugins",
    p.name,
    p.enabled || null,
    p.enabled ? p.version : "disabled in config",
    "enable it with control_plugin_set if you want it",
  );
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

function signInFix(provider: Provider, tier: ServerTier): string {
  const configured = cfg?.providers[provider.id]?.credentials?.[tier];
  if (configured && (configured.args.length || Object.keys(configured.env).length)) {
    return `sign in the identity set in providers.${provider.id}.credentials.${tier} (ops-onboarding skill)`;
  }
  const signIn = provider.onboarding?.signIn;
  const skill = provider.onboarding?.skill ? `; see the ${provider.onboarding.skill} skill` : "";
  if (!signIn) return `sign in to ${provider.displayName}${skill}`;
  return `in your terminal: ${signIn.command}${signIn.note ? ` — ${signIn.note}` : ""}${skill}`;
}

const probeCfg: Config | undefined = cfg && {
  ...cfg,
  execution: { ...cfg.execution, timeoutMs: PROBE_TIMEOUT_MS },
};

async function checkProvider(plugin: string): Promise<Row[]> {
  const module = (await import(pathToFileURL(join(PLUGINS_DIR, plugin, "provider.ts")).href)) as {
    default: Provider;
  };
  const provider = module.default;
  const id = provider.id;
  const installFix = `ops setup ${plugin} --yes`;
  const out: Row[] = [];
  try {
    const bin = resolveBinary(provider.bin);
    out.push(toRow(id, `${provider.bin} on PATH`, true, bin.prefixArgs[0] ?? bin.command));
  } catch (err) {
    return [toRow(id, `${provider.bin} on PATH`, false, firstLine(err), installFix)];
  }
  for (const extra of (provider.requires ?? []).filter((b) => b !== provider.bin)) {
    try {
      resolveBinary(extra);
      out.push(toRow(id, `${extra} on PATH`, true));
    } catch (err) {
      out.push(toRow(id, `${extra} on PATH`, false, firstLine(err), installFix));
    }
  }
  const { status: statusTool, whoami } = provider.onboarding ?? {};
  const status = provider.tools.find((t) => t.name === statusTool);
  if (status) {
    const fix = `${installFix} --optional`;
    try {
      const res = (await status.run({}, makeContext(provider, status, probeCfg))) as Record<
        string,
        unknown
      >;
      const ready = res.ready ?? Object.values(res.engines ?? {}).some(Boolean);
      const detail = String(res.distribution ?? res.mmdc ?? "").slice(0, 120);
      out.push(toRow(id, "toolchain", ready === true || null, detail, fix));
    } catch (err) {
      out.push(toRow(id, "toolchain", false, firstLine(err), fix));
    }
  }
  const probe = provider.tools.find((t) => t.name === whoami);
  if (!probe) return out;
  // Tiers with the same credentials share one probe, so a CLI never refreshes one login twice at once.
  const probes = new Map<string, Promise<string>>();
  const tiers = await Promise.all(
    TIERS.map(async (tier) => {
      const key = cfg ? JSON.stringify(tierCredentials(id, tier, cfg)) : tier;
      const identityOf =
        probes.get(key) ??
        (async () => {
          const res = await probe.run({}, makeContext(provider, { ...probe, tier }, probeCfg));
          return identity(res).slice(0, 80);
        })();
      probes.set(key, identityOf);
      try {
        return toRow(id, `${tier} credentials`, true, await identityOf);
      } catch (err) {
        return toRow(id, `${tier} credentials`, false, firstLine(err), signInFix(provider, tier));
      }
    }),
  );
  const privileged = privilegedEnabled(id, cfg);
  return [
    ...out,
    ...tiers,
    toRow(
      id,
      "privileged tools",
      privileged ? null : true,
      privileged ? "ENABLED" : "disabled (default)",
      process.env.OPS_ALLOW_PRIVILEGED === "1"
        ? "unset OPS_ALLOW_PRIVILEGED when you are done"
        : `set providers.${id}.allowPrivileged to false when you are done`,
    ),
  ];
}

rows.push(...(await Promise.all(providerPlugins().map(checkProvider))).flat());

const ok = !rows.some((r) => r.status === "FAIL");
if (args.includes("--json")) {
  console.log(JSON.stringify({ ok, rows }, null, 2));
} else {
  console.table(rows.map(({ fix: _fix, ...r }) => r));
  const fixes = [...new Set(rows.flatMap((r) => (r.fix ? [`${r.status}  ${r.fix}`] : [])))];
  if (fixes.length) console.log(`\nTo fix:\n${fixes.map((f) => `  ${f}`).join("\n")}`);
}
process.exitCode = ok ? 0 : 1;
