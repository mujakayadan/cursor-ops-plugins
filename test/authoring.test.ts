import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "vitest";
import { resolveBinary } from "../packages/core/cli.ts";
import { evaluateShell } from "../packages/core/policy.ts";
import type { ProviderConfig } from "../packages/core/types.ts";
import latex, {
  listTemplates,
  parseLog,
  pickEngine,
  wrapSnippet,
} from "../plugins/ops-latex/provider.ts";
import mermaid, {
  architectureTerms,
  extractMermaidBlocks,
} from "../plugins/ops-mermaid/provider.ts";

const pcfg = (engine?: string): ProviderConfig => ({
  allowPrivileged: false,
  credentials: { read: { env: {}, args: [] }, write: { env: {}, args: [] } },
  scope: {},
  engine: engine ?? null,
});

describe("mermaid", () => {
  it("extracts fenced mermaid blocks with their line numbers", () => {
    const md = [
      "# Doc",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "~~~~mermaid title",
      "sequenceDiagram",
      "  A->>B: hi",
      "~~~~",
    ].join("\n");
    const blocks = extractMermaidBlocks(md);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0]?.line, 3);
    assert.equal(blocks[1]?.line, 11);
    assert.match(blocks[0]?.source ?? "", /^flowchart LR/);
    assert.match(blocks[1]?.source ?? "", /^sequenceDiagram/);
  });
  it("flags neural-network architectures but not ordinary flowcharts", () => {
    const transformer =
      "flowchart TB\n E[Token Embedding] --> A[Multi-Head Attention] --> N[Add & Norm] --> F[Feed Forward]";
    assert.ok(architectureTerms(transformer).length >= 3);
    const deploy = "flowchart LR\n dev --> ci[CI checks] --> review --> merge --> deploy[Deploy]";
    assert.deepEqual(architectureTerms(deploy), []);
  });
  it("has read status/preview tools and a write render tool", () => {
    const tiers = Object.fromEntries(mermaid.tools.map((t) => [t.name, t.tier]));
    assert.deepEqual(tiers, {
      mermaid_status: "read",
      mermaid_preview: "read",
      mermaid_render: "write",
    });
  });
});

describe("latex snippets and engines", () => {
  it("wraps TikZ snippets and hoists preamble lines", () => {
    const doc = wrapSnippet(
      "\\usetikzlibrary{3d}\n\\definecolor{acc}{HTML}{3366CC}\n\\node[fill=acc] {x};",
    );
    assert.match(doc, /\\documentclass\[tikz,border=8pt\]\{standalone\}/);
    const [preamble = "", body = ""] = doc.split("\\begin{document}");
    assert.match(preamble, /\\usetikzlibrary\{3d\}/);
    assert.match(preamble, /\\definecolor\{acc\}/);
    assert.match(body, /\\begin\{tikzpicture\}\n\\node\[fill=acc\] \{x\};\n\\end\{tikzpicture\}/);
  });
  it("keeps full documents and existing tikzpictures as they are", () => {
    const full = "\\documentclass{article}\n\\begin{document}x\\end{document}";
    assert.equal(wrapSnippet(full), full);
    const pic = wrapSnippet("\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}");
    assert.equal(pic.match(/\\begin\{tikzpicture\}/g)?.length, 1);
  });
  it("picks the engine from the request, magic comment, preamble, then config", () => {
    assert.equal(pickEngine("x", "lualatex", pcfg()), "lualatex");
    assert.equal(pickEngine("% !TEX program = xelatex\n", undefined, pcfg()), "xelatex");
    assert.equal(pickEngine("\\usepackage{fontspec}", undefined, pcfg()), "xelatex");
    assert.equal(pickEngine("\\usepackage[math]{unicode-math}", undefined, pcfg()), "xelatex");
    assert.equal(pickEngine("x", undefined, pcfg("lualatex")), "lualatex");
    assert.equal(pickEngine("x", undefined, pcfg("context")), "pdflatex");
  });
  it("ships compilable architecture templates", () => {
    const names = listTemplates().map((t) => t.name);
    for (const n of ["transformer", "attention", "cnn", "mlp"]) assert.ok(names.includes(n), n);
    for (const t of listTemplates()) assert.ok(t.title && t.description, t.name);
  });
});

describe("latex log parsing", () => {
  it("reports file:line errors with context and skips the fatal banner", () => {
    const log = [
      "./main.tex:12: Undefined control sequence.",
      "l.12 \\foo",
      "         {bar}",
      "! ==> Fatal error occurred, no output PDF file produced!",
    ].join("\n");
    const parsed = parseLog(log);
    assert.deepEqual(parsed.errors, [
      {
        message: "Undefined control sequence.",
        file: "./main.tex",
        line: 12,
        context: "l.12 \\foo",
      },
    ]);
  });
  it("collects missing files, warnings, box counts and pages", () => {
    const log = [
      "! LaTeX Error: File `pgfplots.sty' not found.",
      "LaTeX Warning: Reference `fig:a' on page 1 undefined on input line 3.",
      "Package hyperref Warning: Token not allowed in a PDF string.",
      "Overfull \\hbox (3.0pt too wide) in paragraph at lines 4--5",
      "Underfull \\vbox (badness 10000) has occurred",
      "Output written on main.pdf (2 pages, 1234 bytes).",
    ].join("\n");
    const parsed = parseLog(log);
    assert.deepEqual(parsed.missingFiles, ["pgfplots.sty"]);
    assert.equal(parsed.warnings.length, 2);
    assert.equal(parsed.overfull, 1);
    assert.equal(parsed.underfull, 1);
    assert.equal(parsed.pages, 2);
  });
  it("detects rerun requests but not the rerunfilecheck banner", () => {
    assert.equal(
      parseLog("Package: rerunfilecheck 2022/07/10 v1.10 Rerun checks for auxiliary files (HO)")
        .rerun,
      false,
    );
    assert.equal(
      parseLog("LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.")
        .rerun,
      true,
    );
    assert.equal(parseLog("LaTeX Warning: There were undefined references.").rerun, false);
    assert.equal(parseLog("Package biblatex Warning: Please rerun LaTeX.").rerun, true);
    assert.equal(
      parseLog(
        "Package rerunfilecheck Warning: File `main.out' has changed.\n(rerunfilecheck)  Rerun to get outlines right",
      ).rerun,
      true,
    );
  });
});

describe("latex shell rules", () => {
  const rules = latex.shellRules ?? [];
  const decide = (command: string) => evaluateShell(command, rules).permission;
  it("asks before shell escape and package installs", () => {
    assert.equal(decide("pdflatex --shell-escape main.tex"), "ask");
    assert.equal(decide("lualatex -enable-write18 main.tex"), "ask");
    assert.equal(decide("miktex packages install pgfplots"), "ask");
    assert.equal(decide("tlmgr install tikz-cd"), "ask");
  });
  it("leaves plain compiles alone", () => {
    assert.equal(decide("pdflatex -interaction=nonstopmode main.tex"), "allow");
    assert.equal(decide("xelatex -no-shell-escape main.tex"), "allow");
  });
});

describe("cli shims", () => {
  it.runIf(process.platform === "win32")("unwraps pnpm shims that also set NODE_PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-shim-"));
    const pathBefore = process.env.PATH;
    try {
      mkdirSync(join(dir, "global", "node_modules", "fake-cli"), { recursive: true });
      writeFileSync(join(dir, "global", "node_modules", "fake-cli", "cli.js"), "");
      writeFileSync(
        join(dir, "ops-fake-shim-cli.cmd"),
        [
          "@SETLOCAL",
          '@SET "NODE_PATH=C:\\pnpm\\store\\node_modules\\fake-cli\\bin\\node_modules;%NODE_PATH%"',
          '@"%~dp0\\global\\node_modules\\fake-cli\\cli.js" %*',
        ].join("\r\n"),
      );
      process.env.PATH = `${dir}${delimiter}${pathBefore ?? ""}`;
      const bin = resolveBinary("ops-fake-shim-cli");
      assert.equal(bin.prefixArgs[0], join(dir, "global", "node_modules", "fake-cli", "cli.js"));
    } finally {
      process.env.PATH = pathBefore;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
