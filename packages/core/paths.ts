import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { str, ToolError } from "./schema-helpers.ts";

const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

/** Absolute Windows or POSIX path without shell metacharacters. */
export const absPath = (description: string) =>
  str(description, { pattern: '^([A-Za-z]:[\\\\/]|/)[^\\u0000<>|"?*]{0,400}$' });

/**
 * Normalize an absolute path, reject `..` segments and enforce
 * `providers.<id>.scope.allowedRoots` when it is configured.
 */
export function checkPath(
  raw: string,
  allowedRoots: string[] | undefined,
  providerId: string,
): string {
  const path = normalize(raw);
  if (!isAbsolute(path) || raw.split(/[\\/]/).includes("..")) {
    throw new ToolError("path must be absolute and must not contain '..'");
  }
  const roots = allowedRoots ?? [];
  const within = (root: string) => {
    const rel = relative(resolve(root), path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  if (roots.length && !roots.some(within)) {
    throw new ToolError(
      `${path} is outside providers.${providerId}.scope.allowedRoots (${roots.join(", ")})`,
    );
  }
  return path;
}

/** Fresh directory for throwaway renders; directories older than a day are pruned. */
export function previewDir(providerId: string): string {
  const base = join(tmpdir(), `ops-${providerId}-preview`);
  mkdirSync(base, { recursive: true });
  const now = Date.now();
  for (const name of readdirSync(base)) {
    const path = join(base, name);
    try {
      if (now - statSync(path).mtimeMs > PREVIEW_TTL_MS)
        rmSync(path, { recursive: true, force: true });
    } catch {
      // Removed concurrently by another server.
    }
  }
  return mkdtempSync(join(base, "r-"));
}
