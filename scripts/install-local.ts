#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  type Stats,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { listPlugins, PLUGINS_DIR, REPO_ROOT } from "./lib.ts";

const uninstall = process.argv.includes("--uninstall");
const localDir = join(process.env.CURSOR_HOME || join(homedir(), ".cursor"), "plugins", "local");
const opsHome = process.env.OPS_HOME || join(homedir(), ".ops");

mkdirSync(localDir, { recursive: true });

for (const plugin of listPlugins()) {
  const link = join(localDir, plugin);
  const target = join(PLUGINS_DIR, plugin);
  let existing: Stats | undefined;
  try {
    existing = lstatSync(link);
  } catch {}

  if (existing) {
    if (!existing.isSymbolicLink()) {
      console.warn(`skip ${plugin}: ${link} exists and is not a link (remove it manually)`);
      continue;
    }
    const current = resolve(localDir, readlinkSync(link));
    if (!uninstall && current.toLowerCase() === resolve(target).toLowerCase()) {
      console.log(`ok    ${plugin} (already linked)`);
      continue;
    }
    rmSync(link, { recursive: false, force: true });
  }
  if (uninstall) {
    console.log(`unlinked ${plugin}`);
    continue;
  }
  // Junctions need no admin rights on Windows; plain dir symlinks elsewhere.
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  console.log(`link  ${plugin} -> ${target}`);
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
  console.log("\nReload Cursor (Developer: Reload Window) to pick up the plugins.");
}
