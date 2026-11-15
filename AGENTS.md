# Agent guide

This repository is a Cursor plugin suite (see [README.md](README.md)). Two jobs come up: setting the suite up on a machine, and changing the suite itself.

## Set up the suite on this machine

Use this when the user asks to set up, install or onboard this repository, or gives you its URL. Work through the steps in order, run the commands yourself, and stop only where a step says the user has to act. Every step is idempotent, so on a partly set up machine, rerun from step 1 and skip what is already done.

### 1. Prerequisites

Check `git --version`, `node --version` (24 or newer) and `pnpm --version`. Install what is missing:

| Tool | Windows | macOS |
|---|---|---|
| Git | `winget install --id Git.Git --exact` | `brew install git` |
| Node 24+ | `winget install --id OpenJS.NodeJS.LTS --exact` | `brew install node` |
| pnpm | `winget install --id pnpm.pnpm --exact` | `brew install pnpm` |

On Linux, use the distribution's packages; don't pipe remote install scripts into a shell. On Windows, winget updates PATH only for new processes, so refresh it in your shell before continuing:

```powershell
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
```

### 2. Clone

Clone to the folder the user named, otherwise `~/code/cursor-ops-plugins`. Skip this if you are already inside the checkout.

```powershell
git clone https://github.com/mujakayadan/cursor-ops-plugins.git <folder>
```

The loader and the `ops` launcher record this path, so the checkout must stay where it is. After moving it, run `node scripts/ops.ts install` from the new location. The suite has no runtime dependencies, so `pnpm install` is only needed for development.

### 3. Install the suite

From the checkout (`ops` isn't on PATH in this shell yet, so call the script directly):

```powershell
node scripts/ops.ts install
```

This registers the `workspaceOpen` loader in `~/.cursor/hooks.json`, writes the `ops` launcher to `~/.ops/bin` and adds it to the user PATH, creates the read server token and the `OPS_MCP_TOKEN` user variable, and creates `~/.ops/config.json`. It changes user-level settings, so run it only as part of a setup the user asked for. On macOS and Linux it prints two `export` lines instead of changing the environment: add them to the user's shell profile (`~/.zshrc` or `~/.bashrc`).

### 4. Install the provider CLIs

```powershell
node scripts/ops.ts setup --yes
```

It installs whatever the enabled plugins need and is missing (gh, doctl, AWS CLI, Vercel CLI, m365, mermaid-cli, MiKTeX, uv, Graphviz, …): npm-based tools with pnpm into `~/.ops/tools`, the rest with winget or Homebrew. Some winget installers (AWS CLI, MiKTeX) show a Windows elevation prompt, which the user has to accept. Add `--optional` when the user wants PNG/SVG previews from LaTeX or Java projects; `--dry-run` shows the plan. If the user only wants some providers, name their plugins (`setup --yes ops-github ops-vercel`).

### 5. Restart Cursor (the user)

Cursor reads `OPS_MCP_TOKEN` only at startup. Ask the user to **quit Cursor completely and reopen it**, then to say "continue setup" in this chat. Stop here until they do; a window reload is not enough this one time.

### 6. Check and fix

After the restart the suite is loaded, including the `ops-onboarding` skill, which covers the rest in more depth. Run:

```powershell
ops doctor --json
```

Each row has a `status` (`OK`, `WARN`, `FAIL`) and, unless it is OK, a `fix`. Apply the fixes and run it again until no `FAIL` is left. Most fixes are commands you run. Sign-ins are the exception:

- **Sign-ins are the user's job.** They open a browser, show a device code or ask for a pasted token. Give the user the `fix` command and ask them to run it in Cursor's terminal (`` Ctrl+` ``). Never ask for a token in chat or handle one yourself; the prompt guard blocks credentials in chat anyway.
- Provider sign-ins the user doesn't need can stay failing; say so instead of pushing.
- Microsoft 365 needs an Entra app first; follow the `msgraph-setup` skill.

### 7. Least privilege and scope (optional, recommended)

By default both credential tiers use the CLI's default login, and scopes are open. The `ops-onboarding` skill explains read-only identities per tier and scope fences (GitHub owners, Vercel team, AWS accounts and regions, mail recipient domains). The guardrails don't let you edit `~/.ops/config.json`: ask what the user wants, draft the JSON, and have them paste it. Review settings and enabled plugins are the exception: `control_review_set` and `control_plugin_set` change those with approval.

### 8. Verify

1. `ops doctor` shows no `FAIL` for the providers the user wants.
2. In chat, call `control_status` (ops-control) and one provider read tool, such as `github_whoami`. Both must answer; that proves the shared read server and Cursor's MCP connection work.
3. Tell the user what is ready, what they skipped, and that updates are `git pull` in the checkout followed by Developer: Reload Window.

If a read tool fails to connect, follow the troubleshooting section of `ops-onboarding`. The usual cause is a server Cursor tried while the read server was still starting; toggling it off and on in Settings → MCP reconnects it.

## Change the suite

- Toolchain: Node 24 runs the `.ts` files directly, strict TypeScript 7, Biome, Vitest, prek. Run `pnpm install` and `pnpm exec prek install` once.
- `packages/core` is the single source; `lib/core` in each plugin is generated. After editing core or `templates/_shared/standards`, run `pnpm run sync`, then `pnpm run format`, then `pnpm run sync` again.
- A provider plugin is `provider.ts`: tools, shell rules, `setup` install recipes and, where it needs a sign-in or a local toolchain, `onboarding` (the read tool that proves readiness, the sign-in command, the setup skill). `test/providers.test.ts` covers every provider plugin: a recipe for each binary, and onboarding tools and skills that exist. `pnpm run new-plugin` scaffolds both.
- `pnpm run ci` must pass before a PR. Branches, PR targets and merge methods follow the [GitOps](README.md#gitops) section.
- Code and docs describe the current state only: no history, no compatibility shims, no stale docs.
