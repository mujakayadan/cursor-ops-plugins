import { resolveBinary, runCommand } from "./lib/core/cli.ts";
import { type AccountView, PLANS, type Plan } from "./route.ts";

const SECRET_KEY = /token|secret|password|cookie|email|authorization|api.?key/i;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:+-]{1,80}$/;
const SKIP_LINE = /^(usage|model|models|available|default|id|name)$/i;

export function parsePlan(value: string | undefined): Plan {
  const text = (value ?? "").toLowerCase();
  if (!text.trim()) return "unknown";
  if (/\bultra\b/.test(text)) return "ultra";
  if (/\bsuper\b/.test(text)) return "super";
  if (/\bpremium\b/.test(text)) return "premium";
  if (/\bplus\b/.test(text)) return "plus";
  if (/\bfree\b|\bhobby\b/.test(text)) return "free";
  if (/\benterprise\b/.test(text)) return "enterprise";
  if (/\bteams?\b/.test(text)) return "teams";
  if (/\bpro\b|\blegacy\b|\bstart\b/.test(text)) return "legacy";
  return "unknown";
}

export function parseModelList(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const token = line.replace(/^[\s*+-]+/, "").split(/\s+/)[0] ?? "";
    if (MODEL_ID.test(token) && !SKIP_LINE.test(token)) ids.push(token);
  }
  return [...new Set(ids)];
}

function percent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return Math.round(value);
}

function readAbout(value: unknown): { plan: Plan; includedRemaining: number | null } {
  let plan: Plan = "unknown";
  let used: number | null = null;
  let remaining: number | null = null;
  const walk = (node: unknown, key: string) => {
    if (SECRET_KEY.test(key)) return;
    if (node !== null && typeof node === "object") {
      for (const [child, next] of Object.entries(node)) walk(next, child);
      return;
    }
    if (
      typeof node === "string" &&
      /membership|plan|subscription/i.test(key) &&
      plan === "unknown"
    ) {
      plan = parsePlan(node);
    }
    if (typeof node === "number" && /totalPercentUsed|percentUsed/i.test(key)) used = percent(node);
    if (typeof node === "number" && /includedRemaining|remainingPercent/i.test(key)) {
      remaining = percent(node);
    }
  };
  walk(value, "");
  const includedRemaining = remaining ?? (used === null ? null : 100 - used);
  return { plan, includedRemaining };
}

/** Account facts from CLI text. Raw output is never returned. */
export function parseAccount(about: string, modelsText: string, cli: boolean): AccountView {
  const models = parseModelList(modelsText);
  let plan: Plan = "unknown";
  let includedRemaining: number | null = null;
  const trimmed = about.trim();
  if (trimmed.startsWith("{")) {
    try {
      const read = readAbout(JSON.parse(trimmed) as unknown);
      plan = read.plan;
      includedRemaining = read.includedRemaining;
    } catch {
      plan = "unknown";
    }
  }
  if (plan === "unknown") plan = parsePlan(about);
  if (!PLANS.includes(plan)) plan = "unknown";
  const thirdParty = models.length
    ? models.some((id) => !/grok|composer|^auto$|^cursor/i.test(id))
    : null;
  return { plan, includedRemaining, thirdParty, models, cli: cli ? "agent" : null };
}

const empty = (): AccountView => ({
  plan: "unknown",
  includedRemaining: null,
  thirdParty: null,
  models: [],
  cli: null,
});

/** Read plan and models from the Cursor CLI. Missing CLI yields an unknown account, not an error. */
export async function loadAccount(): Promise<AccountView> {
  try {
    resolveBinary("agent");
  } catch {
    return empty();
  }
  const [about, models] = await Promise.all([
    runCommand("agent", ["about", "--format", "json"], { timeoutMs: 20000 }),
    runCommand("agent", ["models"], { timeoutMs: 20000 }),
  ]);
  return parseAccount(
    about.code === 0 ? about.stdout : "",
    models.code === 0 ? models.stdout : "",
    true,
  );
}
