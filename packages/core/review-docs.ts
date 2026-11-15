import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DOC, HISTORY_FILE, type ReviewHint } from "./review-scan.ts";

const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);
const MAX_WALK = 5000;
const MAX_DOCS = 400;
const MAX_DOC_BYTES = 512 * 1024;
const MAX_TOKENS = 20;
const MAX_MENTIONS = 10;
const MIN_TOKEN = 6;

/** Identifier-shaped tokens (snake_case, kebab-case, camelCase) specific enough that a doc mention refers to them. */
const TOKEN = /[A-Za-z_][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+|\b[a-z]+[A-Z][A-Za-z0-9]*/g;
const LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const INLINE_PATH = /`((?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\/?)`/g;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (token: string) => new RegExp(`(?<![\\w-])${escapeRegExp(token)}(?![\\w-])`);

/** Identifiers an edit removed that appear nowhere in the edited file. */
export function removedIdentifiers(
  edits: { old_string?: string; new_string?: string }[],
  fileText: string | undefined,
): string[] {
  const after = fileText ?? edits.map((e) => e.new_string ?? "").join("\n");
  const removed = new Set<string>();
  for (const e of edits) {
    for (const [token] of (e.old_string ?? "").matchAll(TOKEN)) {
      if (token.length >= MIN_TOKEN && !mentions(token).test(after)) removed.add(token);
    }
  }
  return [...removed].slice(0, MAX_TOKENS);
}

function docFiles(root: string): string[] {
  const docs: string[] = [];
  const stack = [root];
  let visited = 0;
  while (stack.length && visited < MAX_WALK && docs.length < MAX_DOCS) {
    const dir = stack.pop() ?? "";
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited++;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !(entry.name === "core" && dir.endsWith("lib"))) {
          stack.push(full);
        }
      } else if (DOC.test(entry.name) && !HISTORY_FILE.test(entry.name)) {
        docs.push(full);
      }
    }
  }
  return docs;
}

/** Docs under `root` that still mention identifiers the edit removed. */
export function staleMentions(root: string, tokens: string[]): ReviewHint[] {
  if (!tokens.length) return [];
  const patterns = tokens.map((t) => [t, mentions(t)] as const);
  const hints: ReviewHint[] = [];
  for (const doc of docFiles(root)) {
    let text: string;
    try {
      if (statSync(doc).size > MAX_DOC_BYTES) continue;
      text = readFileSync(doc, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (const [token, re] of patterns) {
      const at = lines.findIndex((l) => re.test(l));
      if (at < 0) continue;
      const where = `${relative(root, doc).replaceAll("\\", "/")}:${at + 1}`;
      hints.push({
        rule: "docs/stale-reference",
        message: `\`${where}\` mentions \`${token}\`, which this edit removed; update or delete that text if nothing defines it`,
      });
      if (hints.length >= MAX_MENTIONS) return hints;
    }
  }
  return hints;
}

function isExternal(target: string): boolean {
  return /^(?:[a-z][\w+.-]*:|#|\/\/|mailto:)/i.test(target);
}

/** Broken relative links and missing repository paths in the lines an edit added to a doc. */
export function referenceHints(
  docPath: string,
  root: string,
  added: string[],
  base: number | undefined,
): ReviewHint[] {
  const hints: ReviewHint[] = [];
  const docDir = dirname(docPath);
  added.forEach((text, i) => {
    const line = base === undefined ? undefined : base + i;
    for (const [, raw = ""] of text.matchAll(LINK)) {
      if (isExternal(raw)) continue;
      const target = decodeURI(raw.replace(/[#?].*$/, ""));
      if (target && !existsSync(resolve(docDir, target))) {
        hints.push({
          rule: "docs/broken-link",
          message: `link target \`${raw}\` does not exist`,
          line,
        });
      }
    }
    for (const [, path = ""] of text.matchAll(INLINE_PATH)) {
      if (/[<>*{}$~]/.test(path)) continue;
      const first = path.replace(/^\.{1,2}\//, "").split("/")[0] ?? "";
      const anchored = path.startsWith(".") || existsSync(join(root, first));
      if (!anchored) continue;
      const exists = existsSync(resolve(root, path)) || existsSync(resolve(docDir, path));
      if (!exists) {
        hints.push({ rule: "docs/missing-path", message: `\`${path}\` does not exist`, line });
      }
    }
  });
  return hints;
}
