import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  ARCHITECTURE_SECTIONS,
  checkBlueprint,
  RUNBOOK_SECTIONS,
} from "../plugins/ops-architecture/blueprint.ts";
import { ICON_PROVIDERS, parseSpec } from "../plugins/ops-architecture/diagram-spec.ts";
import { inlineIcons } from "../plugins/ops-architecture/provider.ts";
import { PLUGINS_DIR } from "../scripts/lib.ts";

const SECTION_BODY: Record<string, string> = {
  Requirements:
    "| ID | Requirement |\n|---|---|\n| FR-01 | Customers place orders |\n| NFR-01 | p95 latency ≤ 300 ms |",
  "Use cases": "```mermaid\nflowchart LR\n  c[Customer] --- uc1([Place order])\n```",
  "System context": "```mermaid\nflowchart LR\n  u[Customer] --> s[Orders]\n```",
  Containers: "```mermaid\n---\nconfig:\n  theme: neutral\n---\nflowchart TB\n  api --> db\n```",
  Deployment: "![Production](docs/architecture/production.png)",
  "Runtime flows": "```mermaid\nsequenceDiagram\n  A->>B: call\n```",
  Data: "```mermaid\nerDiagram\n  CUSTOMER ||--o{ ORDER : places\n```",
  "Open source and dependencies":
    "| Component | Purpose | Version | License | Scorecard | Verdict | Rationale |\n|---|---|---|---|---|---|---|\n| FastAPI | HTTP API | 0.118.0 | MIT | 7.1 | Adopt | Typed, maintained |",
  Decisions:
    "- [0001](docs/adr/0001-record-architecture-decisions.md) Record architecture decisions",
};

const ARCHITECTURE = `# Orders architecture\n\n${ARCHITECTURE_SECTIONS.map(
  (title, i) => `## ${i + 1}. ${title}\n\n${SECTION_BODY[title] ?? "Decided."}\n`,
).join("\n")}`;

const TODO = `# Orders delivery plan

## Milestones

| ID | Milestone | Exit criteria | Target date |
|---|---|---|---|
| M1 | Foundation | Skeleton deployed | 2026-12-01 |

\`\`\`mermaid
gantt
  dateFormat YYYY-MM-DD
  E-01 :e01, 2026-11-20, 5d
\`\`\`

## Definition of done

- [ ] Merged with green CI.

## E-01 Platform foundation

### T-001 Provision networking

- **Milestone:** M1
- **Depends on:** none
- **Traces:** NFR-01, ARCHITECTURE.md §6 Deployment
- **Estimate:** 2d
- **Issue:** #12

**Acceptance criteria**

- [ ] terraform plan shows no drift

### T-002 Order API

- **Milestone:** M1
- **Depends on:** T-001
- **Traces:** FR-01
- **Estimate:** 6h
- **Issue:** #13

**Acceptance criteria**

- [ ] POST /orders returns 201
`;

const ADR = `# 0001. Record architecture decisions

## Status

Accepted

## Context

Decisions need a home.

## Decision

Record them in docs/adr.

## Alternatives considered

Wiki pages; pull request descriptions.

## Consequences

Decisions are reviewed with the code.
`;

/** Applies each replacement and fails when a fixture no longer contains the text to replace. */
const edit = (text: string, ...pairs: [string | RegExp, string][]) =>
  pairs.reduce((current, [from, to]) => {
    const next = current.replace(from, to);
    assert.notEqual(next, current, `fixture has no ${String(from)}`);
    return next;
  }, text);

const RUNBOOK = `# Orders runbook\n\n${RUNBOOK_SECTIONS.map((s) => `## ${s}\n\nSteps.\n`).join("\n")}`;

describe("architecture blueprint check", () => {
  let root: string;
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  const messages = () => checkBlueprint(root).errors.map((e) => e.message);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ops-blueprint-"));
    write("ARCHITECTURE.md", ARCHITECTURE);
    write("TODO.md", TODO);
    write("docs/adr/0001-record-architecture-decisions.md", ADR);
    write("docs/runbook.md", RUNBOOK);
    write("docs/architecture/production.diagram.json", "{}");
    write("docs/architecture/production.png", "png");
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(root, "docs/architecture/production.diagram.json"), past, past);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("accepts a complete, traceable set", () => {
    const result = checkBlueprint(root);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.stats, {
      requirements: 2,
      tasks: 2,
      epics: 1,
      milestones: 1,
      adrs: 1,
      platformDiagrams: 1,
    });
  });

  it("requires every requirement to be traced and every reference to exist", () => {
    write(
      "TODO.md",
      edit(
        TODO,
        ["- **Traces:** FR-01", "- **Traces:** FR-09"],
        ["- **Depends on:** T-001", "- **Depends on:** T-003"],
      ),
    );
    assert.ok(messages().includes("no task traces FR-01"));
    assert.ok(
      messages().some((m) => m.includes("traces FR-09, which ARCHITECTURE.md does not define")),
    );
    assert.ok(messages().includes("T-002 depends on unknown task T-003"));
  });

  it("finds dependency cycles, missing fields and criteria", () => {
    write(
      "TODO.md",
      edit(
        TODO,
        ["- **Depends on:** none", "- **Depends on:** T-002"],
        ["- **Estimate:** 6h\n", ""],
        ["- [ ] POST /orders returns 201\n", ""],
      ),
    );
    assert.ok(messages().includes("dependency cycle: T-001 → T-002 → T-001"));
    assert.ok(messages().includes('T-002 has no "- **Estimate:**" line'));
    assert.ok(messages().includes("T-002 has no acceptance criteria checkboxes"));
  });

  it("rejects template guidance, missing sections and diagrams", () => {
    write(
      "ARCHITECTURE.md",
      edit(
        ARCHITECTURE,
        ["## 19. Glossary", "## 19. Terms"],
        ["sequenceDiagram", "flowchart LR"],
        ["Decided.", "<!-- guide: fill this -->"],
      ),
    );
    assert.ok(messages().includes('missing section "## Glossary"'));
    assert.ok(messages().includes('"Runtime flows" needs a mermaid sequenceDiagram diagram'));
    assert.ok(messages().some((m) => m.startsWith("placeholder or template guide comment")));
  });

  it("requires rendered, current platform diagrams and linked ADRs", () => {
    write("docs/architecture/production.diagram.json", '{"title":"changed"}');
    utimesSync(join(root, "docs/architecture/production.png"), new Date(0), new Date(0));
    write(
      "docs/adr/0002-use-postgres.md",
      edit(ADR, ["# 0001.", "# 0002."], ["Accepted", "Proposed"]),
    );
    assert.ok(messages().includes("changed after its image was rendered; render it again"));
    assert.ok(messages().includes('"Decisions" does not link docs/adr/0002-use-postgres.md'));
    assert.ok(checkBlueprint(root).warnings.some((w) => w.message.startsWith("still Proposed")));
  });

  it("reports broken links and warns about tasks without issues", () => {
    write("docs/runbook.md", `${RUNBOOK}\nSee [deploy](deploy.md).\n`);
    write("TODO.md", edit(TODO, [/- \*\*Issue:\*\* #\d+\n/g, ""]));
    assert.ok(messages().includes("link target deploy.md does not exist"));
    assert.ok(checkBlueprint(root).warnings.some((w) => w.message.startsWith("2 task(s) have no")));
  });

  it("does not probe paths outside the project", () => {
    write(
      "docs/runbook.md",
      `${RUNBOOK}\nSee [a](../../../../etc/passwd), [b](/etc/hosts) and [c](%E0%A4%A).\n`,
    );
    const { errors, warnings } = checkBlueprint(root);
    assert.deepEqual(
      warnings.map((w) => w.message),
      [
        "link target ../../../../etc/passwd leaves the project",
        "link target /etc/hosts leaves the project",
      ],
    );
    assert.deepEqual(
      errors.map((e) => e.message),
      ["link target %E0%A4%A is not a valid URI"],
    );
  });
});

describe("platform diagram specs", () => {
  const valid = {
    title: "Production",
    nodes: [
      { id: "api", icon: "aws.compute.Fargate", label: "API" },
      { id: "db", icon: "aws.database.Aurora" },
    ],
    clusters: [{ label: "VPC", nodes: ["api", "db"] }],
    edges: [{ from: "api", to: "db", style: "dashed", direction: "both", color: "#336699" }],
  };

  it("accepts a valid spec", () => {
    assert.deepEqual(parseSpec(valid), valid);
  });

  it("reports every problem at once and accepts only icon names, never code", () => {
    const spec = {
      title: "",
      nodes: [
        { id: "API", icon: "aws.compute.Fargate" },
        { id: "db", icon: "__import__('os').system" },
      ],
      clusters: [
        { label: "A", nodes: ["db"] },
        { label: "B", nodes: ["db", "ghost"] },
      ],
      edges: [{ from: "db", to: "nowhere", style: "wavy" }],
      exec: "x",
    };
    assert.throws(
      () => parseSpec(spec),
      (err: Error) =>
        [
          'spec: unknown field "exec"',
          "title: must be a non-empty string",
          "nodes[0].id: must match",
          "nodes[1].icon: must be provider.category.Class",
          'clusters[1].nodes: node "db" is already in another cluster',
          'clusters[1].nodes: unknown node "ghost"',
          'edges[0].to: unknown node "nowhere"',
          "edges[0].style: must be one of",
        ].every((part) => err.message.includes(part)),
    );
  });

  it("rejects labels Graphviz would read as HTML", () => {
    assert.throws(
      () =>
        parseSpec({
          ...valid,
          title: "<<IMG SRC='/etc/passwd'/>>",
          edges: [{ from: "api", to: "db", label: "a\u0000b" }],
        }),
      (err: Error) =>
        ["title: must not contain", "edges[0].label: must not contain"].every((part) =>
          err.message.includes(part),
        ),
    );
  });

  it("lists the same icon providers as the renderer", () => {
    const python = readFileSync(
      join(PLUGINS_DIR, "ops-architecture", "renderer", "render_diagram.py"),
      "utf8",
    );
    const set = /PROVIDERS = \{([^}]*)\}/.exec(python)?.[1] ?? "";
    assert.deepEqual(
      [...set.matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]).sort(),
      [...ICON_PROVIDERS].sort(),
    );
  });

  it("embeds icon images from the diagrams resources folder only", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-icons-"));
    try {
      const icon = join(dir, "site-packages", "resources", "aws", "compute", "lambda.png");
      mkdirSync(dirname(icon), { recursive: true });
      writeFileSync(icon, "PNG");
      const outside = join(dir, "resources", "secret.png");
      mkdirSync(dirname(outside), { recursive: true });
      writeFileSync(outside, "nope");
      const svg = inlineIcons(`<image xlink:href="${icon}"/><image xlink:href="${outside}"/>`);
      assert.ok(
        svg.includes(`xlink:href="data:image/png;base64,${Buffer.from("PNG").toString("base64")}"`),
      );
      assert.ok(svg.includes(`xlink:href="${outside}"`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("diagram routing rule", () => {
  it("is the same in ops-mermaid and ops-latex", () => {
    const rule = (plugin: string) =>
      readFileSync(join(PLUGINS_DIR, plugin, "rules", "diagram-routing.mdc"), "utf8");
    assert.equal(rule("ops-mermaid"), rule("ops-latex"));
  });
});
