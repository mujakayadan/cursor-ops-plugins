#!/usr/bin/env node
/**
 * Store INHOUSE_ACCESS_TOKEN in the user environment after a browser sign-in.
 * Run from the suite checkout: `node plugins/ops-inhouse/login.ts`
 * Do not use setx — JWTs exceed its length limit.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

const SITE = "https://platform.inhouse.app";
const TOKEN_NAME = "INHOUSE_ACCESS_TOKEN";
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function openBrowser(url: string): void {
  const os = platform();
  if (os === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
  else if (os === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" });
  else spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
}

/** Single-quote for POSIX shell so `source` cannot expand the JWT. */
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function parseToken(raw: string): string {
  let token = raw.trim();
  if (token.toLowerCase().startsWith("bearer ")) {
    token = token.slice(7).trim();
  }
  if (!JWT_RE.test(token)) {
    throw new Error("Token must look like a JWT (three base64url segments). Nothing stored.");
  }
  return token;
}

function setUserEnv(name: string, value: string): void {
  const os = platform();
  if (os === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "[Environment]::SetEnvironmentVariable($env:__OPS_INHOUSE_NAME, $env:__OPS_INHOUSE_VALUE, 'User')",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, __OPS_INHOUSE_NAME: name, __OPS_INHOUSE_VALUE: value },
      },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `powershell exited ${result.status}`);
    }
    return;
  }
  const dir = join(homedir(), ".ops");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "inhouse.env");
  writeFileSync(file, `export ${name}=${shellSingleQuote(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(
    "Wrote ~/.ops/inhouse.env (mode 600). Add `source ~/.ops/inhouse.env` to your shell profile, then restart Cursor.",
  );
}

/** Read a secret without echoing when stdin is a TTY. */
async function readSecret(prompt: string): Promise<string> {
  if (input.isTTY && typeof input.setRawMode === "function") {
    output.write(prompt);
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      input.setRawMode(true);
      input.resume();
      input.setEncoding("utf8");
      const onData = (chunk: string): void => {
        for (const char of chunk) {
          if (char === "\n" || char === "\r" || char === "\u0004") {
            cleanup();
            output.write("\n");
            resolve(value);
            return;
          }
          if (char === "\u0003") {
            cleanup();
            reject(new Error("cancelled"));
            return;
          }
          if (char === "\u007f" || char === "\b") {
            value = value.slice(0, -1);
            continue;
          }
          if (char >= " ") value += char;
        }
      };
      const cleanup = (): void => {
        input.off("data", onData);
        input.setRawMode(false);
        input.pause();
      };
      input.on("data", onData);
    });
  }
  const rl = createInterface({ input, output: undefined, terminal: false });
  try {
    output.write(prompt);
    return await rl.question("");
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  console.log(`Opening ${SITE} …`);
  openBrowser(SITE);
  console.log(`
Sign in if needed. Then in DevTools → Application → Local Storage → this origin,
copy the value of accessToken2 (the JWT only; no "Bearer " prefix).

Paste it below (input is hidden). It is stored as the user environment variable
${TOKEN_NAME} via the OS API (not setx — that truncates long JWTs). Never paste
it into Cursor chat.
`);
  const raw = await readSecret(`${TOKEN_NAME}: `);
  const token = parseToken(raw);
  setUserEnv(TOKEN_NAME, token);
  if (platform() === "win32") {
    console.log(
      `Stored ${TOKEN_NAME} in your Windows user environment. Quit Cursor completely and reopen it, then call inhouse_status.`,
    );
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
