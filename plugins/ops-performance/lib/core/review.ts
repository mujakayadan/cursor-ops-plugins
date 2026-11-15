// GENERATED from packages/core/review.ts by scripts/sync-core.ts. Edit the source, then run `pnpm run sync`.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { loadConfig, opsHome } from "./config.ts";
import type { HookHandler } from "./hook-runtime.ts";
import { referenceHints, removedIdentifiers, staleMentions } from "./review-docs.ts";
import { DOC, HISTORY_FILE, lineOf, type ReviewHint, scanEdit } from "./review-scan.ts";
import type { Config, HookPayload, HookResponse, ReviewLensId } from "./types.ts";

/** Prefix of every automatic review request; prompts starting with it are not user turns. */
export const REVIEW_MARKER = "[ops-review]";

export interface ReviewLens {
  id: ReviewLensId;
  title: string;
  plugin: string;
  skill: string;
  agent: string;
  focus: string;
  relevant(path: string): boolean;
}

const CODE =
  /\.(c|cc|cpp|cs|go|java|js|jsx|kt|kts|mjs|cjs|php|py|rb|rs|scala|swift|sql|ts|tsx|vue|svelte)$/i;
const INFRA =
  /(^|\/)(Dockerfile[^/]*|Containerfile|Jenkinsfile|Makefile)$|\.(tf|hcl|sh|bash|zsh|ps1|ya?ml|toml|gradle|xml|ini|conf|properties)$|(^|\/)(package|composer|tsconfig|deno)\.json$/i;
const TEST =
  /(^|\/)(tests?|__tests__|spec|e2e|fixtures?)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;
const NEVER =
  /(^|\/)(node_modules|dist|build|out|target|vendor|\.venv|\.git|coverage|\.next)\/|(^|\/)lib\/core\/|\.(lock|min\.js|map|snap)$|(^|\/)(pnpm-lock\.yaml|package-lock\.json|uv\.lock|poetry\.lock|Cargo\.lock|go\.sum)$/i;

export const LENSES: Record<ReviewLensId, ReviewLens> = {
  performance: {
    id: "performance",
    title: "Performance",
    plugin: "ops-performance",
    skill: "performance-review",
    agent: "performance-reviewer",
    focus:
      "algorithmic complexity and hot paths, N+1 and unbounded queries, blocking or sequential I/O, caching and memoization, memory growth and leaks, payload and bundle size, rendering work",
    relevant: (path) => CODE.test(path) && !TEST.test(path),
  },
  security: {
    id: "security",
    title: "Security",
    plugin: "ops-security",
    skill: "security-review",
    agent: "security-reviewer",
    focus:
      "injection (SQL, shell, template, path), authentication and authorization checks, secrets and sensitive data exposure, input validation and output encoding, SSRF and unsafe redirects, crypto and randomness, dependency and CI/CD supply chain, insecure defaults",
    relevant: (path) => CODE.test(path) || INFRA.test(path),
  },
  standards: {
    id: "standards",
    title: "Standards",
    plugin: "ops-standards",
    skill: "standards-review",
    agent: "standards-reviewer",
    focus:
      "code and docs that describe only the current state: no history or change narration in comments, docs or notes (git history is the record), no backward-compatibility shims, legacy, dead or commented-out code, no leftover TODOs, debug code or unexplained suppressions; clear names, small focused units, no duplication, idioms consistent with the surrounding code",
    relevant: (path) =>
      (CODE.test(path) || INFRA.test(path) || DOC.test(path)) && !HISTORY_FILE.test(path),
  },
  docs: {
    id: "docs",
    title: "Docs",
    plugin: "ops-docs",
    skill: "docs-review",
    agent: "docs-reviewer",
    focus:
      "documentation that describes the changed code (READMEs, guides, skills, rules, config references, examples, API and CLI docs, code comments) must match it exactly as it is now: update stale names, options, paths, defaults, counts and examples, delete docs for removed behavior, and document new user-facing behavior",
    relevant: (path) =>
      (CODE.test(path) || INFRA.test(path) || DOC.test(path)) &&
      !TEST.test(path) &&
      !HISTORY_FILE.test(path),
  },
};

/** Workspace root that contains `file`, or the file's directory when it is outside every root. */
function rootOf(file: string, roots: string[] = []): string {
  return (
    roots.find((r) => {
      const rel = relative(r, file);
      return !rel.startsWith("..") && !isAbsolute(rel);
    }) ?? dirname(file)
  );
}

function hintsFor(
  lens: ReviewLensId,
  file: string,
  payload: HookPayload,
  text: string | undefined,
): ReviewHint[] {
  const edits = payload.edits ?? [];
  switch (lens) {
    case "security":
    case "performance":
    case "standards":
      return scanEdit(lens, file, edits, text);
    case "docs": {
      const abs = payload.file_path ?? "";
      const root = rootOf(abs, payload.workspace_roots);
      if (DOC.test(file)) {
        return edits.flatMap((e) => {
          const added = e.new_string ?? "";
          return added.trim()
            ? referenceHints(abs, root, added.split(/\r?\n/), lineOf(text, added))
            : [];
        });
      }
      return staleMentions(root, removedIdentifiers(edits, text));
    }
    default: {
      const unhandled: never = lens;
      return unhandled;
    }
  }
}

interface EditEvent {
  t: "edit";
  at: number;
  gen: string;
  lens: ReviewLensId;
  file: string;
  lines: number;
  hints: ReviewHint[];
}
interface RequestEvent {
  t: "request";
  at: number;
  gen: string;
  loop: number;
  message: string;
}
type ReviewEvent =
  | { t: "prompt"; at: number; gen: string; review: boolean }
  | EditEvent
  | RequestEvent;

const isEdit = (e: ReviewEvent): e is EditEvent => e.t === "edit";
const isRequest = (e: ReviewEvent): e is RequestEvent => e.t === "request";

const DELEGATE_AT_FILES = 8;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function reviewDir(): string {
  return process.env.OPS_REVIEW_DIR || join(opsHome(), "review");
}

function logPath(conversation: string): string {
  return join(reviewDir(), `${conversation.replace(/[^\w.-]/g, "_")}.jsonl`);
}

function append(conversation: string, event: ReviewEvent): void {
  mkdirSync(reviewDir(), { recursive: true });
  appendFileSync(logPath(conversation), `${JSON.stringify(event)}\n`);
}

function readEvents(conversation: string): ReviewEvent[] {
  const path = logPath(conversation);
  if (!existsSync(path)) return [];
  const events: ReviewEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as ReviewEvent);
    } catch {
      // A torn line from a concurrent append; the rest of the log is still usable.
    }
  }
  return events;
}

function pruneOldLogs(now: number): void {
  const dir = reviewDir();
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > RETENTION_MS) rmSync(path, { force: true });
    } catch {
      // Another hook removed it first.
    }
  }
}

export function reviewEnabled(lens: ReviewLensId, cfg: Config): boolean {
  const env = process.env.OPS_REVIEW?.toLowerCase();
  if (env === "0" || env === "off" || env === "false") return false;
  return cfg.review.enabled && cfg.review.lenses[lens] !== false;
}

/** Workspace-relative, forward-slash path; absolute when outside every workspace root. */
export function displayPath(file: string, roots: string[] = []): string {
  for (const root of roots) {
    const rel = relative(root, file);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.replaceAll("\\", "/");
  }
  return file.replaceAll("\\", "/");
}

function ignored(path: string, cfg: Config): boolean {
  if (NEVER.test(path)) return true;
  return cfg.review.ignore.some((pattern) => {
    try {
      return new RegExp(pattern).test(path);
    } catch {
      return false;
    }
  });
}

function changedLines(edits: HookPayload["edits"] = []): number {
  return edits.reduce((n, e) => {
    const added = e.new_string ? e.new_string.split("\n").length : 0;
    const removed = e.old_string ? e.old_string.split("\n").length : 0;
    return n + Math.max(added, removed > 0 ? 1 : 0);
  }, 0);
}

export function recordPrompt(payload: HookPayload, lens: ReviewLensId, cfg: Config): void {
  if (!payload.conversation_id || !reviewEnabled(lens, cfg)) return;
  const now = Date.now();
  pruneOldLogs(now);
  append(payload.conversation_id, {
    t: "prompt",
    at: now,
    gen: payload.generation_id ?? "",
    review: (payload.prompt ?? "").trimStart().startsWith(REVIEW_MARKER),
  });
}

export function recordEdit(payload: HookPayload, lens: ReviewLensId, cfg: Config): void {
  if (!payload.conversation_id || !payload.file_path || !reviewEnabled(lens, cfg)) return;
  const file = displayPath(payload.file_path, payload.workspace_roots);
  if (ignored(file, cfg) || !LENSES[lens].relevant(file)) return;
  let text: string | undefined;
  try {
    text = readFileSync(payload.file_path, "utf8");
  } catch {
    text = undefined;
  }
  append(payload.conversation_id, {
    t: "edit",
    at: Date.now(),
    gen: payload.generation_id ?? "",
    lens,
    file,
    lines: changedLines(payload.edits),
    hints: hintsFor(lens, file, payload, text),
  });
}

interface LensChanges {
  lens: ReviewLens;
  files: string[];
  lines: number;
  hints: (ReviewHint & { file: string })[];
}

function collect(edits: EditEvent[], cfg: Config): LensChanges[] {
  const byLens = new Map<ReviewLensId, LensChanges>();
  for (const e of edits) {
    if (!reviewEnabled(e.lens, cfg)) continue;
    const entry = byLens.get(e.lens) ?? { lens: LENSES[e.lens], files: [], lines: 0, hints: [] };
    if (!entry.files.includes(e.file)) entry.files.push(e.file);
    entry.lines += e.lines;
    for (const h of e.hints) {
      const dup = entry.hints.some(
        (x) => x.file === e.file && x.rule === h.rule && x.line === h.line,
      );
      if (!dup) entry.hints.push({ ...h, file: e.file });
    }
    byLens.set(e.lens, entry);
  }
  return [...byLens.values()]
    .map((c) => ({
      ...c,
      files: [...c.files].sort(),
      hints: [...c.hints].sort(
        (a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0),
      ),
    }))
    .sort((a, b) => a.lens.id.localeCompare(b.lens.id));
}

export function buildReviewMessage(changes: LensChanges[], cfg: Config): string {
  const plugins = changes.map((c) => c.lens.plugin).join(", ");
  const allFiles = new Set(changes.flatMap((c) => c.files));
  const out = [
    `${REVIEW_MARKER} Automatic review of the changes from this turn (${plugins}). Review only what changed in this turn, not the whole repository.`,
  ];
  for (const c of changes) {
    const shown = c.files.slice(0, cfg.review.maxFiles).map((f) => `\`${f}\``);
    const more = c.files.length - shown.length;
    out.push(
      "",
      `### ${c.lens.title}: follow the \`${c.lens.skill}\` skill`,
      `Files (${c.files.length}): ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`,
      `Focus: ${c.lens.focus}.`,
    );
    if (c.hints.length) {
      out.push("Static hints (heuristic; confirm or dismiss each):");
      for (const h of c.hints) {
        out.push(`- \`${h.file}${h.line ? `:${h.line}` : ""}\` ${h.rule}: ${h.message}`);
      }
    }
  }
  const agents = changes.map((c) => `\`${c.lens.agent}\``).join(" and ");
  out.push(
    "",
    "How to respond:",
    "1. Read each skill above, then inspect the changed code (prefer `git diff` and the files listed).",
    allFiles.size >= DELEGATE_AT_FILES
      ? `2. This is a large change: delegate each lens to its read-only subagent (${agents}) in parallel, then consolidate.`
      : "2. Review the changes yourself; no subagent is needed for a change this size.",
    "3. Fix clear, low-risk problems in place. List anything that changes behavior, needs a product decision or is outside this turn's changes instead of changing it.",
    "4. End with a short **Review** section: findings by severity with `file:line`, what you fixed, and what remains. If nothing is wrong, say so in one line.",
  );
  return out.join("\n");
}

export function requestReview(payload: HookPayload, cfg: Config): HookResponse {
  if (!payload.conversation_id || payload.status !== "completed") return {};
  const events = readEvents(payload.conversation_id);
  const gen = payload.generation_id ?? "";
  const loop = payload.loop_count ?? 0;

  // Every installed review plugin answers this stop with the same message, so it does not
  // matter which one Cursor keeps when several hooks return a follow-up.
  const answered = events.filter(isRequest).findLast((e) => e.gen === gen && e.loop === loop);
  if (answered) return { followup_message: answered.message };

  const userStart = events.findLastIndex((e) => e.t === "prompt" && !e.review);
  const rounds = new Set(
    events
      .slice(userStart + 1)
      .filter(isRequest)
      .map((e) => `${e.gen}:${e.loop}`),
  ).size;
  if (rounds >= cfg.review.maxRounds) return {};

  const lastRequest = events.findLastIndex(isRequest);
  const changes = collect(events.slice(Math.max(userStart, lastRequest) + 1).filter(isEdit), cfg);
  if (!changes.length) return {};
  const lines = Math.max(...changes.map((c) => c.lines));
  const hinted = changes.some((c) => c.hints.length > 0);
  if (lines < cfg.review.minChangedLines && !hinted) return {};

  const message = buildReviewMessage(changes, cfg);
  append(payload.conversation_id, { t: "request", at: Date.now(), gen, loop, message });
  return { followup_message: message };
}

/** Hook handlers shared by the review plugins; each plugin records only its own lens. */
export function reviewHooks(lens: ReviewLensId): Partial<Record<string, HookHandler>> {
  return {
    beforeSubmitPrompt(payload) {
      recordPrompt(payload, lens, loadConfig());
      return { continue: true };
    },
    afterFileEdit(payload) {
      recordEdit(payload, lens, loadConfig());
      return {};
    },
    stop(payload) {
      return requestReview(payload, loadConfig());
    },
  };
}
