---
name: aws-cost-review
description: Review AWS spend by service and find savings opportunities (idle instances, oversized services, forgotten resources) using read-only tools. Use when the user asks about AWS cost, billing spikes, or how to reduce the AWS bill.
---

# AWS cost review

1. **Spend.** Run `aws_cost_by_service` (`days: 30`, plus `days: 7` to spot spikes). Cost Explorer costs about $0.01 per request, so don't loop it.
2. **Drill into the top 3 services.**
   - EC2: run `aws_ec2_instances` and look for stopped instances that still have EBS volumes. Then run `aws_readonly_call ec2 describe-volumes` with `{"Filters":[{"Name":"status","Values":["available"]}]}` to find unattached volumes.
   - ECS/Fargate: run `aws_ecs_services` and look for a desiredCount that's high relative to the load.
   - S3: run `aws_s3_buckets`. Lifecycle rules: `aws_readonly_call s3api get-bucket-lifecycle-configuration`.
   - NAT/data transfer: `aws_readonly_call ec2 describe-nat-gateways`.
3. **Report** a table:

| Finding | Est. monthly saving | Effort | Risk |
|---|---|---|---|

Deletions are out of scope for the agent tools by design. Hand the user the console steps or IaC change for anything destructive.
