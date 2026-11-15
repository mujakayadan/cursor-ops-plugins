#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  cursorHome,
  LOADER_SCRIPT,
  loaderCommand,
  readUserHooks,
  SERVE_TOKEN_ENV,
  serveTokenPath,
  userHooksPath,
} from "../packages/core/suite.ts";
import { PLUGINS_DIR, REPO_ROOT } from "./lib.ts";
import { stopServer } from "./serve-client.ts";

const uninstall = process.argv.includes("--uninstall");
const opsHome = process.env.OPS_HOME || join(homedir(), ".ops");
const command = `node "${join(REPO_ROOT, "scripts", LOADER_SCRIPT).replaceAll("\\", "/")}"`;

const hooks = readUserHooks();
const others = (hooks.hooks.workspaceOpen ?? []).filter((h) => !h.command.includes(LOADER_SCRIPT));
const before = loaderCommand(hooks);
hooks.hooks.workspaceOpen = uninstall ? others : [...others, { command, timeout: 10 }];
if (hooks.hooks.workspaceOpen.length === 0) delete hooks.hooks.workspaceOpen;
mkdirSync(cursorHome(), { recursive: true });
writeFileSync(userHooksPath(), `${JSON.stringify(hooks, null, 2)}\n`);
if (uninstall) console.log(`removed the suite loader from ${userHooksPath()}`);
else
  console.log(`${before === command ? "ok  " : "set "} workspaceOpen loader in ${userHooksPath()}`);

// Cursor skips links in plugins/local that point outside it, and a followed link would load a
// plugin twice next to the loader, so the suite keeps none there.
const localDir = join(cursorHome(), "plugins", "local");
if (existsSync(localDir)) {
  const suiteRoot = resolve(PLUGINS_DIR).toLowerCase();
  for (const name of readdirSync(localDir)) {
    const link = join(localDir, name);
    if (!lstatSync(link).isSymbolicLink()) continue;
    if (!resolve(localDir, readlinkSync(link)).toLowerCase().startsWith(suiteRoot)) continue;
    rmSync(link, { recursive: false, force: true });
    console.log(`removed link ${link}`);
  }
}

const binDir = join(opsHome, "bin");
const opsScript = join(REPO_ROOT, "scripts", "ops.ts");
const launchers: Record<string, string> = {
  "ops.cmd": `@echo off\r\nnode "${opsScript}" %*\r\n`,
  ops: `#!/bin/sh\nexec node "${opsScript.replaceAll("\\", "/")}" "$@"\n`,
};
if (uninstall) {
  for (const name of Object.keys(launchers)) rmSync(join(binDir, name), { force: true });
} else {
  mkdirSync(binDir, { recursive: true });
  for (const [name, content] of Object.entries(launchers)) {
    writeFileSync(join(binDir, name), content, { mode: 0o755 });
  }
}
console.log(`${uninstall ? "removed" : "wrote  "} the ops command in ${binDir}`);

// The read server's bearer token: a random local secret, never a provider credential.
const tokenFile = serveTokenPath();
if (uninstall) {
  await stopServer();
  rmSync(tokenFile, { force: true });
} else if (!existsSync(tokenFile)) {
  mkdirSync(opsHome, { recursive: true });
  writeFileSync(tokenFile, randomBytes(32).toString("base64url"), { mode: 0o600 });
  console.log(`created the read server token in ${tokenFile}`);
}
const token = uninstall ? "" : readFileSync(tokenFile, "utf8").trim();

const manageUserEnv = !process.argv.includes("--no-user-env");
if (manageUserEnv && process.platform === "win32") {
  // Edits the raw PATH value so %VAR% entries survive; SetEnvironmentVariable broadcasts the change.
  // The token travels in the child's environment, not on its command line.
  const script = `
$dir = '${binDir.replaceAll("'", "''")}'
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$parts = @($raw -split ';' | Where-Object { $_ -and $_ -ne $dir })
if (${uninstall ? "$false" : "$true"}) { $parts += $dir }
$next = $parts -join ';'
if ($next -ne $raw) {
  $key.SetValue('Path', $next, [Microsoft.Win32.RegistryValueKind]::ExpandString)
  'path'
}
$token = $env:OPS_NEW_TOKEN
if ([Environment]::GetEnvironmentVariable('${SERVE_TOKEN_ENV}', 'User') -ne $token) {
  [Environment]::SetEnvironmentVariable('${SERVE_TOKEN_ENV}', $(if ($token) { $token } else { $null }), 'User')
  'token'
} else {
  [Environment]::SetEnvironmentVariable('OPS_ENV_REFRESH', $null, 'User')
}`;
  const changed = execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", env: { ...process.env, OPS_NEW_TOKEN: token } },
  )
    .split(/\r?\n/)
    .map((l) => l.trim());
  if (changed.includes("path")) {
    console.log(
      `${uninstall ? "removed" : "added  "} ${binDir} ${uninstall ? "from" : "to"} your user PATH (new terminals see it)`,
    );
  }
  if (changed.includes("token")) {
    console.log(
      uninstall
        ? `removed ${SERVE_TOKEN_ENV} from your user environment`
        : `set     ${SERVE_TOKEN_ENV} in your user environment. Cursor reads it at startup: quit and reopen Cursor once (a window reload is not enough).`,
    );
  }
} else if (manageUserEnv && !uninstall) {
  console.log("add to your shell profile, then restart Cursor from a shell that has it:");
  if (!(process.env.PATH ?? "").split(":").includes(binDir)) {
    console.log(`  export PATH="${binDir}:$PATH"`);
  }
  console.log(`  export ${SERVE_TOKEN_ENV}="$(cat ${tokenFile})"`);
}

if (!uninstall) {
  mkdirSync(opsHome, { recursive: true });
  const cfg = join(opsHome, "config.json");
  if (!existsSync(cfg)) {
    copyFileSync(join(REPO_ROOT, "config.example.json"), cfg);
    console.log(
      `\ncreated ${cfg} from config.example.json — review credentials/scope before using write tools`,
    );
  }
  console.log("\nReload Cursor (Developer: Reload Window) to load the suite in every workspace.");
}
