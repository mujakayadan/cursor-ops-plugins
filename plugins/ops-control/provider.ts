import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditDir } from "./lib/core/audit.ts";
import { configPath, loadConfig, privilegedEnabled, reviewDir } from "./lib/core/config.ts";
import { bool, int, obj, oneOf, str, ToolError, tool } from "./lib/core/schema-helpers.ts";
import { ALWAYS_ON, loaderCommand, suitePlugins, userHooksPath } from "./lib/core/suite.ts";
import type { Config, Provider, ReviewLensId } from "./lib/core/types.ts";

const PLUGINS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(PLUGINS_DIR, "..");
const LENS_IDS = [
  "security",
  "performance",
  "standards",
  "docs",
] as const satisfies readonly ReviewLensId[];
const AUDIT_SOURCES = ["hook", "mcp", "shell", "mcp-hook"] as const;
const DECISIONS = ["allow", "ask", "deny"] as const;
const MAX_FIELD = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

function readJsonl(path: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // A torn line from a concurrent append.
    }
  }
  return out;
}

function clip(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([k, v]) => [
      k,
      typeof v === "string" && v.length > MAX_FIELD ? `${v.slice(0, MAX_FIELD)}…` : v,
    ]),
  );
}

function gitState(): { branch: string | null; head: string | null } {
  const headFile = join(REPO_ROOT, ".git", "HEAD");
  if (!existsSync(headFile)) return { branch: null, head: null };
  const head = readFileSync(headFile, "utf8").trim();
  const ref = /^ref: (refs\/heads\/(.+))$/.exec(head);
  if (!ref?.[1]) return { branch: null, head: head.slice(0, 12) };
  const refFile = join(REPO_ROOT, ".git", ref[1]);
  return {
    branch: ref[2] ?? null,
    head: existsSync(refFile) ? readFileSync(refFile, "utf8").trim().slice(0, 12) : null,
  };
}

/** Read-modify-write of the user config file; only the keys passed in `apply` change. */
function updateConfig(apply: (raw: Record<string, unknown>) => void): Config {
  const path = configPath();
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (err) {
      throw new ToolError(
        `Invalid ops config at ${path}: ${(err as Error).message}. Fix it by hand.`,
      );
    }
  }
  apply(raw);
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
  return loadConfig({ reload: true });
}

function section(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = raw[key];
  const next =
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  raw[key] = next;
  return next;
}

const tools = [
  tool({
    name: "control_status",
    title: "Suite status",
    tier: "read",
    description:
      "Report the ops plugin suite: checkout and branch, whether the workspaceOpen loader is registered, every plugin with its version and enabled state, review settings, and which providers have privileged tools enabled. Plugin changes take effect after a window reload.",
    run: (_a, { cfg }) => {
      const plugins = suitePlugins(PLUGINS_DIR, cfg.suite.disabledPlugins);
      let loader: string | null = null;
      let loaderError: string | undefined;
      try {
        loader = loaderCommand() ?? null;
      } catch (err) {
        loaderError = (err as Error).message;
      }
      return {
        suite: { root: REPO_ROOT, ...gitState() },
        loader: {
          hooksFile: userHooksPath(),
          registered: loader !== null,
          command: loader,
          ...(loaderError ? { error: loaderError } : {}),
          ...(loader === null
            ? { fix: "Run `pnpm run install-local` in the suite checkout." }
            : {}),
        },
        config: { path: configPath(), exists: existsSync(configPath()) },
        plugins: plugins.map(({ name, version, enabled, provider }) => ({
          name,
          version,
          enabled,
          ...(provider ? { privileged: privilegedEnabled(name.replace(/^ops-/, ""), cfg) } : {}),
        })),
        review: cfg.review,
      };
    },
  }),
  tool({
    name: "control_audit",
    title: "Query the audit log",
    tier: "read",
    description:
      "Newest-first records from the redacted ops audit log: guard decisions, MCP tool calls, finished shell commands and MCP results.",
    input: obj({
      days: int("Days back to search, including today.", { minimum: 1, maximum: 30, default: 1 }),
      source: oneOf(AUDIT_SOURCES, "Only records from this source."),
      decision: oneOf(DECISIONS, "Only guard decisions with this outcome."),
      match: str("Case-insensitive text that must appear in the record.", { maxLength: 200 }),
      limit: int("Records to return.", { minimum: 1, maximum: 200, default: 50 }),
    }),
    run: (a, { cfg }) => {
      const dir = auditDir(cfg);
      if (!existsSync(dir)) return { dir, records: [] };
      const since = new Date(Date.now() - (a.days - 1) * DAY_MS).toISOString().slice(0, 10);
      const files = readdirSync(dir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) >= since)
        .sort()
        .reverse();
      const needle = a.match?.toLowerCase();
      const records: Record<string, unknown>[] = [];
      for (const file of files) {
        for (const record of readJsonl(join(dir, file)).reverse()) {
          if (a.source && record.source !== a.source) continue;
          if (a.decision && record.decision !== a.decision) continue;
          if (needle && !JSON.stringify(record).toLowerCase().includes(needle)) continue;
          records.push(clip(record));
          if (records.length >= a.limit) return { dir, records };
        }
      }
      return { dir, records };
    },
  }),
  tool({
    name: "control_reviews",
    title: "Recent review activity",
    tier: "read",
    description:
      "Per conversation, the edits each review lens recorded, the static hints found, and the review requests sent, newest conversation first (logs are kept for 7 days).",
    input: obj({
      limit: int("Conversations to return.", { minimum: 1, maximum: 50, default: 10 }),
    }),
    run: (a) => {
      const dir = reviewDir();
      if (!existsSync(dir)) return { dir, conversations: [] };
      const logs = readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((x, y) => y.mtime - x.mtime)
        .slice(0, a.limit);
      return {
        dir,
        conversations: logs.map(({ f, mtime }) => {
          const lenses = new Map<string, { files: Set<string>; hints: number }>();
          let requests = 0;
          let lastRequest: string | undefined;
          for (const e of readJsonl(join(dir, f))) {
            if (e.t === "edit" && typeof e.lens === "string") {
              const lens = lenses.get(e.lens) ?? { files: new Set<string>(), hints: 0 };
              lens.files.add(String(e.file));
              lens.hints += Array.isArray(e.hints) ? e.hints.length : 0;
              lenses.set(e.lens, lens);
            } else if (e.t === "request") {
              requests++;
              lastRequest = String(e.message ?? "");
            }
          }
          return {
            conversation: f.replace(/\.jsonl$/, ""),
            lastActivity: new Date(mtime).toISOString(),
            lenses: Object.fromEntries(
              [...lenses].map(([id, l]) => [id, { files: l.files.size, hints: l.hints }]),
            ),
            requests,
            ...(lastRequest ? clip({ lastRequest }) : {}),
          };
        }),
      };
    },
  }),
  tool({
    name: "control_review_set",
    title: "Change review settings",
    tier: "write",
    description:
      "Turn the review follow-ups on or off, toggle one lens, or tune when reviews trigger. Writes only the review section of the ops config; takes effect on the next prompt.",
    input: obj({
      enabled: bool("Reviews on or off for every lens."),
      lens: oneOf(LENS_IDS, "Lens to toggle; pass with lensEnabled."),
      lensEnabled: bool("New state for `lens`."),
      maxRounds: int("Review requests per user prompt.", { minimum: 0, maximum: 5 }),
      minChangedLines: int("Turns with fewer changed lines and no hints skip review.", {
        minimum: 0,
        maximum: 500,
      }),
      maxFiles: int("Changed files listed in a review request.", { minimum: 1, maximum: 200 }),
    }),
    summarize: (a) =>
      Object.entries(a)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(", ") || "no change",
    run: (a) => {
      if ((a.lens === undefined) !== (a.lensEnabled === undefined)) {
        throw new ToolError("Pass `lens` and `lensEnabled` together.");
      }
      const cfg = updateConfig((raw) => {
        const review = section(raw, "review");
        if (a.enabled !== undefined) review.enabled = a.enabled;
        if (a.lens !== undefined && a.lensEnabled !== undefined) {
          section(review, "lenses")[a.lens] = a.lensEnabled;
        }
        if (a.maxRounds !== undefined) review.maxRounds = a.maxRounds;
        if (a.minChangedLines !== undefined) review.minChangedLines = a.minChangedLines;
        if (a.maxFiles !== undefined) review.maxFiles = a.maxFiles;
      });
      return { review: cfg.review };
    },
  }),
  tool({
    name: "control_plugin_set",
    title: "Enable or disable a plugin",
    tier: "write",
    description: `Choose whether a suite plugin loads in every workspace. ${ALWAYS_ON.join(" and ")} always load. Takes effect after Developer: Reload Window.`,
    input: obj(
      {
        plugin: str("Plugin directory name, e.g. ops-latex.", { pattern: "^ops-[a-z0-9-]{1,40}$" }),
        enabled: bool("Load the plugin."),
      },
      ["plugin", "enabled"],
    ),
    summarize: (a) => `${a.enabled ? "enable" : "disable"} ${a.plugin}`,
    run: (a, { cfg }) => {
      if (ALWAYS_ON.includes(a.plugin)) {
        throw new ToolError(`${a.plugin} always loads and cannot be disabled.`);
      }
      if (!suitePlugins(PLUGINS_DIR, []).some((p) => p.name === a.plugin)) {
        throw new ToolError(`No suite plugin named ${a.plugin}.`);
      }
      const disabled = new Set(cfg.suite.disabledPlugins);
      if (a.enabled) disabled.delete(a.plugin);
      else disabled.add(a.plugin);
      const next = updateConfig((raw) => {
        section(raw, "suite").disabledPlugins = [...disabled].sort();
      });
      return {
        disabledPlugins: next.suite.disabledPlugins,
        next: "Reload the window (Developer: Reload Window) to apply.",
      };
    },
  }),
];

const provider: Provider = {
  id: "control",
  displayName: "Suite Control",
  version: "0.1.0",
  bin: "node",
  instructions: {
    read: "Inspect the ops plugin suite: install and plugin status, the audit log, and review activity.",
    write:
      "Change review settings and which suite plugins load; every call requires approval. Guardrails, privileged tools, credentials and third-party MCP policy stay with the user and are not editable here.",
  },
  tools,
};

export default provider;
