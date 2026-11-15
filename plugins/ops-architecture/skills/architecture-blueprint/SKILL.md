---
name: architecture-blueprint
description: Write the enterprise architecture and delivery plan of an application after scaffolding it, or for an existing repository - ARCHITECTURE.md (requirements, use cases, C4 views, platform diagrams with official cloud icons, sequence and data diagrams, security, operations), ADRs, a runbook and a traceable TODO.md synced to GitHub issues - after interviewing the user on everything still open. Use when a new project has been scaffolded, or when the user asks for an architecture document, system design, technical design, delivery plan, backlog or TODO for a project.
---

# Architecture blueprint

The output is what a team lead hands a developer: with these documents and nothing else, the developer can build, deploy and operate the system. It is production architecture, not a prototype sketch, so every statement is a decision with numbers, names and versions.

| File | Contents | Template |
|---|---|---|
| `ARCHITECTURE.md` | 18 sections from context to glossary, with the diagrams below | [ARCHITECTURE.template.md](references/ARCHITECTURE.template.md) |
| `docs/adr/NNNN-<decision>.md` | One per significant decision, with the alternatives | [adr.template.md](references/adr.template.md) |
| `docs/runbook.md` | Deploy, rollback, secrets, alerts, incidents, backup, DR, routine operations | [runbook.template.md](references/runbook.template.md) |
| `docs/architecture/<view>.diagram.json` and `.png` | Platform diagrams with official service icons | `platform-diagrams` skill |
| `TODO.md` | Milestones, definition of done, epics and tasks that trace requirements | [TODO.template.md](references/TODO.template.md) |

Diagrams in the set:

| Diagram | Tool | Section |
|---|---|---|
| Use cases (actors, system boundary, include/extend) | Mermaid flowchart | 3 |
| C4 system context and containers | Mermaid flowchart | 4, 5 |
| Platform deployment with every cloud service as its icon | `architecture_render` | 6 |
| Sequence per critical flow, with failure paths | Mermaid `sequenceDiagram` | 7 |
| Data model, and state machines for entities with a lifecycle | Mermaid `erDiagram`, `stateDiagram-v2` | 8 |
| Milestone schedule | Mermaid `gantt` | `TODO.md` |

Complicated figures that Mermaid's layout can't handle go to TikZ (`latex-diagrams` skill), rendered to SVG and embedded.

## 1. Gather what is already known

Read, in this order:
- the conversation;
- the repository: `AGENTS.md`, `.copier-answers.yml` (language, profile, license), `README.md`, `openapi.json` and the source tree;
- the suite's standards in `AGENTS.md` (GitOps, clean code, security, performance), which the architecture follows rather than restates;
- the platform state through the read tools when the user names an existing account (`aws_whoami`, `github_whoami`, `vercel_whoami`, `digitalocean_whoami`).

List each decision the documents need and mark it known, inferable with high confidence, or open.

## 2. Interview the user

Ask about everything that is open before writing anything. Use AskQuestion forms of up to six questions, grouped by theme, and at most three rounds. Offer concrete options with a recommended default first, and leave free text through "Other". Never invent numbers or names. When the user doesn't know, propose a value, say why, and get it confirmed.

| Theme | Decide |
|---|---|
| Product | problem and outcome, actors and roles, the five to ten core use cases, out of scope, success metrics |
| Load and quality | users and peak requests per second, data volume and growth, latency targets (p95/p99), availability SLO, RPO and RTO, accessibility and localization |
| Platform | cloud and regions (single region, active-passive, active-active), compute model (serverless, containers, Kubernetes, VMs), managed data stores, infrastructure-as-code tool, environments and accounts |
| Security and compliance | data classification (PII, payment, health), regulations (GDPR, SOC 2, ISO 27001, HIPAA, PCI DSS), data residency, identity provider and SSO, tenancy and isolation model, key management |
| Integrations | external systems, payments, email and notifications, events in and out |
| Operations and delivery | observability stack, on-call and support hours, monthly budget, team size and skills, target dates and milestones |

Then summarize the decisions in a short list and get the user's confirmation. Each confirmed choice becomes a requirement row, an ADR or a section statement.

## 3. Write the documents

Copy each template, fill every section, and delete every `<!-- guide: ... -->` comment.

**Requirements.** IDs are `FR-01` and `NFR-01` in table rows. Every NFR is measurable: a metric, a target and how it is measured, such as "p95 API latency ≤ 300 ms at 200 requests per second, measured by the k6 load test in CI".

**Consistency.** Every container in section 5 appears on the platform diagram and in the service table of section 6. Every external system in section 4 appears in a sequence diagram or interface. Every alert in section 11 has a runbook entry, and every threat mitigation in section 10 is a control or a task.

**Decisions.** Write an ADR for each choice a reasonable engineer could have made differently: cloud and region strategy, compute model, each data store, identity, tenancy, messaging, infrastructure-as-code tool, observability stack. ADR 0001 records that architecture decisions live in `docs/adr/`. Section 16 links every ADR. New ADRs start as Proposed and become Accepted when the user approves.

**Stack.** Use the scaffolded stack: language, framework, toolchain, CI, GitOps branches, release-please and the `openapi.json` contract. Name exact managed services, versions, sizes and limits.

**Current state only.** Write in the present tense with no history or change narration. When a decision changes later, update the documents and rewrite the ADR; git keeps the past.

**Plan (`TODO.md`).** Milestones each have exit criteria. One epic covers each coherent outcome. Tasks are at most 3 days and ordered by dependency. Each task has:
- `- **Milestone:**`, `- **Depends on:**` (task IDs or `none`), `- **Traces:**` (requirement IDs and the `ARCHITECTURE.md` section) and `- **Estimate:**` (`4h`, `2d`);
- implementation notes naming the modules, files, resources and settings;
- checkbox acceptance criteria that a reviewer can verify.

The plan covers every requirement and includes:
- the foundation work: accounts, IaC, CI/CD, environments, observability baseline, and a walking skeleton deployed to every environment;
- the feature work;
- the hardening work: threat mitigations, load tests against the NFR targets, a backup restore test, a DR drill, an accessibility audit;
- the launch work: runbook rehearsal and a go-live checklist.

## 4. Draw and verify

1. Draw the platform diagrams with the `platform-diagrams` skill: preview, read the PNG, then render.
2. Run `mermaid_preview` with `file` on `ARCHITECTURE.md` and on `TODO.md`. Read every PNG and fix parse errors and unreadable layouts.
3. Run `architecture_check` with the project root. Fix every error. Resolve each warning or say why it stays, for example missing issue links before the sync.
4. Reread the set as the developer who receives it. Fill any task that still needs a question answered, and any ambiguous component, number or interface.

## 5. Review with the user and commit

Present a summary: the key decisions, the platform diagram image, the milestones with dates, the task count per epic, and the risks. Apply the user's corrections, run step 4 again, and set the approved ADRs to Accepted.

Commit on a feature branch from `dev`, following the GitOps rules in `AGENTS.md`. Use a branch such as `<github-user>/docs/architecture`, a `docs: add architecture, ADRs, runbook and delivery plan` commit, and a pull request to `dev`.

## 6. Sync the plan to GitHub issues

When the repository exists on GitHub, sync after the user approves the plan:
1. Ask whether to add the issues to a GitHub Project board, and its number if so.
2. Call `github_issues_import` (ops-github, one approval per call) with:
   - `milestones`: each `M` row as a milestone titled like `M1 Foundation`, with its target date as `dueOn`.
   - `issues`: every task first, then every epic. Up to 50 per call; split by epic when more.
   - A task issue has key `T-012` and its title. Its body is the task's fields, notes and acceptance criteria, plus a link to `TODO.md`. It has the labels `task` and `epic:E-03` and its milestone.
   - An epic issue has key `E-03`. Its body has the goal and one `- [ ] {{T-012}}` line per task, which the tool turns into issue references. It has the label `epic`.
   - `project` when the user chose a board.
3. Write each returned number into `TODO.md` as `- **Issue:** #45`, run `architecture_check` again, and commit the change on the same branch.

The import skips keys that already have an issue, so running it again after adding tasks creates only the new ones. A pull request that completes a task ticks its checkbox in `TODO.md` and closes its issue (`Closes #45`).

## 7. Report

Report the files written, the counts from `architecture_check` (requirements, epics, tasks, ADRs, platform diagrams), the pull request, the issue sync result, and the decisions the user deferred, if any.
