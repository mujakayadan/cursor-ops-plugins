---
name: vercel-deploy-triage
description: Diagnose failed or misbehaving Vercel deployments with ops-vercel read tools - find the failing deployment, extract build errors, compare with the last good deployment, and check env var names. Use when a Vercel build fails, a preview is broken, or production regressed after a deploy.
---

# Vercel deployment triage

1. **Find it.** Run `vercel_deployment_list` (filter `project`, `state: "ERROR"` or `target: "production"`). Note the failing deployment and the last `READY` one on the same target.
2. **Status.** Run `vercel_deployment_get` to get `errorCode`/`errorMessage`, branch and commit.
3. **Build logs.** Run `vercel_deployment_build_logs` with `errorsOnly: true`, then without the filter if you need context.
4. **Classify.**

| Signal | Likely cause | Next step |
|---|---|---|
| `Module not found` / type errors | code change | diff the commits between last READY and failing |
| `Missing environment variable` / undefined at build | env var missing for that target | `vercel_env_list` and compare targets (names only) |
| `FUNCTION_INVOCATION_TIMEOUT`, 5xx after READY | runtime, not build | check runtime logs in dashboard / vendor MCP |
| install failures | lockfile / registry | compare `installCommand` via `vercel_project_get` |

5. **Report** the cause and the fix. If production is affected, propose a rollback using `vercel-production-release`.
