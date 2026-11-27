---
name: msgraph-setup
description: Set up, sign in to or switch accounts for the ops-msgraph tools (Outlook mail, calendar and Microsoft Teams through Microsoft Graph and the m365 CLI). Use when msgraph_whoami reports that m365 is not logged in, a Graph call fails with 401/403 or consent errors, or the user wants to add or switch between work and personal accounts.
---

# Microsoft Graph setup

The ops-msgraph tools call Microsoft Graph through the [CLI for Microsoft 365](https://pnp.github.io/cli-microsoft365/) (`m365`). The CLI owns sign-in and the token cache; never read, print or copy tokens or the `~/.cli-m365-*.json` files, and never create app secrets for the user.

## 1. Install
`ops setup ops-msgraph`, then `m365 version`. Optional: `m365 cli config set --key disableTelemetry --value true`.

## 2. Entra app (once per user or tenant)
m365 signs in with an Entra app registration the user owns. Either run `m365 setup` and let it create one, or register it by hand in the Entra admin center (App registrations, New registration):

- Supported account types: "Accounts in any organizational directory and personal Microsoft accounts" when the user also wants a personal Outlook.com account; otherwise "this organizational directory only".
- Authentication: add the "Mobile and desktop applications" platform with redirect URI `http://localhost`, and set "Allow public client flows" to Yes.
- API permissions, Microsoft Graph, delegated: `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `People.Read`, `Chat.ReadWrite`, `ChannelMessage.Send`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `offline_access`. `ChannelMessage.Read.All` (reading channel posts) needs admin consent; leave it out if the user can't get it.

Personal accounts only support the mail, calendar and profile permissions; Teams tools work with work or school accounts only.

## 3. Sign in
Name every connection after the account itself (usually the email), never a shared label like `personal` or `work` when more than one account of that kind exists. Connection names may include letters, digits, spaces, `_`, `.`, `@` and `-`.

The user runs these in their own terminal (they open a browser or show a device code). Reuse the same Entra `--appId` for each login:

- Work / school: `m365 login --appId <app-id> --tenant <tenant-id> --connectionName <you@contoso.com>`
- Personal (Outlook.com / MSA): `m365 login --appId <app-id> --tenant consumers --connectionName <you@outlook.com>`

Repeat the personal line once per Microsoft account, each with its own `--connectionName`. To replace a badly named connection: `m365 connection remove --name <old-name> --force`, then sign in again with the email as the name.

Then call `msgraph_whoami` to confirm the active account, and `msgraph_connection_list` to see all names.

## 4. Switch accounts
Every tool acts as the active m365 connection. `msgraph_connection_list` shows them; `msgraph_connection_use` (write, needs approval) switches. Say which account is active before any write.

## 5. Settings (`~/.ops/config.json`)
```json
{ "providers": { "msgraph": { "timeZone": "America/New_York", "scope": { "allowedRecipientDomains": ["contoso.com"] } } } }
```
- `timeZone`: default zone for calendar tools (else this machine's zone).
- `scope.allowedRecipientDomains`: mail, replies, forwards and invitations may only reach these domains (and their subdomains).

## Troubleshooting
- `Log in to Microsoft 365 first`: step 3.
- `403` / `Access is denied` / `AADSTS65001`: the app lacks a permission above or it needs admin consent; add it, then sign in again.
- Teams tools fail on a personal account: expected.
