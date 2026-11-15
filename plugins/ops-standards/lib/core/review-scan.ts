// GENERATED from packages/core/review-scan.ts by scripts/sync-core.ts. Edit the source, then run `pnpm run sync`.
import { findSecrets } from "./redact.ts";
import type { ReviewLensId } from "./types.ts";

export interface ReviewHint {
  rule: string;
  message: string;
  line?: number | undefined;
}

interface LineRule {
  id: string;
  re: RegExp;
  message: string;
  /** Workspace-relative paths the rule applies to; all reviewed files when omitted. */
  files?: RegExp;
}

interface LoopRule {
  id: string;
  /** Matched within LOOP_WINDOW lines after a loop header. */
  body: RegExp;
  message: string;
}

const CODE =
  /\.(c|cc|cpp|cs|go|java|js|jsx|kt|kts|mjs|cjs|php|py|rb|rs|scala|swift|ts|tsx|vue|svelte)$/i;
const WORKFLOW = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i;
export const DOC = /\.(md|mdx|markdown|mdc|rst|adoc)$/i;
/** Generated or intentional history files, where past tense is the content. */
export const HISTORY_FILE = /(^|\/)(CHANGELOG|HISTORY|RELEASES?|RELEASE_NOTES)(\.\w+)?$/i;
const LOOP_HEADER =
  /^\s*(?:for\s*\(|for\s+(?:await\s+)?\(?\s*(?:const|let|var)?\s*[\w\s,[\]{}]+\s+(?:of|in)\b|for\s+[\w\s,()]+\s+in\s+.+:\s*$|while\s*\(|\w[\w.]*\.forEach\()/;
const LOOP_WINDOW = 4;
const MAX_HINTS_PER_FILE = 10;

const SECURITY_RULES: LineRule[] = [
  {
    id: "security/dynamic-code",
    re: /\beval\s*\(|\bnew\s+Function\s*\(|\bexec\s*\(\s*(?:compile|input|request)/,
    message: "dynamic code execution; make sure no untrusted input reaches it",
    files: CODE,
  },
  {
    id: "security/shell-injection",
    re: /\bexec(?:Sync)?\s*\(\s*(?:`[^`]*\$\{|[^)\n]*["'`]\s*\+)|shell\s*=\s*True|\bos\.system\s*\(|\bRuntime\.getRuntime\(\)\.exec\s*\(/,
    message: "shell command built from strings; pass an argument array without a shell",
    files: CODE,
  },
  {
    id: "security/sql-injection",
    re: /`[^`\n]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^`\n]*\$\{|\bf["'][^"'\n]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^"'\n]*\{|["'][^"'\n]*\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b[^"'\n]*["']\s*(?:\+|%\s)|String\.format\(\s*"[^"\n]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i,
    message: "SQL built by string interpolation; use bound parameters",
    files: CODE,
  },
  {
    id: "security/xss-sink",
    re: /\.(?:innerHTML|outerHTML)\s*=|dangerouslySetInnerHTML|\bv-html\b|\bdocument\.write\s*\(|\|\s*safe\b|mark_safe\s*\(/,
    message: "raw HTML sink; escape or sanitize untrusted content",
  },
  {
    id: "security/tls-disabled",
    re: /rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|\bcurl\b[^\n]*\s(?:-k|--insecure)\b/,
    message: "TLS certificate verification disabled",
  },
  {
    id: "security/weak-crypto",
    re: /createHash\(\s*["'](?:md5|sha1)["']|hashlib\.(?:md5|sha1)\(|MessageDigest\.getInstance\(\s*"(?:MD5|SHA-?1)"|\b(?:AES|DES)\/ECB\b|["']DES(?:ede)?["'/]/,
    message: "weak hash or cipher; use SHA-256+ for integrity and a password KDF for passwords",
    files: CODE,
  },
  {
    id: "security/insecure-random",
    re: /(?:token|secret|password|nonce|salt|otp|session)\w*\s*[:=][^\n;]*(?:Math\.random\(|\brandom\.(?:random|randint|choice)\()/i,
    message: "non-cryptographic randomness for a secret; use crypto.randomBytes / secrets",
    files: CODE,
  },
  {
    id: "security/unsafe-deserialization",
    re: /\bpickle\.loads?\(|\byaml\.load\((?![^)\n]*SafeLoader)|\bmarshal\.loads\(|\bnew\s+ObjectInputStream\(|\bunserialize\s*\(/,
    message: "unsafe deserialization of possibly untrusted data",
    files: CODE,
  },
  {
    id: "security/cors-wildcard",
    re: /Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*|\borigin\s*:\s*["']\*["']|allow_origins\s*=\s*\[\s*["']\*|allowedOrigins\(\s*"\*"/,
    message: "CORS allows any origin; restrict it, especially with credentials",
  },
  {
    id: "security/workflow-injection",
    re: /\$\{\{\s*github\.event\.(?:issue|pull_request|comment|review|head_commit|discussion)\.[\w.]*(?:title|body|message|label|name|ref)\s*\}\}|\$\{\{\s*github\.head_ref\s*\}\}/,
    message: "untrusted event text interpolated into a workflow; pass it through env",
    files: WORKFLOW,
  },
  {
    id: "security/workflow-trigger",
    re: /\bpull_request_target\b|permissions:\s*write-all/,
    message: "privileged workflow trigger or permissions; never check out or run PR code with them",
    files: WORKFLOW,
  },
  {
    id: "security/permissive-runtime",
    re: /\bprivileged:\s*true|\bchmod\s+(?:-R\s+)?0?777\b|\bcurl\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b|--no-verify\b/,
    message: "overly permissive runtime, permissions or unverified script execution",
  },
];

const PERFORMANCE_RULES: LineRule[] = [
  {
    id: "performance/async-foreach",
    re: /\.forEach\(\s*async\b/,
    message:
      "async callback in forEach is neither awaited nor bounded; use for…of or Promise.all with a limit",
  },
  {
    id: "performance/sync-io",
    re: /\b(?:readFileSync|writeFileSync|appendFileSync|execSync|spawnSync)\s*\(/,
    message: "synchronous I/O blocks the event loop; fine in CLIs, avoid in servers and hot paths",
  },
  {
    id: "performance/blocking-sleep",
    re: /\btime\.sleep\s*\(|\bThread\.sleep\s*\(/,
    message: "blocking sleep; use scheduling, backoff utilities or async waits",
  },
  {
    id: "performance/select-star",
    re: /\bSELECT\s+\*\s+FROM\b/i,
    message: "SELECT * over-fetches; select only the needed columns",
  },
  {
    id: "performance/unbounded-query",
    re: /\.objects\.all\(\)|\.findAll\(\s*\)|\.find\(\s*\{\s*\}\s*\)|\.findMany\(\s*\)/,
    message: "unbounded query; paginate or limit",
  },
  {
    id: "performance/json-clone",
    re: /JSON\.parse\(\s*JSON\.stringify\(/,
    message: "JSON round-trip clone; use structuredClone or avoid the copy",
  },
  {
    id: "performance/nested-scan",
    re: /\.(?:map|filter|forEach|some|every|reduce|flatMap)\([^\n]*\.(?:find|filter|includes|indexOf|findIndex)\(/,
    message: "linear scan inside an iteration is O(n·m); index with a Map or Set",
  },
];

/** Narration of how code or docs used to be; the current state is documented, git keeps the past. */
const HISTORY =
  /\b(?:previously|formerly|used to (?:be|use|return|call|have)|no longer|anymore|(?:was|were|got|has been) (?:renamed|replaced|removed|moved|changed|rewritten)|renamed (?:from|to)|(?:old|legacy|previous) (?:behaviou?r|implementation|version|approach|code|api|format|name)|backwards?[- ]compat\w*|for (?:backward |legacy )?compatibility|kept for compat\w*|deprecated|this (?:PR|change|commit|refactor) |we (?:changed|switched|moved|now)|now (?:uses|supports|returns|handles|lives)|correction:|as of v?\d)/i;
const COMMENT = /(?:\/\/|\/\*|^\s*\*|#|<!--|^\s*--\s)/;
/** A home folder name that is a placeholder or shared system folder rather than a real user. */
const PLACEHOLDER_USER = /(?:[<{$%]|(?:Public|Default|Shared|you|me|user|username|name)(?![\w.-]))/;
const WINDOWS_HOME = new RegExp(
  String.raw`\b[a-z]:[\\/]+Users[\\/]+(?!${PLACEHOLDER_USER.source})[\w.-]+`,
);
const POSIX_HOME = new RegExp(
  String.raw`(?:^|[\s"'\x60(=:>/]|\/mnt\/[a-z])\/(?:Users|home)\/(?!${PLACEHOLDER_USER.source})[\w.-]+`,
);
/** A folder on a drive other than the system drive `C:`. */
const DATA_DRIVE = /\b[d-z]:[\\/]+[a-z]\w*/;
const PERSONAL_PATH = new RegExp(
  [WINDOWS_HOME, POSIX_HOME, DATA_DRIVE].map((r) => r.source).join("|"),
  "i",
);

const STANDARDS_RULES: LineRule[] = [
  {
    id: "standards/history-comment",
    re: new RegExp(`${COMMENT.source}.*${HISTORY.source}`, "i"),
    message:
      "comment narrates history; describe the code as it is now (git history records the past)",
    files: CODE,
  },
  {
    id: "standards/history-doc",
    re: HISTORY,
    message:
      "doc narrates history or compatibility; document only the current state (git history records the past)",
    files: DOC,
  },
  {
    id: "standards/commented-out-code",
    re: /^\s*(?:\/\/|#)\s*(?:const|let|var|function|return|import|export|await|def|class|if\s*\(|for\s*\(|while\s*\(|print\(|console\.)\S*[^\n]*[;{}()=]\s*$/,
    message: "commented-out code; delete it (git history keeps it)",
    files: CODE,
  },
  {
    id: "standards/todo",
    re: /\b(?:TODO|FIXME|XXX|HACK)\b/,
    message: "unfinished-work marker; finish the work now or track it in an issue",
  },
  {
    id: "standards/compat-shim",
    re: /@deprecated\b|\b(?:legacy|Legacy|LEGACY)\w*\s*[:=(]|\b\w+(?:Old|_old|V1|_v1)\s*[:=(]/,
    message:
      "deprecated, legacy or versioned duplicate; switch every caller to the current code and delete the old path",
    files: CODE,
  },
  {
    id: "standards/suppression",
    re: /@ts-(?:ignore|nocheck)\b|eslint-disable(?![^\n]*--\s*\S)|#\s*type:\s*ignore\s*$|#\s*noqa\s*$|biome-ignore\s+\S+\s*$/,
    message: "lint or type suppression without a reason; fix the cause or state why it is needed",
    files: CODE,
  },
  {
    id: "standards/personal-path",
    re: PERSONAL_PATH,
    message:
      "user- or machine-specific path; derive it at runtime (home dir, env, config) or use a placeholder such as ~/code/app",
  },
  {
    id: "standards/debug-leftover",
    re: /\bdebugger\s*;|\bconsole\.debug\s*\(|\bbreakpoint\(\)|\bpdb\.set_trace\(/,
    message: "debugging leftover; remove it",
    files: CODE,
  },
];

/** Lenses whose hints come from per-line rules; the docs lens checks references instead. */
export type ScanLensId = Exclude<ReviewLensId, "docs">;

const LINE_RULES: Record<ScanLensId, LineRule[]> = {
  security: SECURITY_RULES,
  performance: PERFORMANCE_RULES,
  standards: STANDARDS_RULES,
};

const PERFORMANCE_LOOP_RULES: LoopRule[] = [
  {
    id: "performance/query-in-loop",
    body: /\.(?:query|execute|findOne|findUnique|findFirst|findById|getOne)\s*\(|\.objects\.(?:get|filter)\s*\(|\bfetch\s*\(|\baxios\.\w+\s*\(|\brequests\.(?:get|post|put|delete)\s*\(/,
    message: "database or network call inside a loop (N+1); batch it",
  },
  {
    id: "performance/await-in-loop",
    body: /\bawait\b(?!\s+Promise\.(?:all|allSettled))/,
    message:
      "sequential await inside a loop; run independent work concurrently with a bounded Promise.all",
  },
];

/** Starting line (1-based) of `snippet` inside `text`, when it can be located. */
export function lineOf(text: string | undefined, snippet: string): number | undefined {
  if (!text || !snippet) return undefined;
  const at = text.indexOf(snippet);
  return at < 0 ? undefined : text.slice(0, at).split("\n").length;
}

function scanLines(
  lens: ScanLensId,
  path: string,
  lines: string[],
  base: number | undefined,
): ReviewHint[] {
  const hints: ReviewHint[] = [];
  const at = (i: number) => (base === undefined ? undefined : base + i);
  const applicable = LINE_RULES[lens].filter((r) => !r.files || r.files.test(path));

  lines.forEach((text, i) => {
    for (const rule of applicable) {
      if (rule.re.test(text)) hints.push({ rule: rule.id, message: rule.message, line: at(i) });
    }
    if (lens === "security") {
      const kinds = findSecrets(text);
      if (kinds.length) {
        hints.push({
          rule: "security/hardcoded-secret",
          message: `credential material in source (${kinds.join(", ")}); load it from a secret store`,
          line: at(i),
        });
      }
    }
  });

  if (lens === "performance" && CODE.test(path)) {
    lines.forEach((text, i) => {
      if (!LOOP_HEADER.test(text)) return;
      const window = lines.slice(i + 1, i + 1 + LOOP_WINDOW);
      for (const rule of PERFORMANCE_LOOP_RULES) {
        const hit = window.findIndex((l) => rule.body.test(l));
        if (hit >= 0) {
          hints.push({ rule: rule.id, message: rule.message, line: at(i + 1 + hit) });
          break;
        }
      }
    });
  }
  return hints;
}

/**
 * Heuristic hints for the lines an edit introduced. They point the reviewer at likely
 * problems; the agent confirms or dismisses each one.
 */
export function scanEdit(
  lens: ScanLensId,
  path: string,
  edits: { new_string?: string }[],
  fileText?: string,
): ReviewHint[] {
  const seen = new Set<string>();
  const hints: ReviewHint[] = [];
  for (const edit of edits) {
    const added = edit.new_string ?? "";
    if (!added.trim()) continue;
    for (const hint of scanLines(lens, path, added.split(/\r?\n/), lineOf(fileText, added))) {
      const key = `${hint.rule}:${hint.line ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hints.push(hint);
    }
  }
  return hints.slice(0, MAX_HINTS_PER_FILE);
}
