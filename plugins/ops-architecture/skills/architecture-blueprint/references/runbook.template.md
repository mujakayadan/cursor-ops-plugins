# <System name> runbook

<!-- guide: Procedures an on-call engineer follows under pressure: exact commands, consoles and
expected output, never "investigate the issue". Every alert in ARCHITECTURE.md §11 has an entry
here. Delete every guide comment as you fill a section. -->

| | |
|---|---|
| Service owner | |
| On-call rotation | |
| Escalation | |
| Dashboards | |

## Deploy

<!-- guide: How a change reaches each environment (pipeline, approvals, promotion from dev to main),
how to verify a deployment, and how to deploy by hand when the pipeline is down. -->

## Rollback

<!-- guide: Application rollback, database migration rollback or roll-forward, infrastructure
rollback, feature-flag kill switches, and how to confirm the rollback worked. -->

## Configuration and secrets

<!-- guide: Where configuration and secrets live per environment, how to rotate each secret, and who
may change them. Never the values. -->

## Monitoring and alerts

<!-- guide: One entry per alert: what it means, severity, first checks, mitigation steps and when to
escalate. -->

| Alert | Severity | Meaning | First response |
|---|---|---|---|

## Incident response

<!-- guide: Severity levels, who declares and leads an incident, communication channels and
templates, status page, and the post-incident review process. -->

## Backup and restore

<!-- guide: What is backed up, how often, retention, where, and the tested restore procedure with
its last drill date. -->

## Disaster recovery

<!-- guide: Region or account loss: the failover procedure step by step, RPO and RTO targets from
ARCHITECTURE.md §13, failback, and the drill schedule. -->

## Routine operations

<!-- guide: Scheduled tasks: dependency and image updates, certificate renewal, access reviews,
cost reviews, capacity reviews, key rotation. -->
