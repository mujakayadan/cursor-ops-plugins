---
name: google-setup
description: Set up, sign in to or troubleshoot the ops-google tools (Gmail, Calendar, People/contacts, Meet and Drive through the gog CLI). Use when google_whoami reports that gog is not authorized, a Google call fails with 401/403 or consent errors, or the user wants to add another Google account.
---

# Google setup

The ops-google tools call Gmail, Calendar, People (contacts), Meet and Drive through [gog](https://gogcli.sh/) (`gog`). The CLI owns OAuth and the token cache; never read, print or copy refresh tokens, `client_secret_*.json` contents, or keyring material, and never create OAuth client secrets for a desktop app (public client only).

Google Chat is out of scope for this plugin.

## 1. Install
`ops setup ops-google`, then `gog --version`.

- Windows: winget package `steipete.gogcli`.
- macOS/Linux: `brew install openclaw/tap/gogcli`.
- Otherwise follow https://gogcli.sh/install.html.

## 2. Google Cloud project and OAuth client (once)
gog signs in with a Desktop OAuth client the user owns.

1. Open https://console.cloud.google.com/projectcreate and create a project (any name).
2. Enable APIs: Gmail API, Google Calendar API (`calendar-json.googleapis.com`), People API, Google Drive API, Google Meet API (API library → search each → Enable).
3. OAuth consent screen: User type **External**, add the user's email as a test user if the app stays in Testing. For personal ongoing use, open **Audience** and **Publish app** (In production) so refresh tokens do not expire after seven days; an unverified personal app still works for the owner (100-user lifetime cap, consent warning).
4. Create credentials: **OAuth client ID** → Application type **Desktop app** → Download JSON.
5. Store it (copies into gog's config; do not commit the file):

```powershell
gog auth credentials ~/Downloads/client_secret_*.json
```

## 3. Sign in
The user runs this in their own terminal (it opens a browser):

```powershell
gog auth add you@gmail.com --services gmail,calendar,drive,contacts,people,meet
```

Then call `google_whoami` to confirm. Optional: `gog auth manage` to set the default account when several are stored.

## 4. Settings (`~/.ops/config.json`)
```json
{ "providers": { "google": { "timeZone": "America/New_York", "scope": { "allowedRecipientDomains": ["example.com"] } } } }
```
- `timeZone`: default zone for calendar create when the tool call omits one.
- `scope.allowedRecipientDomains`: mail, forwards, invitations and Drive shares may only reach these domains (and their subdomains).

## Troubleshooting
- `gog is not authorized` / missing refresh token: step 3; if the Cloud app is still in Testing, publish it or re-run `gog auth add … --force-consent` weekly.
- `403` on `people/me` / missing `profile` scope: include `people` in `--services` (distinct from `contacts`) and re-run step 3 with `--force-consent`.
- `403` / insufficient scopes: re-run step 3 with the full `--services` list; enable the matching API on the Cloud project.
- Meet tools fail on a brand-new project: enable **Google Meet API**; calendar `--with-meet` still works via Calendar API for many personal accounts.
- Never paste `client_secret` JSON or tokens into chat.
