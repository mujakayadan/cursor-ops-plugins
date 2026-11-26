---
name: inhouse-setup
description: >-
  Sign in to ops-inhouse: store INHOUSE_ACCESS_TOKEN from a browser session and
  verify with inhouse_status / inhouse_whoami. Use when setting up Inhouse tools,
  fixing 401s, or the user asks how to authenticate.
---

# Inhouse setup

`ops-inhouse` calls `https://api.inhouse.ai` with a Bearer JWT. Inhouse does not ship a public OAuth client for third-party CLIs the way Google (`gog auth add`) or Microsoft (`m365 login`) do, so sign-in is: browser session → copy `accessToken2` → user environment variable.

Never paste the token into Cursor chat.

## Sign in (preferred)

From the suite checkout:

```powershell
node plugins/ops-inhouse/login.ts
```

That opens [platform.inhouse.app](https://platform.inhouse.app), asks you to paste `accessToken2` from DevTools → Application → Local Storage, and stores `INHOUSE_ACCESS_TOKEN` with the OS user-environment API. Do **not** use `setx` — it truncates JWTs longer than ~1024 characters.

Then **quit Cursor completely and reopen it**. Call `inhouse_status` (ready true) and `inhouse_whoami`.

## Manual (Windows)

```powershell
[Environment]::SetEnvironmentVariable('INHOUSE_ACCESS_TOKEN', '<jwt>', 'User')
```

Optional: `INHOUSE_API_URL` (https only, or http on localhost; default `https://api.inhouse.ai`).

## Official connector

The separate Cursor Inhouse MCP (`user-inhouse`) uses Clerk OAuth in the browser. It is independent of `INHOUSE_ACCESS_TOKEN`. You can use both.

## Failures

- `ready: false`: token unset in the process Cursor launched; quit/reopen after setting the user variable.
- `401`: token expired; run `login.ts` again with a fresh `accessToken2`.
- Plugin missing: enable Ops: Inhouse from the suite marketplace and ensure the checkout includes that plugin (pull `main` / reload).
