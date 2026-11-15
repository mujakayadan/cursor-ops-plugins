---
name: latex-documents
description: Write and build LaTeX documents (papers, reports, theses, CVs, slides) with the ops-latex tools; compile, read errors, fix layout and export PDFs. Use when the user works on .tex files, a bibliography, or asks to typeset a document.
---

# LaTeX documents

## Workflow

1. **Check the toolchain once:** `latex_status`. It reports the distribution, engines, biber/bibtex, converters and whether key packages are installed.
2. **Compile and look:** `latex_preview` with `file` (the main `.tex`) and `pages` (up to 10). It runs the engine directly from the file's directory: shell escape off, references rerun automatically, biber or BibTeX run once when the document uses them. Read the page PNGs to check layout.
3. **Fix the first error first.** Errors come with `file:line` and the offending source line (`context`). Later errors are usually knock-on effects.
4. **Clean warnings:** undefined references or citations, overfull boxes (`overfull` count) and font substitutions.
5. **Export:** `latex_render` to `.pdf` next to the source (aux files stay in a temp directory), or a single page to `.png`/`.svg`.

## Engine

The engine is chosen automatically: a `% !TEX program = lualatex` comment wins, `fontspec`, `unicode-math` or `polyglossia` select `xelatex`, and everything else uses `pdflatex`. Pass `engine` to override it, or set `providers.latex.engine`.

## Good defaults

- `\documentclass{article}` (or `report`/`book`), `\usepackage[utf8]{inputenc}` only for pdflatex on old distributions, `\usepackage{microtype}` for better line breaking, `\usepackage{hyperref}` last, and `\usepackage[capitalise]{cleveref}` after it.
- Bibliography: `\usepackage[backend=biber,style=numeric]{biblatex}`, `\addbibresource{refs.bib}`, `\printbibliography`. Cite with `\cite{key}` or `\textcite{key}`.
- Figures: render diagrams to PDF with `latex_render` and include them with `\includegraphics[width=\linewidth]{figures/model.pdf}`. Put the TikZ source in its own `standalone` file so it previews quickly on its own.
- Use `\label` and `\cref` instead of hard-coded numbers, and `\SI`/`\num` (`siunitx`) for units and numbers.
- Split long documents with `\input{sections/intro}`; previews follow `\input` relative to the main file.

## Common errors

| Error | Fix |
| --- | --- |
| `Undefined control sequence` | Typo, or a missing `\usepackage`. |
| `File 'x.sty' not found` | Install the package (see `installHint`); ask the user first. |
| `Missing $ inserted` | Math outside math mode, usually `_` or `^` in text; escape it as `\_`. |
| `Overfull \hbox` | Rephrase, use `\sloppy` locally, allow `\-` hyphenation, or let `microtype` handle it. |
| `Citation 'x' undefined` | Wrong key, or `refs.bib` isn't next to the main file. |
| `Too many }'s` / `Runaway argument` | Unbalanced braces near the reported line. |
