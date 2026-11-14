---
name: github-pr-delivery
description: Deliver a change as a GitHub pull request end-to-end with the ops-github tools - open as draft, keep checks green, respond to review, and merge only with typed confirmation. Use when the user asks to open, update, get reviewed, or merge a PR.
---

# PR delivery

## Open
- Push the branch locally with git. Then call `github_pr_create` (write tier). It defaults to `draft: true`.
- Write the body as **Summary** (why), **Changes** (what), **Testing** (evidence), **Risk/Rollback**.

## Keep green
- `github_pr_checks` until no `pending`. For failures, follow `github-ci-triage`.

## Review loop
- Read the feedback with `github_pr_view` and `github_issue_view` (PR comments share the issue thread).
- Reply with `github_pr_comment`, summarizing what changed per comment.

## Merge (privileged)
Preconditions, all verified with read tools:
- `github_pr_view`: `reviewDecision` is `APPROVED`, `mergeable` is `MERGEABLE`, not draft.
- `github_pr_checks`: every check passes.

Then show the user `OWNER/REPO#NUMBER` and the merge method, and ask for explicit confirmation. Call `github_pr_merge` with `confirm: "OWNER/REPO#NUMBER"`. Branch protection is never bypassed. If merge is blocked, report why. Don't look for a workaround.
