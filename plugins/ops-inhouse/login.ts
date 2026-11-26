#!/usr/bin/env node
/**
 * Store INHOUSE_ACCESS_TOKEN in the user environment after a browser sign-in.
 * Run from the suite checkout: `node plugins/ops-inhouse/login.ts`
 * Do not use setx — JWTs exceed its length limit.
 */
import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

const SITE = "https://platform.inhouse.app";

function openBrowser(url: string): void {
  const os = platform();
  if (os === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
  else if (os === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" });
  else spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
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
  const result = spawnSync(
    "bash",
    [
      "-lc",
      'mkdir -p "$HOME/.ops" && umask 077 && printf "export %s=%s\\n" "$__OPS_INHOUSE_NAME" "$__OPS_INHOUSE_VALUE" > "$HOME/.ops/inhouse.env"',
    ],
    {
      encoding: "utf8",
      env: { ...process.env, __OPS_INHOUSE_NAME: name, __OPS_INHOUSE_VALUE: value },
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || "failed to write ~/.ops/inhouse.env");
  }
  console.log(
    "Wrote ~/.ops/inhouse.env (mode 600). Add `source ~/.ops/inhouse.env` to your shell profile, then restart Cursor.",
  );
}

async function main(): Promise<void> {
  console.log(`Opening ${SITE} …`);
  openBrowser(SITE);
  console.log(`
Sign in if needed. Then in DevTools → Application → Local Storage → this origin,
copy the value of accessToken2 (the JWT only; no "Bearer " prefix).

Paste it below. It is stored as the user environment variable INHOUSE_ACCESS_TOKEN
via the OS API (not setx — that truncates long JWTs). Never paste it into Cursor chat.
`);
  const rl = createInterface({ input, output });
  const token = (await rl.question("INHOUSE_ACCESS_TOKEN: ")).trim();
  rl.close();
  if (token.length < 20) {
    console.error("Token looks too short; nothing stored.");
    process.exit(1);
  }
  setUserEnv("INHOUSE_ACCESS_TOKEN", token);
  if (platform() === "win32") {
    console.log(
      "Stored INHOUSE_ACCESS_TOKEN in your Windows user environment. Quit Cursor completely and reopen it, then call inhouse_status.",
    );
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
