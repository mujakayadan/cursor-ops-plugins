---
name: performance-review
description: Review code changes for performance problems (algorithmic complexity, N+1 and unbounded queries, blocking or sequential I/O, caching, memory leaks, payload, bundle and rendering cost) and fix clear issues. Use when the ops-performance hook requests a review, before merging, or when asked to find why code is slow.
---

# Performance review

Review the **changes** first: the files and hints in the request, or `git diff` (plus `git diff --staged`) when asked ad hoc. Judge each change by how often it runs and how much data it touches. A one-off script and a request handler deserve different scrutiny.

## Method

1. **Classify the path.** Is it hot (per request, per render, per item, in a loop or a tight timer), warm (per job or page load) or cold (startup, CLI, migration)? Estimate the data size (n) it handles.
2. **Walk the checklist** for hot and warm paths. For cold paths, only flag problems that are pathological (quadratic over large inputs, unbounded memory).
3. **Triage static hints.** Each hint in the request is a heuristic. Confirm it or dismiss it with a reason (e.g. "sync I/O in a CLI is fine").
4. **Fix** clear, local, behavior-preserving wins right away: batch a per-item query, replace a nested `find` with a `Map`, run independent awaits with `Promise.all`, add a missing `LIMIT`, remove a listener leak.
5. **Report** the rest. Anything that needs a schema change, an index, a cache policy or a measurement is listed with the expected impact.

## Checklist

| Area | Look for |
| --- | --- |
| Complexity | Nested loops or scans (`find`/`filter`/`includes` inside a loop) over growing data; repeated sorting; regex or JSON work rebuilt per item; string building in loops |
| Data access | N+1 queries or HTTP calls per item; missing pagination or `LIMIT`; `SELECT *`; filtering or sorting in app code that the database could do; queries on new filter columns with no index; long transactions |
| I/O & concurrency | Sync file, process or crypto I/O in servers or handlers; sequential `await` of independent work; unbounded `Promise.all` or fan-out; missing timeouts or retries with backoff; blocking sleeps |
| Caching | Recomputing or refetching stable data per request; caches with no key discipline, TTL, size bound or invalidation; cache stampedes |
| Memory | Loading whole files or tables into memory instead of streaming; unbounded maps, arrays or queues; listeners, timers, intervals, subscriptions or connections never released; closures capturing large objects |
| Frontend | Unnecessary re-renders (new objects or functions in props, missing memoization on expensive children), effects without proper dependencies, large dependencies or non-tree-shaken imports, unoptimized images, layout thrash, long lists without virtualization |
| Payloads | Over-fetching fields; missing compression; N requests where one batched request works; chatty polling where push or caching works |
| Startup & build | Heavy work at import time; eager loading of rarely used modules; cold-start sensitive serverless code doing setup per invocation |

## Severity

- **High:** grows superlinearly with user data, or does I/O per item, on a hot path; or is an unbounded memory or resource leak.
- **Medium:** a clear constant-factor waste on a hot path (sequential awaits, over-fetching, missing cache of stable data).
- **Low:** a minor or cold-path improvement; mention it only if it's cheap.

Don't report speculative micro-optimizations. When the impact depends on data size or traffic you can't see, say what to measure.

## Output

End the turn with:

```markdown
**Review: performance**
- High `orders/service.ts:88` N+1: one `findById` per line item; batched with `findMany({ where: { id: { in } } })`. (fixed)
- Medium `api/search.ts:31` no `LIMIT` on a user-driven query; add pagination. (needs decision)
```

If nothing is wrong: `**Review: performance** No issues found in the changed code.` Keep it short; no generic advice.
