#!/usr/bin/env node
// Linked worktrees for concurrent agents on this suite checkout.
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertWorkBranch } from "../plugins/ops-core/hooks/guardrails.ts";
import { REPO_ROOT } from "./lib.ts";

const USAGE = `ops worktree — linked checkouts for concurrent agents on this suite

  ops worktree add <user>/<type>/<kebab-name>   create from origin/dev under <repo>-wt/<user>/<type>/<kebab>
  ops worktree list                             show linked worktrees
  ops worktree remove <user>/<type>/<kebab-name>
                                                remove the linked checkout and delete the local branch when it is merged into HEAD`;

export { assertWorkBranch };

/** Sibling directory `<repo>-wt/<user>/<type>/<kebab>` for a work branch. */
export function worktreePath(repoRoot: string, branch: string): string {
  assertWorkBranch(branch);
  return join(dirname(repoRoot), `${basename(repoRoot)}-wt`, ...branch.split("/"));
}

function git(args: string[]): string {
  const r = spawnSync("git", args, {
    cwd: REPO_ROOT,
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
  const deleted = spawnSync("git", ["branch", "-d", branch], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (deleted.status === 0) {
    console.log(`removed ${path} and deleted local branch ${branch}`);
    return 0;
  }
  console.log(`removed ${path}`);
  console.log(
    `local branch ${branch} remains. Delete it with git branch -D only after its squash is on the target branch and the remote branch is gone. Never delete main, dev, qa, or staging.`,
  );
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
