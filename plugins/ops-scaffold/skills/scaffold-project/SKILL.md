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
| Project name and destination | missing | parent folder: the user's code root (e.g. `D:\Codes`), dir = slug |
| Agent clients | never ask unless the user mentions it | `cursor`, `claude` |
| MCP servers | user mentions docs or GitHub automation | `context7` |
| License | user mentions open source or publishing | `MIT` |
| Package or group id | user states one | derived from the slug; Java group `com.example` |

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
{ "destination": "D:\\Codes\\billing-api", "language": "python", "profile": "backend", "project_name": "Billing API", "description": "Billing service." }
```

The tool refuses non-empty directories. Never delete or empty a directory to make room; pick a new name instead.

## 4. Verify
Open the generated `AGENTS.md` and run the verification sequence it lists from the project directory:
- Python: `uv run ruff check . && uv run ty check && uv run pytest`
- TypeScript: `pnpm run check && pnpm build`
- Java: `./gradlew build` (`gradlew.bat build` on Windows; the first run downloads Gradle and the JDK)

## 5. Report
Report the path, language and profile, what was installed, verification results, and the next commands from the tool result. Mention that `scaffold_update` (or `uvx copier update --trust`) pulls in future template improvements.
