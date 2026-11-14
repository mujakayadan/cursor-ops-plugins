import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { resolveBinary, runCommand } from "./lib/core/cli.ts";
import {
  bool,
  type Infer,
  list,
  obj,
  oneOf,
  str,
  ToolError,
  tool,
} from "./lib/core/schema-helpers.ts";
import type { HookPayload, Provider, ProviderConfig, ShellRule } from "./lib/core/types.ts";

const COPIER_VERSION = "9.19.1";
const DEFAULT_SOURCE = "https://github.com/mujakayadan/cursor-ops-plugins.git";
const INSTALL_TIMEOUT_MS = 900000;

const LANGUAGES = ["python", "typescript", "java"] as const;
const LICENSES = ["MIT", "Apache-2.0", "none"] as const;
export type Language = (typeof LANGUAGES)[number];

export interface LanguageSpec {
  profiles: Record<string, string>;
  toolchain: string;
  requires: string[];
  runtime: Record<string, string>;
}

/** Mirrors copier.yml at the repository root; test/scaffold.test.ts keeps them in sync. */
export const CATALOG: Record<Language, LanguageSpec> = {
  python: {
    profiles: {
      simple: "CLI application with an argparse entry point",
      backend: "FastAPI backend with typed settings, SQLModel and Alembic",
      library: "Typed, publishable library (py.typed, uv build)",
    },
    toolchain: "uv, Ruff, ty, pytest, prek",
    requires: ["uv"],
    runtime: { python_version: "3.13" },
  },
  typescript: {
    profiles: { next: "Next.js 16 App Router app (React 19, Turbopack)" },
    toolchain: "pnpm, Biome, TypeScript 7, Vitest, prek",
    requires: ["node", "pnpm"],
    runtime: { node_version: "24" },
  },
  java: {
    profiles: {
      simple: "Plain Java application with a main class",
      backend: "Spring Boot 4 backend (Web MVC, Actuator, JDBC, Flyway, Postgres, Testcontainers)",
      library: "Java library with sources and javadoc jars",
    },
    toolchain:
      "Gradle 9 wrapper (Kotlin DSL, version catalog), Spotless/palantir-java-format, Error Prone + NullAway, JUnit 6",
    requires: ["java", "uv"],
    runtime: { java_version: "25" },
  },
};

const ALL_PROFILES = [...new Set(LANGUAGES.flatMap((l) => Object.keys(CATALOG[l].profiles)))];

const NEXT_STEPS: Record<Language, string[]> = {
  python: ["uv run pytest", "uv run prek run --all-files"],
  typescript: ["pnpm dev", "pnpm run check"],
  java: ["./gradlew build   (Windows: gradlew.bat build)"],
};

const absPath = (description: string) =>
  str(description, { pattern: '^([A-Za-z]:[\\\\/]|/)[^\\u0000<>|"?*]{0,400}$' });
const ref = str("Template git tag or commit (default: latest tag, else HEAD).", {
  pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$",
});

type AnswerValue = string | boolean | string[];
type Answers = Record<string, AnswerValue>;

function templateSource(pcfg: ProviderConfig): string {
  return pcfg.source || DEFAULT_SOURCE;
}

function checkPath(raw: string, pcfg: ProviderConfig): string {
  const path = normalize(raw);
  if (!isAbsolute(path) || raw.split(/[\\/]/).includes("..")) {
    throw new ToolError("path must be absolute and must not contain '..'");
  }
  const roots = pcfg.scope.allowedRoots ?? [];
  const within = (root: string) => {
    const rel = relative(resolve(root), path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  if (roots.length && !roots.some(within)) {
    throw new ToolError(
      `${path} is outside providers.scaffold.scope.allowedRoots (${roots.join(", ")})`,
    );
  }
  return path;
}

function available(name: string): boolean {
  try {
    resolveBinary(name);
    return true;
  } catch {
    return false;
  }
}

function requireBinaries(names: string[]): void {
  const missing = names.filter((n) => !available(n));
  if (missing.length) {
    throw new ToolError(
      `Missing required tools on PATH: ${missing.join(", ")}. Install them or set install_deps=false.`,
    );
  }
}

function unquote(v: string): string | boolean {
  const s = v.trim();
  if (/^'.*'$/.test(s)) return s.slice(1, -1).replaceAll("''", "'");
  if (/^".*"$/.test(s)) return JSON.parse(s) as string;
  if (s === "true" || s === "false") return s === "true";
  return s;
}

/** Parse the flat YAML Copier writes to .copier-answers.yml (scalars and block lists only). */
export function parseAnswers(text: string): Answers {
  const out: Answers = {};
  let current: string[] | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && current) {
      current.push(String(unquote(item[1] ?? "")));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key = "", value = ""] = kv;
    if (value === "") {
      current = [];
      out[key] = current;
    } else {
      current = undefined;
      out[key] = value === "[]" ? [] : unquote(value);
    }
  }
  return out;
}

async function gitStatus(cwd: string): Promise<{ repo: boolean; changes: string[] }> {
  const res = await runCommand("git", ["status", "--porcelain"], { cwd, timeoutMs: 30000 });
  if (res.code !== 0) return { repo: false, changes: [] };
  return { repo: true, changes: res.stdout.split("\n").filter(Boolean) };
}

function readAnswers(project: string): Answers {
  const path = join(project, ".copier-answers.yml");
  if (!existsSync(path)) {
    throw new ToolError(
      `${project} has no .copier-answers.yml; it was not generated by this scaffolder`,
    );
  }
  return parseAnswers(readFileSync(path, "utf8"));
}

const createInput = obj(
  {
    destination: absPath(
      "Absolute path of the new project directory. Must not exist or must be empty; its parent must exist.",
    ),
    language: oneOf(LANGUAGES, "Project language."),
    profile: oneOf(ALL_PROFILES, "Profile for the language (see scaffold_list_templates)."),
    project_name: str("Human-readable project name.", {
      pattern: "^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$",
    }),
    project_slug: str("Repository/package name in kebab-case. Defaults from project_name.", {
      pattern: "^[a-z][a-z0-9]*(-[a-z0-9]+)*$",
    }),
    description: str("One-line description.", { pattern: '^[^\\r\\n"\\\\]{1,200}$' }),
    author_name: str("Author name.", { pattern: '^[^\\r\\n"\\\\]{1,100}$' }),
    author_email: str("Author email.", { pattern: '^[^@\\s"]+@[^@\\s"]+$' }),
    license: oneOf(
      LICENSES,
      "License of the new project. Ask the user; 'none' means proprietary (no LICENSE file).",
    ),
    agents: list(oneOf(["cursor", "claude"], "Agent client."), "Agent clients to configure.", {
      default: ["cursor", "claude"],
      maxItems: 2,
    }),
    mcp_servers: list(
      oneOf(["context7", "github"], "MCP server."),
      "Remote MCP servers to configure (URLs only).",
      { default: ["context7"], maxItems: 2 },
    ),
    docker: bool("Add a Dockerfile (backend and next profiles)."),
    github_ci: bool("Add GitHub Actions CI.", true),
    initialize_git: bool("git init (main) and install prek hooks.", true),
    install_deps: bool("Install dependencies after generation.", true),
    package_name: str("Python import package name.", { pattern: "^[a-z][a-z0-9_]{0,59}$" }),
    group_id: str("Java group id.", { pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$" }),
    java_package: str("Java base package.", {
      pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$",
    }),
    ref,
  },
  ["destination", "language", "profile", "project_name", "license"],
);

export type CreateArgs = Infer<typeof createInput>;

const LANGUAGE_ONLY = {
  python: ["package_name"],
  java: ["group_id", "java_package"],
} as const satisfies Partial<Record<Language, readonly (keyof CreateArgs)[]>>;

/** Build the Copier data file for a create request; exported for tests. */
export function buildAnswers(a: CreateArgs): Record<string, unknown> {
  const lang = CATALOG[a.language];
  if (!lang.profiles[a.profile]) {
    throw new ToolError(
      `profile "${a.profile}" is not available for ${a.language}; choose one of: ${Object.keys(lang.profiles).join(", ")}`,
    );
  }
  if (a.license !== "none" && !a.author_name) {
    throw new ToolError(
      `author_name is required for the ${a.license} license; it is the copyright holder in LICENSE`,
    );
  }
  const data: Record<string, unknown> = {
    language: a.language,
    [`${a.language}_profile`]: a.profile,
    project_name: a.project_name,
    project_slug: a.project_slug,
    description: a.description,
    author_name: a.author_name,
    author_email: a.author_email,
    license: a.license,
    agents: a.agents,
    mcp_servers: a.mcp_servers,
    docker: a.docker,
    github_ci: a.github_ci,
    initialize_git: a.initialize_git,
    install_deps: a.install_deps,
  };
  for (const [language, keys] of Object.entries(LANGUAGE_ONLY)) {
    for (const key of keys) {
      if (a[key] === undefined) continue;
      if (language !== a.language) {
        throw new ToolError(`${key} only applies to ${language} projects`);
      }
      data[key] = a[key];
    }
  }
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
}

const tools = [
  tool({
    name: "scaffold_list_templates",
    title: "List scaffold templates",
    tier: "read",
    description:
      "Languages, profiles, toolchains and options the scaffolder supports, which required tools are on PATH, and the configured template source.",
    run: (_a, ctx) => ({
      source: templateSource(ctx.provider),
      ref: ctx.provider.ref ?? "latest tag, else HEAD",
      allowedRoots: ctx.provider.scope.allowedRoots ?? [],
      languages: Object.fromEntries(
        LANGUAGES.map((l) => [
          l,
          { ...CATALOG[l], missingTools: CATALOG[l].requires.filter((b) => !available(b)) },
        ]),
      ),
      options: {
        license: LICENSES,
        agents: ["cursor", "claude"],
        mcp_servers: ["context7", "github"],
        docker: "default true for backend and next profiles",
        github_ci: "default true",
      },
      gitAvailable: available("git"),
    }),
  }),
  tool({
    name: "scaffold_inspect_project",
    title: "Inspect generated project",
    tier: "read",
    description:
      "Read a generated project's Copier answers (language, profile, template source and commit) and its git working-tree state. Use before scaffold_update.",
    input: obj({ project: absPath("Absolute path of the generated project.") }, ["project"]),
    run: async (a, ctx) => {
      const project = checkPath(a.project, ctx.provider);
      const answers = readAnswers(project);
      const git = await gitStatus(project);
      return {
        project,
        language: answers.language,
        profile: answers[`${answers.language}_profile`],
        templateSource: answers._src_path,
        templateCommit: answers._commit,
        answers: Object.fromEntries(Object.entries(answers).filter(([k]) => !k.startsWith("_"))),
        git: {
          isRepo: git.repo,
          clean: git.repo && git.changes.length === 0,
          changes: git.changes.slice(0, 50),
        },
      };
    },
  }),
  tool({
    name: "scaffold_create",
    title: "Create project from template",
    tier: "write",
    description:
      "Generate a new Python, TypeScript or Java project with Copier into an empty or new directory. Runs the template's setup tasks (git init, dependency install, git hooks) unless disabled. Never overwrites existing files.",
    input: createInput,
    summarize: (a) =>
      `create ${a.language}/${a.profile} project "${a.project_name}" at ${a.destination}${a.install_deps === false ? " (no install)" : ""}`,
    run: async (a, ctx) => {
      const destination = checkPath(a.destination, ctx.provider);
      if (!existsSync(dirname(destination))) {
        throw new ToolError(`parent directory ${dirname(destination)} does not exist`);
      }
      if (
        existsSync(destination) &&
        (!statSync(destination).isDirectory() || readdirSync(destination).length > 0)
      ) {
        throw new ToolError(
          `${destination} already exists and is not empty; choose a new directory`,
        );
      }
      const data = buildAnswers(a);
      if (a.initialize_git) requireBinaries(["git"]);
      if (a.install_deps) requireBinaries(CATALOG[a.language].requires);

      const source = templateSource(ctx.provider);
      const vcsRef = a.ref ?? ctx.provider.ref;
      const work = mkdtempSync(join(tmpdir(), "ops-scaffold-"));
      try {
        const dataFile = join(work, "answers.json");
        writeFileSync(dataFile, JSON.stringify(data));
        await ctx.cli(
          [
            "copy",
            "--trust",
            "--defaults",
            "--data-file",
            dataFile,
            ...(vcsRef ? ["--vcs-ref", vcsRef] : []),
            source,
            destination,
          ],
          { parse: "text", timeoutMs: INSTALL_TIMEOUT_MS },
        );
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      const answers = readAnswers(destination);
      return {
        created: destination,
        language: a.language,
        profile: a.profile,
        template: { source: answers._src_path, commit: answers._commit },
        topLevel: readdirSync(destination).sort(),
        dependenciesInstalled: a.install_deps,
        nextSteps: [
          `Read ${join(destination, "AGENTS.md")}`,
          ...NEXT_STEPS[a.language].map((c) => `cd ${destination} && ${c}`),
        ],
      };
    },
  }),
  tool({
    name: "scaffold_update",
    title: "Update project from template",
    tier: "write",
    description:
      "Apply template changes to a generated project with `copier update`, keeping its recorded answers. Requires a clean git working tree; conflicts are written inline or as .rej files for review.",
    input: obj(
      {
        project: absPath("Absolute path of the generated project."),
        conflict: oneOf(["inline", "rej"], "How to write merge conflicts.", "inline"),
        ref,
      },
      ["project"],
    ),
    summarize: (a) => `copier update ${a.project}${a.ref ? ` → ${a.ref}` : ""}`,
    run: async (a, ctx) => {
      const project = checkPath(a.project, ctx.provider);
      readAnswers(project);
      const before = await gitStatus(project);
      if (!before.repo) {
        throw new ToolError(
          `${project} is not a git repository; copier update needs git to merge changes`,
        );
      }
      if (before.changes.length) {
        throw new ToolError(
          `working tree is not clean (${before.changes.length} change(s)); commit or stash first`,
        );
      }
      const vcsRef = a.ref ?? ctx.provider.ref;
      await ctx.cli(
        [
          "update",
          "--trust",
          "--defaults",
          "--conflict",
          a.conflict,
          ...(vcsRef ? ["--vcs-ref", vcsRef] : []),
        ],
        { parse: "text", timeoutMs: INSTALL_TIMEOUT_MS, cwd: project },
      );
      const after = await gitStatus(project);
      const conflicts = after.changes.filter((c) => c.endsWith(".rej") || c.startsWith("UU"));
      const answers = readAnswers(project);
      return {
        project,
        templateCommit: answers._commit,
        changed: after.changes.slice(0, 200),
        conflicts,
        next: "Review the diff (git diff), resolve conflicts, run the project's verify skill, then commit.",
      };
    },
  }),
];

const IN = String.raw`(^|[\s;&|(])`;

function findUp(start: string, marker: string): boolean {
  let dir = resolve(start);
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, marker))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

/** Rule predicate: true when the command runs inside a project containing `marker`. */
const inProject =
  (marker: string) =>
  (payload: HookPayload): boolean => {
    const cwd = payload.cwd || payload.workspace_roots?.[0];
    return cwd ? findUp(cwd, marker) : false;
  };

const shellRules: ShellRule[] = [
  {
    id: "uv-project-pip",
    decision: "deny",
    when: inProject("uv.lock"),
    re: new RegExp(
      `(?<!\\buv(\\.exe)?)${IN}(pip3?|python3?(\\.exe)? -m pip|py -m pip)(\\.exe)? (install|uninstall)\\b`,
      "i",
    ),
    reason:
      "This is a uv project: use `uv add <pkg>` / `uv add --dev <pkg>` / `uv remove <pkg>`. pip bypasses pyproject.toml and uv.lock.",
  },
  {
    id: "uv-project-other-managers",
    decision: "deny",
    when: inProject("uv.lock"),
    re: new RegExp(`${IN}(poetry|pipenv|conda)(\\.exe)? (add|install|remove|lock)\\b`, "i"),
    reason: "This is a uv project: manage dependencies with `uv add` / `uv remove`.",
  },
  {
    id: "uv-project-uv-pip",
    decision: "ask",
    when: inProject("uv.lock"),
    re: /\buv(\.exe)? pip (install|uninstall)\b/i,
    reason:
      "`uv pip` changes the environment without updating pyproject.toml or uv.lock; prefer `uv add` / `uv remove`.",
  },
  {
    id: "pnpm-project-other-managers",
    decision: "deny",
    when: inProject("pnpm-lock.yaml"),
    re: new RegExp(
      `${IN}(npm|yarn|bun)(\\.cmd|\\.exe|\\.ps1)? (install|i|ci|add|remove|rm|uninstall|un|update|up|upgrade)\\b`,
      "i",
    ),
    reason:
      "This is a pnpm project: use `pnpm add` / `pnpm add -D` / `pnpm remove` / `pnpm install`. Other package managers corrupt pnpm-lock.yaml.",
  },
  {
    id: "pnpm-project-other-runners",
    decision: "deny",
    when: inProject("pnpm-lock.yaml"),
    re: new RegExp(`${IN}(npx|bunx)(\\.cmd|\\.exe|\\.ps1)?\\s`, "i"),
    reason:
      "This is a pnpm project: use `pnpm exec <bin>` for installed tools and `pnpm dlx <pkg>` for one-off packages.",
  },
  {
    id: "biome-project-eslint-prettier",
    decision: "ask",
    when: inProject("biome.json"),
    re: /\bpnpm(\.cmd|\.exe|\.ps1)? (add|install|i)\b.*\b(eslint|prettier)\b/i,
    reason:
      "Biome is this project's linter and formatter; adding ESLint or Prettier duplicates it.",
  },
  {
    id: "gradle-project-system-build",
    decision: "deny",
    when: inProject("gradlew"),
    re: new RegExp(`${IN}(gradle|mvn|mvnw)(\\.bat|\\.cmd|\\.exe)? `, "i"),
    reason:
      "This project pins Gradle with the wrapper: run `./gradlew <task>` (Windows: `gradlew.bat <task>`), never a system Gradle or Maven.",
  },
  {
    id: "copier-overwrite",
    decision: "ask",
    re: /\bcopier(\.exe)? (copy|recopy)\b.*(\s-w\b|--overwrite\b)|\bcopier(\.exe)? recopy\b/i,
    reason: "Overwrites existing project files from the template.",
  },
];

const provider: Provider = {
  id: "scaffold",
  displayName: "Scaffold",
  version: "1.0.0",
  bin: "uvx",
  baseArgs: ["--from", `copier==${COPIER_VERSION}`, "copier"],
  baseEnv: { NO_COLOR: "1" },
  requires: ["uvx", "git"],
  instructions: {
    read: "Read-only scaffolder access: supported templates and generated-project state.",
    write: "Creates and updates projects from Copier templates. Every call needs user approval.",
  },
  tools,
  shellRules,
};

export default provider;
