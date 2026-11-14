import {
  bool,
  dict,
  int,
  list,
  obj,
  oneOf,
  PATTERNS,
  pick,
  str,
  ToolError,
  tool,
} from "./lib/core/schema-helpers.ts";
import type { JsonObject, Provider, ProviderConfig, ShellRule } from "./lib/core/types.ts";

const repo = str("Repository as OWNER/NAME.", { pattern: PATTERNS.githubRepo });
const number = int("Pull request or issue number.", { minimum: 1 });
const limit = (def = 20, max = 100) =>
  int("Maximum results.", { minimum: 1, maximum: max, default: def });
const body = str("Markdown body.", { minLength: 1, maxLength: 20000 });

function ownerScope(args: { repo?: string }, pcfg: ProviderConfig): string | undefined {
  const owners = pcfg.scope.owners ?? [];
  if (!owners.length || !args.repo) return undefined;
  const owner = (args.repo.split("/")[0] ?? "").toLowerCase();
  return owners.map((o) => o.toLowerCase()).includes(owner)
    ? undefined
    : `owner "${owner}" is not in providers.github.scope.owners`;
}

const SECRET_API_PATHS =
  /\/(actions|dependabot|codespaces)\/secrets\/[^/]+$|\/keys?$|\/installation\/token/i;

const PR_FIELDS =
  "number,title,author,state,isDraft,headRefName,baseRefName,reviewDecision,updatedAt,url";
const RUN_FIELDS =
  "databaseId,displayTitle,workflowName,status,conclusion,headBranch,event,createdAt,url";

const tools = [
  tool({
    name: "github_whoami",
    title: "Current GitHub identity",
    tier: "read",
    description: "Return the authenticated GitHub login for this tier's credentials.",
    run: async (_a, { cli }) =>
      pick(await cli<JsonObject>(["api", "user"], { parse: "json" }), [
        "login",
        "name",
        "type",
        "html_url",
      ]),
  }),
  tool({
    name: "github_repo_view",
    title: "View repository",
    tier: "read",
    description: "Repository metadata: default branch, visibility, description, archive state.",
    input: obj({ repo }, ["repo"]),
    scope: ownerScope,
    run: (a, { cli }) =>
      cli(
        [
          "repo",
          "view",
          a.repo,
          "--json",
          "name,owner,description,defaultBranchRef,visibility,isArchived,pushedAt,url",
        ],
        { parse: "json" },
      ),
  }),
  tool({
    name: "github_pr_list",
    title: "List pull requests",
    tier: "read",
    description:
      "List pull requests with review state. Supports GitHub search syntax via `search`.",
    input: obj(
      {
        repo,
        state: oneOf(["open", "closed", "merged", "all"], "PR state.", "open"),
        search: str("GitHub search query, e.g. 'author:@me review:required'.", { maxLength: 256 }),
        limit: limit(),
      },
      ["repo"],
    ),
    scope: ownerScope,
    run: (a, { cli }) => {
      const args = ["pr", "list", "-R", a.repo, "--state", a.state];
      args.push("--limit", String(a.limit), "--json", PR_FIELDS);
      if (a.search) args.push(`--search=${a.search}`);
      return cli(args, { parse: "json" });
    },
  }),
  tool({
    name: "github_pr_view",
    title: "View pull request",
    tier: "read",
    description:
      "Pull request details incl. checks rollup and changed files; optionally the unified diff.",
    input: obj(
      { repo, number, includeDiff: bool("Include the unified diff (truncated).", false) },
      ["repo", "number"],
    ),
    scope: ownerScope,
    run: async (a, { cli }) => {
      const fields = `${PR_FIELDS},body,mergeable,statusCheckRollup,files,additions,deletions`;
      const pr = await cli<JsonObject>(
        ["pr", "view", String(a.number), "-R", a.repo, "--json", fields],
        { parse: "json" },
      );
      if (a.includeDiff) {
        pr.diff = await cli(["pr", "diff", String(a.number), "-R", a.repo], { parse: "text" });
      }
      return pr;
    },
  }),
  tool({
    name: "github_pr_checks",
    title: "Pull request checks",
    tier: "read",
    description: "CI checks attached to a pull request with pass/fail/pending buckets and links.",
    input: obj({ repo, number }, ["repo", "number"]),
    scope: ownerScope,
    // gh exits 1 when checks fail and 8 when pending; the JSON is still valid.
    run: (a, { cli }) =>
      cli(
        [
          "pr",
          "checks",
          String(a.number),
          "-R",
          a.repo,
          "--json",
          "name,state,bucket,workflow,link",
        ],
        { okCodes: [0, 1, 8], parse: "json" },
      ),
  }),
  tool({
    name: "github_issue_list",
    title: "List issues",
    tier: "read",
    description: "List issues, optionally filtered by GitHub search syntax.",
    input: obj(
      {
        repo,
        state: oneOf(["open", "closed", "all"], "Issue state.", "open"),
        search: str("GitHub search query.", { maxLength: 256 }),
        limit: limit(),
      },
      ["repo"],
    ),
    scope: ownerScope,
    run: (a, { cli }) => {
      const args = ["issue", "list", "-R", a.repo, "--state", a.state, "--limit", String(a.limit)];
      args.push("--json", "number,title,author,labels,state,updatedAt,url");
      if (a.search) args.push(`--search=${a.search}`);
      return cli(args, { parse: "json" });
    },
  }),
  tool({
    name: "github_issue_view",
    title: "View issue",
    tier: "read",
    description: "Issue body, labels, assignees and comments.",
    input: obj({ repo, number }, ["repo", "number"]),
    scope: ownerScope,
    run: (a, { cli }) =>
      cli(
        [
          "issue",
          "view",
          String(a.number),
          "-R",
          a.repo,
          "--json",
          "number,title,body,author,labels,assignees,state,comments,url",
        ],
        { parse: "json" },
      ),
  }),
  tool({
    name: "github_run_list",
    title: "List workflow runs",
    tier: "read",
    description: "Recent GitHub Actions runs, filterable by branch and status.",
    input: obj(
      {
        repo,
        branch: str("Branch name.", { maxLength: 255 }),
        status: oneOf(
          ["queued", "in_progress", "completed", "failure", "success", "cancelled"],
          "Run status filter.",
        ),
        limit: limit(10, 50),
      },
      ["repo"],
    ),
    scope: ownerScope,
    run: (a, { cli }) => {
      const args = ["run", "list", "-R", a.repo, "--limit", String(a.limit), "--json", RUN_FIELDS];
      if (a.branch) args.push(`--branch=${a.branch}`);
      if (a.status) args.push("--status", a.status);
      return cli(args, { parse: "json" });
    },
  }),
  tool({
    name: "github_run_failed_logs",
    title: "Failed job logs",
    tier: "read",
    description: "Logs of the failed steps of a workflow run (truncated). Use for CI triage.",
    input: obj({ repo, runId: str("Workflow run id.", { pattern: PATTERNS.numericId }) }, [
      "repo",
      "runId",
    ]),
    scope: ownerScope,
    run: (a, { cli }) =>
      cli(["run", "view", a.runId, "-R", a.repo, "--log-failed"], { parse: "text" }),
  }),
  tool({
    name: "github_search_code",
    title: "Search code",
    tier: "read",
    description: "Search code across GitHub with optional owner/repo restriction.",
    input: obj(
      {
        query: str("Code search terms.", { minLength: 1, maxLength: 256 }),
        owner: str("Restrict to an owner.", { pattern: "^[A-Za-z0-9-]{1,39}$" }),
        repo,
        limit: limit(20, 100),
      },
      ["query"],
    ),
    scope: ownerScope,
    run: (a, { cli }) => {
      const args = ["search", "code", "--limit", String(a.limit), "--json", "path,repository,url"];
      if (a.owner) args.push("--owner", a.owner);
      if (a.repo) args.push("--repo", a.repo);
      args.push("--", a.query);
      return cli(args, { parse: "json" });
    },
  }),
  tool({
    name: "github_api_get",
    title: "GitHub REST GET",
    tier: "read",
    description:
      "Read-only GitHub REST call (GET only) for endpoints without a dedicated tool, e.g. 'repos/OWNER/REPO/branches/main/protection'.",
    input: obj(
      {
        path: str("REST path without host, e.g. repos/OWNER/REPO/pulls/1/reviews.", {
          pattern: "^/?[A-Za-z0-9_.\\-/]{1,300}$",
        }),
        query: dict("Query parameters."),
        paginate: bool("Fetch all pages.", false),
      },
      ["path"],
    ),
    run: (a, { cli }) => {
      if (a.path.includes("..")) throw new ToolError("path must not contain '..'");
      if (SECRET_API_PATHS.test(a.path)) {
        throw new ToolError(
          "This endpoint can expose credential material and is blocked by policy.",
        );
      }
      const args = ["api", "-X", "GET", a.path.replace(/^\//, "")];
      for (const [k, v] of Object.entries(a.query ?? {})) args.push("-f", `${k}=${v}`);
      if (a.paginate) args.push("--paginate");
      return cli(args);
    },
  }),

  tool({
    name: "github_pr_create",
    title: "Create pull request",
    tier: "write",
    description: "Open a pull request. Defaults to draft so humans promote it to ready.",
    input: obj(
      {
        repo,
        title: str("PR title.", { minLength: 1, maxLength: 256 }),
        body,
        base: str("Base branch.", { maxLength: 255 }),
        head: str("Head branch.", { minLength: 1, maxLength: 255 }),
        draft: bool("Open as draft.", true),
      },
      ["repo", "title", "body", "head"],
    ),
    scope: ownerScope,
    summarize: (a) =>
      `${a.repo}: ${a.head} → ${a.base ?? "(default)"} "${a.title}"${a.draft ? " [draft]" : ""}`,
    run: (a, { cli }) => {
      const args = ["pr", "create", "-R", a.repo, `--title=${a.title}`, `--body=${a.body}`];
      args.push(`--head=${a.head}`);
      if (a.base) args.push(`--base=${a.base}`);
      if (a.draft) args.push("--draft");
      return cli(args, { parse: "text" });
    },
  }),
  tool({
    name: "github_pr_comment",
    title: "Comment on pull request",
    tier: "write",
    description: "Add a comment to a pull request.",
    input: obj({ repo, number, body }, ["repo", "number", "body"]),
    scope: ownerScope,
    summarize: (a) => `${a.repo}#${a.number}: ${a.body.slice(0, 200)}`,
    run: (a, { cli }) =>
      cli(["pr", "comment", String(a.number), "-R", a.repo, `--body=${a.body}`], {
        parse: "text",
      }),
  }),
  tool({
    name: "github_issue_create",
    title: "Create issue",
    tier: "write",
    description: "Open an issue with optional labels.",
    input: obj(
      {
        repo,
        title: str("Issue title.", { minLength: 1, maxLength: 256 }),
        body,
        labels: list(str("Label.", { maxLength: 50 }), "Labels.", { maxItems: 10 }),
      },
      ["repo", "title", "body"],
    ),
    scope: ownerScope,
    summarize: (a) => `${a.repo}: "${a.title}"`,
    run: (a, { cli }) => {
      const args = ["issue", "create", "-R", a.repo, `--title=${a.title}`, `--body=${a.body}`];
      for (const l of a.labels ?? []) args.push(`--label=${l}`);
      return cli(args, { parse: "text" });
    },
  }),
  tool({
    name: "github_issue_comment",
    title: "Comment on issue",
    tier: "write",
    description: "Add a comment to an issue.",
    input: obj({ repo, number, body }, ["repo", "number", "body"]),
    scope: ownerScope,
    summarize: (a) => `${a.repo}#${a.number}: ${a.body.slice(0, 200)}`,
    run: (a, { cli }) =>
      cli(["issue", "comment", String(a.number), "-R", a.repo, `--body=${a.body}`], {
        parse: "text",
      }),
  }),
  tool({
    name: "github_run_rerun",
    title: "Re-run workflow",
    tier: "write",
    description: "Re-run a workflow run (failed jobs only by default).",
    input: obj(
      {
        repo,
        runId: str("Workflow run id.", { pattern: PATTERNS.numericId }),
        failedOnly: bool("Only re-run failed jobs.", true),
      },
      ["repo", "runId"],
    ),
    scope: ownerScope,
    summarize: (a) => `${a.repo} run ${a.runId}${a.failedOnly ? " (failed jobs)" : " (all jobs)"}`,
    run: (a, { cli }) =>
      cli(["run", "rerun", a.runId, "-R", a.repo, ...(a.failedOnly ? ["--failed"] : [])], {
        parse: "text",
      }),
  }),

  tool({
    name: "github_pr_merge",
    title: "Merge pull request",
    tier: "privileged",
    description: "Merge a pull request. Never bypasses branch protection (no --admin).",
    input: obj(
      {
        repo,
        number,
        method: oneOf(["squash", "merge", "rebase"], "Merge method.", "squash"),
        deleteBranch: bool("Delete the head branch after merge.", false),
      },
      ["repo", "number"],
    ),
    confirmHint: '"OWNER/REPO#NUMBER"',
    confirm: (a) => `${a.repo}#${a.number}`,
    scope: ownerScope,
    summarize: (a) =>
      `${a.repo}#${a.number} via ${a.method}${a.deleteBranch ? ", delete branch" : ""}`,
    run: (a, { cli }) =>
      cli(
        [
          "pr",
          "merge",
          String(a.number),
          "-R",
          a.repo,
          `--${a.method}`,
          ...(a.deleteBranch ? ["--delete-branch"] : []),
        ],
        { parse: "text" },
      ),
  }),
];

const gh = String.raw`\bgh(\.exe)?\s+`;
const shellRules: ShellRule[] = [
  {
    id: "gh-repo-delete",
    decision: "deny",
    re: new RegExp(`${gh}repo\\s+delete\\b`, "i"),
    reason: "Deleting repositories is not allowed from the agent.",
  },
  {
    id: "gh-merge-admin",
    decision: "deny",
    re: new RegExp(`${gh}pr\\s+merge\\b.*--admin\\b`, "i"),
    reason: "Bypassing branch protection (--admin) is not allowed.",
  },
  {
    id: "gh-pr-merge",
    decision: "ask",
    re: new RegExp(`${gh}pr\\s+merge\\b`, "i"),
    reason: "Merging a pull request.",
  },
  {
    id: "gh-api-mutation",
    decision: "ask",
    re: new RegExp(`${gh}api\\b.*(-X|--method)\\s*(POST|PUT|PATCH|DELETE)\\b`, "i"),
    reason: "Mutating GitHub API call.",
  },
  {
    id: "gh-secret",
    decision: "ask",
    re: new RegExp(`${gh}(secret|variable)\\s+(set|delete|remove)\\b`, "i"),
    reason: "Changing Actions secrets or variables.",
  },
  {
    id: "gh-release-delete",
    decision: "ask",
    re: new RegExp(`${gh}release\\s+delete\\b`, "i"),
    reason: "Deleting a release.",
  },
  {
    id: "gh-repo-visibility",
    decision: "ask",
    re: new RegExp(`${gh}repo\\s+(edit\\b.*--visibility|archive|rename)\\b`, "i"),
    reason: "Changing repository visibility/state.",
  },
  {
    id: "gh-workflow-run",
    decision: "ask",
    re: new RegExp(`${gh}workflow\\s+(run|disable)\\b`, "i"),
    reason: "Triggering or disabling a workflow.",
  },
];

const provider: Provider = {
  id: "github",
  displayName: "GitHub",
  version: "1.0.0",
  bin: "gh",
  baseEnv: { GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" },
  instructions: {
    read: "Read-only GitHub access (repos, PRs, issues, Actions). Prefer these tools for investigation.",
    write:
      "GitHub write access. Every call requires user approval; privileged tools require typed confirmation.",
  },
  tools,
  shellRules,
};

export default provider;
