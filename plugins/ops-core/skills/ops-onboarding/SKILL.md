---
name: ops-onboarding
description: Set up and troubleshoot the ops plugin suite - per-tier credentials (read-only vs write) for gh, doctl, aws and vercel, ~/.ops/config.json, privileged-action enablement, and the doctor check. Use when installing the ops plugins, when ops-* MCP tools fail with auth errors, or when the user asks how to configure read/write credentials.
---

# Ops plugin onboarding

## Model
Each provider has two MCP servers:
- `ops-<p>-read` uses the **read** credentials.
- `ops-<p>-write` uses the **write** credentials, and also runs privileged tools when they are enabled.

Credentials never live in Cursor config. They come from the provider CLI's own login, selected per tier in `~/.ops/config.json` → `providers.<p>.credentials.{read,write}` via `env` and/or extra CLI `args`.

## Recommended least-privilege setup

| Provider | Read tier | Write tier |
|---|---|---|
| GitHub | fine-grained PAT (read-only) in a separate gh config dir: `env: {"GH_CONFIG_DIR": "C:/Users/<you>/.ops/gh-read"}`, then `$env:GH_CONFIG_DIR=...; gh auth login` | default `gh auth login` |
| DigitalOcean | custom-scoped read token: `doctl auth init --context ops-read`, `args: ["--context","ops-read"]` | `doctl auth init --context ops-write`, `args: ["--context","ops-write"]` |
| AWS | SSO profile with ReadOnlyAccess: `args: ["--profile","acme-readonly"]` | scoped deploy role: `args: ["--profile","acme-deployer"]` |
| Vercel | `args: ["--global-config","C:/Users/<you>/.ops/vercel-read"]` + `vercel login` with that flag | default `vercel login` |

Also set scope guards: `github.scope.owners`, `vercel.scope.teamId`, `aws.scope.allowedAccounts` / `allowedRegions`, `digitalocean.scope.protectedTags`.

## Privileged actions
Privileged actions are disabled by default. To enable them for one provider, set `providers.<p>.allowPrivileged: true`. For a temporary break-glass session, set `OPS_ALLOW_PRIVILEGED=1` in Cursor's environment. Both are audited. After changing either, restart the MCP servers (Settings → MCP, toggle the server off and on).

## Verify
From the plugins repo, run `pnpm run doctor`. It checks CLIs, installed plugins, the config file, and the identity behind each tier. Fix every FAIL before using the write tools.

## Troubleshooting
- **Tool says the CLI is not on PATH:** install the CLI, then restart Cursor so the MCP process inherits the new PATH.
- **The read tier shows the same identity as the write tier:** the per-tier credentials aren't configured, so both tiers use the default login.
- **Audit records** are in `~/.ops/audit/YYYY-MM-DD.jsonl`, with secrets redacted.
