import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, join } from "node:path";
import { resolveBinary, runCommand } from "./lib/core/cli.ts";
import { absPath, checkPath, previewDir } from "./lib/core/paths.ts";
import { bool, int, list, obj, oneOf, str, ToolError, tool } from "./lib/core/schema-helpers.ts";
import type { Provider, ProviderConfig, ShellRule } from "./lib/core/types.ts";

const ENGINES = ["pdflatex", "xelatex", "lualatex"] as const;
type Engine = (typeof ENGINES)[number];

const COMPILE_TIMEOUT_MS = 180000;
const CONVERT_TIMEOUT_MS = 60000;
const MAX_RUNS = 4;
const MAX_SOURCE = 200000;
const OUTPUT_EXTENSIONS = new Set([".pdf", ".svg", ".png"]);
const DEFAULT_PACKAGES = ["tikz", "pgfplots", "standalone", "amsmath", "biblatex"];

const SNIPPET_PREAMBLE = String.raw`\documentclass[tikz,border=8pt]{standalone}
\usepackage{amsmath,amssymb}
\usetikzlibrary{arrows.meta,positioning,fit,backgrounds,calc,shapes.geometric,shapes.misc,decorations.pathreplacing,matrix,shadows}
`;

/** Single-line preamble commands a snippet may carry; they move above \begin{document}. */
const PREAMBLE_LINE = /^\s*\\(usepackage|usetikzlibrary|usepgfplotslibrary|definecolor)\b.*$/gm;

/**
 * A full document is returned unchanged. A TikZ snippet (a tikzpicture or bare TikZ commands)
 * is wrapped in a standalone document with the common TikZ libraries.
 */
export function wrapSnippet(source: string): string {
  if (/\\documentclass\b/.test(source)) return source;
  const preamble = source.match(PREAMBLE_LINE) ?? [];
  const body = source.replace(PREAMBLE_LINE, "").trim();
  const picture = /\\begin\{tikzpicture\}/.test(body)
    ? body
    : `\\begin{tikzpicture}\n${body}\n\\end{tikzpicture}`;
  return `${SNIPPET_PREAMBLE}${preamble.join("\n")}\n\\begin{document}\n${picture}\n\\end{document}\n`;
}

/** Engine from an explicit choice, a `% !TEX program` comment, the preamble, or the default. */
export function pickEngine(
  source: string,
  requested: Engine | undefined,
  pcfg: ProviderConfig,
): Engine {
  if (requested) return requested;
  const magic = source.match(/^%\s*!TEX\s+(?:TS-)?program\s*=\s*(pdflatex|xelatex|lualatex)\b/im);
  if (magic?.[1]) return magic[1] as Engine;
  if (/\\usepackage(\[[^\]]*\])?\{[^}]*\b(fontspec|unicode-math|polyglossia)\b/.test(source)) {
    return "xelatex";
  }
  const configured = pcfg.engine as Engine | null | undefined;
  return configured && ENGINES.includes(configured) ? configured : "pdflatex";
}

export interface LogEntry {
  file?: string;
  line?: number;
  message: string;
  context?: string;
}

export interface ParsedLog {
  errors: LogEntry[];
  warnings: string[];
  missingFiles: string[];
  overfull: number;
  underfull: number;
  pages?: number;
  rerun: boolean;
}

/** Errors, warnings, missing packages and the page count from a TeX log (file:line:error mode). */
export function parseLog(log: string): ParsedLog {
  const lines = log.split(/\r?\n/);
  const errors: LogEntry[] = [];
  lines.forEach((text, i) => {
    const fileLine = text.match(/^(.*?\.(?:tex|sty|cls|def|bbl|aux)):(\d+): (.+)$/);
    const bang = fileLine ? null : text.match(/^! (.+)$/);
    if (!fileLine && !bang) return;
    const contextLine = lines.slice(i + 1, i + 8).find((l) => /^l\.\d+/.test(l));
    const entry: LogEntry = { message: (fileLine?.[3] ?? bang?.[1] ?? "").trim() };
    if (/^(==> Fatal error occurred|Emergency stop)/.test(entry.message)) return;
    if (fileLine) {
      entry.file = fileLine[1] ?? "";
      entry.line = Number(fileLine[2]);
    }
    if (contextLine) entry.context = contextLine.trim();
    if (!errors.some((e) => e.message === entry.message && e.line === entry.line))
      errors.push(entry);
  });
  const missingFiles = [
    ...new Set([...log.matchAll(/File `([^']+)' not found/g)].map((m) => m[1] ?? "")),
  ];
  const warnings = [
    ...new Set(
      [...log.matchAll(/^(?:LaTeX|Package [\w-]+|Class [\w-]+) Warning: (.+)$/gm)]
        .map((m) => (m[1] ?? "").trim())
        .filter((w) => !/^Shell escape (disabled|feature is not enabled)/.test(w)),
    ),
  ];
  const pages = log.match(/Output written on .*?\((\d+) pages?/);
  const parsed: ParsedLog = {
    errors: errors.slice(0, 10),
    warnings: warnings.slice(0, 15),
    missingFiles,
    overfull: (log.match(/^Overfull \\[hv]box/gm) ?? []).length,
    underfull: (log.match(/^Underfull \\[hv]box/gm) ?? []).length,
    rerun: /Warning:(?:[^\n]|\n\([\w-]+\))*?(?:\brerun\b|\(re\)run)/i.test(log),
  };
  if (pages?.[1]) parsed.pages = Number(pages[1]);
  return parsed;
}

function available(bin: string): boolean {
  try {
    resolveBinary(bin);
    return true;
  } catch {
    return false;
  }
}

const distributions = new Map<string, string>();

/** "MiKTeX", "TeX Live" or "unknown" for an engine; MiKTeX needs its installer disabled. */
async function distribution(engine: Engine): Promise<string> {
  const cached = distributions.get(engine);
  if (cached) return cached;
  const res = await runCommand(engine, ["--version"], { timeoutMs: 30000 }).catch(() => null);
  const text = res?.stdout ?? "";
  const name = /MiKTeX/i.test(text) ? "MiKTeX" : /TeX Live/i.test(text) ? "TeX Live" : "unknown";
  distributions.set(engine, name);
  return name;
}

function installHint(dist: string, missing: string[]): string {
  const pkgs = missing.map((f) => f.replace(/\.(sty|cls|def|cfg|tex)$/, ""));
  return dist === "MiKTeX"
    ? `miktex packages install ${pkgs.join(" ")} (or MiKTeX Console › Packages)`
    : `tlmgr install ${pkgs.join(" ")}`;
}

interface CompileJob {
  texPath: string;
  cwd: string;
  outDir: string;
  engine: Engine;
}

export interface CompileResult extends ParsedLog {
  ok: boolean;
  engine: Engine;
  distribution: string;
  runs: number;
  pdf?: string;
  bibliography?: BibliographyRun;
  installHint?: string;
  logTail?: string;
}

interface BibliographyRun {
  tool: "biber" | "bibtex";
  ok: boolean;
  detail?: string;
}

/** One biber or BibTeX pass, run from the output directory where the .bcf/.aux files are. */
async function runBibliography(
  job: CompileJob,
  name: string,
): Promise<BibliographyRun | undefined> {
  const aux = join(job.outDir, `${name}.aux`);
  const usesBiber = existsSync(join(job.outDir, `${name}.bcf`));
  const usesBibtex = !usesBiber && existsSync(aux) && /\\bibdata\{/.test(readFileSync(aux, "utf8"));
  if (!usesBiber && !usesBibtex) return undefined;
  const tool = usesBiber ? "biber" : "bibtex";
  if (!available(tool)) return { tool, ok: false, detail: `${tool} not found` };
  const args = usesBiber
    ? ["--input-directory", job.cwd, "--output-directory", job.outDir, name]
    : [name];
  const res = await runCommand(tool, args, {
    env: { BIBINPUTS: `${job.cwd}${delimiter}`, openout_any: "p" },
    cwd: job.outDir,
    timeoutMs: COMPILE_TIMEOUT_MS,
  });
  if (res.code === 0) return { tool, ok: true };
  const detail = `${res.stdout}\n${res.stderr}`
    .split(/\r?\n/)
    .filter((l) => /ERROR|I couldn't|I found no|Warning--/.test(l))
    .slice(0, 8)
    .join("\n");
  return { tool, ok: false, detail: detail || `${tool} exited with code ${res.code}` };
}

/**
 * Compile with the engine directly (no latexmk, so no Perl and no latexmkrc code): shell
 * escape off, MiKTeX's on-the-fly installer off, reruns for references and one
 * bibliography pass when the document uses biblatex or BibTeX.
 */
async function compile(job: CompileJob): Promise<CompileResult> {
  if (!available(job.engine)) {
    throw new ToolError(
      `${job.engine} not found. Install it with \`ops setup ops-latex\` (see latex_status).`,
    );
  }
  const dist = await distribution(job.engine);
  const name = basename(job.texPath, extname(job.texPath));
  const args = [
    "-interaction=nonstopmode",
    "-halt-on-error",
    "-file-line-error",
    "-no-shell-escape",
    `-output-directory=${job.outDir}`,
    ...(dist === "MiKTeX" ? ["-disable-installer", "-max-print-line=10000"] : []),
    job.texPath,
  ];
  const env = { openout_any: "p", max_print_line: "10000" };
  const logPath = join(job.outDir, `${name}.log`);
  let runs = 0;
  let bibliography: BibliographyRun | undefined;
  let bibliographyChecked = false;
  let parsed = parseLog("");
  let code: number | null = null;
  while (runs < MAX_RUNS) {
    const res = await runCommand(job.engine, args, {
      env,
      cwd: job.cwd,
      timeoutMs: COMPILE_TIMEOUT_MS,
    });
    runs++;
    if (res.timedOut) throw new ToolError(`${job.engine} timed out after ${COMPILE_TIMEOUT_MS}ms`);
    code = res.code;
    const log = existsSync(logPath) ? readFileSync(logPath, "latin1") : res.stdout;
    parsed = parseLog(log);
    if (code !== 0) {
      const result: CompileResult = {
        ...parsed,
        ok: false,
        engine: job.engine,
        distribution: dist,
        runs,
        logTail: log.split(/\r?\n/).slice(-25).join("\n"),
      };
      if (parsed.missingFiles.length) result.installHint = installHint(dist, parsed.missingFiles);
      return result;
    }
    if (!bibliographyChecked) {
      bibliographyChecked = true;
      bibliography = await runBibliography(job, name);
      if (bibliography?.ok) continue;
    }
    if (!parsed.rerun) break;
  }
  const pdf = join(job.outDir, `${name}.pdf`);
  const result: CompileResult = {
    ...parsed,
    ok: existsSync(pdf),
    engine: job.engine,
    distribution: dist,
    runs,
  };
  if (existsSync(pdf)) result.pdf = pdf;
  if (bibliography) result.bibliography = bibliography;
  return result;
}

async function convert(
  pdf: string,
  output: string,
  { page, dpi, transparent }: { page: number; dpi: number; transparent: boolean },
): Promise<void> {
  const ext = extname(output).toLowerCase();
  const pages = ["-f", String(page), "-l", String(page)];
  let res: Awaited<ReturnType<typeof runCommand>> | undefined;
  if (ext === ".png") {
    const base = output.slice(0, -4);
    if (available("pdftocairo")) {
      const flags = [
        "-png",
        "-r",
        String(dpi),
        "-singlefile",
        ...pages,
        ...(transparent ? ["-transp"] : []),
      ];
      res = await runCommand("pdftocairo", [...flags, pdf, base], {
        timeoutMs: CONVERT_TIMEOUT_MS,
      });
    } else if (available("pdftoppm")) {
      const flags = ["-png", "-r", String(dpi), "-singlefile", ...pages];
      res = await runCommand("pdftoppm", [...flags, pdf, base], { timeoutMs: CONVERT_TIMEOUT_MS });
    }
  } else if (ext === ".svg") {
    if (available("pdftocairo")) {
      res = await runCommand("pdftocairo", ["-svg", ...pages, pdf, output], {
        timeoutMs: CONVERT_TIMEOUT_MS,
      });
    } else if (available("dvisvgm")) {
      res = await runCommand("dvisvgm", ["--pdf", `--page=${page}`, "-o", output, pdf], {
        timeoutMs: CONVERT_TIMEOUT_MS,
      });
    }
  }
  if (!res) {
    throw new ToolError(
      `No converter for ${ext}: install poppler (pdftocairo/pdftoppm) or dvisvgm. PDF output works without one.`,
    );
  }
  if (res.code !== 0 || !existsSync(output)) {
    throw new ToolError(
      `converting to ${ext} failed: ${(res.stderr || res.stdout).trim().slice(0, 500)}`,
    );
  }
}

interface Prepared {
  texPath: string;
  cwd: string;
  source: string;
  cleanup?: string;
}

function prepare(a: { source?: string; file?: string }, pcfg: ProviderConfig): Prepared {
  if ((a.source === undefined) === (a.file === undefined)) {
    throw new ToolError("pass exactly one of source or file");
  }
  if (a.file !== undefined) {
    const file = checkPath(a.file, pcfg.scope.allowedRoots, "latex");
    if (extname(file).toLowerCase() !== ".tex") throw new ToolError("file must be a .tex file");
    if (!existsSync(file)) throw new ToolError(`${file} does not exist`);
    return { texPath: file, cwd: dirname(file), source: readFileSync(file, "utf8") };
  }
  const work = mkdtempSync(join(tmpdir(), "ops-latex-src-"));
  const texPath = join(work, "diagram.tex");
  const source = wrapSnippet(a.source ?? "");
  writeFileSync(texPath, source);
  return { texPath, cwd: work, source, cleanup: work };
}

function summary(r: CompileResult) {
  const { logTail, rerun: _rerun, ...rest } = r;
  return r.ok || r.errors.length ? rest : { ...rest, logTail };
}

const sourceInput = str(
  "LaTeX source: a full document, a tikzpicture, or bare TikZ commands (wrapped in a standalone document with common TikZ libraries).",
  { maxLength: MAX_SOURCE },
);
const fileInput = absPath("Absolute path of a .tex file; compiled from its own directory.");
const engineInput = oneOf(
  ENGINES,
  "TeX engine. Default: a `% !TEX program` comment, xelatex for fontspec/unicode-math, else providers.latex.engine or pdflatex.",
);

const tools = [
  tool({
    name: "latex_status",
    title: "LaTeX toolchain status",
    tier: "read",
    description:
      "Report the TeX distribution, available engines, bibliography tools and PDF converters, and whether given packages are installed.",
    input: obj({
      packages: list(
        str("Package name.", { pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" }),
        "Packages to check (default: tikz, pgfplots, standalone, amsmath, biblatex).",
        { maxItems: 40 },
      ),
    }),
    run: async (a) => {
      const engines = Object.fromEntries(ENGINES.map((e) => [e, available(e)]));
      const first = ENGINES.find((e) => engines[e]);
      const dist = first ? await distribution(first) : "none";
      const packages: Record<string, boolean | null> = {};
      for (const pkg of a.packages ?? DEFAULT_PACKAGES) {
        if (!available("kpsewhich")) {
          packages[pkg] = null;
          continue;
        }
        const res = await runCommand("kpsewhich", [`${pkg}.sty`], { timeoutMs: 30000 });
        packages[pkg] = res.code === 0 && res.stdout.trim().length > 0;
      }
      const missing = Object.entries(packages)
        .filter(([, v]) => v === false)
        .map(([k]) => k);
      return {
        distribution: dist,
        engines,
        bibliography: { biber: available("biber"), bibtex: available("bibtex") },
        converters: {
          pdftocairo: available("pdftocairo"),
          pdftoppm: available("pdftoppm"),
          dvisvgm: available("dvisvgm"),
        },
        packages,
        install: !first
          ? "Run `ops setup ops-latex` (MiKTeX on Windows, BasicTeX on macOS) or install TeX Live (tug.org/texlive)."
          : missing.length
            ? installHint(dist, missing)
            : undefined,
        notes: [
          "Compiles never use shell escape or latexmk/latexmkrc, and MiKTeX's on-the-fly package installer is disabled; install missing packages explicitly.",
        ],
      };
    },
  }),
  tool({
    name: "latex_preview",
    title: "Preview LaTeX document or diagram",
    tier: "read",
    description:
      "Compile LaTeX source, a TikZ snippet or a .tex file in a throwaway directory and render pages to PNG. Returns PNG paths (read them to check the layout), errors with file:line, warnings, overfull boxes and missing packages. Writes nothing into the workspace.",
    input: obj({
      source: sourceInput,
      file: fileInput,
      engine: engineInput,
      pages: int("Pages to render, starting at page 1.", { minimum: 1, maximum: 10, default: 1 }),
      dpi: int("Preview resolution.", { minimum: 50, maximum: 300, default: 130 }),
    }),
    run: async (a, ctx) => {
      const prepared = prepare(a, ctx.provider);
      const outDir = previewDir("latex");
      try {
        const engine = pickEngine(prepared.source, a.engine, ctx.provider);
        const result = await compile({
          texPath: prepared.texPath,
          cwd: prepared.cwd,
          outDir,
          engine,
        });
        if (!result.ok || !result.pdf) {
          return {
            ...summary(result),
            next: "Fix the first error (file:line), then preview again.",
          };
        }
        const pngs: string[] = [];
        const last = Math.min(a.pages, result.pages ?? 1);
        for (let page = 1; page <= last; page++) {
          const png = join(outDir, `page-${page}.png`);
          await convert(result.pdf, png, { page, dpi: a.dpi, transparent: false });
          pngs.push(png);
        }
        return {
          ...summary(result),
          pngs,
          next: "Read the PNGs to check layout, overlaps and labels; iterate on the source, then export with latex_render.",
        };
      } finally {
        if (prepared.cleanup) rmSync(prepared.cleanup, { recursive: true, force: true });
      }
    },
  }),
  tool({
    name: "latex_render",
    title: "Render LaTeX to file",
    tier: "write",
    description:
      "Compile LaTeX source, a TikZ snippet or a .tex file and write the result to a PDF, SVG or PNG file in the workspace. Auxiliary files stay in a temporary directory. Refuses to overwrite unless overwrite=true.",
    input: obj(
      {
        source: sourceInput,
        file: fileInput,
        output: absPath("Absolute output path ending in .pdf, .svg or .png."),
        engine: engineInput,
        page: int("Page to export for SVG/PNG.", { minimum: 1, maximum: 9999, default: 1 }),
        dpi: int("PNG resolution.", { minimum: 72, maximum: 1200, default: 300 }),
        transparent: bool("Transparent PNG background.", false),
        overwrite: bool("Replace an existing output file.", false),
      },
      ["output"],
    ),
    summarize: (a) =>
      `render ${a.file ?? "inline LaTeX"} → ${a.output}${a.overwrite ? " (overwrite)" : ""}`,
    scope: (a, pcfg) => {
      try {
        checkPath(a.output, pcfg.scope.allowedRoots, "latex");
        if (a.file) checkPath(a.file, pcfg.scope.allowedRoots, "latex");
        return undefined;
      } catch (err) {
        return (err as Error).message;
      }
    },
    run: async (a, ctx) => {
      const output = checkPath(a.output, ctx.provider.scope.allowedRoots, "latex");
      const ext = extname(output).toLowerCase();
      if (!OUTPUT_EXTENSIONS.has(ext)) throw new ToolError("output must end in .pdf, .svg or .png");
      if (existsSync(output) && !a.overwrite) {
        throw new ToolError(`${output} exists; pass overwrite=true to replace it`);
      }
      const prepared = prepare(a, ctx.provider);
      const outDir = mkdtempSync(join(tmpdir(), "ops-latex-out-"));
      try {
        const engine = pickEngine(prepared.source, a.engine, ctx.provider);
        const result = await compile({
          texPath: prepared.texPath,
          cwd: prepared.cwd,
          outDir,
          engine,
        });
        if (!result.ok || !result.pdf) {
          throw new ToolError(
            `compile failed: ${JSON.stringify({ errors: result.errors, missingFiles: result.missingFiles, installHint: result.installHint }).slice(0, 1500)}`,
          );
        }
        if (result.pages && a.page > result.pages) {
          throw new ToolError(`page ${a.page} requested but the document has ${result.pages}`);
        }
        mkdirSync(dirname(output), { recursive: true });
        if (ext === ".pdf") copyFileSync(result.pdf, output);
        else
          await convert(result.pdf, output, {
            page: a.page,
            dpi: a.dpi,
            transparent: a.transparent,
          });
        return {
          written: output,
          pages: result.pages,
          engine: result.engine,
          warnings: result.warnings,
          overfull: result.overfull,
        };
      } finally {
        rmSync(outDir, { recursive: true, force: true });
        if (prepared.cleanup) rmSync(prepared.cleanup, { recursive: true, force: true });
      }
    },
  }),
];

const TEX = String.raw`\b((pdf|xe|lua)?la)?tex(\.exe)?\b`;
const shellRules: ShellRule[] = [
  {
    id: "latex-shell-escape",
    decision: "ask",
    re: new RegExp(`(${TEX}|\\blatexmk(\\.exe)?\\b).*\\s--?(shell-escape|enable-write18)\\b`, "i"),
    reason:
      "Shell escape lets the document run arbitrary commands (\\write18). Only enable it for trusted sources that need it (e.g. minted).",
  },
  {
    id: "tex-package-install",
    decision: "ask",
    re: /\b(miktex(\.exe)?\s+packages\s+(install|update|remove)|mpm(\.exe)?\s+--(install|update|uninstall)|tlmgr(\.exe)?\s+(install|update|remove))\b/i,
    reason: "Changes the TeX distribution's installed packages.",
  },
];

const provider: Provider = {
  id: "latex",
  displayName: "LaTeX",
  version: "1.0.0",
  bin: "pdflatex",
  setup: [
    {
      bin: "pdflatex",
      winget: "MiKTeX.MiKTeX",
      brew: "--cask basictex",
      docs: "https://miktex.org/download (Windows), https://tug.org/texlive/ (Linux, macOS)",
    },
    {
      bin: "pdftoppm",
      winget: "oschwartz10612.Poppler",
      brew: "poppler",
      docs: "https://poppler.freedesktop.org",
      optional: "PNG and SVG previews",
    },
  ],
  baseEnv: { openout_any: "p" },
  instructions: {
    read: "Compiles LaTeX and TikZ in throwaway directories and returns PNG previews, errors and warnings. Use it for complex diagrams that need precise layout, math, grouping or 3D shapes.",
    write:
      "Writes compiled PDF, SVG or PNG output into the workspace. Every call needs user approval.",
  },
  tools,
  shellRules,
};

export default provider;
