---
name: aws-cfn-change
description: Change CloudFormation stack parameters through a reviewed change set - create, review the diff for replacements, then execute with typed confirmation. Use when the user asks to update a stack parameter, resize via CloudFormation, or apply infrastructure changes on AWS.
---

# CloudFormation change via change set

1. **Current state.** Run `aws_cfn_stacks` and `aws_readonly_call` with `cloudformation describe-stacks` and `{"StackName": "<stack>"}` to get the parameters.
2. **Create the change set** (write tier). Call `aws_cfn_create_change_set` with only the parameters that change, and name it `ops-<yyyymmdd>-<short-purpose>`.
3. **Review.** Run `aws_readonly_call` with `cloudformation describe-change-set` and `{"StackName": "<stack>", "ChangeSetName": "<name>"}`. Summarize it for the user:
   - Each resource's `Action` (Add / Modify / Remove).
   - **`Replacement: True`**, which recreates the resource and is data-loss risk for databases and volumes. Flag it prominently.
4. **Approval.** The user explicitly approves this change set by name.
5. **Execute** (privileged). Call `aws_cfn_execute_change_set` with `confirm: "<stack>:<changeSetName>"`.
6. **Verify.** Poll `aws_cfn_stack_events` until `UPDATE_COMPLETE`, or until a rollback, which you should report with its first failure reason.
