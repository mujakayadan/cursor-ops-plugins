---
name: standards-review
description: Review changed code and docs against the clean-code standard (current state only, no history narration, no backward-compatibility shims, legacy, dead or commented-out code, no personal or machine-specific values, clean names and structure) and fix what violates it. Use when the ops-standards hook requests a review, before merging, or when asked to clean up code or docs.
---

# Standards review

Review the **changes**: the files and hints in the request, or `git diff` (plus `git diff --staged`) when asked ad hoc. The standard is the `clean-code` rule. The repository should read as if it had always been written this way.

## Method

1. **Read the diff and each changed file in full**, plus the callers of anything renamed or removed (`rg` for the old name).
2. **Walk the checklist** below.
3. **Triage static hints.** Each one is a heuristic. Confirm it or dismiss it with a reason; for example, "deprecated" may quote an external API's own status.
4. **Fix in place.** Standards fixes are behavior-preserving by nature:
   - rewrite history narration as a present-tense description, or delete it;
   - delete commented-out and dead code;
   - inline or delete compatibility shims after updating their callers;
   - replace personal paths, names and IDs with runtime lookups or neutral placeholders;
   - rename unclear identifiers;
   - extract duplicated logic.
5. **Report** only what you couldn't fix safely. For example, removing a public API that external consumers use needs the user's decision.

## Checklist

| Area | Look for |
| --- | --- |
| History | Comments, docs, rules, skills, notes or commit-style prose in files that say what changed, what it used to be, corrections or "now" narration. Docs that describe migrations or old behavior. |
| Compatibility | Aliases for old names, re-exports kept "for compatibility", optional parameters that only serve old callers, fallbacks that read old config keys or file formats, `legacy`/`old`/`v1` duplicates, `@deprecated` code the repo itself still owns |
| Dead code | Unused exports, functions, parameters, options, branches, feature flags, files, assets, config entries or dependencies; commented-out code; unreachable code after a refactor |
| Leftovers | TODO/FIXME/HACK markers, debug output, `debugger`, scratch files, suppressions without a reason |
| Portability | Paths, user names, emails, account or tenant IDs or time zones of one person or machine in code, docs, tests or examples; derive them at runtime (home directory, environment, config) or use placeholders such as `~/code/app`, `<account-id>` and `example.com` |
| Clarity | Vague names (`data`, `tmp`, `handle2`), misleading names after a behavior change, functions doing several things, deep nesting, magic numbers without a named constant |
| Duplication | Copy-pasted logic, parallel lists that must be kept in sync by hand, repeated literals |
| Consistency | Idioms, error handling, naming and formatting that differ from the surrounding code; comments that restate the code |

## Output

End the turn with:

```markdown
**Review: standards**
- `src/config.ts:41` fallback that still read the old `timeout_ms` key; removed it and updated `docs/config.md`. (fixed)
- `lib/api.ts:12` `fetchUserV1` kept beside `fetchUser`; callers moved and the duplicate deleted. (fixed)
- `pkg/client.ts` the public `connectLegacy` export may have external users; remove it? (needs decision)
```

If nothing is wrong: `**Review: standards** No issues found in the changed code.` Keep it short; no generic advice.
