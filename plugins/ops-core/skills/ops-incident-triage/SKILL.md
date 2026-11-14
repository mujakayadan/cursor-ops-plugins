---
name: ops-incident-triage
description: Read-only incident investigation across GitHub, Vercel, DigitalOcean and AWS. Correlates recent deploys, CI runs, logs and alarms to find what changed. Use when something is down, erroring, slow, or the user asks "what broke", "why is prod failing", or for an incident timeline.
---

# Incident triage (read-only)

Do not call any write tool during triage. Produce a hypothesis and a proposed remediation; changes go through `ops-change-management`.

## Workflow

1. **Scope.** Which service, environment, and since when? If unknown, assume "production, last 2 hours".
2. **What changed?** Build a timeline from the providers in use:
   - GitHub: `github_pr_list` (state `merged`, search `merged:>=<date>`), `github_run_list` on the default branch.
   - Vercel: `vercel_deployment_list` (target `production`), then `vercel_deployment_get` on the latest.
   - DigitalOcean: `digitalocean_app_deployments`, `digitalocean_droplet_list`.
   - AWS: `aws_cfn_stack_events`, `aws_ecs_services` (deployments + events), `aws_cloudwatch_alarms`.
3. **Symptoms.** Pull logs around the first error:
   - `vercel_deployment_build_logs` (`errorsOnly: true`) for build failures.
   - `digitalocean_app_logs` (`type: run`, then `deploy`).
   - `aws_logs_search` with `filterPattern: "ERROR"` and a window starting just before the incident.
   - `github_run_failed_logs` for CI.
4. **Correlate.** Line up the first error against the timeline. The nearest preceding change is the prime suspect. Say how confident you are.
5. **Report** using:

```
## Incident summary
Impact: …    Started: …    Status: ongoing/mitigated
## Timeline (UTC)
- hh:mm  event (source)
## Most likely cause
… (evidence: tool + identifier)
## Proposed remediation
1. Immediate (e.g. roll back deployment X) — needs approval
2. Follow-up
```

For long investigations, delegate to the `ops-investigator` subagent so the main conversation stays focused.
