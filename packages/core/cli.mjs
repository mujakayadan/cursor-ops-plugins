import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

const IS_WINDOWS = process.platform === "win32";
const SHIM_EXTENSIONS = [".cmd", ".bat", ".ps1"];
const resolved = new Map();

function candidates(name) {
  if (!IS_WINDOWS) return [name];
  const exts = (process.env.PATHEXT || ".EXE;.CMD;.BAT").toLowerCase().split(";").filter(Boolean);
  return [...exts.map((e) => name + e), `${name}.ps1`];
}

/** Locate an npm shim's JS entry point so it can run under node without a shell. */
function shimTarget(shimPath) {
  const text = readFileSync(shimPath, "utf8");
  const match = text.match(/node_modules[\\/][^"'\s$]+?\.[cm]?js/);
  if (!match) return null;
  const target = resolve(dirname(shimPath), match[0]);
  return existsSync(target) ? target : null;
}

/**
 * Resolve a binary on PATH to { command, prefixArgs }. Commands never go through a
 * shell, so Windows .cmd/.ps1 npm shims are unwrapped into `node <entry.js>`.
 */
export function resolveBinary(name) {
  if (resolved.has(name)) return resolved.get(name);
  for (const dir of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const file of candidates(name)) {
      const full = join(dir, file);
      if (!existsSync(full)) continue;
      const lower = full.toLowerCase();
      if (SHIM_EXTENSIONS.some((e) => lower.endsWith(e))) {
        const target = shimTarget(full);
        if (!target) continue;
        const result = { command: process.execPath, prefixArgs: [target] };
        resolved.set(name, result);
        return result;
      }
      const result = { command: full, prefixArgs: [] };
      resolved.set(name, result);
      return result;
    }
  }
  throw new Error(`Required CLI "${name}" was not found on PATH. Run \`pnpm run doctor\` in the ops plugins repo.`);
}

/**
 * Run a CLI with an argv array (no shell interpolation). Resolves with
 * { code, stdout, stderr, timedOut } and never rejects for non-zero exit codes.
 */
export function runCommand(bin, args, { env = {}, timeoutMs = 120000, input, cwd } = {}) {
  const { command, prefixArgs } = resolveBinary(bin);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...prefixArgs, ...args], {
      env: { ...process.env, ...env },
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

export function tryParseJson(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed || !/^[[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
