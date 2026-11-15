---
name: scaffold-template-authoring
description: Change or extend the Copier project templates in the cursor-ops-plugins repository (copier.yml, templates/python, templates/typescript, templates/java) and prove every profile still builds. Use when asked to add a profile, bump a toolchain version, change generated files, or fix a template bug.
---

# Author scaffold templates

Templates live in the `cursor-ops-plugins` repo:
- `copier.yml` (repo root) holds every question, plus the `_exclude` rules and `_tasks` for each language. `_subdirectory: templates/{{ language }}` selects the tree.
- `templates/<language>/` is the rendered tree. Only `*.jinja` files are templated; everything else is copied verbatim.
- `templates/_shared/` holds include-only fragments: answers file, license, MCP config, `.editorconfig`, `.gitattributes`, the common AGENTS.md section, and the per-language rule and verify-skill bodies. Reference them with `{% include 'templates/_shared/...' %}`.

## Rules
- Write rule and skill content once in `_shared/<language>/` and include it from both `.cursor/` and `.claude/` wrappers.
- `_shared/standards/*.md` are the suite's engineering standards. The common AGENTS.md section includes them, and `pnpm run sync` generates the review plugins' rules from them, so edit the fragment and run sync. Fragments are plain Markdown with no Jinja syntax and no trailing newline.
- Skills render only into `.claude/skills/` when Claude is selected (Cursor reads that folder too) and into `.cursor/skills/` otherwise. The `_exclude` rules enforce this.
- Profile-specific files are dropped through `_exclude` entries guarded by `language == ... and profile ...`. Add one for every new profile-only file.
- Generated code must pass the project's own formatter as rendered. Keep lines that interpolate user input (names, descriptions) on their own lines or behind a magic trailing comma.
- Wrapper files that end with an `{% include %}` must not have a trailing newline. Keep all template files LF.
- The templates are a standard, not a menu. Don't add questions for tool or runtime choices. Every project uses one package manager per language (uv, pnpm, the Gradle wrapper) and one runtime version.
- Runtime versions (`python_version`, `node_version`, `java_version`) are computed `when: false` values in `copier.yml`. To bump one, change its default and the matching `runtime` entry in `plugins/ops-scaffold/provider.ts` `CATALOG`. `copier update` then rolls it out to existing projects.
- Pin exact tool versions (`package.json` and the Gradle catalog) or lower bounds (Python).
- A new profile needs a choice in `copier.yml`, an entry in `CATALOG`, a case in `scripts/test-templates.ts`, and a policy or contract eval if the tool surface changes.

## Prove it
```shell
pnpm run templates:render    # structure assertions for every case (fast)
pnpm run templates:test      # renders every case and runs its full toolchain (uv / pnpm / gradle)
pnpm run ci                  # plugin validation, unit tests, evals
```
Use `node scripts/test-templates.ts --only java/backend --keep` to inspect a single rendered case.

## Release
Template changes ship with the suite: merge the work branch into `dev`, promote `dev` to `main`, and merge the release-please PR, which tags `vX.Y.Z`. `copier update` in generated projects moves to the newest tag.
