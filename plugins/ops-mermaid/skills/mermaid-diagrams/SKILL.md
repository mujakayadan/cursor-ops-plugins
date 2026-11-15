---
name: mermaid-diagrams
description: Write, validate and render Mermaid diagrams (flowchart, sequence, state, class, ER, Gantt, git graph, mind map, timeline) with the ops-mermaid tools. Use when the user asks for a diagram, chart or flow in Markdown, docs or a README, or to fix a Mermaid parse error. Neural-network architectures go to the latex-diagrams skill instead.
---

# Mermaid diagrams

## Pick the tool first

Mermaid suits boxes and arrows with automatic layout. If the diagram is a **neural-network or deep-learning architecture** (transformer, attention, CNN, encoder-decoder, MLP, U-Net) or needs math, precise alignment or stacked/3D blocks, stop and use the `latex-diagrams` skill (ops-latex). The Mermaid tools refuse architecture-like diagrams unless the user explicitly asked for Mermaid (`force: true`).

| Need | Mermaid type |
| --- | --- |
| Process, decision, pipeline | `flowchart LR` / `flowchart TB` |
| Requests between services over time | `sequenceDiagram` |
| Lifecycle or state machine | `stateDiagram-v2` |
| Data model | `erDiagram` |
| Code structure | `classDiagram` |
| Schedule | `gantt` |
| Branching strategy | `gitGraph` |
| Brainstorm or hierarchy | `mindmap` |
| Events over time | `timeline` |

## Workflow

1. **Write the source** where it will live: a ```mermaid fence in Markdown (renders on GitHub and in most doc sites) or a `.mmd` file when an image file is needed.
2. **Preview:** call `mermaid_preview` with `file` (a `.md` file previews every block) or `source`. It returns a PNG per diagram, or the parse error with its line.
3. **Look at the PNG** (read the file) and fix crossing edges, cramped labels, the wrong direction or an unreadable size. Preview again.
4. **Export** only when a file is needed (slides, papers, docs without Mermaid support): `mermaid_render` to `.svg` (default for the web), `.png` (`scale` 2–3) or `.pdf`.

## Syntax that avoids most errors

- Quote labels with special characters: `A["Load (cached)"]`, `B["x > 0?"]`. Use `<br/>` for line breaks inside quotes.
- Node ids are plain words (`apiGateway`); put the text in the label. Don't use `end` as an id (write `End` or `done`).
- Edge labels: `A -->|yes| B` or `A -- yes --> B`. Dotted: `-.->`, thick: `==>`, invisible spacer: `A ~~~ B`.
- Group with `subgraph id["Title"] ... end`; set `direction LR` inside a subgraph to change its layout.
- Style with classes rather than per-node styles: `classDef store fill:#eef,stroke:#88a` then `class db,cache store`.
- Theme and options go in front matter at the top:
  ```
  ---
  config:
    theme: neutral
  ---
  flowchart LR
  ```
- Sequence: `participant`/`actor`, `->>` for calls, `-->>` for replies, `activate`/`deactivate`, `alt`/`else`/`end`, `loop`, `Note over A,B: text`.
- ER: `CUSTOMER ||--o{ ORDER : places` (cardinality on both sides).

## Layout tips

- Keep 5–15 nodes per diagram. Split bigger ones into an overview plus detail diagrams.
- Choose `LR` for pipelines and `TB` for hierarchies. Long horizontal flows render tiny on GitHub.
- Order node declarations in reading order; Mermaid's layout follows declaration order.
- GitHub may lag the latest Mermaid release. Avoid brand-new diagram types (for example `architecture-beta`) in Markdown meant for GitHub; export an SVG instead.
- Add `accTitle:` and `accDescr:` lines for accessibility in published docs.
