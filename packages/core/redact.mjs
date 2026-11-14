const SECRET_PATTERNS = [
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "aws-secret-access-key", re: /(aws_secret_access_key\s*[=:]\s*)["']?[A-Za-z0-9/+=]{40}["']?/gi, keepGroup: 1 },
  { kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { kind: "digitalocean-token", re: /\bdo[opr]_v1_[a-f0-9]{64}\b/g },
  { kind: "vercel-token", re: /\bvc[kpa]_[A-Za-z0-9]{24,}\b/g },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "stripe-key", re: /\b[rs]k_live_[A-Za-z0-9]{20,}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: "bearer-token", re: /(\bBearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g, keepGroup: 1 },
  { kind: "url-credentials", re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi, keepGroup: [1, 2] },
  {
    kind: "secret-field",
    re: /(["']?(?:password|passwd|secret|client_secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)["']?\s*[:=]\s*["'])([^"'\s]{6,})(["'])/gi,
    keepGroup: [1, 3],
  },
];

function replacement(kind, match, groups, keepGroup) {
  const tag = `[REDACTED:${kind}]`;
  if (keepGroup === undefined) return tag;
  if (typeof keepGroup === "number") return `${groups[keepGroup - 1]}${tag}`;
  const [prefix, suffix] = keepGroup;
  return `${groups[prefix - 1]}${tag}${groups[suffix - 1]}`;
}

export function redact(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const { kind, re, keepGroup } of SECRET_PATTERNS) {
    out = out.replace(re, (match, ...rest) => replacement(kind, match, rest, keepGroup));
  }
  return out;
}

export function findSecrets(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const kinds = new Set();
  for (const { kind, re } of SECRET_PATTERNS) {
    if (kind === "secret-field" || kind === "jwt") continue;
    re.lastIndex = 0;
    if (re.test(text)) kinds.add(kind);
    re.lastIndex = 0;
  }
  return [...kinds];
}

export function redactDeep(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}

export function truncate(text, max) {
  if (typeof text !== "string" || text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}
