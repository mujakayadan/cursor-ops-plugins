#!/usr/bin/env node
import { readFileSync } from "node:fs";

const EXACT = new Set(["copier.yml", "scripts/test-templates.ts", "scripts/template-ci-scope.ts"]);

/** A pull request runs the template jobs when it touches the scaffold or this check. */
export function templateCiShouldRun(files: readonly string[]): boolean {
  for (const file of files) {
    const name = file.trim().replaceAll("\\", "/");
    if (name.startsWith("templates/") || EXACT.has(name)) return true;
  }
  return false;
}

const invoked = process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/template-ci-scope.ts");
if (invoked) {
  const files = readFileSync(0, "utf8").split(/\r?\n/);
  process.stdout.write(templateCiShouldRun(files) ? "true\n" : "false\n");
}
