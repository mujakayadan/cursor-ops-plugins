---
name: vercel-production-release
description: Promote a verified deployment to Vercel production or roll production back, with pre-checks and typed confirmation. Use when the user asks to release, promote, ship to prod, or roll back a Vercel project.
---

# Vercel production release / rollback

Both actions are **privileged**. They're disabled unless `providers.vercel.allowPrivileged` is true, and each one needs typed confirmation.

## Pre-checks (read tier)
1. `vercel_project_get` → record the **current production deployment id**. This is your rollback target.
2. `vercel_deployment_get` on the candidate → `state` must be `READY`, and the commit and branch must be the expected ones.
3. Smoke-test the candidate's preview URL if the user has a check (curl the health endpoint).

## Promote
Tell the user: "Promote `<candidate>` to production, replacing `<current>`. Rollback target: `<current>`." Once they confirm explicitly, call `vercel_promote` with `confirm: "promote:<candidate>"`.

## Roll back
Use `vercel_deployment_list` (`target: "production"`, `state: "READY"`) to pick the previous good deployment. After the user confirms, call `vercel_rollback` with `confirm: "rollback:<deployment>"`.

## Verify
Run `vercel_project_get` again and check the production deployment id changed as intended. Report the old and new ids and the rollback command.
