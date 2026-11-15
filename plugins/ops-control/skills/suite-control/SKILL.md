---
name: suite-control
description: Inspect and adjust the ops plugin suite with the ops-control tools. Use when the user asks which ops plugins are installed or loaded, why a plugin or review is missing, what the guardrails allowed or blocked, what the reviews found, or to turn a review lens or a plugin on or off.
---

# Suite control

## Inspect

- `control_status` answers "what is installed and on": the suite checkout and branch, whether the `workspaceOpen` loader is registered, whether the shared read server is up and on the current commit, every plugin with its version and enabled state, the review settings, and which providers have privileged tools enabled.
- `control_audit` answers "what happened": guard decisions (`source: "hook"`, filter `decision: "deny"` or `"ask"`), MCP tool calls (`"mcp"`), finished shell commands (`"shell"`) and MCP results (`"mcp-hook"`). Records are already redacted; quote them, never try to recover what was redacted.
- `control_reviews` answers "what did the reviews see": per conversation, the files and static hints each lens recorded and the review requests sent.

## Change

Each change asks the user for approval.
- `control_review_set` turns reviews or a single lens (`security`, `performance`, `standards`, `docs`) on or off, or tunes `maxRounds`, `minChangedLines` and `maxFiles`. It applies from the next prompt.
- `control_plugin_set` chooses whether a plugin loads in every workspace. `ops-core` and `ops-control` always load. It applies after Developer: Reload Window; say so.

## Not here

These stay with the user, outside the agent:
- the guardrail overrides, privileged tools (`allowPrivileged`), credentials, scope and third-party MCP policy in `~/.ops/config.json`;
- installing the loader. If `control_status` reports it unregistered, ask the user to run `pnpm run install-local` in the suite checkout and reload the window.

Never work around this by editing those files from the shell; the guardrails deny it.
