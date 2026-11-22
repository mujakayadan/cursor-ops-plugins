---
name: workspace-sessions
description: Set up Cursor as a chatbot in the editor, with one folder and its chats per topic, kept on this machine. Use when the user wants a workspace, a session per topic, separate chats per subject, or a setup guide other people can follow.
---

# Workspace sessions

Use the editor. A topic is a folder. Open that folder with File → Open Folder. The chats in that window are the session, and they run on this machine. Close the window when you stop. Open the same folder again to continue those chats.

A directory that holds the topic folders is a shelf. Opening the shelf, or a `.code-workspace` that lists every topic, is one workspace and one history for all of them.

Leave the folder at that path. Moving or renaming it starts a new workspace, and the existing chats stay on the old path.

Add a folder only for a topic the user named.

The Agents Window is a different surface. A cloud agent there edits a remote checkout, not the files on this machine, and Move to → Local appears only when a local agent for that same repo is already open. The suite loads through the editor's `workspaceOpen` hook, and guardrail and review hooks run in the editor. An Agents Window chat does not get that loader or those hooks the same way. For a topic chat that stays on this machine with the suite, stay in the editor.

## With this suite

The loader runs when a workspace opens, so the enabled plugins are in each topic folder. Nothing is copied per topic.

`memory_remember` writes the machine knowledge graph, which every workspace can read. A fact that belongs to one topic stays in that agent's transcript, or in a file in that folder.

Two agents in one checkout use `ops worktree add` so they do not share a working tree. A topic folder has no worktree of its own.

Keep machine paths out of a public repository. The folders stay on the user's machine.
