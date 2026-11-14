---
name: digitalocean-app-platform-ops
description: Operate DigitalOcean App Platform apps with ops-digitalocean tools - check deployment health, read build/deploy/run logs, diagnose failed deployments, and redeploy safely. Use when a DigitalOcean app is down, a deployment failed, or the user asks to redeploy or inspect an App Platform app.
---

# App Platform operations

## Health check
1. `digitalocean_app_list` → find the app and note `activeDeployment.phase` and `inProgressDeployment`.
2. `digitalocean_app_deployments` → recent phases. `ERROR` or `CANCELED` mark the failure point.

## Diagnose a failed deployment
| Phase failed at | Logs to read |
|---|---|
| BUILDING | `digitalocean_app_logs` with `type: "build"` |
| DEPLOYING | `type: "deploy"` (health checks, crash loops) |
| ACTIVE but erroring | `type: "run"`, optionally per `component` |

Common causes: a missing env var (compare the spec from `digitalocean_app_get`; values are redacted, names are visible), a health-check port mismatch, or out-of-memory (OOM) on a small instance size.

## Redeploy
Use `digitalocean_app_redeploy` (write tier, needs approval). Only use `forceRebuild: true` when the cached build is suspect. Then poll `digitalocean_app_deployments` until it's `ACTIVE` or failed, and report the outcome.

Never change the app spec through shell `doctl apps update` without a reviewed diff. The hook asks for approval anyway.
