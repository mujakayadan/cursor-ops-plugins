---
name: ops-change-management
description: Safe change workflow for production-affecting operations on GitHub, DigitalOcean, Vercel or AWS (deploys, promotions, rollbacks, scaling, DNS, merges, infrastructure changes). Use whenever the user asks to change, deploy, release, roll back, restart, scale or fix something in a live environment.
---

# Ops change management

Run every live change through this checklist. Copy it into the conversation and tick items off.

```
Change: <one line>
- [ ] 1. Current state captured (read tools)
- [ ] 2. Plan + blast radius + rollback stated
- [ ] 3. User approved the plan
- [ ] 4. Backup / snapshot / change set taken where available
- [ ] 5. Change applied (write tool, approved)
- [ ] 6. Verified with read tools
- [ ] 7. Summary reported
```

## 1. Capture current state
Use only `ops-*-read` tools. Record identifiers you will act on (deployment id, droplet id, stack name, PR number) and the identity in use (`*_whoami` / `aws_whoami`). If the identity or account is unexpected, stop.

## 2. Plan
State in plain language:
- **What** changes and **where** (environment, region, account/team).
- **Blast radius**: who or what is affected while it happens.
- **Rollback**: the exact action that undoes it (e.g. `vercel_rollback` to the current production deployment id you just recorded).

## 3. Approval
Wait for an explicit "yes" to the plan. A request like "fix prod" is not approval for a specific privileged action.

## 4. Backup
| Change | Backup step |
|---|---|
| Droplet reboot/power-off/resize | `digitalocean_droplet_snapshot` |
| CloudFormation update | `aws_cfn_create_change_set`, review via `aws_readonly_call describe-change-set` |
| Vercel promote | record current production deployment from `vercel_project_get` |
| PR merge | confirm checks green with `github_pr_checks` |

## 5. Apply
Call the write tool. Cursor asks the user to approve; privileged tools additionally need `confirm` exactly as the tool schema describes. One change at a time.

## 6. Verify
Re-run the read tools from step 1 and compare. For deploys, check status and logs until healthy or clearly failed. If verification fails, propose the rollback from step 2. Don't apply it silently.

## 7. Report
Summarize what changed, verification evidence, and the rollback command. Writes and guardrail decisions are already in the audit log (`~/.ops/audit/*.jsonl`).
