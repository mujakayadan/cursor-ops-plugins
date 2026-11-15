---
name: latex-diagrams
description: Build complex technical diagrams in LaTeX/TikZ with the ops-latex tools, especially deep-learning architectures (transformers, attention, encoder-decoder, CNNs, RNNs, MLPs, U-Nets, diffusion pipelines) and figures that need math, tensor shapes or precise layout. Use whenever the user asks for a model architecture diagram or a publication-quality figure.
---

# LaTeX/TikZ diagrams

Deep-learning and other complex diagrams are drawn in TikZ, not Mermaid: TikZ gives exact alignment, stacked and 3D blocks, math labels and vector output that works in papers and slides.

## Workflow

1. **Start from a template.** Call `latex_templates` to list them (`transformer`, `attention`, `cnn`, `mlp`), then `latex_templates` with `name` for the source. Templates are self-contained `standalone` documents that compile as-is.
2. **Save it in the repo** where figures live (e.g. `figures/model.tex`) and adapt it: block names, layer counts, tensor shapes, colors.
3. **Preview:** `latex_preview` with `file`. It compiles in a temporary directory and returns a PNG, or errors with `file:line`, missing packages and an install hint.
4. **Read the PNG** and check it like a reviewer would: no overlapping text or blocks, arrows enter and leave the intended sides, residual and skip paths don't cross labels, consistent spacing and colors, and labels readable at the final size. Iterate until it's clean.
5. **Export:** `latex_render` to `.pdf` (papers; vector, embed with `\includegraphics`), `.svg` (web and docs) or `.png` (`dpi` 300, `transparent` for slides). Commit the `.tex` source next to the export.

For a one-off sketch, pass `source` with just a `tikzpicture` or bare TikZ commands. It's wrapped in a `standalone` document with `arrows.meta`, `positioning`, `fit`, `backgrounds`, `calc`, `shapes`, `decorations.pathreplacing`, `matrix` and `shadows`.

## Conventions

- **Styles at the top.** Define `\tikzset{...}` styles per block kind (attention, feed-forward, norm, embedding, conv, pool, linear, softmax) and `\definecolor` a palette. Then each block is one `\node[attn] (name) {...};` line.
- **Relative placement.** `above=6mm of x`, `right=of y`, `($(a)!0.5!(b)$)`. Use absolute coordinates only to anchor whole columns, such as encoder at `(0,0)` and decoder at `(64mm,0)`.
- **Named anchors and coordinates** (`\coordinate (branch) at ...`) for branch points, so residual paths and Q/K/V splits stay aligned when blocks move.
- **Repetition:** wrap a repeated block in a `fit` node (`fit=(first)(last)`, on the background layer) and label it `$N\times$`. Show parallel heads with `double copy shadow`.
- **Paths:** `-{Stealth}` arrows. Draw orthogonal residuals as `(branch) -- ++(-22mm,0) |- (target.west)`, rounding corners with `rounded corners=4pt`. Dash optional paths (`dashed`).
- **Shapes and math:** annotate tensors like `$B{\times}T{\times}d$`, write operators as circle nodes (`$+$`, `$\oplus$`, `$\otimes$`), and put equations in math mode under the figure.
- **Fonts:** `every node/.style={font=\sffamily\small}` for a modern look; keep two sizes at most.
- **3D feature maps:** reuse the `\fmap` cuboid macro from the `cnn` template (thickness = channels, face = spatial size).
- **Plots** such as loss curves or attention heatmaps: `pgfplots` (`\usepackage{pgfplots}` and `\pgfplotsset{compat=1.18}`); heatmaps use `matrix plot*`.

## Architecture recipes

| Diagram | Base | Key pieces |
| --- | --- | --- |
| Transformer / BERT / GPT | `transformer` | Delete the decoder for encoder-only. For decoder-only (GPT), keep masked attention and drop cross-attention. Pre-norm: put the Norm before the sublayer. |
| Vision Transformer | `transformer` encoder | Add patch tiles, a linear projection, a `[CLS]` token and position embeddings at the bottom, and an MLP head on top. |
| Attention internals | `attention` | Scaled dot-product steps, `h` stacked heads, Concat and Linear. Add the equation. |
| CNN / ResNet | `cnn` | Chain `\fmap` calls. Draw skip connections as arcs over blocks: `(a-out) to[out=60,in=120] (b-in)`. |
| U-Net | `cnn` | Encoder going down, decoder going up, horizontal copy-and-crop arrows between levels. |
| MLP / autoencoder | `mlp` | Change `\layers`. Mirror the layers for an autoencoder and highlight the bottleneck. |
| RNN / LSTM | blank snippet | Unrolled cells in a row, `$h_{t-1} \to h_t$` arrows, gates as small labelled circles. |
| Diffusion / pipelines | blank snippet | Stages as blocks, `decorate` braces for grouping, dashed for sampling loops. |

## Troubleshooting

- **Missing package:** the result lists `missingFiles` and an `installHint`. Ask the user before installing; the guard asks too. Compiles never install packages on their own.
- **`I do not know the key '/tikz/...'`:** a TikZ library is missing; add it to `\usetikzlibrary`.
- **`Dimension too large`:** a coordinate or pgfmath value is huge. Check units (mm vs. cm) and divisions.
- **Labels overlap:** increase node distances or `minimum width`, use `align=center` with `\\` line breaks, or move labels with `label={[font=\scriptsize]below:...}`.
- **Shell escape** is always off (no `\write18`, `minted` or `--shell-escape`). Use `listings` for code.
