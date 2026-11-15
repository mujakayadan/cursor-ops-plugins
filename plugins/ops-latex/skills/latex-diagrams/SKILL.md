---
name: latex-diagrams
description: Design and build complicated technical diagrams in LaTeX/TikZ with the ops-latex tools, meaning figures that need precise layout, grouping, parallel or skip paths, math labels, 3D blocks or publication quality (deep-learning architectures, block diagrams, detailed system figures, circuits, commutative diagrams). Use whenever a diagram is too complex for Mermaid's automatic layout.
---

# LaTeX/TikZ diagrams

TikZ is for diagrams where you decide the layout: exact alignment, nested groups, routed paths, math labels, 3D shapes and vector output for papers, slides and docs. Design each figure for the content in front of you. Don't force it into a stock shape.

## Workflow

1. **Understand the structure** before drawing. List the components, how they connect, what repeats, what is grouped, and what the reader must see first (the main flow). Sketch the grid in your head: which axis is the main flow (bottom-to-top, left-to-right) and which components share a row or column.
2. **Write the source** where figures live (e.g. `figures/<name>.tex`) as a `standalone` document (see the skeleton below). For a quick sketch, pass `source` to `latex_preview` with just TikZ commands. It's wrapped in `standalone` with `arrows.meta`, `positioning`, `fit`, `backgrounds`, `calc`, `shapes`, `decorations.pathreplacing`, `matrix` and `shadows`. Single-line `\usepackage`, `\usetikzlibrary` and `\definecolor` lines are moved into the preamble.
3. **Preview:** `latex_preview` with `file`. You get a PNG, or errors with `file:line`, missing packages and an install hint.
4. **Read the PNG** and review it like a reader would. Check that:
   - no text or blocks overlap;
   - arrows enter and leave the intended sides, and skip paths don't cross labels;
   - spacing and colors are consistent, and the main flow is obvious;
   - labels are readable at the final size.

   Iterate until it's clean. Complex figures usually take several rounds.
5. **Export:** `latex_render` to `.pdf` (papers; embed with `\includegraphics`), `.svg` (web and docs) or `.png` (`dpi` 300, `transparent` for slides). Commit the `.tex` source next to the export.

## Skeleton

```latex
\documentclass[tikz,border=8pt]{standalone}
\usepackage{amsmath,amssymb}
\usetikzlibrary{arrows.meta,positioning,fit,backgrounds,calc,shapes.geometric}
\definecolor{blockA}{HTML}{DCE8F7}  % one fill per component kind
\definecolor{blockB}{HTML}{FCE5CD}
\begin{document}
\begin{tikzpicture}[
  font=\sffamily\small, node distance=6mm and 10mm, >={Stealth[length=2.2mm]},
  box/.style={draw, rounded corners=2pt, minimum width=28mm, minimum height=7mm, align=center},
  kindA/.style={box, fill=blockA}, kindB/.style={box, fill=blockB},
  op/.style={draw, circle, inner sep=1pt},
  group/.style={draw, dashed, rounded corners=4pt, inner sep=3mm},
]
  % nodes, then paths, then groups on the background layer
\end{tikzpicture}
\end{document}
```

## Techniques

- **Styles first.** Define one style per component kind and a small palette. Each component then takes one `\node[kindA] (id) {Label};` line, and a restyle is a one-line change.
- **Relative placement.** Use `above=of a`, `right=12mm of b` and `below=of a.south west, anchor=north west`. Place midpoints with `calc` (`($(a)!0.5!(b)$)`). Anchor whole columns or lanes with absolute coordinates, such as `(0,0)` and `(70mm,0)`, and place everything else relative to them.
- **Grids** of similar items (layers, timesteps, lanes, matrix cells): use `\foreach` with computed positions, or `matrix of nodes`.
- **Branch points and routing.** Name branch points with `\coordinate`. Use `|-` and `-|` for orthogonal paths, `rounded corners` for clean bends, and `to[out=..,in=..]` for arcs over blocks. Route skip and feedback paths outside the main column so they never cross labels. Draw paths after all nodes so they sit on top of the layout you meant.
- **Grouping and repetition.** Use `\begin{scope}[on background layer] \node[group, fit=(first)(last)] (g) {}; \end{scope}`, then label it (`$N\times$`, "Encoder", "Stage 2") at a corner with `anchor`. Show stacked or parallel copies with `double copy shadow`, and group spans with `decorate, decoration={brace}`.
- **Operators and junctions:** small circle nodes with math (`$+$`, `$\times$`, `$\oplus$`, `$\Sigma$`).
- **Math and annotations:** label edges and blocks with shapes, dimensions or symbols in math mode (`$B{\times}T{\times}d$`, `$h_{t-1}$`, `$H(s)$`). Use `\scriptsize` for secondary annotations, and keep to two font sizes at most.
- **3D and volumetric blocks** (feature maps, tensors, stacked planes): draw a cuboid with a macro, then chain calls along x.

  ```latex
  \newcommand{\cuboid}[6]{% name, x, width, height, depth, color
    \coordinate (#1-f) at (#2,0);
    \fill[#6!35] (#2,-#4/2) rectangle ++(#3,#4);
    \fill[#6!55] (#2,#4/2) -- ++(#5,#5*0.6) -- ++(#3,0) -- ++(-#5,-#5*0.6) -- cycle;
    \fill[#6!20] (#2+#3,-#4/2) -- ++(#5,#5*0.6) -- ++(0,#4) -- ++(-#5,-#5*0.6) -- cycle;
    \draw (#2,-#4/2) rectangle ++(#3,#4)
          (#2,#4/2) -- ++(#5,#5*0.6) -- ++(#3,0) -- ++(0,-#4) -- ++(-#5,-#5*0.6)
          (#2+#3,#4/2) -- ++(#5,#5*0.6);
    \coordinate (#1-in) at (#2,0); \coordinate (#1-out) at (#2+#3+#5/2,#5*0.3);}
  ```
  Connect blocks with `\draw[->] (a-out) -- (b-in);`. `out` is the middle of the side face, so the arrow never crosses its own block.
- **Plots inside diagrams** (curves, heatmaps, distributions): use `pgfplots` (`\usepackage{pgfplots}` and `\pgfplotsset{compat=1.18}`). Heatmaps use `matrix plot*`.
- **Specialized packages** when they fit (check with `latex_status` `packages`): `tikz-cd` for commutative diagrams, `circuitikz` for circuits, `tikz-3dplot` for true 3D, and `pgf-umlsd` for formal UML sequences.

## Readability

- One main flow direction. Secondary paths (skips, feedback, optional) are visually quieter: thinner, dashed or gray.
- Align what is parallel and make identical components identical in size. Leave at least 4–6 mm between neighbors.
- Color encodes kind, not decoration. Use 3–5 fills plus a neutral, and avoid pure saturated colors.
- If one figure tries to show both the overview and the internals, split it in two, or zoom the detail out to the side with dashed connector lines.

## Troubleshooting

- **Missing package:** the result lists `missingFiles` and an `installHint`. Ask the user before installing; the guard asks too. Compiles never install packages on their own.
- **`I do not know the key '/tikz/...'`:** a TikZ library is missing; add it to `\usetikzlibrary`.
- **`Dimension too large`:** a coordinate or pgfmath value is huge. Check units (mm vs. cm) and divisions.
- **Labels overlap:** increase `node distance` or `minimum width`, use `align=center` with `\\` line breaks, or move labels with `label={[font=\scriptsize]below:...}`.
- **Shell escape** is always off (no `\write18`, `minted` or `--shell-escape`). Use `listings` for code.
