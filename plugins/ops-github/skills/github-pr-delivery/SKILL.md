---
name: github-pr-delivery
description: Deliver a change as a GitHub pull request end-to-end with the ops-github tools - open as draft, keep checks green, respond to review, and merge under the GitOps rules. Use when the user asks to open, update, get reviewed, or merge a PR.
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
When checks are green, merge. Check with read tools first:
- `github_pr_view`: not draft, `mergeable` is `MERGEABLE`, `reviewDecision` is not `CHANGES_REQUESTED`. Solo repos need no approving review.
- `github_pr_checks`: every check passes.

A work pull request into `dev`, `qa`, or `staging` is squash-merged by the agent (`github_pr_merge` method `auto`, or `gh pr merge --squash`). Do not wait for the user. A sync between those branches uses a merge commit, and the agent merges that too.

A pull request into `main`, including promote and release-please, merges only when the user approves `github_pr_merge` (method `auto`) or merges it themselves. Never `gh pr merge` a pull request into `main`.

The tool refuses red or pending checks, work branches into `main`, and squashed promotions. Branch protection is never bypassed. If merge is blocked, report why. Don't look for a workaround, and never fall back to `gh pr merge --admin`.
