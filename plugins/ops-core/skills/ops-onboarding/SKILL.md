---
name: ops-onboarding
description: Set up, finish setting up or troubleshoot the ops plugin suite on this machine - missing CLIs, provider sign-ins, per-tier credentials (read-only vs write) for gh, doctl, aws, vercel and m365, scope fences in ~/.ops/config.json, privileged-action enablement, and read server connection problems. Use when the user asks to set up or onboard the suite or a plugin, when `ops doctor` reports failures, or when ops-* MCP tools fail with "not found", auth or connection errors.
---

# Ops plugin onboarding

A machine without the suite starts with the bootstrap in the repository's `AGENTS.md` (prerequisites, clone, `ops install`, `ops setup`, Cursor restart). Once the suite is loaded, this skill takes over.

## Setup loop

1. Run `ops doctor --json`. Every row that isn't `OK` has a `fix`.
2. Apply fixes yourself: `ops setup <plugin> --yes` for missing CLIs (`--optional` for feature-only tools), `ops status` or `ops serve --restart` for the read server (both refresh when HEAD moved), `ops install` for the loader or token.
3. Hand sign-ins to the user. Their fix reads `in your terminal: <command>`, because they open a browser, show a device code or prompt for a pasted token. Ask the user to run it in Cursor's terminal (`` Ctrl+` ``). Never take a token in chat or run a sign-in that would pass one through your tools.
4. Run the doctor again until no `FAIL` remains for the providers the user wants. Skipped providers can stay failing; say which.
5. Verify from chat: call `control_status` and, for each signed-in provider, its `onboarding.whoami` read tool (for example `github_whoami`).
6. Set the user profile if `control_profile_get` returns none: ask with AskQuestion which expertise level describes the user (senior software engineer, software engineer, technical, not technical) and their role, then save it with `control_profile_set`. Every later conversation starts with it.

Each provider declares its install recipes in `provider.ts` (`setup`) and, where it needs a sign-in or a local toolchain, its readiness tool and sign-in command (`onboarding`). That is where the doctor's fixes come from. Microsoft 365 also needs an Entra app: follow `msgraph-setup`.

## Credential model

Each provider has two MCP servers:
- `ops-<p>-read` uses the **read** credentials.
- `ops-<p>-write` uses the **write** credentials, and also runs privileged tools when they are enabled.

Credentials never live in Cursor config. They come from the provider CLI's own login, selected per tier in `~/.ops/config.json` → `providers.<p>.credentials.{read,write}` via `env` and/or extra CLI `args`. Without that, both tiers use the default login, which works but isn't least privilege.

You can't edit `~/.ops/config.json` (the guardrails deny it). Ask what the user wants, draft the JSON, and have them paste it. Only review settings and enabled plugins go through you, with `control_review_set` and `control_plugin_set`.

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

## Troubleshooting
- **Tool says a CLI was not found:** `ops setup <plugin> --yes`. The servers find new installs on the next call.
- **`ops` itself is not found:** run `node scripts/ops.ts install` in the suite checkout and open a new terminal.
- **Read tools fail to connect or return 401:** read tiers run on the shared server. The doctor shows whether it is up and whether `OPS_MCP_TOKEN` matches; after a fresh install, quit and reopen Cursor once so it has the variable. `ops serve --restart` restarts the server. Its log, `~/.ops/serve.log`, records refused requests (repeats of the same status, reason and auth state within a second are counted on that kind's next line instead of logged) with the reason and whether the `Authorization` header was missing, uninterpolated (`${env:...}` sent literally), wrong or accepted, never the token itself.
- **A read server shows an error in Settings → MCP while the doctor says the server is up:** Cursor connected while the server was down or restarting, and it doesn't retry a failed server on its own. Ask the user to toggle that server off and on in Settings → MCP; a quit and reopen of Cursor also works.
- **The read tier shows the same identity as the write tier:** the per-tier credentials aren't configured, so both tiers use the default login.
- **Audit records** are in `~/.ops/audit/YYYY-MM-DD.jsonl`, with secrets redacted.

## Sessions

The Agents Window is the chatbot, opened once. A topic is one agent on its own folder. Follow `workspace-sessions`. The loader runs for every workspace, so the enabled plugins come with it.
