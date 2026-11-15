#!/usr/bin/env node
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
