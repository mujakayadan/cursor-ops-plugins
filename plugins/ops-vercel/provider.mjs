import { ToolError, bool, int, obj, oneOf, pick, str } from "./lib/core/schema-helpers.mjs";

const project = str("Project id or name.", { pattern: "^[A-Za-z0-9_.-]{1,100}$" });
const deployment = str("Deployment id (dpl_…) or deployment hostname.", { pattern: "^(dpl_[A-Za-z0-9]{6,64}|[A-Za-z0-9][A-Za-z0-9.-]{0,252})$" });
const limit = (def = 20) => int("Maximum results.", { minimum: 1, maximum: 100, default: def });

// Endpoints that return decrypted secret values or credential material.
const SECRET_PATHS = /\/env\/[^/]+$|decrypt|\/secrets?\b|\/tokens?\/[^/]+$|\/integrations\/.*\/token/i;

function withTeam(query, pcfg) {
  const q = { ...query };
  if (pcfg.scope?.teamId) q.teamId = pcfg.scope.teamId;
  return q;
}

async function apiGet(ctx, path, query = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(withTeam(query, ctx.provider))) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return ctx.cli(["api", qs ? `${path}?${qs}` : path, "--raw"], { parse: "json" });
}

function teamScope(_args, pcfg) {
  const allowed = pcfg.scope?.allowedTeams ?? [];
  if (allowed.length && !pcfg.scope?.teamId) return "providers.vercel.scope.teamId must be set when allowedTeams is configured";
  if (allowed.length && !allowed.includes(pcfg.scope.teamId)) return `team "${pcfg.scope.teamId}" is not in providers.vercel.scope.allowedTeams`;
  return undefined;
}

const compactDeployment = (d) => ({
  id: d.uid ?? d.id,
  url: d.url,
  name: d.name,
  state: d.state ?? d.readyState,
  target: d.target ?? "preview",
  created: d.created ?? d.createdAt,
  creator: d.creator?.username,
  branch: d.meta?.githubCommitRef,
  commit: d.meta?.githubCommitSha?.slice(0, 12),
  commitMessage: d.meta?.githubCommitMessage?.split("\n")[0],
  inspectorUrl: d.inspectorUrl,
});

const tools = [
  {
    name: "vercel_whoami",
    title: "Current Vercel identity",
    tier: "read",
    description: "Username for this tier's Vercel CLI credentials.",
    run: async (_a, { cli }) => (await cli(["whoami"], { parse: "text" })).trim(),
  },
  {
    name: "vercel_project_list",
    title: "List projects",
    tier: "read",
    description: "Projects in the configured scope with framework and last update.",
    input: obj({ search: str("Filter by name.", { maxLength: 100 }), limit: limit(50) }),
    scope: teamScope,
    run: async (a, ctx) => {
      const res = await apiGet(ctx, "/v10/projects", { search: a.search, limit: a.limit });
      return (res.projects ?? []).map((p) => ({ ...pick(p, ["id", "name", "framework", "nodeVersion", "updatedAt"]), productionUrl: p.targets?.production?.url }));
    },
  },
  {
    name: "vercel_project_get",
    title: "Get project",
    tier: "read",
    description: "Project settings: framework, build/output commands, git link, production target.",
    input: obj({ project }, ["project"]),
    scope: teamScope,
    run: async (a, ctx) => {
      const p = await apiGet(ctx, `/v9/projects/${encodeURIComponent(a.project)}`);
      return {
        ...pick(p, ["id", "name", "framework", "buildCommand", "installCommand", "outputDirectory", "rootDirectory", "nodeVersion", "updatedAt"]),
        link: p.link && pick(p.link, ["type", "org", "repo", "productionBranch"]),
        production: p.targets?.production && compactDeployment(p.targets.production),
      };
    },
  },
  {
    name: "vercel_deployment_list",
    title: "List deployments",
    tier: "read",
    description: "Recent deployments, filterable by project, target and state.",
    input: obj({ project, target: oneOf(["production", "preview"], "Deployment target."), state: oneOf(["BUILDING", "ERROR", "INITIALIZING", "QUEUED", "READY", "CANCELED"], "Deployment state."), limit: limit() }),
    scope: teamScope,
    run: async (a, ctx) => {
      const res = await apiGet(ctx, "/v6/deployments", { projectId: a.project, target: a.target, state: a.state, limit: a.limit });
      return (res.deployments ?? []).map(compactDeployment);
    },
  },
  {
    name: "vercel_deployment_get",
    title: "Get deployment",
    tier: "read",
    description: "Deployment status, target, git metadata, aliases and error details.",
    input: obj({ deployment }, ["deployment"]),
    scope: teamScope,
    run: async (a, ctx) => {
      const d = await apiGet(ctx, `/v13/deployments/${encodeURIComponent(a.deployment)}`);
      return { ...compactDeployment(d), alias: d.alias, errorCode: d.errorCode, errorMessage: d.errorMessage, regions: d.regions };
    },
  },
  {
    name: "vercel_deployment_build_logs",
    title: "Deployment build logs",
    tier: "read",
    description: "Most recent build log lines for a deployment (newest last). Use to triage failed builds.",
    input: obj({ deployment, limit: int("Number of log events.", { minimum: 10, maximum: 2000, default: 300 }), errorsOnly: bool("Only stderr/error events.", false) }, ["deployment"]),
    scope: teamScope,
    run: async (a, ctx) => {
      const events = await apiGet(ctx, `/v3/deployments/${encodeURIComponent(a.deployment)}/events`, { limit: a.limit, direction: "backward", builds: 1 });
      return (Array.isArray(events) ? events : [])
        .filter((e) => !a.errorsOnly || e.type === "stderr" || e.level === "error")
        .reverse()
        .map((e) => `${e.type ?? ""} ${e.payload?.text ?? e.text ?? ""}`.trim())
        .join("\n");
    },
  },
  {
    name: "vercel_env_list",
    title: "List environment variable names",
    tier: "read",
    description: "Environment variable NAMES and targets for a project. Values are never returned.",
    input: obj({ project }, ["project"]),
    scope: teamScope,
    run: async (a, ctx) => {
      const res = await apiGet(ctx, `/v10/projects/${encodeURIComponent(a.project)}/env`);
      return (res.envs ?? []).map((e) => pick(e, ["key", "type", "target", "gitBranch", "updatedAt"]));
    },
  },
  {
    name: "vercel_domain_list",
    title: "List domains",
    tier: "read",
    description: "Domains in the configured scope with verification and renewal state.",
    input: obj({ limit: limit(50) }),
    scope: teamScope,
    run: async (a, ctx) => ((await apiGet(ctx, "/v5/domains", { limit: a.limit })).domains ?? []).map((d) => pick(d, ["name", "verified", "serviceType", "expiresAt", "renew", "createdAt"])),
  },
  {
    name: "vercel_api_get",
    title: "Vercel REST GET",
    tier: "read",
    description: "Read-only Vercel REST call (GET only) for endpoints without a dedicated tool, e.g. '/v1/projects/{id}/crons'.",
    input: obj(
      {
        path: str("REST path starting with /vN/.", { pattern: "^/v[0-9]+/[A-Za-z0-9_.\\-/]{1,300}$" }),
        query: { type: "object", description: "Query parameters.", additionalProperties: { type: "string" } },
      },
      ["path"],
    ),
    scope: teamScope,
    run: (a, ctx) => {
      if (a.path.includes("..")) throw new ToolError("path must not contain '..'");
      const query = a.query ?? {};
      if (SECRET_PATHS.test(a.path) || Object.keys(query).some((k) => /decrypt/i.test(k))) {
        throw new ToolError("This endpoint can expose secret values and is blocked by policy. Use vercel_env_list for names only.");
      }
      return apiGet(ctx, a.path, query);
    },
  },

  {
    name: "vercel_redeploy_preview",
    title: "Redeploy to preview",
    tier: "write",
    description: "Rebuild an existing deployment into the PREVIEW target. Does not wait for completion.",
    input: obj({ deployment }, ["deployment"]),
    scope: teamScope,
    summarize: (a) => `redeploy ${a.deployment} → preview`,
    run: (a, { cli }) => cli(["redeploy", a.deployment, "--target", "preview", "--no-wait"], { parse: "text" }),
  },

  {
    name: "vercel_promote",
    title: "Promote to production",
    tier: "privileged",
    description: "Point production domains at an existing READY deployment.",
    input: obj({ deployment }, ["deployment"]),
    confirmHint: '"promote:<deployment>"',
    confirm: (a) => `promote:${a.deployment}`,
    scope: teamScope,
    summarize: (a) => `PRODUCTION ← ${a.deployment}`,
    run: (a, { cli }) => cli(["promote", a.deployment, "--yes"], { parse: "text", timeoutMs: 240000 }),
  },
  {
    name: "vercel_rollback",
    title: "Roll back production",
    tier: "privileged",
    description: "Instantly roll production back to a previous deployment.",
    input: obj({ deployment }, ["deployment"]),
    confirmHint: '"rollback:<deployment>"',
    confirm: (a) => `rollback:${a.deployment}`,
    scope: teamScope,
    summarize: (a) => `PRODUCTION rollback → ${a.deployment}`,
    run: (a, { cli }) => cli(["rollback", a.deployment, "--yes"], { parse: "text", timeoutMs: 240000 }),
  },
];

const vc = String.raw`\b(vercel|vc)(\.cmd|\.ps1)?\s+`;
const shellRules = [
  { id: "vercel-skip-permissions", decision: "deny", re: /--dangerously-skip-permissions\b/i, reason: "Skipping Vercel CLI confirmations is not allowed." },
  { id: "vercel-project-rm", decision: "deny", re: new RegExp(`${vc}(project|projects)\\s+(rm|remove)\\b`, "i"), reason: "Deleting Vercel projects is not allowed from the agent." },
  { id: "vercel-rm", decision: "ask", re: new RegExp(`${vc}(rm|remove)\\b`, "i"), reason: "Removing deployments." },
  { id: "vercel-prod", decision: "ask", re: new RegExp(`${vc}(.*\\s)?(--prod\\b|--target[ =]production\\b|promote\\b|rollback\\b)`, "i"), reason: "Changing PRODUCTION." },
  { id: "vercel-env-write", decision: "ask", re: new RegExp(`${vc}env\\s+(add|rm|remove|update)\\b`, "i"), reason: "Changing environment variables." },
  { id: "vercel-env-pull", decision: "ask", re: new RegExp(`${vc}env\\s+pull\\b`, "i"), reason: "Writes decrypted secrets to a local file." },
  { id: "vercel-domains", decision: "ask", re: new RegExp(`${vc}(domains|dns|certs|alias)\\s+(add|rm|remove|set|move|transfer-in|buy)\\b`, "i"), reason: "Changing domains, DNS, certificates or aliases." },
  { id: "vercel-api-mutation", decision: "ask", re: new RegExp(`${vc}api\\b.*(-X|--method)\\s*(POST|PUT|PATCH|DELETE)\\b`, "i"), reason: "Mutating Vercel API call." },
];

export default {
  id: "vercel",
  displayName: "Vercel",
  version: "1.0.0",
  bin: "vercel",
  baseArgs: ["--non-interactive"],
  baseEnv: { NO_COLOR: "1", FORCE_COLOR: "0" },
  instructions: {
    read: "Read-only Vercel access (projects, deployments, build logs, env var names, domains).",
    write: "Vercel write access. Preview redeploys need approval; production changes are privileged and need typed confirmation.",
  },
  tools,
  shellRules,
};
