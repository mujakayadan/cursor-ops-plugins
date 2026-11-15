import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, Credentials, ProviderConfig, Tier } from "./types.ts";

export const TIERS: readonly Tier[] = ["read", "write", "privileged"];

export function opsHome(): string {
  return process.env.OPS_HOME || join(homedir(), ".ops");
}

/** Where `ops setup` installs npm-based CLIs; their binaries resolve before PATH. */
export function toolsDir(): string {
  return join(opsHome(), "tools");
}

export function reviewDir(): string {
  return process.env.OPS_REVIEW_DIR || join(opsHome(), "review");
}

export function configPath(): string {
  return process.env.OPS_CONFIG || join(opsHome(), "config.json");
}

const DEFAULTS: Config = {
  audit: { enabled: true, dir: null, maxFieldChars: 4000 },
  execution: { timeoutMs: 120000, maxOutputChars: 60000 },
  providers: {},
  thirdPartyMcp: {
    read: "allow",
    write: "ask",
    privileged: "ask",
    unknown: "allow",
    trustedServers: ["^cursor-ide-browser$"],
    serverOverrides: {},
    deniedTools: [
      "(^|_)(drop|delete|destroy|purge|wipe|truncate|reset)_(databases?|dbs?|projects?|clusters?|buckets?|instances?|repos?|repositor(y|ies)|schemas?|tables?|collections?|volumes?|organizations?|orgs?|namespaces?)(_|$)",
    ],
  },
  guardrails: { shell: { overrides: {} } },
  prompts: { blockSecrets: true },
  review: {
    enabled: true,
    lenses: { security: true, performance: true, standards: true, docs: true },
    maxRounds: 1,
    minChangedLines: 3,
    maxFiles: 30,
    ignore: [],
  },
  suite: { disabledPlugins: [] },
};

const PROVIDER_DEFAULTS: ProviderConfig = {
  allowPrivileged: false,
  credentials: {
    read: { env: {}, args: [] },
    write: { env: {}, args: [] },
  },
  scope: {},
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Merge `override` into `base`: objects merge recursively, everything else (incl. arrays) replaces. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(override)) return (override === undefined ? base : override) as T;
  const out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(override)) {
    const current = out[k];
    out[k] = isPlainObject(v) && isPlainObject(current) ? deepMerge(current, v) : v;
  }
  return out as T;
}

let cached: Config | undefined;

export function loadConfig({ reload = false }: { reload?: boolean } = {}): Config {
  if (cached && !reload) return cached;
  let user: unknown = {};
  const path = configPath();
  if (existsSync(path)) {
    try {
      user = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      // V8 quotes the surrounding source, which can hold credential env values.
      const reason = (err as Error).message.replace(/, .* is not valid JSON$/s, ": not valid JSON");
      throw new Error(`Invalid ops config at ${path}: ${reason}`);
    }
  }
  cached = deepMerge(DEFAULTS, user);
  return cached;
}

export function providerConfig(providerId: string, cfg: Config = loadConfig()): ProviderConfig {
  return deepMerge(PROVIDER_DEFAULTS, cfg.providers[providerId] ?? {});
}

export function privilegedEnabled(providerId: string, cfg: Config = loadConfig()): boolean {
  if (process.env.OPS_ALLOW_PRIVILEGED === "1") return true;
  return providerConfig(providerId, cfg).allowPrivileged === true;
}

/** Credentials for a tier. Privileged tools run with the write credentials. */
export function tierCredentials(
  providerId: string,
  tier: Tier,
  cfg: Config = loadConfig(),
): Credentials {
  const creds = providerConfig(providerId, cfg).credentials;
  const key = tier === "read" ? "read" : "write";
  return { env: creds[key]?.env ?? {}, args: creds[key]?.args ?? [] };
}
