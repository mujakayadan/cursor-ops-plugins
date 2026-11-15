import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { resolveBinary, runCommand } from "./lib/core/cli.ts";
import { absPath, checkPath, previewDir } from "./lib/core/paths.ts";
import { bool, int, obj, oneOf, str, ToolError, tool } from "./lib/core/schema-helpers.ts";
import type { Provider, ProviderConfig } from "./lib/core/types.ts";

const RENDER_TIMEOUT_MS = 90000;
const MAX_SOURCE = 100000;
const MAX_BLOCKS = 20;
const THEMES = ["default", "neutral", "dark", "forest", "base"] as const;
const DIAGRAM_EXTENSIONS = new Set([".mmd", ".mermaid"]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);
const OUTPUT_EXTENSIONS = new Set([".svg", ".png", ".pdf"]);

const MATH =
  /\$[^$\n]+\$|\\(frac|sum|prod|int|sqrt|partial|nabla|alpha|beta|gamma|theta|lambda|sigma|mu|mathbb|mathbf|mathcal|cdot|times|otimes|oplus)\b|[A-Za-z]_\{|\^\{/;
const EDGE = /(--+>|==+>|-\.+->|--+[ox]\b|<--+>|~~~)/;
const MAX_FLOW_EDGES = 40;
const MAX_SUBGRAPH_DEPTH = 3;
const MAX_SPACER_LINKS = 3;

type Theme = (typeof THEMES)[number];

interface RenderOptions {
  theme: Theme;
  background: string;
  scale: number;
  width?: number | undefined;
}

interface Diagram {
  index: number;
  line: number;
  source: string;
}

/**
 * Signs that a diagram has outgrown Mermaid's automatic layout and needs a hand-laid-out
 * TikZ figure: math in labels, deep nesting, sheer size, or spacer links fighting the layout.
 */
export function complexitySignals(source: string): string[] {
  const signals: string[] = [];
  if (MATH.test(source)) signals.push("math notation in labels");
  if (!/^\s*(flowchart|graph)\b/m.test(source)) return signals;
  let depth = 0;
  let maxDepth = 0;
  let edges = 0;
  let spacers = 0;
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*subgraph\b/.test(line)) maxDepth = Math.max(maxDepth, ++depth);
    else if (/^\s*end\s*$/.test(line)) depth = Math.max(0, depth - 1);
    if (EDGE.test(line)) edges++;
    spacers += (line.match(/~~~/g) ?? []).length;
  }
  if (maxDepth >= MAX_SUBGRAPH_DEPTH) signals.push(`subgraphs nested ${maxDepth} deep`);
  if (edges > MAX_FLOW_EDGES) signals.push(`${edges} edge lines`);
  if (spacers >= MAX_SPACER_LINKS) signals.push(`${spacers} invisible spacer links`);
  return signals;
}

function advice(source: string): string | undefined {
  const signals = complexitySignals(source);
  if (!signals.length) return undefined;
  return `Complex for Mermaid (${signals.join(", ")}). Unless the user asked for Mermaid, draw it in LaTeX/TikZ with ops-latex (latex-diagrams skill), which gives exact placement, math labels, grouping and 3D blocks.`;
}

/** Mermaid fences in a Markdown document, with the 1-based line of their first source line. */
export function extractMermaidBlocks(markdown: string): Diagram[] {
  const blocks: Diagram[] = [];
  const re = /^[ \t]*(`{3,}|~{3,})[ \t]*mermaid\b[^\n]*\r?\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm;
  for (const m of markdown.matchAll(re)) {
    blocks.push({
      index: blocks.length,
      line: markdown.slice(0, m.index).split("\n").length + 1,
      source: m[2] ?? "",
    });
  }
  return blocks;
}

function puppeteerCacheHasBrowser(): boolean {
  const cache = process.env.PUPPETEER_CACHE_DIR || join(homedir(), ".cache", "puppeteer");
  return existsSync(join(cache, "chrome-headless-shell")) || existsSync(join(cache, "chrome"));
}

function systemBrowsers(): string[] {
  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return [
      join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      join(local, "Google", "Chrome", "Application", "chrome.exe"),
      join(pf, "Chromium", "Application", "chrome.exe"),
      join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/bin/microsoft-edge",
  ];
}

/** Browser for mermaid-cli: configured path, puppeteer's own download, then a system Chrome/Edge. */
export function resolveBrowser(pcfg: ProviderConfig): { path?: string; source: string } {
  if (pcfg.browserPath) return { path: pcfg.browserPath, source: "providers.mermaid.browserPath" };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return { source: "PUPPETEER_EXECUTABLE_PATH" };
  if (puppeteerCacheHasBrowser()) return { source: "puppeteer cache" };
  const found = systemBrowsers().find((p) => existsSync(p));
  return found ? { path: found, source: "system browser" } : { source: "none found" };
}

function cleanError(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter(
      (l) => l.trim() && !/^\s+at\s/.test(l) && !/\((https?|file):\/\/[^)]*:\d+:\d+\)\s*$/.test(l),
    )
    .slice(0, 12)
    .join("\n")
    .slice(0, 2000);
}

async function render(
  source: string,
  output: string,
  options: RenderOptions,
  pcfg: ProviderConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    resolveBinary("mmdc");
  } catch {
    throw new ToolError("mmdc not found. Install it with `ops setup ops-mermaid`.");
  }
  const work = mkdtempSync(join(tmpdir(), "ops-mermaid-"));
  try {
    const input = join(work, "diagram.mmd");
    const config = join(work, "config.json");
    const puppeteer = join(work, "puppeteer.json");
    const browser = resolveBrowser(pcfg);
    writeFileSync(input, source);
    writeFileSync(config, JSON.stringify({ securityLevel: "strict", theme: options.theme }));
    writeFileSync(
      puppeteer,
      JSON.stringify(
        browser.path ? { executablePath: browser.path, headless: true } : { headless: true },
      ),
    );
    const out = join(work, `diagram${extname(output)}`);
    const args = ["-i", input, "-o", out, "-c", config, "-p", puppeteer, "-q"];
    args.push("-t", options.theme, "-b", options.background, "-s", String(options.scale));
    if (options.width) args.push("-w", String(options.width));
    if (extname(output) === ".pdf") args.push("-f");
    const res = await runCommand("mmdc", args, {
      env: { NO_COLOR: "1" },
      timeoutMs: RENDER_TIMEOUT_MS,
      cwd: work,
    });
    if (res.timedOut) return { ok: false, error: `mmdc timed out after ${RENDER_TIMEOUT_MS}ms` };
    if (res.code !== 0 || !existsSync(out)) {
      const error = cleanError(res.stderr || res.stdout) || `mmdc exited with code ${res.code}`;
      const hint = /Failed to launch|Could not find (Chrome|chrome-headless-shell)/.test(error)
        ? " (No usable browser: install Chrome, set providers.mermaid.browserPath, or run `npx puppeteer browsers install chrome-headless-shell`.)"
        : "";
      return { ok: false, error: error + hint };
    }
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(out, output);
    return { ok: true };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function loadDiagrams(a: { source?: string; file?: string }, pcfg: ProviderConfig): Diagram[] {
  if ((a.source === undefined) === (a.file === undefined)) {
    throw new ToolError("pass exactly one of source or file");
  }
  if (a.source !== undefined) return [{ index: 0, line: 1, source: a.source }];
  const file = checkPath(a.file ?? "", pcfg.scope.allowedRoots, "mermaid");
  if (!existsSync(file)) throw new ToolError(`${file} does not exist`);
  const ext = extname(file).toLowerCase();
  const text = readFileSync(file, "utf8");
  if (text.length > MAX_SOURCE * 5) throw new ToolError(`${file} is too large`);
  if (DIAGRAM_EXTENSIONS.has(ext)) return [{ index: 0, line: 1, source: text }];
  if (MARKDOWN_EXTENSIONS.has(ext)) {
    const blocks = extractMermaidBlocks(text);
    if (!blocks.length) throw new ToolError(`${file} has no \`\`\`mermaid blocks`);
    return blocks.slice(0, MAX_BLOCKS);
  }
  throw new ToolError("file must be .mmd, .mermaid, .md, .markdown or .mdx");
}

const sourceInput = str("Mermaid diagram source (without ``` fences).", { maxLength: MAX_SOURCE });
const fileInput = absPath(
  "Absolute path of a .mmd/.mermaid file, or a Markdown file whose ```mermaid blocks are rendered.",
);
const themeInput = oneOf(THEMES, "Mermaid theme.", "default");

const tools = [
  tool({
    name: "mermaid_status",
    title: "Mermaid toolchain status",
    tier: "read",
    description:
      "Report the mermaid-cli version and which browser renders diagrams, with setup hints when something is missing.",
    run: async (_a, ctx) => {
      const version = await runCommand("mmdc", ["--version"], { timeoutMs: 30000 }).catch(
        () => null,
      );
      const browser = resolveBrowser(ctx.provider);
      return {
        mmdc: version?.code === 0 ? version.stdout.trim() : null,
        install: version?.code === 0 ? undefined : "ops setup ops-mermaid",
        browser,
        ready: version?.code === 0 && browser.source !== "none found",
        routing:
          "Mermaid for flowcharts, sequence, state, class, ER, Gantt, git graphs and mind maps with automatic layout. Complicated diagrams that need precise placement, math, deep grouping or 3D blocks (deep-learning architectures, for example) go to ops-latex/TikZ.",
      };
    },
  }),
  tool({
    name: "mermaid_preview",
    title: "Preview Mermaid diagram",
    tier: "read",
    description:
      "Validate and render Mermaid source, a .mmd file or every ```mermaid block in a Markdown file to throwaway PNGs. Returns each PNG path (read it to check the layout) or the parse error with its line, plus advice when a diagram is too complex for Mermaid. Writes nothing into the workspace.",
    input: obj({
      source: sourceInput,
      file: fileInput,
      theme: themeInput,
    }),
    run: async (a, ctx) => {
      const diagrams = loadDiagrams(a, ctx.provider);
      const dir = previewDir("mermaid");
      const results = [];
      for (const d of diagrams) {
        const png = join(dir, `diagram-${d.index + 1}.png`);
        const res = await render(
          d.source,
          png,
          { theme: a.theme, background: "white", scale: 2 },
          ctx.provider,
        );
        const tip = advice(d.source);
        results.push({
          index: d.index,
          line: d.line,
          ...(res.ok ? { ok: true, png } : res),
          ...(tip ? { advice: tip } : {}),
        });
      }
      return {
        ok: results.every((r) => r.ok),
        diagrams: results,
        next: "Read each PNG to check the layout, fix errors in the source, then preview again.",
      };
    },
  }),
  tool({
    name: "mermaid_render",
    title: "Render Mermaid diagram to file",
    tier: "write",
    description:
      "Render Mermaid source or a .mmd file to an SVG, PNG or PDF file in the workspace. Refuses to overwrite unless overwrite=true. For diagrams that stay in Markdown (GitHub renders ```mermaid natively), use mermaid_preview instead.",
    input: obj(
      {
        source: sourceInput,
        file: absPath("Absolute path of a .mmd/.mermaid file."),
        output: absPath("Absolute output path ending in .svg, .png or .pdf."),
        theme: themeInput,
        background: str("Background color (CSS color or 'transparent').", {
          pattern: "^(transparent|#[0-9A-Fa-f]{3,8}|[a-z]{3,20})$",
          default: "white",
        }),
        scale: int("Pixel scale for PNG output (1-4).", { minimum: 1, maximum: 4, default: 2 }),
        width: int("Page width in pixels.", { minimum: 100, maximum: 10000 }),
        overwrite: bool("Replace an existing output file.", false),
      },
      ["output"],
    ),
    summarize: (a) =>
      `render ${a.file ?? "inline Mermaid diagram"} → ${a.output}${a.overwrite ? " (overwrite)" : ""}`,
    scope: (a, pcfg) => {
      try {
        checkPath(a.output, pcfg.scope.allowedRoots, "mermaid");
        if (a.file) checkPath(a.file, pcfg.scope.allowedRoots, "mermaid");
        return undefined;
      } catch (err) {
        return (err as Error).message;
      }
    },
    run: async (a, ctx) => {
      const output = checkPath(a.output, ctx.provider.scope.allowedRoots, "mermaid");
      if (!OUTPUT_EXTENSIONS.has(extname(output).toLowerCase())) {
        throw new ToolError("output must end in .svg, .png or .pdf");
      }
      if (a.file && !DIAGRAM_EXTENSIONS.has(extname(a.file).toLowerCase())) {
        throw new ToolError(
          "file must be .mmd or .mermaid; render Markdown blocks from their source",
        );
      }
      if (existsSync(output) && !a.overwrite) {
        throw new ToolError(`${output} exists; pass overwrite=true to replace it`);
      }
      const [diagram] = loadDiagrams(a, ctx.provider);
      if (!diagram) throw new ToolError("no diagram to render");
      const res = await render(
        diagram.source,
        output,
        { theme: a.theme, background: a.background, scale: a.scale, width: a.width },
        ctx.provider,
      );
      if (!res.ok) throw new ToolError(res.error);
      const tip = advice(diagram.source);
      return { written: output, format: extname(output).slice(1), ...(tip ? { advice: tip } : {}) };
    },
  }),
];

const provider: Provider = {
  id: "mermaid",
  displayName: "Mermaid",
  version: "1.0.0",
  bin: "mmdc",
  setup: [
    {
      bin: "mmdc",
      pnpm: "@mermaid-js/mermaid-cli",
      docs: "https://github.com/mermaid-js/mermaid-cli",
    },
  ],
  onboarding: { status: "mermaid_status", skill: "mermaid-diagrams" },
  baseEnv: { NO_COLOR: "1" },
  instructions: {
    read: "Validates and previews Mermaid diagrams to throwaway PNGs. Complicated diagrams that need precise layout, math or 3D blocks belong in ops-latex (TikZ).",
    write:
      "Renders Mermaid diagrams to SVG, PNG or PDF files in the workspace. Every call needs user approval.",
  },
  tools,
};

export default provider;
