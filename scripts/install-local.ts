#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
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
  userHooksPath,
} from "../packages/core/suite.ts";
import { PLUGINS_DIR, REPO_ROOT } from "./lib.ts";

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

const managePath = !process.argv.includes("--no-path");
if (managePath && process.platform === "win32") {
  // Edits the raw registry value so %VAR% entries survive; the empty variable write broadcasts the change.
  const script = `
$dir = '${binDir.replaceAll("'", "''")}'
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$parts = @($raw -split ';' | Where-Object { $_ -and $_ -ne $dir })
if (${uninstall ? "$false" : "$true"}) { $parts += $dir }
$next = $parts -join ';'
if ($next -ne $raw) {
  $key.SetValue('Path', $next, [Microsoft.Win32.RegistryValueKind]::ExpandString)
  [Environment]::SetEnvironmentVariable('OPS_PATH_REFRESH', $null, 'User')
  'changed'
}`;
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  }).trim();
  if (out === "changed") {
    console.log(
      `${uninstall ? "removed" : "added  "} ${binDir} ${uninstall ? "from" : "to"} your user PATH (new terminals see it)`,
    );
  }
} else if (managePath && !uninstall && !(process.env.PATH ?? "").split(":").includes(binDir)) {
  console.log(`add to your shell profile: export PATH="${binDir}:$PATH"`);
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
