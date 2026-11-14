import { privilegedEnabled } from "./config.mjs";
import { redactDeep, truncate } from "./redact.mjs";

const RANK = { allow: 0, ask: 1, deny: 2 };

export function strictest(...decisions) {
  return decisions.filter(Boolean).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "allow");
}

const PRIVILEGED_VERBS = new Set([
  "delete", "destroy", "remove", "rm", "terminate", "purge", "drop", "revoke", "merge", "transfer",
  "rollback", "promote", "buy", "purchase", "wipe", "truncate", "force", "kill", "reset",
]);
const WRITE_VERBS = new Set([
  "create", "update", "edit", "patch", "put", "post", "set", "add", "write", "upload", "push", "deploy",
  "redeploy", "publish", "release", "rerun", "rerequest", "retry", "cancel", "start", "stop", "restart",
  "pause", "unpause", "resume", "invoke", "run", "execute", "exec", "assign", "approve", "dismiss",
  "reply", "comment", "label", "fork", "enable", "disable", "send", "submit", "sync", "invalidate",
  "restore", "replace", "rename", "move", "copy", "import", "accept", "activate", "complete", "upsert",
  "extend", "stage", "record", "request", "verify", "issue",
]);
const READ_VERBS = new Set([
  "get", "list", "search", "describe", "read", "view", "fetch", "count", "aggregate", "inspect", "query",
  "lookup", "show", "find", "browse", "checks", "status",
]);
// Nouns that collide with verbs in common MCP tool names (e.g. GitHub "issue_read", "pull_request_read").
const NOUN_WHEN_FOLLOWED_BY_READ = new Set(["issue", "request"]);

function tokens(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Heuristic risk tier for a third-party MCP tool name. */
export function classifyToolName(name) {
  const toks = tokens(name ?? "");
  const hasRead = toks.some((t) => READ_VERBS.has(t));
  if (toks.some((t) => PRIVILEGED_VERBS.has(t))) return "privileged";
  const writeHits = toks.filter((t) => WRITE_VERBS.has(t) && !(hasRead && NOUN_WHEN_FOLLOWED_BY_READ.has(t)));
  if (writeHits.length) return "write";
  if (hasRead) return "read";
  return "unknown";
}

/**
 * Match a shell command against rules. A rule may carry `when(payload)` to apply only in
 * some contexts (e.g. inside a uv project); it receives the hook payload.
 */
export function evaluateShell(command, rules, payload = {}) {
  const normalized = (command ?? "").replace(/\s+/g, " ");
  const matches = rules.filter((r) => r.re.test(normalized) && (!r.when || r.when(payload)));
  const permission = strictest(...matches.map((m) => m.decision));
  return { permission, matches };
}

export function shellResponse({ permission, matches }, label) {
  if (permission === "allow") return { permission: "allow" };
  const reasons = matches.filter((m) => m.decision === permission).map((m) => `- ${m.reason} [${m.id}]`).join("\n");
  const verb = permission === "deny" ? "blocked" : "requires approval";
  return {
    permission,
    user_message: `${label} guardrail: this command ${verb}.\n${reasons}`,
    agent_message:
      permission === "deny"
        ? `Blocked by ${label} policy:\n${reasons}\nDo not retry or work around this. Explain the block to the user and propose a safer alternative.`
        : `${label} policy requires explicit user approval:\n${reasons}`,
  };
}

function parseToolInput(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    return JSON.parse(raw ?? "{}");
  } catch {
    return {};
  }
}

function summarizeArgs(tool, args) {
  const { confirm, ...rest } = args;
  const fallback = truncate(JSON.stringify(redactDeep(rest)), 300);
  if (!tool?.summarize) return fallback;
  try {
    return truncate(String(tool.summarize(args)), 500);
  } catch {
    return fallback;
  }
}

export function ownServerPattern(providerId) {
  return new RegExp(`(^|[^a-z0-9])ops-${providerId}-(read|write)$`, "i");
}

/**
 * Decision for calls to this provider's own read/write MCP servers.
 * Returns null when the call targets some other server.
 */
export function decideOwnMcp(provider, payload, cfg) {
  const server = payload.mcp_server_name ?? "";
  const match = server.match(ownServerPattern(provider.id));
  if (!match) return null;
  const serverTier = match[2].toLowerCase();
  const tool = provider.tools.find((t) => t.name === payload.tool_name);
  const label = provider.displayName;

  if (!tool) {
    return { permission: "deny", user_message: `${label}: unknown tool "${payload.tool_name}" on ${server}.`, agent_message: "Unknown tool for this server; blocked by policy." };
  }
  if (serverTier === "read" && tool.tier !== "read") {
    return { permission: "deny", user_message: `${label}: ${tool.name} is not a read tool.`, agent_message: "The read server may only run read tools." };
  }
  const args = parseToolInput(payload.tool_input);
  const summary = summarizeArgs(tool, args);

  switch (tool.tier) {
    case "read":
      return { permission: "allow" };
    case "write":
      return {
        permission: "ask",
        user_message: `${label} WRITE: ${tool.title}\n${summary}`,
        agent_message: `${tool.name} changes ${label} state and needs user approval.`,
      };
    case "privileged":
      if (!privilegedEnabled(provider.id, cfg)) {
        return {
          permission: "deny",
          user_message: `${label}: privileged action ${tool.name} is disabled.`,
          agent_message: `Privileged ${label} actions are disabled. Tell the user to set providers.${provider.id}.allowPrivileged=true in ~/.ops/config.json (or OPS_ALLOW_PRIVILEGED=1) if this is intended.`,
        };
      }
      return {
        permission: "ask",
        user_message: `${label} PRIVILEGED (high impact): ${tool.title}\n${summary}\nConfirm only if you have verified the exact target.`,
        agent_message: `${tool.name} is a high-impact ${label} action and needs explicit user approval.`,
      };
    default: {
      const unreachable = tool.tier;
      throw new Error(`Unhandled tier: ${unreachable}`);
    }
  }
}

const OWN_SERVER_ANY = /(^|[^a-z0-9])ops-[a-z0-9]+-(read|write)$/i;

/** Decision for MCP servers not managed by the ops plugins (official vendor servers, user servers, ...). */
export function decideThirdPartyMcp(payload, cfg) {
  const server = payload.mcp_server_name;
  const policy = cfg.thirdPartyMcp;
  if (server && OWN_SERVER_ANY.test(server)) return { permission: "allow" };
  if (!server) {
    return { permission: "deny", user_message: "MCP call without a server name was blocked.", agent_message: "Unidentified MCP server; blocked by policy." };
  }
  if (policy.trustedServers.some((p) => new RegExp(p, "i").test(server))) return { permission: "allow" };

  let effective = { read: policy.read, write: policy.write, privileged: policy.privileged, unknown: policy.unknown };
  for (const [pattern, override] of Object.entries(policy.serverOverrides ?? {})) {
    if (new RegExp(pattern, "i").test(server)) effective = { ...effective, ...override };
  }
  const tier = classifyToolName(payload.tool_name);
  const permission = effective[tier] ?? "ask";
  if (permission === "allow") return { permission };

  const args = truncate(JSON.stringify(redactDeep(parseToolInput(payload.tool_input))), 300);
  return {
    permission,
    user_message: `${server} › ${payload.tool_name} classified as ${tier.toUpperCase()}.\n${args}`,
    agent_message:
      permission === "deny"
        ? `Third-party MCP policy blocks ${tier} tools on ${server}. Use the ops-* servers or ask the user.`
        : `Third-party MCP ${tier} tool requires user approval.`,
  };
}
