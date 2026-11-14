import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TIERS = ["read", "write", "privileged"];

export function opsHome() {
  return process.env.OPS_HOME || join(homedir(), ".ops");
}

export function configPath() {
  return process.env.OPS_CONFIG || join(opsHome(), "config.json");
}

const DEFAULTS = {
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
};

const PROVIDER_DEFAULTS = {
  allowPrivileged: false,
  credentials: {
    read: { env: {}, args: [] },
    write: { env: {}, args: [] },
  },
  scope: {},
};

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

let cached;

export function loadConfig({ reload = false } = {}) {
  if (cached && !reload) return cached;
  let user = {};
  const path = configPath();
  if (existsSync(path)) {
    try {
      user = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(`Invalid ops config at ${path}: ${err.message}`);
    }
  }
  cached = deepMerge(DEFAULTS, user);
  return cached;
}

export function providerConfig(providerId, cfg = loadConfig()) {
  return deepMerge(PROVIDER_DEFAULTS, cfg.providers?.[providerId] ?? {});
}

export function privilegedEnabled(providerId, cfg = loadConfig()) {
  if (process.env.OPS_ALLOW_PRIVILEGED === "1") return true;
  return providerConfig(providerId, cfg).allowPrivileged === true;
}

/** Credentials for a tier. Privileged tools run with the write credentials. */
export function tierCredentials(providerId, tier, cfg = loadConfig()) {
  const creds = providerConfig(providerId, cfg).credentials;
  const key = tier === "read" ? "read" : "write";
  return { env: creds[key]?.env ?? {}, args: creds[key]?.args ?? [] };
}
