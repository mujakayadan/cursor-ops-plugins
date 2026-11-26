---
name: rea-usage
description: >-
  Use the Reverse Engineer Anything (REA) MCP for binaries, packaged apps,
  JavaScript/Electron trees, firmware and live web captures when source alone
  is not enough. Call REA tools; do not reimplement them. Use when the user
  asks to reverse engineer, decompile, inspect a shipped artifact, or build an
  AgentEnv from a live app or capture.
---

# REA

This plugin pins the upstream [REA](https://github.com/morluto/rea) MCP (`rea-agents`). Use its tools as documented by that server.

## When to use

- Shipped binaries, archives, APK/IPA, Electron/`asar`, Bun/Deno compile outputs
- JavaScript application trees that need graph or decompilation evidence
- Live web application or capture analysis (AgentEnv) when the user supplies a target

Skip REA for ordinary analysis of a complete source repository already open in the workspace.

## How

1. Confirm the `rea` MCP server is connected (Settings → MCP). If it is missing, enable the Ops: REA plugin and restart Cursor.
2. Call the REA tools this session exposes. Prefer the server’s schemas over inventing CLI flags.
3. For native engines or doctor failures, follow upstream REA setup (`npx rea-agents@latest doctor` / docs). This suite does not install Ghidra, IDA or similar.

REA is a third-party MCP under suite `thirdPartyMcp` policy. Do not paste secrets from artifacts into chat.

## Upstream pin

`plugins/ops-rea/mcp.json` pins `rea-agents@…`. Bump that version to sync upstream; do not vendor REA source into this repo.
