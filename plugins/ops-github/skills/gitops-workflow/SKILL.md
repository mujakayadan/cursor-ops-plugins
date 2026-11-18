---
name: gitops-workflow
description: Apply and follow the team's GitOps flow on GitHub - main is production, dev is integration, work happens on <user>/<type>/<name> branches through PRs, release-please cuts releases, images go to GHCR. Use when creating or bootstrapping a repository, starting work on a change, promoting dev to main, releasing, or when the user asks about branches, protection, releases, issues or project boards.
---

# GitOps workflow

## The rules
- **Environment branches:** `main` (production) and `dev` (integration) in every repo; `qa` and `staging` only when the user asks. They change only through pull requests. Never commit or push to them; the ops-core guardrails and the repo's git hooks refuse it.
- **Work branches:** `<github-user>/<type>/<kebab-name>`, cut from `dev`. Type is one of `feat fix chore docs refactor perf test build ci style revert hotfix`. Get the login from `github_whoami`. Example: `git switch -c octocat/fix/login-timeout origin/dev`.
- **Targets:** work PRs go to `dev` (the agent squash-merges them when checks are green). `main` accepts PRs only from `dev`, `qa`, `staging`, Dependabot and release-please, with a merge commit. The agent opens that pull request. It merges only when the user approves `github_pr_merge`, or the user merges it. Never `gh pr merge` a pull request into `main`. After anything lands on `main`, the `sync-main-to-dev` workflow opens a `main → dev` PR; the agent merges that with a merge commit when checks are green.
- **Titles:** Conventional Commits (`feat(api): add health check`, `fix!: drop v1 endpoint`). The squash commit takes the PR title, and release-please reads it.
- **Checks:** the `pr-policy` workflow enforces targets, branch names and titles. `github_pr_merge` also refuses to merge until every check is green. On GitHub Free, private repos have no rulesets, so these checks plus the local hooks are the enforcement.
- **API contract:** backend repos commit `openapi.json`, and the `api-compat` job diffs it against the base branch with oasdiff. Error-level breaking changes fail the PR unless declared with `!` in the title and a line starting `BREAKING CHANGE: <migration>` in the body; that also makes release-please bump the major version (minor before 1.0). Promotions and bot PRs only report. Suggest a compatible alternative before declaring a break.

## New repository
1. Ask the user for the visibility (`public` or `private`); there is no default. The same applies to the license (see `scaffold-project`).
2. `github_repo_create` with `visibility`, and `source` set to the local repo whose initial commit is on `main`. This pushes `main`.
3. `github_repo_bootstrap` with `environments` (only if asked), `requiredChecks` (the CI job names, e.g. `verify`, plus `api-compat` when the repo has `openapi.json`) and `project` (if the user has a board). It creates `dev` from `main`, sets merge settings (squash and merge commits on, rebase off, delete merged branches), adds labels, and applies rulesets where the plan allows (public repos on Free). It also lets Actions open PRs.
4. Relay the `gitopsToken` line. Without the token, CI on release and sync PRs waits as *action required* until the user approves the runs in the Actions tab. To avoid that, the user creates a fine-grained token (this repo; Contents and Pull requests read/write) and stores it as the `GITOPS_TOKEN` Actions secret. Never create or store that token yourself.

Changing an existing repo to public is `github_repo_set_visibility` (privileged, typed confirmation). First scan the full history for secrets (e.g. `gitleaks git` or `trufflehog git file://.`) and show the result to the user.

## Delivering a change
1. Issue first when the work is non-trivial: `github_issue_create` with a `bug`/`enhancement` label, then `github_project_item_add` to put it on the board.
2. **Checkout isolation.** If another agent already uses this folder (another work branch checked out, or dirty files that are not yours), create a linked worktree before editing. In the ops suite checkout: `ops worktree add <github-user>/<type>/<kebab-name>` (path `<repo>-wt/<user>/<type>/<kebab>`), then open that folder. In any other repo: `git worktree add -b <branch> <path> origin/dev`. Otherwise cut the branch in place: `git switch -c <github-user>/<type>/<kebab-name> origin/dev`.
3. One concern per PR. Commit only the files for this change; leave unrelated dirty files unstaged. Conventional commit messages.
4. `git push -u origin <branch>`. Local hooks run lint and tests (suite: biome and tsc on commit, vitest on push); never `--no-verify`. Fix hook failures before opening the PR.
5. `github_pr_create` with `base: "dev"` and a conventional title; the body says `Closes #N` and sticks to this change.
6. Keep checks green (`github-ci-triage`). **Squash-merge the work PR into `dev` yourself** (`github_pr_merge` method `auto`, or `gh pr merge --squash`). Do not wait for the user to merge work→`dev`. Own every file you touched: commit, push, and resolve conflicts (rebase onto `origin/dev`). After the squash lands, the checkout you used is gone and the primary checkout is clean. Remove a suite worktree with `ops worktree remove <github-user>/<type>/<kebab-name>` (that also deletes the local branch when it is merged into HEAD). Elsewhere, `git worktree remove <path>`. A squash is not an ancestor of HEAD, so `git branch -d` can refuse; `git branch -D` is only for that case, and only when the remote branch is gone and the squash commit is on the target branch. Never delete `main`, `dev`, `qa`, or `staging`. Leave no uncommitted files and no linked worktree behind.
7. After a **suite** change lands and you keep this Cursor window, run `ops status` (or `ops serve --restart`) so the shared read server matches the new HEAD. Opening a workspace does the same.
8. When the change should ship to production, open the promote PR (`dev` → `main`, title `chore: release`) yourself. Merge it with `github_pr_merge` method `auto` so the user approves that call, or leave the URL for the user to merge. Do not run `gh pr merge` on a promote or release-please PR.

## Promote and release
1. Promote: `github_pr_create` with `head: "dev"`, `base: "main"` and title `chore: release`. Merge with `github_pr_merge` method `auto` (the user approves the call) or leave the URL for the user to merge. Never `gh pr merge` it.
2. release-please opens or updates its `chore(main): release X.Y.Z` PR on `main`. Review the changelog with the user. They approve `github_pr_merge` or merge it themselves. Never `gh pr merge` it. That tags `vX.Y.Z`, publishes the GitHub release and, for Docker projects, pushes `ghcr.io/<owner>/<repo>:X.Y.Z` and `:latest` with provenance. Pushes to `dev` publish `:dev` and `:sha-<short>`.
3. After sync opens `chore: sync main into dev`, merge it into `dev` yourself with a **merge commit** when checks are green (or ask the user if anything looks wrong).
4. Check with `github_release_list`.

## Hotfix
Branch `<user>/hotfix/<name>` from `dev`, PR to `dev`, squash-merge into `dev`, then open the promote PR (`dev` → `main`) right away. The user approves `github_pr_merge` or merges it. Don't open PRs from work branches to `main`; `pr-policy` rejects them.
