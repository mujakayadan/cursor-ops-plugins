---
name: aws-incident-triage
description: Investigate AWS service incidents read-only - alarms, ECS rollouts, Lambda and CloudWatch logs, CloudFormation events - and pinpoint the failing component. Use when an AWS-hosted service is erroring, an alarm fires, an ECS deployment is stuck, or a stack rolled back.
---

# AWS incident triage

Always start with `aws_whoami` to confirm the account and role. Pass `region` explicitly on every call.

1. **Alarms.** Run `aws_cloudwatch_alarms` (`state: "ALARM"`). Each alarm's metric and namespace point at the service.
2. **Compute.**
   - ECS: `aws_ecs_services`. Look for `rolloutState: FAILED`, runningCount < desiredCount, and the event messages (failing health checks, CannotPullContainerError, out-of-memory).
   - Lambda: `aws_lambda_functions`, then `aws_logs_search` on `/aws/lambda/<name>` with `filterPattern: "?ERROR ?Task timed out"`.
   - EC2: `aws_ec2_instances` with `state` filters.
3. **Recent infrastructure changes.** Run `aws_cfn_stacks`, then `aws_cfn_stack_events` on stacks with recent `LastUpdatedTime`. The first `*_FAILED` event is the root cause; later failures cascade from it.
4. **Anything else.** Use `aws_readonly_call`, e.g. `elbv2 describe-target-health`, `rds describe-db-instances`, `route53 list-resource-record-sets`. Secret-returning operations are blocked by design.
5. **Report** using the `ops-incident-triage` template. Remediations such as `aws_ecs_force_deploy` or `aws_ecs_scale` are write-tier and need approval.
