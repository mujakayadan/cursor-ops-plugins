---
name: docs-review
description: Find and fix documentation that no longer matches the code (stale names, options, paths, defaults, counts, examples, links, removed features, undocumented new behavior). Use when the ops-docs hook requests a review after code or doc changes, before merging, or when asked for a doc staleness audit of a repository.
---

# Docs review

Docs are correct when a reader who follows them gets exactly what the code does now.

## After a change (hook request)

1. **List what changed** for readers: the files in the request, or `git diff` (plus `git diff --staged`). Note every renamed or removed identifier, option, config key, command, path, tool, default value and count, and every new user-facing behavior.
2. **Find the docs that describe it.** `rg` each old and new name across Markdown, `.mdc` rules, skills, READMEs, config examples, help strings and comments. Also read the nearest README and any doc the changed files link to.
3. **Triage static hints:**
   - `docs/stale-reference`: a doc still mentions an identifier the edit removed. Confirm the identifier no longer exists anywhere (`rg`) before you change the doc.
   - `docs/broken-link` and `docs/missing-path`: a link or path in edited doc text doesn't resolve.
4. **Fix in place:**
   - update names, options, defaults, counts and examples;
   - delete sections about removed behavior;
   - add concise docs for new user-facing behavior where readers will look;
   - rewrite any history narration as a present-tense description.
5. **Report** only what needs the user, such as docs in another repository or a product decision about what to document.

## Full audit (ad hoc)

When asked to check a whole repository for stale docs:

1. Inventory the docs: `rg --files -g '*.md' -g '*.mdx' -g '*.mdc' -g '*.rst'`, excluding dependencies, builds and changelogs.
2. For each doc, extract the checkable claims:
   - commands and scripts (check `package.json`, `Makefile`, `pyproject.toml`);
   - paths and links (do they exist?);
   - identifiers, tools, options and config keys (`rg` them in the code);
   - defaults and counts (compare with the code);
   - code examples (do they match current signatures?).
3. Flag history narration ("previously", "no longer", "renamed", "now uses", migration notes) in anything but changelogs.
4. Fix clear mismatches. List the rest by file with the evidence.

## Output

End the turn with:

```markdown
**Review: docs**
- `README.md:154` listed the removed `latex_templates` tool; removed it from the table. (fixed)
- `docs/config.md:30` default `maxFiles` said 20, code says 30; corrected. (fixed)
- New `review.lenses.docs` option was undocumented; added a row to the configuration reference. (fixed)
```

If nothing is stale: `**Review: docs** Docs match the changed code.` Keep it short.
