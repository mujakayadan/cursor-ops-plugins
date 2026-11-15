---
name: model-routing
description: Choose the Cursor model and effort for a task and its subtasks from the signed-in plan and remaining included usage. Use when starting a substantial task, launching a subagent, or deciding between Composer, Grok and a third-party model.
---

# Model routing

Included Cursor models draw from the subscription pool: Grok 4.7, Grok 4.6, Grok 4.5 and Composer 2.5. Third-party models (Claude, GPT, Gemini, Muse and the rest) are not in that pool. On plans that list them, they bill from prepaid credit at API price. Fast mode and the 500k window each multiply the draw, so they stay off unless the route sets them.

The chat model is the picker. This skill cannot switch it. A subagent model is chosen with the Task `model` argument, and only when the route returns a `taskModel`.

## 1. Read the account

Call `models_account` once per conversation before the first substantial task. It runs `agent about` and `agent models`. When the CLI is missing, the plan is unknown: stay on included models at medium effort, and give the user the install URL from the tool result. Do not pipe the install script, and do not read Cursor's local auth database.

## 2. Route each task

Call `models_route` with:

- `task`: `routine` (mechanical edits, lookups, one obvious fix), `implementation` (a normal change), `parallel` (independent read-only subtasks), `hard` (architecture, an ambiguous production bug, a security-sensitive change), or `frontier` (the user named a third-party model, or Grok 4.7 at high effort already failed the same hard problem).
- `subagents`: the model ids this session is allowed to launch.
- `prefer` when the user named a model.
- `longContext` only when the input cannot fit in 256k.

Then:

- Work on the current chat model when it is in the same family as `model` (Grok or Composer). When it is a third-party model and `billing` is `included`, say once which included model to switch the picker to, and keep going.
- Pass `taskModel` to a subagent only when it is non-null. Otherwise omit `model` so the subagent inherits the chat model. Do not pass a high-fast slug just because it is the only Grok id in the allowlist.
- Launch a subagent for `parallel` work or for a `hard` task whose `taskModel` is set. Do the `routine` and `implementation` work in this chat.
- When `billing` is `blocked`, do not call the third-party model. The `reason` says what to use instead.
- When `billing` is `credit`, the user named that model and the account lists it. Use it for that task only.

## 3. Effort

Medium effort is the default. High effort is only for `hard` and named-model `frontier` tasks, and only when the route's `effort` is `high` (Premium and above, and the included pool is not tight). Plus fixes effort at medium and disables fast mode and the 500k window; do not work around that. Never turn fast mode on to retry a failure.
