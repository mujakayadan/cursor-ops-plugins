import { ToolError } from "./lib/core/schema-helpers.ts";
import {
  type Advisory,
  GRAPH_SYSTEMS,
  getAdvisory,
  getDependencies,
  getPackage,
  getProject,
  getProjectPackages,
  getScorecard,
  getVersion,
  osvBatch,
  type ProjectInfo,
  type ScorecardCheck,
  type System,
} from "./sources.ts";

export const LICENSE_CLASSES = [
  "permissive",
  "weak-copyleft",
  "strong-copyleft",
  "restrictive",
  "unknown",
] as const;
export type LicenseClass = (typeof LICENSE_CLASSES)[number];

const PERMISSIVE =
  /^(?:MIT|MIT-0|Apache-2\.0|BSD-[234]-Clause(?:-Clear)?|0BSD|ISC|Unlicense|Zlib|BSL-1\.0|CC0-1\.0|PSF-2\.0|Python-2\.0|BlueOak-1\.0\.0|UPL-1\.0|X11)$/;
const WEAK_COPYLEFT =
  /^(?:MPL-2\.0|LGPL-[23]\.[01](?:-only|-or-later)?|EPL-[12]\.0|CDDL-1\.[01]|EUPL-1\.2)$/;
const STRONG_COPYLEFT = /^(?:A?GPL-[23]\.0(?:-only|-or-later)?|OSL-3\.0)$/;
const RESTRICTIVE = /^(?:BUSL-1\.1|SSPL-1\.0|Elastic-2\.0|Commons-Clause|CC-BY-NC.*|PolyForm.*)$/;

const STALE_DAYS = 365;
const MIN_SCORECARD = 5;
const MAX_ADVISORY_DETAILS = 10;
const MAX_GRAPH_NODES = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function classifyId(id: string): LicenseClass {
  if (PERMISSIVE.test(id)) return "permissive";
  if (WEAK_COPYLEFT.test(id)) return "weak-copyleft";
  if (STRONG_COPYLEFT.test(id)) return "strong-copyleft";
  if (RESTRICTIVE.test(id)) return "restrictive";
  return "unknown";
}

const rank = (c: LicenseClass) => LICENSE_CLASSES.indexOf(c);

/** The most permissive reading of an SPDX expression: the best `OR` branch of its worst `AND` terms. */
export function classifyLicense(expressions: string[]): LicenseClass {
  if (!expressions.length) return "unknown";
  return expressions
    .map((expr) =>
      expr
        .replace(/[()]/g, " ")
        .split(/\s+OR\s+/i)
        .map((branch) =>
          branch
            .split(/\s+AND\s+/i)
            .map((term) => classifyId(term.trim().replace(/\s+WITH\s+.*$/i, "")))
            .reduce((worst, c) => (rank(c) > rank(worst) ? c : worst), "permissive"),
        )
        .reduce((best, c) => (rank(c) < rank(best) ? c : best), "unknown"),
    )
    .reduce((worst, c) => (rank(c) > rank(worst) ? c : worst), "permissive");
}

const daysSince = (iso: string | undefined) =>
  iso ? Math.floor((Date.now() - Date.parse(iso)) / DAY_MS) : undefined;

function scorecardSummary(
  project: ProjectInfo | undefined,
  published: Awaited<ReturnType<typeof getScorecard>>,
) {
  const card = project?.scorecard
    ? {
        score: project.scorecard.overallScore,
        date: project.scorecard.date,
        checks: project.scorecard.checks,
      }
    : published
      ? { score: published.score, date: published.date, checks: published.checks }
      : undefined;
  if (!card) return undefined;
  return {
    score: card.score,
    date: card.date.slice(0, 10),
    checks: Object.fromEntries(card.checks.map((c: ScorecardCheck) => [c.name, c.score])),
  };
}

function projectFlags(scorecard: ReturnType<typeof scorecardSummary>): string[] {
  if (!scorecard)
    return ["no published OpenSSF Scorecard; review the repository's practices by hand"];
  const flags: string[] = [];
  if (scorecard.score < MIN_SCORECARD) flags.push(`OpenSSF Scorecard ${scorecard.score}/10`);
  for (const check of ["Maintained", "Code-Review", "Vulnerabilities", "Dangerous-Workflow"]) {
    const score = scorecard.checks[check];
    if (score !== undefined && score >= 0 && score < MIN_SCORECARD)
      flags.push(`Scorecard ${check} ${score}/10`);
  }
  return flags;
}

async function projectDetails(id: string) {
  const project = await getProject(id);
  const published = project?.scorecard ? undefined : await getScorecard(id);
  const scorecard = scorecardSummary(project, published);
  return {
    summary: {
      id,
      ...(project
        ? {
            stars: project.starsCount,
            forks: project.forksCount,
            openIssues: project.openIssuesCount,
            license: project.license,
            description: project.description,
          }
        : {}),
      ...(scorecard ? { scorecard } : {}),
      ...(project?.ossFuzz ? { ossFuzz: true } : {}),
    },
    flags: projectFlags(scorecard),
    checks: project?.scorecard?.checks ?? published?.checks ?? [],
  };
}

async function advisoryDetails(ids: string[]) {
  const details = await Promise.all(
    ids.slice(0, MAX_ADVISORY_DETAILS).map((id) => getAdvisory(id)),
  );
  return ids.map((id, i) => {
    const a: Advisory | undefined = details[i];
    return {
      id,
      ...(a?.title ? { title: a.title } : {}),
      ...(a?.cvss3Score !== undefined ? { cvss3: a.cvss3Score } : {}),
      ...(a?.aliases?.length ? { aliases: a.aliases } : {}),
    };
  });
}

async function dependencyRisk(system: System, name: string, version: string) {
  if (!GRAPH_SYSTEMS.includes(system)) return { available: false as const };
  const graph = await getDependencies(system, name, version);
  if (!graph) return { available: false as const };
  const nodes = graph.nodes.filter((n) => n.relation !== "SELF").slice(0, MAX_GRAPH_NODES);
  const vulns = await osvBatch(
    nodes.map((n) => ({ system, name: n.versionKey.name, version: n.versionKey.version })),
  );
  const vulnerable = nodes
    .map((n, i) => ({
      name: n.versionKey.name,
      version: n.versionKey.version,
      advisories: vulns[i] ?? [],
    }))
    .filter((n) => n.advisories.length);
  return {
    available: true as const,
    direct: nodes.filter((n) => n.relation === "DIRECT").length,
    indirect: nodes.filter((n) => n.relation === "INDIRECT").length,
    vulnerable,
    ...(graph.error ? { error: graph.error } : {}),
  };
}

export async function vetPackage(
  system: System,
  name: string,
  requested?: string,
  withDependencies = true,
) {
  const pkg = await getPackage(system, name);
  if (!pkg) throw new ToolError(`${system} package ${name} is not known to deps.dev`);
  const versions = [...pkg.versions].sort(
    (a, b) => Date.parse(b.publishedAt ?? "0") - Date.parse(a.publishedAt ?? "0"),
  );
  const fallback = pkg.versions.find((v) => v.isDefault) ?? versions[0];
  const version = requested ?? fallback?.versionKey.version;
  if (!version) throw new ToolError(`${system} package ${name} has no versions`);
  const info = await getVersion(system, pkg.packageKey.name, version);
  if (!info) throw new ToolError(`${system} package ${name} has no version ${version}`);

  const repo = info.relatedProjects?.find((p) => p.relationType === "SOURCE_REPO")?.projectKey.id;
  const [project, advisories, dependencies] = await Promise.all([
    repo ? projectDetails(repo) : undefined,
    advisoryDetails((info.advisoryKeys ?? []).map((a) => a.id)),
    withDependencies ? dependencyRisk(system, pkg.packageKey.name, version) : undefined,
  ]);

  const licenses = info.licenses ?? [];
  const license = classifyLicense(licenses);
  const latest = versions[0];
  const sinceLatest = daysSince(latest?.publishedAt);
  const releasesLastYear = versions.filter(
    (v) => (daysSince(v.publishedAt) ?? Infinity) <= STALE_DAYS,
  ).length;
  const verified = (info.attestations ?? []).some((a) => a.verified);

  const flags = [
    ...(license === "unknown"
      ? [`license not recognized (${licenses.join(", ") || "none declared"}); needs legal review`]
      : []),
    ...(license === "strong-copyleft" || license === "restrictive"
      ? [`${license} license ${licenses.join(", ")}`]
      : []),
    ...(info.isDeprecated
      ? [`version deprecated${info.deprecatedReason ? `: ${info.deprecatedReason}` : ""}`]
      : []),
    ...(info.projectStatus?.status && info.projectStatus.status !== "active"
      ? [`project status ${info.projectStatus.status}`]
      : []),
    ...(sinceLatest !== undefined && sinceLatest > STALE_DAYS
      ? [`no release in ${sinceLatest} days`]
      : []),
    ...(advisories.length ? [`${advisories.length} advisory(ies) affect ${version}`] : []),
    ...(dependencies?.available && dependencies.vulnerable.length
      ? [`${dependencies.vulnerable.length} dependency version(s) with known advisories`]
      : []),
    ...(repo ? (project?.flags ?? []) : ["no linked source repository"]),
  ];

  return {
    package: { system, name: pkg.packageKey.name },
    version,
    ...(info.publishedAt ? { publishedAt: info.publishedAt.slice(0, 10) } : {}),
    latest: latest
      ? { version: latest.versionKey.version, publishedAt: latest.publishedAt?.slice(0, 10) }
      : null,
    versions: pkg.versions.length,
    releasesLastYear,
    license: { spdx: licenses, class: license },
    provenance: verified
      ? "verified attestation"
      : info.attestations?.length
        ? "unverified attestation"
        : "none",
    advisories,
    ...(project ? { project: project.summary } : {}),
    ...(dependencies ? { dependencies } : {}),
    flags,
  };
}

export async function vetProject(id: string) {
  const [{ summary, flags, checks }, packages] = await Promise.all([
    projectDetails(id),
    getProjectPackages(id),
  ]);
  const names = [
    ...new Set(
      (packages?.versions ?? []).map(
        (v) => `${v.versionKey.system.toLowerCase()}:${v.versionKey.name}`,
      ),
    ),
  ];
  return {
    project: summary,
    scorecardChecks: checks.map((c) => ({
      name: c.name,
      score: c.score,
      ...(c.reason ? { reason: c.reason } : {}),
    })),
    packages: names.slice(0, 20),
    flags: [...(summary.license ? [] : ["no license reported by the host"]), ...flags],
  };
}
