import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBlueprint, SPEC_SUFFIX } from "./blueprint.ts";
import { ICON_PROVIDERS, parseSpec } from "./diagram-spec.ts";
import { resolveBinary, runCommand } from "./lib/core/cli.ts";
import { absPath, checkPath, previewDir } from "./lib/core/paths.ts";
import { bool, freeform, obj, oneOf, str, ToolError, tool } from "./lib/core/schema-helpers.ts";
import type { Provider, ProviderConfig } from "./lib/core/types.ts";

const PYTHON_VERSION = "3.13";
const RENDERER_DIR = fileURLToPath(new URL("./renderer/", import.meta.url));
const RENDERER = join(RENDERER_DIR, "render_diagram.py");
/**
 * `diagrams` and its dependencies, pinned with hashes so every machine draws the same icons and an
 * auto-allowed preview never installs an unreviewed release. Regenerate with `uv pip compile`.
 */
const REQUIREMENTS = join(RENDERER_DIR, "requirements.txt");
/** The first run downloads the diagrams package and its icons (about 35 MB) into the uv cache. */
const RENDER_TIMEOUT_MS = 180000;
const MAX_SPEC_BYTES = 200000;
const MAX_ICONS = 400;
const FORMATS = ["png", "svg"] as const;
type Format = (typeof FORMATS)[number];

const iconCache = new Map<string, Promise<Record<string, string[]>>>();

function pathKey(): string {
  return Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
}

/**
 * uv runs the renderer; Graphviz's `dot` has to be on its PATH even when only the registry PATH
 * has it. Its folder goes last so it can't shadow the Python that uv picks.
 */
function rendererEnv(): Record<string, string> {
  let dot: string;
  try {
    dot = resolveBinary("dot").command;
  } catch {
    throw new ToolError("Graphviz (dot) not found. Install it with `ops setup ops-architecture`.");
  }
  try {
    resolveBinary("uv");
  } catch {
    throw new ToolError("uv not found. Install it with `ops setup ops-architecture`.");
  }
  const key = pathKey();
  return {
    [key]: `${process.env[key] ?? ""}${delimiter}${dirname(dot)}`,
    UV_NO_CONFIG: "1",
    NO_COLOR: "1",
  };
}

/**
 * The read server's working directory can be any opened repository, so uv runs from the renderer
 * folder with config discovery off: a repo's uv.toml must not choose the package index.
 */
async function runRenderer(args: string[], input?: string): Promise<string> {
  const res = await runCommand(
    "uv",
    [
      "run",
      "--no-project",
      "--no-config",
      "--quiet",
      "--python",
      PYTHON_VERSION,
      "--with-requirements",
      REQUIREMENTS,
      "python",
      RENDERER,
      ...args,
    ],
    {
      env: rendererEnv(),
      cwd: RENDERER_DIR,
      timeoutMs: RENDER_TIMEOUT_MS,
      ...(input === undefined ? {} : { input }),
    },
  );
  if (res.timedOut) throw new ToolError(`renderer timed out after ${RENDER_TIMEOUT_MS}ms`);
  if (res.code !== 0) {
    const reported = /\{"error":.*\}/.exec(res.stderr)?.[0];
    const message = reported
      ? (JSON.parse(reported) as { error: string }).error
      : res.stderr.trim().split(/\r?\n/).slice(-6).join("\n");
    throw new ToolError(message || `renderer exited with code ${res.code}`);
  }
  return res.stdout;
}

/**
 * Graphviz SVGs reference each icon by its absolute path inside the diagrams package; embed them
 * as data URIs so the SVG renders anywhere. Only PNGs whose real path is in a package's
 * `site-packages/resources` folder are read.
 */
export function inlineIcons(svg: string): string {
  const icons = new Map<string, string | undefined>();
  const icon = (path: string): string | undefined => {
    if (icons.has(path)) return icons.get(path);
    let data: string | undefined;
    if (isAbsolute(path) && existsSync(path)) {
      const real = realpathSync(path);
      if (/[\\/]site-packages[\\/]resources[\\/]/.test(real))
        data = readFileSync(real).toString("base64");
    }
    icons.set(path, data);
    return data;
  };
  return svg.replace(/((?:xlink:)?href)="([^"]+\.png)"/g, (match, attr: string, path: string) => {
    const data = icon(path);
    return data ? `${attr}="data:image/png;base64,${data}"` : match;
  });
}

async function draw(spec: unknown, output: string, format: Format): Promise<void> {
  const valid = parseSpec(spec);
  const work = mkdtempSync(join(tmpdir(), "ops-architecture-"));
  try {
    await runRenderer(["render", work, format], JSON.stringify(valid));
    const drawn = join(work, `diagram.${format}`);
    if (!existsSync(drawn)) throw new ToolError("renderer produced no image");
    mkdirSync(dirname(output), { recursive: true });
    if (format === "svg") writeFileSync(output, inlineIcons(readFileSync(drawn, "utf8")));
    else copyFileSync(drawn, output);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function readSpecFile(raw: string, pcfg: ProviderConfig): { file: string; spec: unknown } {
  const file = checkPath(raw, pcfg.scope.allowedRoots, "architecture");
  if (!file.endsWith(SPEC_SUFFIX)) throw new ToolError(`file must end in ${SPEC_SUFFIX}`);
  if (!existsSync(file)) throw new ToolError(`${file} does not exist`);
  if (statSync(file).size > MAX_SPEC_BYTES) throw new ToolError(`${file} is too large`);
  const text = readFileSync(file, "utf8");
  try {
    return { file, spec: JSON.parse(text) };
  } catch {
    throw new ToolError(`${file} is not valid JSON`);
  }
}

const specFile = absPath(`Absolute path of a diagram spec ending in ${SPEC_SUFFIX}.`);

const tools = [
  tool({
    name: "architecture_status",
    title: "Architecture toolchain status",
    tier: "read",
    description:
      "Report whether uv and Graphviz are installed for drawing platform diagrams, with the install command when something is missing.",
    run: async () => {
      const version = async (bin: string, args: string[]) => {
        try {
          const res = await runCommand(bin, args, { timeoutMs: 15000 });
          return res.code === 0 ? (res.stdout || res.stderr).trim().split(/\r?\n/)[0] : null;
        } catch {
          return null;
        }
      };
      const [uv, dot] = await Promise.all([version("uv", ["--version"]), version("dot", ["-V"])]);
      return {
        uv,
        graphviz: dot,
        diagrams: /^diagrams==(\S+)/m.exec(readFileSync(REQUIREMENTS, "utf8"))?.[1] ?? null,
        ready: Boolean(uv && dot),
        ...(uv && dot ? {} : { install: "ops setup ops-architecture" }),
      };
    },
  }),
  tool({
    name: "architecture_icons",
    title: "List platform icons",
    tier: "read",
    description:
      "List the icon classes a diagram spec can use for one provider (aws, azure, gcp, k8s, digitalocean, onprem, saas, ...), grouped by category, optionally filtered by a search term. Icons are written provider.category.Class in specs, such as aws.compute.Lambda.",
    input: obj(
      {
        provider: oneOf(ICON_PROVIDERS, "Icon provider."),
        query: str(
          "Case-insensitive filter on category or class name, such as 'queue' or 'lambda'.",
          {
            maxLength: 40,
            pattern: "^[A-Za-z0-9_ -]*$",
          },
        ),
      },
      ["provider"],
    ),
    run: async (a) => {
      let pending = iconCache.get(a.provider);
      if (!pending) {
        pending = runRenderer(["icons", a.provider]).then(
          (out) => JSON.parse(out) as Record<string, string[]>,
        );
        iconCache.set(a.provider, pending);
        pending.catch(() => iconCache.delete(a.provider));
      }
      const catalog = await pending;
      const q = a.query?.trim().toLowerCase();
      const icons: Record<string, string[]> = {};
      let count = 0;
      for (const [category, names] of Object.entries(catalog)) {
        const hits = q ? names.filter((n) => `${category}.${n}`.toLowerCase().includes(q)) : names;
        if (!hits.length || count >= MAX_ICONS) continue;
        icons[category] = hits.slice(0, MAX_ICONS - count);
        count += icons[category].length;
      }
      return { provider: a.provider, count, truncated: count >= MAX_ICONS, icons };
    },
  }),
  tool({
    name: "architecture_preview",
    title: "Preview platform diagram",
    tier: "read",
    description: `Validate a platform diagram spec (inline or a ${SPEC_SUFFIX} file) and draw it with official cloud icons to a throwaway PNG. Returns the PNG path (read it to check the layout) or every spec problem at once. Writes nothing into the workspace.`,
    input: obj({
      spec: freeform(
        "Diagram spec: { title, direction, nodes: [{ id, icon, label }], clusters: [{ label, nodes, clusters }], edges: [{ from, to, label, style, direction }] }.",
      ),
      file: specFile,
    }),
    run: async (a, ctx) => {
      if ((a.spec === undefined) === (a.file === undefined))
        throw new ToolError("pass exactly one of spec or file");
      const spec = a.file ? readSpecFile(a.file, ctx.provider).spec : a.spec;
      const png = join(previewDir("architecture"), "diagram.png");
      await draw(spec, png, "png");
      return {
        ok: true,
        png,
        next: "Read the PNG and check grouping, edge crossings and labels; fix the spec and preview again.",
      };
    },
  }),
  tool({
    name: "architecture_render",
    title: "Render platform diagram",
    tier: "write",
    description: `Draw a ${SPEC_SUFFIX} spec with official cloud icons to a PNG or SVG next to it (same name), for ARCHITECTURE.md to embed. SVGs embed their icons. Refuses to overwrite unless overwrite=true.`,
    input: obj(
      {
        file: specFile,
        format: oneOf(FORMATS, "Image format.", "png"),
        overwrite: bool("Replace an existing image.", false),
      },
      ["file"],
    ),
    summarize: (a) => `render ${a.file} → .${a.format}${a.overwrite ? " (overwrite)" : ""}`,
    scope: (a, pcfg) => {
      try {
        checkPath(a.file, pcfg.scope.allowedRoots, "architecture");
        return undefined;
      } catch (err) {
        return (err as Error).message;
      }
    },
    run: async (a, ctx) => {
      const { file, spec } = readSpecFile(a.file, ctx.provider);
      const output = `${file.slice(0, -SPEC_SUFFIX.length)}.${a.format}`;
      if (existsSync(output) && !a.overwrite)
        throw new ToolError(`${output} exists; pass overwrite=true to replace it`);
      await draw(spec, output, a.format);
      return { written: output };
    },
  }),
  tool({
    name: "architecture_check",
    title: "Check architecture documents",
    tier: "read",
    description:
      "Check a project's ARCHITECTURE.md, TODO.md, docs/adr/*.md and docs/runbook.md: required sections and diagrams, requirement IDs traced by tasks, task fields, dependencies and cycles, ADR numbering and links, rendered and current platform diagrams, broken links and placeholders. Returns errors (must fix), warnings and counts.",
    input: obj({ project: absPath("Absolute path of the project root.") }, ["project"]),
    run: (a, ctx) => {
      const root = checkPath(a.project, ctx.provider.scope.allowedRoots, "architecture");
      if (!existsSync(root)) throw new ToolError(`${root} does not exist`);
      return {
        ...checkBlueprint(root),
        next: "Fix every error, then run mermaid_preview on ARCHITECTURE.md and TODO.md to check that each Mermaid diagram parses.",
      };
    },
  }),
];

const provider: Provider = {
  id: "architecture",
  displayName: "Architecture",
  version: "1.0.0",
  bin: "uv",
  requires: ["dot"],
  setup: [
    {
      bin: "uv",
      winget: "astral-sh.uv",
      brew: "uv",
      docs: "https://docs.astral.sh/uv/getting-started/installation/",
    },
    {
      bin: "dot",
      winget: "Graphviz.Graphviz",
      brew: "graphviz",
      docs: "https://graphviz.org/download/",
    },
  ],
  onboarding: { status: "architecture_status", skill: "architecture-blueprint" },
  baseEnv: { NO_COLOR: "1" },
  instructions: {
    read: "Checks architecture documents (ARCHITECTURE.md, TODO.md, ADRs, runbook), lists official cloud icons and previews platform diagrams to throwaway PNGs.",
    write:
      "Renders platform diagram specs to PNG or SVG files in the workspace. Every call needs user approval.",
  },
  tools,
};

export default provider;
