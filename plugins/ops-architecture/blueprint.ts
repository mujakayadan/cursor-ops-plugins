import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const ARCHITECTURE_FILE = "ARCHITECTURE.md";
export const TODO_FILE = "TODO.md";
export const RUNBOOK_FILE = "docs/runbook.md";
export const ADR_DIR = "docs/adr";
export const DIAGRAM_DIR = "docs/architecture";
export const SPEC_SUFFIX = ".diagram.json";

/** Section titles of ARCHITECTURE.md, in order; a heading may carry a number such as `## 6. Deployment`. */
export const ARCHITECTURE_SECTIONS = [
  "Context and scope",
  "Requirements",
  "Use cases",
  "System context",
  "Containers",
  "Deployment",
  "Runtime flows",
  "Data",
  "Interfaces",
  "Security",
  "Observability",
  "Scalability and performance",
  "Resilience and disaster recovery",
  "Environments and delivery",
  "Cost",
  "Decisions",
  "Risks",
  "Glossary",
] as const;

/** Mermaid diagram types each section must contain at least one of. */
const SECTION_DIAGRAMS: Partial<Record<(typeof ARCHITECTURE_SECTIONS)[number], string[]>> = {
  "Use cases": ["flowchart"],
  "System context": ["flowchart", "C4Context"],
  Containers: ["flowchart", "C4Container"],
  "Runtime flows": ["sequenceDiagram"],
  Data: ["erDiagram"],
};

export const RUNBOOK_SECTIONS = [
  "Deploy",
  "Rollback",
  "Configuration and secrets",
  "Monitoring and alerts",
  "Incident response",
  "Backup and restore",
  "Disaster recovery",
  "Routine operations",
] as const;

export const ADR_SECTIONS = [
  "Status",
  "Context",
  "Decision",
  "Alternatives considered",
  "Consequences",
] as const;

const ADR_STATUS = /^(?:Proposed|Accepted)$/;
const ADR_FILE = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const REQUIREMENT_ROW = /^\|\s*((?:FR|NFR)-\d+)\s*\|/;
const REQUIREMENT_REF = /\b(?:FR|NFR)-\d+\b/g;
const MILESTONE_ROW = /^\|\s*(M\d+)\s*\|/;
const EPIC = /^## (E-\d+)\s+\S/;
const TASK = /^### (T-\d+)\s+(\S.*)$/;
const FIELD = /^- \*\*(Milestone|Depends on|Traces|Estimate|Issue):\*\*\s*(.*)$/;
const TASK_REF = /\bT-\d+\b/g;
const ESTIMATE = /^(\d+(?:\.\d+)?)\s*([hd])$/;
const MAX_TASK_DAYS = 3;
const HOURS_PER_DAY = 8;
const CHECKBOX = /^\s*- \[[ xX]\] \S/;
const ISSUE = /^(?:#\d+|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+)$/;
const PLACEHOLDER =
  /\bTBD\b|\bTBC\b|\bFIXME\b|\bTODO:|lorem ipsum|\?\?\?|<!--\s*guide:|<System name>|<(?:fill|placeholder|insert|describe|todo)\b[^>]*>/i;
const LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const MAX_FINDINGS = 100;

export interface Finding {
  file: string;
  line?: number;
  message: string;
}

export interface CheckResult {
  ok: boolean;
  errors: Finding[];
  warnings: Finding[];
  stats: Record<string, number>;
}

interface Section {
  title: string;
  line: number;
  lines: string[];
}

interface Doc {
  file: string;
  lines: string[];
  /** Line numbers (1-based) that sit inside fenced code blocks. */
  fenced: Set<number>;
}

interface Task {
  id: string;
  line: number;
  fields: Partial<Record<"Milestone" | "Depends on" | "Traces" | "Estimate" | "Issue", string>>;
  criteria: number;
}

function readDoc(root: string, file: string): Doc | undefined {
  const path = join(root, file);
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const fenced = new Set<number>();
  let fence: string | undefined;
  lines.forEach((line, i) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || marker.startsWith(fence))) {
      fence = fence ? undefined : marker;
      fenced.add(i + 1);
    } else if (fence) fenced.add(i + 1);
  });
  return { file, lines, fenced };
}

const headingTitle = (text: string) => text.replace(/^\d+(?:\.\d+)*\.?\s+/, "").trim();

/** H2 sections outside code fences. */
function sections(doc: Doc): Section[] {
  const out: Section[] = [];
  doc.lines.forEach((line, i) => {
    const m = /^## (.+)$/.exec(line);
    if (m?.[1] && !doc.fenced.has(i + 1))
      out.push({ title: headingTitle(m[1]), line: i + 1, lines: [] });
    else out.at(-1)?.lines.push(line);
  });
  return out;
}

/** The first word of each mermaid block, such as `flowchart` or `sequenceDiagram`. */
function mermaidTypes(lines: string[]): string[] {
  const types: string[] = [];
  let inMermaid = false;
  let frontMatter = false;
  let typed = false;
  for (const line of lines) {
    if (/^\s*(`{3,}|~{3,})\s*mermaid\b/.test(line)) {
      inMermaid = true;
      typed = false;
      continue;
    }
    if (!inMermaid) continue;
    if (/^\s*(`{3,}|~{3,})\s*$/.test(line)) {
      inMermaid = false;
      continue;
    }
    if (typed) continue;
    const text = line.trim();
    if (text === "---") frontMatter = !frontMatter;
    else if (!frontMatter && text && !text.startsWith("%%")) {
      types.push(text.split(/\s/)[0] ?? "");
      typed = true;
    }
  }
  return types;
}

class Report {
  readonly errors: Finding[] = [];
  readonly warnings: Finding[] = [];
  error(file: string, message: string, line?: number) {
    if (this.errors.length < MAX_FINDINGS)
      this.errors.push({ file, message, ...(line ? { line } : {}) });
  }
  warn(file: string, message: string, line?: number) {
    if (this.warnings.length < MAX_FINDINGS)
      this.warnings.push({ file, message, ...(line ? { line } : {}) });
  }
}

function checkCommon(root: string, doc: Doc, report: Report): void {
  doc.lines.forEach((line, i) => {
    const n = i + 1;
    if (PLACEHOLDER.test(line))
      report.error(
        doc.file,
        "placeholder or template guide comment left; write the real content",
        n,
      );
    if (doc.fenced.has(n)) return;
    for (const m of line.matchAll(LINK)) {
      const target = (m[1] ?? "").split("#")[0] ?? "";
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const path = resolve(root, dirname(doc.file), decodeURI(target));
      if (!existsSync(path)) report.error(doc.file, `link target ${target} does not exist`, n);
    }
  });
}

function requiredSections(
  doc: Doc,
  titles: readonly string[],
  report: Report,
): Map<string, Section> {
  const found = new Map(sections(doc).map((s) => [s.title.toLowerCase(), s]));
  for (const title of titles) {
    if (!found.has(title.toLowerCase())) report.error(doc.file, `missing section "## ${title}"`);
  }
  return found;
}

function checkArchitecture(root: string, doc: Doc, adrs: string[], report: Report): Set<string> {
  const found = requiredSections(doc, ARCHITECTURE_SECTIONS, report);
  const section = (title: string) => found.get(title.toLowerCase());

  const requirements = new Set<string>();
  const req = section("Requirements");
  req?.lines.forEach((line, i) => {
    const id = REQUIREMENT_ROW.exec(line)?.[1];
    if (!id) return;
    if (requirements.has(id)) report.error(doc.file, `${id} is defined twice`, req.line + i + 1);
    requirements.add(id);
  });
  if (req && ![...requirements].some((id) => id.startsWith("FR-"))) {
    report.error(
      doc.file,
      "Requirements defines no functional requirement rows (| FR-01 | ... |)",
      req.line,
    );
  }
  if (req && ![...requirements].some((id) => id.startsWith("NFR-"))) {
    report.error(
      doc.file,
      "Requirements defines no non-functional requirement rows (| NFR-01 | ... |)",
      req.line,
    );
  }

  for (const [title, types] of Object.entries(SECTION_DIAGRAMS)) {
    const s = section(title);
    if (s && !mermaidTypes(s.lines).some((t) => types.includes(t))) {
      report.error(doc.file, `"${title}" needs a mermaid ${types.join(" or ")} diagram`, s.line);
    }
  }

  const deployment = section("Deployment");
  if (deployment) {
    const images = deployment.lines.flatMap((l) =>
      [...l.matchAll(/!\[[^\]]*\]\(([^)\s]+\.(?:png|svg))\)/g)].map((m) => m[1] ?? ""),
    );
    const platform = images.filter((img) =>
      existsSync(join(root, img.replace(/\.(png|svg)$/, SPEC_SUFFIX))),
    );
    if (!platform.length) {
      report.error(
        doc.file,
        `"Deployment" needs a platform diagram image rendered from a ${DIAGRAM_DIR}/<name>${SPEC_SUFFIX} spec`,
        deployment.line,
      );
    }
  }

  const decisions = section("Decisions");
  if (decisions) {
    const text = decisions.lines.join("\n");
    for (const adr of adrs) {
      if (!text.includes(`${ADR_DIR}/${adr}`))
        report.error(doc.file, `"Decisions" does not link ${ADR_DIR}/${adr}`, decisions.line);
    }
  }
  return requirements;
}

function checkAdrs(root: string, report: Report): string[] {
  const dir = join(root, ADR_DIR);
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort()
    : [];
  if (!files.length)
    report.error(ADR_DIR, "no architecture decision records; record each major choice");
  const numbers = new Set<string>();
  for (const name of files) {
    const file = `${ADR_DIR}/${name}`;
    const number = ADR_FILE.exec(name)?.[1];
    if (!number) {
      report.error(file, "ADR file names are NNNN-kebab-title.md");
      continue;
    }
    if (numbers.has(number)) report.error(file, `ADR number ${number} is used twice`);
    numbers.add(number);
    const doc = readDoc(root, file);
    if (!doc) continue;
    checkCommon(root, doc, report);
    if (!doc.lines.some((l) => l.startsWith(`# ${number}. `)))
      report.error(file, `title must be "# ${number}. <decision>"`);
    const found = requiredSections(doc, ADR_SECTIONS, report);
    const status = found.get("status")?.lines.find((l) => l.trim());
    if (status !== undefined && !ADR_STATUS.test(status.trim())) {
      report.error(file, "Status must be Proposed or Accepted");
    } else if (status?.trim() === "Proposed") {
      report.warn(file, "still Proposed; set it to Accepted once the user approves the decision");
    }
  }
  return files.filter((f) => ADR_FILE.test(f));
}

function checkDiagramSpecs(root: string, report: Report): number {
  const dir = join(root, DIAGRAM_DIR);
  const specs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(SPEC_SUFFIX)) : [];
  for (const spec of specs) {
    const base = spec.slice(0, -SPEC_SUFFIX.length);
    const images = [".png", ".svg"]
      .map((ext) => join(dir, base + ext))
      .filter((p) => existsSync(p));
    const file = `${DIAGRAM_DIR}/${spec}`;
    if (!images.length)
      report.error(file, `not rendered; render it to ${DIAGRAM_DIR}/${base}.png or .svg`);
    else if (images.every((img) => statSync(img).mtimeMs < statSync(join(dir, spec)).mtimeMs)) {
      report.error(file, "changed after its image was rendered; render it again");
    }
  }
  return specs.length;
}

function parseTasks(
  doc: Doc,
  report: Report,
): { tasks: Task[]; epics: number; milestones: Set<string> } {
  const milestones = new Set<string>();
  const tasks: Task[] = [];
  let epics = 0;
  let section = "";
  let criteria = false;
  doc.lines.forEach((line, i) => {
    const n = i + 1;
    if (doc.fenced.has(n)) return;
    const h2 = /^## (.+)$/.exec(line)?.[1];
    if (h2) {
      section = headingTitle(h2);
      if (EPIC.test(line)) epics++;
      return;
    }
    if (section === "Milestones") {
      const m = MILESTONE_ROW.exec(line)?.[1];
      if (m) milestones.add(m);
      return;
    }
    const task = TASK.exec(line);
    if (task?.[1]) {
      if (!/^E-\d+/.test(section))
        report.error(doc.file, `${task[1]} is not under an epic heading (## E-01 ...)`, n);
      tasks.push({ id: task[1], line: n, fields: {}, criteria: 0 });
      criteria = false;
      return;
    }
    const current = tasks.at(-1);
    if (!current) return;
    if (/^#{1,3} /.test(line)) {
      criteria = false;
      return;
    }
    const field = FIELD.exec(line);
    if (field?.[1]) current.fields[field[1] as keyof Task["fields"]] = (field[2] ?? "").trim();
    if (/acceptance criteria/i.test(line)) criteria = true;
    else if (criteria && CHECKBOX.test(line)) current.criteria++;
  });
  return { tasks, epics, milestones };
}

function estimateDays(value: string): number | undefined {
  const m = ESTIMATE.exec(value);
  if (!m) return undefined;
  return m[2] === "h" ? Number(m[1]) / HOURS_PER_DAY : Number(m[1]);
}

function findCycle(tasks: Map<string, string[]>): string[] | undefined {
  const state = new Map<string, "open" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === "done") return undefined;
    if (state.get(id) === "open") return [...path.slice(path.indexOf(id)), id];
    state.set(id, "open");
    path.push(id);
    for (const dep of tasks.get(id) ?? []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, "done");
    return undefined;
  };
  for (const id of tasks.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return undefined;
}

function checkTodo(doc: Doc, requirements: Set<string>, report: Report) {
  const found = requiredSections(doc, ["Milestones", "Definition of done"], report);
  const milestoneSection = found.get("milestones");
  if (milestoneSection && !mermaidTypes(milestoneSection.lines).includes("gantt")) {
    report.error(doc.file, '"Milestones" needs a mermaid gantt chart', milestoneSection.line);
  }
  const { tasks, epics, milestones } = parseTasks(doc, report);
  if (!epics) report.error(doc.file, "no epics (## E-01 <title>)");
  if (!tasks.length) report.error(doc.file, "no tasks (### T-001 <title>)");
  if (milestoneSection && !milestones.size)
    report.error(doc.file, "Milestones defines no rows (| M1 | ... |)", milestoneSection.line);

  const ids = new Set<string>();
  const deps = new Map<string, string[]>();
  const traced = new Set<string>();
  let withoutIssue = 0;
  for (const t of tasks) {
    if (ids.has(t.id)) report.error(doc.file, `${t.id} is defined twice`, t.line);
    ids.add(t.id);
  }
  for (const t of tasks) {
    const { Milestone, Traces, Estimate, Issue } = t.fields;
    const dependsOn = t.fields["Depends on"];
    for (const name of ["Milestone", "Depends on", "Traces", "Estimate"] as const) {
      if (!t.fields[name]) report.error(doc.file, `${t.id} has no "- **${name}:**" line`, t.line);
    }
    if (Milestone && !milestones.has(Milestone))
      report.error(doc.file, `${t.id} names unknown milestone ${Milestone}`, t.line);
    const taskDeps =
      dependsOn && dependsOn.toLowerCase() !== "none" ? (dependsOn.match(TASK_REF) ?? []) : [];
    for (const dep of taskDeps) {
      if (!ids.has(dep)) report.error(doc.file, `${t.id} depends on unknown task ${dep}`, t.line);
    }
    deps.set(t.id, taskDeps);
    const refs = Traces?.match(REQUIREMENT_REF) ?? [];
    for (const ref of refs) {
      if (requirements.has(ref)) traced.add(ref);
      else
        report.error(
          doc.file,
          `${t.id} traces ${ref}, which ${ARCHITECTURE_FILE} does not define`,
          t.line,
        );
    }
    if (Traces && !refs.length && !Traces.includes(ARCHITECTURE_FILE)) {
      report.error(
        doc.file,
        `${t.id} traces neither a requirement nor an ${ARCHITECTURE_FILE} section`,
        t.line,
      );
    }
    if (Estimate) {
      const days = estimateDays(Estimate);
      if (days === undefined)
        report.error(doc.file, `${t.id} estimate "${Estimate}" must look like 4h or 2d`, t.line);
      else if (days > MAX_TASK_DAYS)
        report.warn(
          doc.file,
          `${t.id} is estimated at ${Estimate}; split tasks over ${MAX_TASK_DAYS}d`,
          t.line,
        );
    }
    if (!t.criteria)
      report.error(doc.file, `${t.id} has no acceptance criteria checkboxes`, t.line);
    if (!Issue) withoutIssue++;
    else if (!ISSUE.test(Issue))
      report.error(doc.file, `${t.id} issue "${Issue}" must be #123 or an issue URL`, t.line);
  }
  const cycle = findCycle(deps);
  if (cycle) report.error(doc.file, `dependency cycle: ${cycle.join(" → ")}`);
  for (const id of requirements) {
    if (!traced.has(id)) report.error(doc.file, `no task traces ${id}`);
  }
  if (withoutIssue) {
    report.warn(
      doc.file,
      `${withoutIssue} task(s) have no "- **Issue:**" link; sync TODO.md to GitHub issues`,
    );
  }
  return { tasks: tasks.length, epics, milestones: milestones.size };
}

/** Check a project's architecture document set: structure, diagrams, traceability and links. */
export function checkBlueprint(root: string): CheckResult {
  const report = new Report();
  const architecture = readDoc(root, ARCHITECTURE_FILE);
  const todo = readDoc(root, TODO_FILE);
  const runbook = readDoc(root, RUNBOOK_FILE);
  if (!architecture) report.error(ARCHITECTURE_FILE, "missing");
  if (!todo) report.error(TODO_FILE, "missing");
  if (!runbook) report.error(RUNBOOK_FILE, "missing");

  const adrs = checkAdrs(root, report);
  const diagrams = checkDiagramSpecs(root, report);
  let requirements = new Set<string>();
  if (architecture) {
    checkCommon(root, architecture, report);
    requirements = checkArchitecture(root, architecture, adrs, report);
  }
  let plan = { tasks: 0, epics: 0, milestones: 0 };
  if (todo) {
    checkCommon(root, todo, report);
    plan = checkTodo(todo, requirements, report);
  }
  if (runbook) {
    checkCommon(root, runbook, report);
    requiredSections(runbook, RUNBOOK_SECTIONS, report);
  }
  return {
    ok: report.errors.length === 0,
    errors: report.errors,
    warnings: report.warnings,
    stats: {
      requirements: requirements.size,
      ...plan,
      adrs: adrs.length,
      platformDiagrams: diagrams,
    },
  };
}
