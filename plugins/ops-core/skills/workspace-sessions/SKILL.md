---
name: workspace-sessions
description: Give each topic its own Cursor session by opening one folder, or one saved multi-root workspace, per topic. Use when the user wants a workspace, a session per topic or project, separate chats per subject, or a setup guide other people can follow.
---

# Workspace sessions

Cursor keeps agent chat with the workspace that is open. One topic is one session. A second topic is a second folder, opened in its own window. Chats do not cross between them.

## One folder, one session

1. Pick a stable folder for the topic. Put that topic's repositories in it, or leave them where they are and point a workspace file at them.
2. Open that folder: File → Open Folder, or Agents Window → Open Folder. That open is the session.
3. Leave the path where it is. Moving or renaming the folder starts a new workspace, and the old chats stay on the old path.

Do not put every topic in one window. A multi-root workspace is one session that spans several folders, for a change that has to touch them together.

## Several repositories, one topic

Save a workspace file inside the topic folder:

```json
{
  "folders": [
    { "name": "api", "path": "api" },
    { "name": "web", "path": "web" }
  ]
}
```

Paths are relative to the file. Open it from the editor with File → Open Workspace from File. The Agents Window folder picker accepts folders, not workspace files. After the editor has opened the file once, that workspace shows up as an agent target. Turning a single-folder window into a multi-root workspace creates a new identity, and the chat that was open stays on the original folder.

## With this suite

The loader runs on every workspace open, so each topic session gets the enabled plugins. Nothing is copied per topic.

A topic session is not a git worktree. Two agents in one checkout still use `ops worktree add` so they do not share a working tree. A topic that is a different folder needs no worktree.

When you create the folders for the user, open each one. Keep machine paths out of a public repository; the guide stays portable, and the workspace files stay on their machine.
