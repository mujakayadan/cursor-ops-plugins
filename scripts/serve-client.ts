import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { opsHome } from "../packages/core/config.ts";
import {
  gitHead,
  SERVE_ORIGIN,
  type ServeHealth,
  serveHealth,
  serveToken,
} from "../packages/core/suite.ts";
import { REPO_ROOT } from "./lib.ts";

const MAX_LOG = 1_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const serveLogPath = () => join(opsHome(), "serve.log");

async function waitFor(up: boolean, timeoutMs: number): Promise<ServeHealth | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await serveHealth(300);
    if (Boolean(health) === up) return health;
    await sleep(150);
  }
  return undefined;
}

export async function stopServer(timeoutMs = 3000): Promise<boolean> {
  if (!(await serveHealth())) return true;
  const token = serveToken();
  if (!token) return false;
  await fetch(`${SERVE_ORIGIN}/shutdown`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(1000),
  }).catch(() => undefined);
  await waitFor(false, timeoutMs);
  return !(await serveHealth());
}

/** Start the shared read server in the background, replacing one that serves another commit. */
export async function ensureServer(timeoutMs = 6000): Promise<ServeHealth | undefined> {
  const { head } = gitHead(REPO_ROOT);
  const health = await serveHealth();
  if (health && health.head === head) return health;
  if (health && !(await stopServer())) return undefined;
  mkdirSync(opsHome(), { recursive: true });
  const log = serveLogPath();
  if (existsSync(log) && statSync(log).size > MAX_LOG) truncateSync(log);
  const fd = openSync(log, "a");
  spawn(process.execPath, [join(REPO_ROOT, "scripts", "serve.ts")], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", fd, fd],
  }).unref();
  closeSync(fd);
  return waitFor(true, timeoutMs);
}
