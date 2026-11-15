#!/usr/bin/env node
// Linked worktrees for concurrent agents: one branch per directory beside the primary checkout.
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BRANCH_TYPES } from "../plugins/ops-core/hooks/guardrails.ts";
import { REPO_ROOT } from "./lib.ts";

const TYPES = BRANCH_TYPES.join("|");
const BRANCH_RE = new RegExp(`^([A-Za-z0-9][A-Za-z0-9-]*)/(?:${TYPES})/[a-z0-9][a-z0-9._-]*$`);

const USAGE = `ops worktree — linked checkouts for concurrent agents

  ops worktree add <user>/<type>/<kebab-name>   create from origin/dev
  ops worktree list                             show linked worktrees
  ops worktree remove <user>/<type>/<kebab-name>
                                                remove the linked checkout for that branch`;

export function assertWorkBranch(branch: string): void {
  if (!BRANCH_RE.test(branch)) {
    throw new Error(
      `Branch '${branch}' must be <github-user>/<type>/<kebab-name> with type one of: ${BRANCH_TYPES.join(", ")}.`,
    );
  }
}

/** Sibling directory `<repo>-wt/<kebab>` for a work branch. */
export function worktreePath(repoRoot: string, branch: string): string {
  assertWorkBranch(branch);
  const kebab = branch.split("/").pop();
  if (!kebab) throw new Error(`Branch '${branch}' has no name segment.`);
  return join(dirname(repoRoot), `${basename(repoRoot)}-wt`, kebab);
}

function git(args: string[], opts: { cwd?: string } = {}): string {
  const r = spawnSync("git", args, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || `git ${args.join(" ")} failed`).trim());
  }
  return (r.stdout ?? "").trim();
}

function add(branch: string): number {
  assertWorkBranch(branch);
  const path = worktreePath(REPO_ROOT, branch);
  git(["fetch", "origin", "dev"]);
  git(["worktree", "add", "-b", branch, path, "origin/dev"]);
  console.log(path);
  console.log(`Open this folder in Cursor and continue on ${branch}.`);
  return 0;
}

function list(): number {
  console.log(git(["worktree", "list"]));
  return 0;
}

function remove(branch: string): number {
  assertWorkBranch(branch);
  const path = resolve(worktreePath(REPO_ROOT, branch));
  git(["worktree", "remove", path]);
  console.log(`removed ${path}`);
  return 0;
}

export async function worktree(args: string[]): Promise<number> {
  const [cmd, branch] = args;
  try {
    switch (cmd) {
      case "add":
        if (!branch) {
          console.error(USAGE);
          return 64;
        }
        return add(branch);
      case "list":
        return list();
      case "remove":
        if (!branch) {
          console.error(USAGE);
          return 64;
        }
        return remove(branch);
      default:
        console.error(USAGE);
        return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 64;
    }
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await worktree(process.argv.slice(2));
}
