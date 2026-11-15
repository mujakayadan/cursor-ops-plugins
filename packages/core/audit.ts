import { appendFileSync, mkdirSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { loadConfig, opsHome } from "./config.ts";
import { redactDeep, truncate } from "./redact.ts";
import type { Config } from "./types.ts";

export function auditDir(cfg: Config): string {
  return process.env.OPS_AUDIT_DIR || cfg.audit.dir || join(opsHome(), "audit");
}

function clip(value: unknown, max: number): unknown {
  if (typeof value === "string") return truncate(value, max);
  if (Array.isArray(value)) return value.map((v) => clip(v, max));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v, max)]));
  }
  return value;
}

interface Identity {
  user: string;
  host: string;
  cursorUser: string | undefined;
}

let identity: Identity | undefined;
function who(): Identity {
  if (!identity) {
    let user = "unknown";
    try {
      user = userInfo().username;
    } catch {}
    identity = { user, host: hostname(), cursorUser: process.env.CURSOR_USER_EMAIL || undefined };
  }
  return identity;
}

/** Append a redacted JSONL audit record. Never throws: auditing must not break the agent. */
export function audit(event: Record<string, unknown>): void {
  try {
    const cfg = loadConfig();
    if (!cfg.audit.enabled) return;
    const dir = auditDir(cfg);
    mkdirSync(dir, { recursive: true });
    const ts = new Date();
    const record = clip(
      redactDeep({ ts: ts.toISOString(), ...who(), ...event }),
      cfg.audit.maxFieldChars,
    );
    appendFileSync(
      join(dir, `${ts.toISOString().slice(0, 10)}.jsonl`),
      `${JSON.stringify(record)}\n`,
    );
  } catch (err) {
    process.stderr.write(`[ops-audit] failed to write audit record: ${(err as Error).message}\n`);
  }
}
