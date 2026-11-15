import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { toolsDir } from "./config.ts";

const IS_WINDOWS = process.platform === "win32";
const SHIM_EXTENSIONS = [".cmd", ".bat", ".ps1"];

export interface ResolvedBinary {
  command: string;
  prefixArgs: string[];
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
  input?: string | undefined;
  cwd?: string | undefined;
}

const resolved = new Map<string, ResolvedBinary>();

function candidates(name: string): string[] {
  if (!IS_WINDOWS) return [name];
  const exts = (process.env.PATHEXT || ".EXE;.CMD;.BAT").toLowerCase().split(";").filter(Boolean);
  return [...exts.map((e) => name + e), `${name}.ps1`];
}

/** Locate a package-manager shim's JS entry point so it can run under node without a shell. */
function shimTarget(shimPath: string): string | null {
  const text = readFileSync(shimPath, "utf8");
  // pnpm and npm shims launch `<shim dir>/<path>.js`; NODE_PATH lines also mention node_modules.
  const anchored = text.match(/(?:%~dp0|%dp0%|\$basedir)[\\/]([^"'\s;%$]+?\.[cm]?js)\b/);
  const loose = text.match(/node_modules[\\/][^"'\s$;]+?\.[cm]?js/);
  for (const rel of [anchored?.[1], loose?.[0]]) {
    if (!rel) continue;
    const target = resolve(dirname(shimPath), rel);
    if (existsSync(target)) return target;
  }
  return null;
}

/** `existsSync` follows links, and Windows app execution aliases (winget.exe) can't be followed. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function findIn(dirs: string[], name: string): ResolvedBinary | undefined {
  for (const dir of dirs) {
    for (const file of candidates(name)) {
      const full = join(dir, file);
      if (!present(full)) continue;
      const lower = full.toLowerCase();
      if (SHIM_EXTENSIONS.some((e) => lower.endsWith(e))) {
        const target = shimTarget(full);
        if (target) return { command: process.execPath, prefixArgs: [target] };
        continue;
      }
      return { command: full, prefixArgs: [] };
    }
  }
  return undefined;
}

const ENVIRONMENT_KEYS = [
  "HKCU\\Environment",
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
];

/** The user and machine PATH as stored now, which includes installs made after this process started. */
function registryPath(): string[] {
  const dirs: string[] = [];
  for (const key of ENVIRONMENT_KEYS) {
    try {
      const reg = join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
      const out = execFileSync(reg, ["query", key, "/v", "Path"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const value = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(out)?.[1] ?? "";
      const expanded = value.replace(/%([^%]+)%/g, (m, v: string) => process.env[v] ?? m);
      dirs.push(...expanded.split(";").filter(Boolean));
    } catch {
      // Key or value missing.
    }
  }
  return dirs;
}

/** Program Files folders of Windows installers that don't add their binaries to PATH. */
const WINDOWS_INSTALL_DIRS: Record<string, string[]> = { dot: ["Graphviz\\bin"] };

function windowsInstallDirs(name: string): string[] {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(
    (r): r is string => Boolean(r),
  );
  return (WINDOWS_INSTALL_DIRS[name] ?? []).flatMap((dir) => roots.map((root) => join(root, dir)));
}

/**
 * Resolve a binary from the suite's tools directory, then PATH, then on Windows the PATH stored in
 * the registry and the install folders of installers that skip PATH. Commands never go through a
 * shell, so .cmd/.ps1 shims are unwrapped into `node <entry.js>`.
 */
export function resolveBinary(name: string): ResolvedBinary {
  const cached = resolved.get(name);
  if (cached) return cached;
  const searched = [
    join(toolsDir(), "node_modules", ".bin"),
    ...(process.env.PATH || "").split(delimiter).filter(Boolean),
  ];
  const result =
    findIn(searched, name) ??
    (IS_WINDOWS
      ? findIn(
          [...registryPath().filter((d) => !searched.includes(d)), ...windowsInstallDirs(name)],
          name,
        )
      : undefined);
  if (result) {
    resolved.set(name, result);
    return result;
  }
  throw new Error(`Required CLI "${name}" was not found. Run \`ops setup\` to install it.`);
}

/** Run a CLI with an argv array (no shell interpolation). Never rejects for non-zero exit codes. */
export function runCommand(
  bin: string,
  args: string[],
  { env = {}, timeoutMs = 120000, input, cwd }: RunOptions = {},
): Promise<CommandResult> {
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
    child.stdout.on("data", (d: Buffer) => {
      stdout += d;
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d;
    });
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

export function tryParseJson(text: unknown): unknown {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed || !/^[[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
