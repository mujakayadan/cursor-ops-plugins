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
import type { Cli, JsonObject, Provider, ProviderConfig, ShellRule } from "./lib/core/types.ts";

const repo = str("Repository as OWNER/NAME.", { pattern: PATTERNS.githubRepo });
const number = int("Pull request or issue number.", { minimum: 1 });
const limit = (def = 20, max = 100) =>
  int("Maximum results.", { minimum: 1, maximum: max, default: def });
const body = str("Markdown body.", { minLength: 1, maxLength: 20000 });

function checkOwner(owner: string, pcfg: ProviderConfig): string | undefined {
  const owners = pcfg.scope.owners ?? [];
  if (!owners.length) return undefined;
  return owners.map((o) => o.toLowerCase()).includes(owner.toLowerCase())
    ? undefined
    : `owner "${owner}" is not in providers.github.scope.owners`;
}

function ownerScope(args: { repo?: string }, pcfg: ProviderConfig): string | undefined {
  return args.repo ? checkOwner(args.repo.split("/")[0] ?? "", pcfg) : undefined;
}

const SECRET_API_PATHS =
  /\/(actions|dependabot|codespaces)\/secrets\/[^/]+$|\/keys?$|\/installation\/token/i;

const OWNER_PATTERN = "^[A-Za-z0-9-]{1,39}$";
const owner = str("User or organization login.", { pattern: OWNER_PATTERN });
const visibility = oneOf(
  ["public", "private"],
  "Repository visibility. Ask the user; there is no default.",
);

/** Long-lived environment branches; everything else is `<user>/<type>/<name>`. */
export const ENV_BRANCHES = ["main", "dev", "qa", "staging"] as const;
const OPTIONAL_ENVS = ["qa", "staging"] as const;
/** Heads `main` accepts: promotions from env branches and bot PRs (Dependabot, release-please). */
const MAIN_SOURCES = /^(?:dev|qa|staging|dependabot\/.+|release-please--.+)$/;
const isEnvBranch = (b: string): boolean => (ENV_BRANCHES as readonly string[]).includes(b);

export type MergeMethod = "squash" | "merge";

/**
 * GitOps merge rules: features squash into `dev`; promotions and syncs between env branches
 * use merge commits so the branches never diverge; `main` only accepts promotions and bots.
 */
export function mergeMethodFor(
  base: string,
  head: string,
  requested: MergeMethod | "auto",
): MergeMethod {
  if (base === "main" && !MAIN_SOURCES.test(head)) {
    throw new ToolError(
      `main only accepts pull requests from dev, qa, staging, dependabot/* or release-please--*; "${head}" must target dev.`,
    );
  }
  const needsMerge = base === "main" || isEnvBranch(head);
  if (needsMerge && requested === "squash") {
    throw new ToolError(
      `${head} → ${base} must use a merge commit; squashing would make the branches diverge.`,
    );
  }
  if (needsMerge) return "merge";
  return requested === "auto" ? "squash" : requested;
}

interface CheckRun {
  name: string;
  bucket: string;
}

/** Refuses to merge unless every check passed: the free-plan substitute for required checks. */
export function assertChecksGreen(checks: CheckRun[]): void {
  if (!checks.length) {
    throw new ToolError(
      "No CI checks reported on this pull request. The GitOps standard needs pr-policy and CI to pass before merging.",
    );
  }
  const notGreen = checks.filter((c) => c.bucket !== "pass" && c.bucket !== "skipping");
  if (notGreen.length) {
    throw new ToolError(
      `Checks are not green: ${notGreen.map((c) => `${c.name} (${c.bucket})`).join(", ")}.`,
    );
  }
}

export const GITOPS_LABELS: Record<string, [color: string, description: string]> = {
  bug: ["d73a4a", "Something is not working"],
  enhancement: ["a2eeef", "New feature or request"],
  documentation: ["0075ca", "Documentation only"],
  chore: ["cfd3d7", "Maintenance, tooling, CI"],
  dependencies: ["0366d6", "Dependency updates"],
  security: ["b60205", "Security fix or hardening"],
  "breaking-change": ["e11d21", "Requires a major version bump"],
};

/** Branch ruleset: no deletion or force push, PR-only, conversations resolved, checks required. */
export function rulesetFor(branch: string, requiredChecks: string[]): JsonObject {
  return {
    name: `gitops: ${branch}`,
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: true,
          allowed_merge_methods: branch === "dev" ? ["squash", "merge"] : ["merge"],
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: requiredChecks.map((context) => ({ context })),
        },
      },
    ],
  };
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const PLAN_KEY = "^[A-Z]{1,4}-\\d{1,4}$";
const LABEL = "^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,49}$";
const KEY_TOKEN = /\{\{([A-Z]{1,4}-\d{1,4})\}\}/g;

interface PlanImport {
  repo: string;
  issues: { key: string; title: string; body: string; labels?: string[]; milestone?: string }[];
  milestones?: { title: string; dueOn?: string; description?: string }[];
  project?: { owner: string; number: number };
}

interface IssueRef {
  key: string;
  number: number;
  url: string;
}

/** The plan key an issue title starts with (`T-012 Build the order API`). */
export const planKeyOf = (title: string): string | undefined =>
  /^([A-Z]{1,4}-\d{1,4})\s/.exec(title)?.[1];

/** Replace `{{KEY}}` tokens with issue references for the keys that have an issue. */
export function resolveKeys(
  body: string,
  refs: Map<string, IssueRef>,
): { text: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const text = body.replace(KEY_TOKEN, (token, key: string) => {
    const ref = refs.get(key);
    if (ref) return `#${ref.number}`;
    unresolved.push(key);
    return token;
  });
  return { text, unresolved };
}

const lines = (text: string): string[] => text.split(/\r?\n/).filter((l) => l.trim());

/**
 * Every imported issue carries this label, and only labelled issues count as existing plan issues:
 * applying a label needs triage access, so an outsider can't claim a key with an issue title.
 */
const PLAN_LABEL = "plan";

function repoApi(repo: string, cli: Cli) {
  return {
    post: <T>(path: string, payload: JsonObject, method = "POST") =>
      cli<T>(["api", "-X", method, `repos/${repo}/${path}`, "--input", "-"], {
        input: JSON.stringify(payload),
        parse: "json",
      }),
    lines: (path: string, jq: string) =>
      cli(["api", `repos/${repo}/${path}`, "--paginate", "--jq", jq], { parse: "text" }).then(
        lines,
      ),
  };
}
type RepoApi = ReturnType<typeof repoApi>;

async function existingPlanIssues(api: RepoApi): Promise<Map<string, IssueRef>> {
  const refs = new Map<string, IssueRef>();
  const jq = ".[] | select(.pull_request == null) | {number, title, url: .html_url} | @json";
  for (const line of await api.lines(`issues?state=all&labels=${PLAN_LABEL}&per_page=100`, jq)) {
    const issue = JSON.parse(line) as { number: number; title: string; url: string };
    const key = planKeyOf(issue.title);
    if (key && !refs.has(key)) refs.set(key, { key, number: issue.number, url: issue.url });
  }
  return refs;
}

async function ensureLabels(api: RepoApi, wanted: Iterable<string>): Promise<void> {
  const labels = new Set(
    (await api.lines("labels?per_page=100", ".[].name")).map((l) => l.toLowerCase()),
  );
  for (const label of wanted) {
    if (labels.has(label.toLowerCase())) continue;
    await api.post("labels", { name: label });
    labels.add(label.toLowerCase());
  }
}

/** Resolves milestone titles to numbers, creating the missing ones from the declared list. */
async function milestoneResolver(
  api: RepoApi,
  declaredList: NonNullable<PlanImport["milestones"]>,
): Promise<(title: string) => Promise<number>> {
  const milestones = new Map<string, number>();
  for (const line of await api.lines(
    "milestones?state=all&per_page=100",
    ".[] | {number, title} | @json",
  )) {
    const m = JSON.parse(line) as { number: number; title: string };
    milestones.set(m.title, m.number);
  }
  const declared = new Map(declaredList.map((m) => [m.title, m]));
  return async (title) => {
    const known = milestones.get(title);
    if (known) return known;
    const m = declared.get(title);
    const created = await api.post<{ number: number }>("milestones", {
      title,
      ...(m?.description ? { description: m.description } : {}),
      ...(m?.dueOn ? { due_on: `${m.dueOn}T23:59:59Z` } : {}),
    });
    milestones.set(title, created.number);
    return created.number;
  };
}

async function importIssues(a: PlanImport, cli: Cli) {
  const keys = a.issues.map((i) => i.key);
  const duplicate = keys.find((k, i) => keys.indexOf(k) !== i);
  if (duplicate) throw new ToolError(`key ${duplicate} appears twice`);
  const api = repoApi(a.repo, cli);
  const refs = await existingPlanIssues(api);
  await ensureLabels(api, new Set([PLAN_LABEL, ...a.issues.flatMap((i) => i.labels ?? [])]));
  const milestoneNumber = await milestoneResolver(api, a.milestones ?? []);
  for (const m of a.milestones ?? []) await milestoneNumber(m.title);

  const created: IssueRef[] = [];
  const skipped: IssueRef[] = [];
  const pending: { ref: IssueRef; body: string; text: string }[] = [];
  for (const issue of a.issues) {
    const existing = refs.get(issue.key);
    if (existing) {
      skipped.push(existing);
      continue;
    }
    const { text, unresolved } = resolveKeys(issue.body, refs);
    const res = await api.post<{ number: number; html_url: string }>("issues", {
      title: `${issue.key} ${issue.title}`,
      body: text,
      labels: [...new Set([PLAN_LABEL, ...(issue.labels ?? [])])],
      ...(issue.milestone ? { milestone: await milestoneNumber(issue.milestone) } : {}),
    });
    const ref = { key: issue.key, number: res.number, url: res.html_url };
    refs.set(issue.key, ref);
    created.push(ref);
    if (unresolved.length) pending.push({ ref, body: issue.body, text });
    if (a.project) {
      await cli(
        [
          "project",
          "item-add",
          String(a.project.number),
          "--owner",
          a.project.owner,
          "--url",
          ref.url,
        ],
        { parse: "text" },
      );
    }
  }

  const unresolved: string[] = [];
  for (const p of pending) {
    const resolved = resolveKeys(p.body, refs);
    unresolved.push(...resolved.unresolved.map((k) => `${p.ref.key} → ${k}`));
    if (resolved.text !== p.text)
      await api.post(`issues/${p.ref.number}`, { body: resolved.text }, "PATCH");
  }
  return {
    created,
    skipped,
    ...(unresolved.length ? { unresolved } : {}),
    next: "Write each key's issue number into TODO.md (- **Issue:** #n).",
  };
}

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
    name: "github_release_list",
    title: "List releases",
    tier: "read",
    description: "Recent releases with tag, latest/draft/prerelease flags and publish date.",
    input: obj({ repo, limit: limit(10, 100) }, ["repo"]),
    scope: ownerScope,
    run: (a, { cli }) =>
      cli(
        [
          "release",
          "list",
          "-R",
          a.repo,
          "--limit",
          String(a.limit),
          "--json",
          "tagName,name,isLatest,isDraft,isPrerelease,publishedAt",
        ],
        { parse: "json" },
      ),
  }),
  tool({
    name: "github_project_list",
    title: "List projects",
    tier: "read",
    description:
      "GitHub Projects (kanban boards) of a user or organization. Needs the `project` token scope.",
    input: obj({ owner, limit: limit(30, 100) }, ["owner"]),
    run: (a, { cli }) =>
      cli(["project", "list", "--owner", a.owner, "--limit", String(a.limit), "--format", "json"], {
        parse: "json",
      }),
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
    name: "github_issues_import",
    title: "Import plan as issues",
    tier: "write",
    description:
      "Create a plan's epics and tasks as issues in one approved call. Each issue title starts with its key (T-012 Build the order API) and every issue gets the `plan` label; keys that already have a `plan` issue are skipped, so a re-run only creates what is missing and never edits existing issues. Missing labels and milestones are created. `{{KEY}}` in a body becomes that key's issue reference (#45) once it exists, so an epic can list its tasks. Optionally adds each new issue to a Project board (needs the `project` token scope). Up to 50 issues per call; import larger plans epic by epic.",
    input: obj(
      {
        repo,
        issues: list(
          obj(
            {
              key: str("Plan key, such as T-012 or E-03.", { pattern: PLAN_KEY }),
              title: str("Title without the key.", { minLength: 1, maxLength: 200 }),
              body,
              labels: list(str("Label.", { pattern: LABEL }), "Labels.", { maxItems: 10 }),
              milestone: str("Milestone title.", { minLength: 1, maxLength: 100 }),
            },
            ["key", "title", "body"],
          ),
          "Issues in plan order.",
          { minItems: 1, maxItems: 50 },
        ),
        milestones: list(
          obj(
            {
              title: str("Milestone title.", { minLength: 1, maxLength: 100 }),
              dueOn: str("Due date (YYYY-MM-DD).", { pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
              description: str("Milestone description.", { maxLength: 2000 }),
            },
            ["title"],
          ),
          "Milestones to create when missing.",
          { maxItems: 20 },
        ),
        project: obj({ owner, number: int("Project number.", { minimum: 1 }) }, [
          "owner",
          "number",
        ]),
      },
      ["repo", "issues"],
    ),
    scope: (a, pcfg) =>
      ownerScope(a, pcfg) ?? (a.project ? checkOwner(a.project.owner, pcfg) : undefined),
    summarize: (a) =>
      `${a.repo}: create missing issues for ${a.issues.map((i) => i.key).join(", ")}${
        a.project ? ` and add them to project ${a.project.owner}#${a.project.number}` : ""
      }`,
    run: (a, { cli }) => importIssues(a, cli),
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
    name: "github_project_item_add",
    title: "Add to project",
    tier: "write",
    description:
      "Add an issue or pull request (by URL) to a GitHub Project board. Needs the `project` token scope.",
    input: obj(
      {
        owner,
        project: int("Project number.", { minimum: 1 }),
        url: str("Issue or pull request URL.", {
          pattern: "^https://github\\.com/[A-Za-z0-9-]+/[A-Za-z0-9._-]+/(issues|pull)/[0-9]+$",
        }),
      },
      ["owner", "project", "url"],
    ),
    scope: (a, pcfg) =>
      checkOwner(a.owner, pcfg) ?? checkOwner(new URL(a.url).pathname.split("/")[1] ?? "", pcfg),
    summarize: (a) => `${a.url} → project ${a.owner}#${a.project}`,
    run: (a, { cli }) =>
      cli(["project", "item-add", String(a.project), "--owner", a.owner, "--url", a.url], {
        parse: "text",
      }),
  }),
  tool({
    name: "github_pr_merge",
    title: "Merge pull request",
    tier: "write",
    description:
      "Merge a pull request under the GitOps rules: all checks green, features squash into dev, promotions into main (from dev/qa/staging/bots only) use merge commits. Never bypasses protection (no --admin).",
    input: obj(
      {
        repo,
        number,
        method: oneOf(
          ["auto", "squash", "merge"],
          "Merge method; auto picks squash for features and merge for promotions.",
          "auto",
        ),
        deleteBranch: bool("Delete the head branch after merge (never env branches).", true),
      },
      ["repo", "number"],
    ),
    scope: ownerScope,
    summarize: (a) => `${a.repo}#${a.number} via ${a.method}`,
    run: async (a, { cli }) => {
      const n = String(a.number);
      const pr = await cli<{
        baseRefName: string;
        headRefName: string;
        headRefOid: string;
        isDraft: boolean;
        state: string;
        reviewDecision: string;
      }>(
        [
          "pr",
          "view",
          n,
          "-R",
          a.repo,
          "--json",
          "baseRefName,headRefName,headRefOid,isDraft,state,reviewDecision",
        ],
        { parse: "json" },
      );
      if (pr.state !== "OPEN") throw new ToolError(`${a.repo}#${n} is ${pr.state}.`);
      if (pr.isDraft) throw new ToolError(`${a.repo}#${n} is a draft; mark it ready first.`);
      if (pr.reviewDecision === "CHANGES_REQUESTED") {
        throw new ToolError(`${a.repo}#${n} has requested changes.`);
      }
      const method = mergeMethodFor(pr.baseRefName, pr.headRefName, a.method);
      // gh exits 1 when checks fail or none exist, and 8 when pending.
      const raw = await cli(["pr", "checks", n, "-R", a.repo, "--json", "name,bucket"], {
        okCodes: [0, 1, 8],
        parse: "text",
      });
      assertChecksGreen(raw.trim().startsWith("[") ? (JSON.parse(raw) as CheckRun[]) : []);
      const args = ["pr", "merge", n, "-R", a.repo, `--${method}`];
      args.push("--match-head-commit", pr.headRefOid);
      if (a.deleteBranch && !isEnvBranch(pr.headRefName)) args.push("--delete-branch");
      return cli(args, { parse: "text" });
    },
  }),
  tool({
    name: "github_repo_create",
    title: "Create repository",
    tier: "write",
    description:
      "Create a repository. Visibility has no default: ask the user. With `source`, pushes that local repo's main branch; then run github_repo_bootstrap.",
    input: obj(
      {
        name: str("Repository name.", { pattern: "^[A-Za-z0-9._-]{1,100}$" }),
        owner: str("Owner login; defaults to the authenticated user.", {
          pattern: OWNER_PATTERN,
        }),
        visibility,
        description: str("Short description.", { maxLength: 350 }),
        source: str("Absolute path of a local git repository to push as the initial main.", {
          maxLength: 1024,
        }),
      },
      ["name", "visibility"],
    ),
    summarize: (a) =>
      `${a.owner ? `${a.owner}/` : ""}${a.name} (${a.visibility})${a.source ? ` from ${a.source}` : ""}`,
    run: (a, { cli }) => {
      const args = ["repo", "create", a.owner ? `${a.owner}/${a.name}` : a.name];
      args.push(`--${a.visibility}`);
      if (a.description) args.push(`--description=${a.description}`);
      if (a.source) args.push(`--source=${a.source}`, "--remote=origin", "--push");
      return cli(args, { parse: "text" });
    },
  }),
  tool({
    name: "github_repo_bootstrap",
    title: "Bootstrap GitOps repository",
    tier: "write",
    description:
      "Apply the GitOps standard to a repository whose main exists: create dev (and optional qa/staging) from main, set merge settings, labels, branch rulesets where the plan allows, and optionally link a project.",
    input: obj(
      {
        repo,
        environments: list(
          oneOf([...OPTIONAL_ENVS], "Extra environment branch."),
          "Extra environment branches besides main and dev. Only when the user asks.",
          { maxItems: 2 },
        ),
        requiredChecks: list(
          str("Check run name.", { minLength: 1, maxLength: 100 }),
          "Required status checks besides pr-policy (e.g. CI job names).",
          { maxItems: 20 },
        ),
        project: int("Project number to link (owner's project).", { minimum: 1 }),
      },
      ["repo"],
    ),
    scope: ownerScope,
    summarize: (a) =>
      `${a.repo}: branches main, dev${(a.environments ?? []).map((e) => `, ${e}`).join("")}; settings, labels, rulesets${a.project ? `, project ${a.project}` : ""}`,
    run: async (a, { cli }) => {
      const info = await cli<{ default_branch: string; visibility: string }>(
        ["api", `repos/${a.repo}`],
        { parse: "json" },
      );
      if (info.default_branch !== "main") {
        throw new ToolError(
          `The default branch is "${info.default_branch}". Push main and make it the default first.`,
        );
      }
      const main = await cli<{ object: { sha: string } }>(
        ["api", `repos/${a.repo}/git/ref/heads/main`],
        { parse: "json" },
      );
      const existing = new Set(
        (
          await cli(["api", `repos/${a.repo}/branches`, "--paginate", "--jq", ".[].name"], {
            parse: "text",
          })
        )
          .split(/\r?\n/)
          .filter(Boolean),
      );
      const envs = ["main", "dev", ...new Set(a.environments ?? [])];
      const created: string[] = [];
      for (const b of envs) {
        if (existing.has(b)) continue;
        await cli(
          [
            "api",
            "-X",
            "POST",
            `repos/${a.repo}/git/refs`,
            "-f",
            `ref=refs/heads/${b}`,
            "-f",
            `sha=${main.object.sha}`,
          ],
          { parse: "text" },
        );
        created.push(b);
      }

      await cli(
        [
          "api",
          "-X",
          "PATCH",
          `repos/${a.repo}`,
          "-F",
          "allow_merge_commit=true",
          "-F",
          "allow_squash_merge=true",
          "-F",
          "allow_rebase_merge=false",
          "-F",
          "delete_branch_on_merge=true",
          "-F",
          "has_issues=true",
          "-F",
          "has_projects=true",
          "-f",
          "squash_merge_commit_title=PR_TITLE",
          "-f",
          "squash_merge_commit_message=PR_BODY",
          "-f",
          "merge_commit_title=PR_TITLE",
          "-f",
          "merge_commit_message=PR_BODY",
        ],
        { parse: "text" },
      );

      // release-please and the main → dev sync open pull requests with the workflow token.
      await cli(
        [
          "api",
          "-X",
          "PUT",
          `repos/${a.repo}/actions/permissions/workflow`,
          "-f",
          "default_workflow_permissions=read",
          "-F",
          "can_approve_pull_request_reviews=true",
        ],
        { parse: "text" },
      );

      for (const [label, [color, description]] of Object.entries(GITOPS_LABELS)) {
        await cli(
          [
            "label",
            "create",
            label,
            "-R",
            a.repo,
            `--color=${color}`,
            `--description=${description}`,
            "--force",
          ],
          { parse: "text" },
        );
      }

      const checks = ["pr-policy", ...new Set(a.requiredChecks ?? [])];
      let rulesets: string;
      const listed = await cli(["api", `repos/${a.repo}/rulesets`], {
        okCodes: [0, 1],
        parse: "text",
      });
      if (!listed.trim().startsWith("[")) {
        rulesets = `unavailable (${listed.trim().slice(0, 200)}). Rulesets need a public repo or a paid plan; pr-policy, CI and the local hooks still enforce the flow.`;
      } else {
        const ids = new Map(
          (JSON.parse(listed) as { id: number; name: string }[]).map((r) => [r.name, r.id]),
        );
        for (const b of envs) {
          const body = rulesetFor(b, checks);
          const id = ids.get(String(body.name));
          const path = id ? `repos/${a.repo}/rulesets/${id}` : `repos/${a.repo}/rulesets`;
          await cli(["api", "-X", id ? "PUT" : "POST", path, "--input", "-"], {
            input: JSON.stringify(body),
            parse: "text",
          });
        }
        rulesets = `applied to ${envs.join(", ")} (required checks: ${checks.join(", ")})`;
      }

      let project: string | undefined;
      if (a.project) {
        const [repoOwner = "", repoName = ""] = a.repo.split("/");
        project = await cli(
          ["project", "link", String(a.project), "--owner", repoOwner, "--repo", repoName],
          { parse: "text" },
        ).then(
          () => `linked project ${a.project}`,
          (e: unknown) =>
            `not linked: ${errorMessage(e).slice(0, 200)} (needs the \`project\` token scope)`,
        );
      }

      const secrets = await cli<{ name: string }[]>(
        ["secret", "list", "-R", a.repo, "--json", "name"],
        { parse: "json" },
      ).catch(() => undefined);
      const token = secrets?.some((s) => s.name === "GITOPS_TOKEN")
        ? "present"
        : "missing: add a fine-grained token (Contents and Pull requests: read/write on this repo) as the GITOPS_TOKEN Actions secret; until then, CI on release-please and main→dev sync PRs waits for approval in the Actions tab";

      return {
        repo: a.repo,
        visibility: info.visibility,
        branches: { created, existing: envs.filter((b) => !created.includes(b)) },
        settings:
          "merge commits and squash on, rebase off, delete head branches, PR title as commit title",
        labels: Object.keys(GITOPS_LABELS),
        rulesets,
        ...(project ? { project } : {}),
        gitopsToken: token,
      };
    },
  }),

  tool({
    name: "github_repo_set_visibility",
    title: "Change repository visibility",
    tier: "privileged",
    description:
      "Make a repository public or private. Public exposes all history; scan it for secrets first.",
    input: obj({ repo, visibility }, ["repo", "visibility"]),
    confirmHint: '"OWNER/REPO:public" or "OWNER/REPO:private"',
    confirm: (a) => `${a.repo}:${a.visibility}`,
    scope: ownerScope,
    summarize: (a) => `${a.repo} → ${a.visibility}`,
    run: (a, { cli }) =>
      cli(
        [
          "repo",
          "edit",
          a.repo,
          "--visibility",
          a.visibility,
          "--accept-visibility-change-consequences",
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
  setup: [{ bin: "gh", winget: "GitHub.cli", brew: "gh", docs: "https://cli.github.com" }],
  onboarding: {
    whoami: "github_whoami",
    signIn: {
      command: "gh auth login --web --git-protocol https --scopes project",
      note: "opens the browser with a one-time code; `project` is for the project-board tools",
    },
  },
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
