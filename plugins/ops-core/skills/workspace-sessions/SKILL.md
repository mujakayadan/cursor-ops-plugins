---
name: workspace-sessions
description: Set up Cursor as a chatbot, with one Agents Window and one folder-backed agent per topic. Use when the user wants a workspace, a session per topic, separate chats per subject, or a setup guide other people can follow.
---

# Workspace sessions

The Agents Window is the chatbot. Open it once (Command Palette → Open Agents Window). A topic is one agent, and that agent's workspace is its own folder. Cursor keeps the chat with the workspace, so continue that same agent to keep the session and its transcript.

A directory that holds the topic folders is a shelf. Opening the shelf, or a `.code-workspace` that lists every topic, is one workspace and one history for all of them.

1. Create a folder for the topic and leave it at that path. Moving or renaming it starts a new workspace, and the existing chats stay on the old path.
2. In the Agents Window, start an agent on that folder.
3. Next time, open the Agents Window and continue that agent. Search there reaches chats across workspaces.

Add a folder only for a topic the user named.

## With this suite

The loader runs when a workspace opens, so the enabled plugins are in each topic folder. Nothing is copied per topic.

`memory_remember` writes the machine knowledge graph, which every workspace can read. A fact that belongs to one topic stays in that agent's transcript, or in a file in that folder.

Two agents in one checkout use `ops worktree add` so they do not share a working tree. A topic folder has no worktree of its own.

Keep machine paths out of a public repository. The folders stay on the user's machine.
