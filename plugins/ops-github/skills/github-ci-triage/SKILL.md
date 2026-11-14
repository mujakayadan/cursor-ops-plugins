---
name: github-ci-triage
description: Diagnose failing GitHub Actions / PR checks using the ops-github read tools - find the failing job, extract the real error from logs, classify it (code, flaky, infra, config) and propose a fix. Use when CI is red, a PR check fails, or the user asks why a workflow failed.
---

# GitHub CI triage

1. **Locate.**
   - With a PR: `github_pr_checks` → keep the `bucket: "fail"` entries.
   - Without a PR: `github_run_list` with `branch` and `status: "failure"`.
2. **Logs.** Call `github_run_failed_logs` with the run id (the number in the check link `/actions/runs/<id>`). Find the first real error, not the cascade after it.
3. **Classify.**

| Class | Signals | Action |
|---|---|---|
| Code | assertion/compile/type errors tied to changed files | fix locally, push |
| Flaky | timeouts, passes on re-run history, network resets | propose `github_run_rerun` (failedOnly) |
| Infra | runner lost, registry 5xx, rate limits | re-run later; note upstream status |
| Config | missing secret/permission, bad workflow YAML | point to the exact file/setting |

4. **Correlate with the diff.** Call `github_pr_view` with `includeDiff: true` only when the class is Code.
5. **Report**: failing job, root error excerpt (≤20 lines), class, proposed fix. Only re-run (`github_run_rerun`, write tier) after the user agrees.
