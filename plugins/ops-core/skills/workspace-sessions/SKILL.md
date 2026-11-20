---
name: workspace-sessions
description: Set up one Cursor workspace as a chatbot, with one folder per topic session. Use when the user wants a workspace, a session per topic, separate chats per subject, or a setup guide other people can follow.
---

# Workspace sessions

One folder is the workspace. Open it once and use that window as a chatbot. Every topic chat lives there.

A topic is a folder inside that workspace. Start the agent on that folder from the same window. The chat stays with the folder. A new topic is a new folder. Leave the path where it is; moving or renaming the folder starts a new workspace, and the existing chats stay on the old path.

Open the Agents Window on the workspace (Command Palette → Open Agents Window). Pick the topic folder as that agent's target. Stay in that one window. Add a folder only for a topic the user named.

## With this suite

The loader runs on every workspace open, so the enabled plugins are in that workspace. Nothing is copied per topic.

Two agents in one checkout use `ops worktree add` so they do not share a working tree. A topic folder has no worktree of its own.

Keep machine paths out of a public repository. The workspace stays on the user's machine.
