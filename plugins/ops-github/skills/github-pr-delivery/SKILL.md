---
name: github-pr-delivery
description: Deliver a change as a GitHub pull request end-to-end with the ops-github tools - open as draft, keep checks green, respond to review, and merge under the GitOps rules with user approval. Use when the user asks to open, update, get reviewed, or merge a PR.
---

# PR delivery

## Open
- Branch names, targets and titles follow `gitops-workflow`: work branches `<user>/<type>/<name>` target `dev`, titles are Conventional Commits.
- Push the branch locally with git. Then call `github_pr_create` (write tier). It defaults to `draft: true`.
- Write the body as **Summary** (why), **Changes** (what), **Testing** (evidence), **Risk/Rollback**.

## Keep green
- `github_pr_checks` until no `pending`. For failures, follow `github-ci-triage`.

## Review loop
- Read the feedback with `github_pr_view` and `github_issue_view` (PR comments share the issue thread).
- Reply with `github_pr_comment`, summarizing what changed per comment.

## Merge
Merge only when the user asked for it or the agreed task includes it. Check with read tools first:
- `github_pr_view`: not draft, `mergeable` is `MERGEABLE`, `reviewDecision` is not `CHANGES_REQUESTED`. Solo repos need no approving review.
- `github_pr_checks`: every check passes.

Call `github_pr_merge` (write tier; the user approves each call). Leave `method: "auto"`: features squash into `dev`, and promotions or syncs between `main`/`dev`/`qa`/`staging` get a merge commit. The tool itself refuses red or pending checks, work branches into `main`, and squashed promotions. Branch protection is never bypassed. If merge is blocked, report why. Don't look for a workaround, and never fall back to `gh pr merge --admin`.
