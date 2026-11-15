---
name: scaffold-project
description: Create a new Python, TypeScript (Next.js) or Java project from the team's Copier templates with uv/Ruff/ty, pnpm/Biome or Gradle/Spring Boot preconfigured, plus AGENTS.md, Cursor/Claude rules, CI and git hooks. Use when the user asks to scaffold, bootstrap, start, generate or set up a new project, app, service, API, backend or library.
---

# Scaffold a project

The `ops-scaffold` MCP servers generate projects from Copier templates. Never hand-write a project skeleton when a template fits; templates are tested and can be updated later with `copier update`.

## 1. Discover
Call `scaffold_list_templates` (read tier). It returns the languages, profiles, options and any `missingTools` on this machine.

## 2. Interview
Ask only what the request leaves open. Use one AskQuestion form where available:

| Decision | Ask when | Default |
|---|---|---|
| Language + profile | not stated or ambiguous ("an API" could be Python backend or Java backend) | none, always confirm |
| Project name and destination | missing | parent folder: the user's code root (e.g. `~/code`), dir = slug |
| Agent clients | never ask unless the user mentions it | `cursor`, `claude` |
| MCP servers | user mentions docs or GitHub automation | `context7` |
| License | always, unless the user already said | none; offer `MIT`, `Apache-2.0`, or `none` (proprietary, no LICENSE file) |
| Copyright holder (`author_name`) | license is not `none` and it is not known | none; the person or company that owns the code |
| Package or group id | user states one | derived from the slug; Java group `com.example` |
| GitHub repo and its visibility | always, unless the user already said; publishing is optional | none; offer `public`, `private`, or "no GitHub repo yet" |
| Extra environment branches | only if the user mentions QA or staging | none; `main` and `dev` always |
| Git LFS (`git_lfs`) | the project will hold media, models, datasets or other large binaries | `false`; needs `git-lfs` (`gitLfsAvailable`) |

Runtime versions are fixed by the standard (Python 3.13, Node 24, Java 25) and are not options. If the user asks for a different one, say it is the team standard and that changing it is a template change (`scaffold-template-authoring`).

Map intent to profiles:
- CLI tool or script: `python/simple` or `java/simple`
- REST API, service, backend: `python/backend` (FastAPI) or `java/backend` (Spring Boot)
- Reusable package or SDK: `python/library` or `java/library`
- Web app, website, dashboard, frontend: `typescript/next`

If `missingTools` lists something needed, tell the user first. Either they install it, or you generate with `install_deps: false` and tell them which install command to run later.

## 3. Create
Call `scaffold_create` (write tier, needs approval) with an **absolute** `destination` that does not exist yet. Example:

```json
{ "destination": "C:\\code\\billing-api", "language": "python", "profile": "backend", "project_name": "Billing API", "description": "Billing service.", "license": "MIT", "author_name": "Acme Inc." }
```

The tool refuses non-empty directories. Never delete or empty a directory to make room; pick a new name instead.

## 4. Verify
Open the generated `AGENTS.md` and run the verification sequence it lists from the project directory:
- Python: `uv run ruff check . && uv run ty check && uv run pytest`
- TypeScript: `pnpm run check && pnpm build`
- Java: `./gradlew build` (`gradlew.bat build` on Windows; the first run downloads Gradle and the JDK)

Backend profiles commit `openapi.json` as the API contract. For `python/backend`, the template writes it before the initial commit when dependencies are installed. For `java/backend`, the first `./gradlew build` with Docker running writes it; commit it on the first feature branch.

With `initialize_git` the template makes the initial commit on `main` before installing hooks. From then on, `main` and `dev` change only through pull requests.

## 5. Publish (when the user chose a visibility)
Follow the `gitops-workflow` skill (ops-github): `github_repo_create` with the chosen `visibility` and `source` set to the project path pushes `main`. Then `github_repo_bootstrap` creates `dev` (plus any qa/staging the user asked for), the merge settings, labels and rulesets. Pass the CI job names as `requiredChecks`: `verify`, plus `api-compat` for backend profiles. Report the `gitopsToken` hint from its result to the user.

## 6. Architecture and plan
For applications and services (`python/backend`, `java/backend`, `typescript/next`), continue with the `architecture-blueprint` skill (ops-architecture). It interviews the user, researches and vets open source for exemplars and reusable components (`oss-research`, ops-oss), then writes `ARCHITECTURE.md`, the ADRs, the runbook and `TODO.md`, and syncs the plan to GitHub issues. Offer it for CLI tools and libraries too; there the deployment section describes distribution rather than infrastructure. Skip it only when the user declines.

## 7. Report
Report the path, language and profile, what was installed, verification results, the architecture pull request and issue sync, and the next commands from the tool result. Mention that `scaffold_update` (or `uvx copier update --trust`) pulls in future template improvements. The first change, which is the first task in `TODO.md` when there is one, starts with `git switch -c <github-user>/feat/<name> dev`.
