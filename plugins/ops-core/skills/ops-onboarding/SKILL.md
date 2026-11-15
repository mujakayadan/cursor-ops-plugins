---
name: ops-onboarding
description: Set up and troubleshoot the ops plugin suite - per-tier credentials (read-only vs write) for gh, doctl, aws, vercel and m365, ~/.ops/config.json, privileged-action enablement, and the doctor check. Use when installing the ops plugins, when ops-* MCP tools fail with auth errors, or when the user asks how to configure read/write credentials.
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
| Microsoft Graph | the active `m365 login` connection (shared: m365 can't pick an account per process) | same; writes rely on approvals and `msgraph.scope.allowedRecipientDomains` (see `msgraph-setup`) |

Also set scope guards: `github.scope.owners`, `vercel.scope.teamId`, `aws.scope.allowedAccounts` / `allowedRegions`, `digitalocean.scope.protectedTags`, `msgraph.scope.allowedRecipientDomains`.

## Privileged actions
Privileged actions are disabled by default. To enable them for one provider, set `providers.<p>.allowPrivileged: true`. For a temporary break-glass session, set `OPS_ALLOW_PRIVILEGED=1` in Cursor's environment. Both are audited. After changing either, restart the MCP servers (Settings → MCP, toggle the server off and on).

## Verify
Run `ops doctor`. It checks CLIs, the suite loader, the plugins, the config file, and the identity behind each tier. Fix every FAIL before using the write tools.

## Troubleshooting
- **Tool says a CLI was not found:** run `ops setup` (add the plugin name to limit it, `--optional` for feature-only tools). The servers find new installs on the next call.
- **`ops` itself is not found:** run `pnpm run install-local` in the suite checkout and open a new terminal.
- **Read tools fail to connect or return 401:** read tiers run on the shared server. `ops doctor` shows whether it is up and whether `OPS_MCP_TOKEN` matches; after a fresh install, quit and reopen Cursor once so it has the variable. `ops serve --restart` restarts the server; its log is `~/.ops/serve.log`.
- **The read tier shows the same identity as the write tier:** the per-tier credentials aren't configured, so both tiers use the default login.
- **Audit records** are in `~/.ops/audit/YYYY-MM-DD.jsonl`, with secrets redacted.
