---
name: security-review
description: Review code changes for security vulnerabilities (injection, broken authz, secrets, unsafe crypto, SSRF, deserialization, supply chain, CI/CD and container risks) and fix clear issues. Use when the ops-security hook requests a review, before merging, or when asked to audit code or a diff for security.
---

# Security review

Review the **changes** first: the files and hints in the request, or `git diff` (plus `git diff --staged`) when asked ad hoc. Read surrounding code only as far as needed to follow data from its source to its sink. A full-repository audit happens only when the user asks for one.

## Method

1. **Map the change.** What new inputs, endpoints, commands, queries, files, dependencies or permissions does it add? Who can reach them (anonymous user, authenticated user, admin, CI, other services)?
2. **Trace untrusted data** from each source (request params, headers, bodies, files, env, CLI args, tool or LLM output, webhooks, DB rows other users wrote) to each sink. Check the checklist below.
3. **Triage static hints.** Each hint in the request is a heuristic. Confirm it or dismiss it with a reason; don't repeat a hint you can't confirm.
4. **Fix** clear, local, behavior-preserving problems right away: parameterize a query, drop `shell=True`, add a missing ownership check that mirrors siblings, move a literal secret to env.
5. **Report** the rest. Anything that changes behavior, an API contract or a product decision is listed, not changed.

## Checklist

| Area | Look for |
| --- | --- |
| Injection | SQL/NoSQL built from strings; shell commands via a shell or string concat; template, LDAP, XPath, regex (ReDoS) injection; `eval`/`Function`; prompt injection where model output drives tools |
| Path & files | Traversal (`..`, absolute paths, symlinks) outside an allowed root; unrestricted uploads (type, size, location); zip slip |
| AuthN / AuthZ | Missing or client-side-only checks; IDOR (object fetched by id without owner check); privilege escalation via mass assignment; insecure session/JWT handling (no expiry, `alg: none`, unsigned) |
| Secrets & data | Hardcoded credentials; secrets or PII in logs, errors, URLs, analytics or client bundles; real emails, names, account or tenant IDs in code, fixtures or examples; overly broad API responses |
| Web | XSS sinks (`innerHTML`, `dangerouslySetInnerHTML`, `v-html`, the template `safe` filter); CSRF on state-changing cookie routes; open redirects; CORS `*` with credentials; missing security headers on new apps |
| SSRF & network | Server-side fetches of user-supplied URLs without an allowlist; TLS verification disabled; plaintext protocols |
| Crypto | MD5/SHA-1 for security, ECB, static IVs, home-made crypto; `Math.random`/`random` for tokens; passwords not hashed with bcrypt/scrypt/argon2 |
| Deserialization & parsing | `pickle`, `yaml.load`, Java serialization, XML external entities on untrusted input |
| Dependencies | New packages: maintained, popular, correctly spelled (typosquats), pinned via lockfile; no `curl \| sh` installs |
| CI/CD & infra | `pull_request_target` plus a checkout of PR code; `${{ github.event.* }}` interpolated into `run:`; `permissions: write-all`; unpinned third-party actions; containers running privileged or as root; world-writable files; public buckets or `0.0.0.0/0` ingress |
| Errors & limits | Stack traces to clients; fail-open error handling around auth; missing rate limits or size limits on expensive or auth endpoints |

## Severity

- **Critical:** exploitable remotely without auth for code execution, data breach or account takeover.
- **High:** exploitable by any authenticated user, or a secret is exposed.
- **Medium:** needs unusual conditions or limited impact (e.g. a missing header, verbose errors).
- **Low:** hardening or defense in depth.

## Output

End the turn with:

```markdown
**Review: security**
- High `api/users.ts:42` IDOR: `getUser(id)` returns any user; added an owner check. (fixed)
- Medium `server.ts:10` CORS allows `*` with credentials; restrict to the app origin. (needs decision)
```

If nothing is wrong: `**Review: security** No issues found in the changed code.` Keep it short; no generic advice.
