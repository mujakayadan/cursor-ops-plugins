import { ToolError } from "./lib/core/schema-helpers.ts";

/** Package systems deps.dev covers, with their OSV ecosystem names. */
export const SYSTEMS = {
  npm: "npm",
  pypi: "PyPI",
  maven: "Maven",
  cargo: "crates.io",
  go: "Go",
  nuget: "NuGet",
  rubygems: "RubyGems",
} as const;
export type System = keyof typeof SYSTEMS;
/** deps.dev resolves dependency graphs only for these. */
export const GRAPH_SYSTEMS: readonly System[] = ["npm", "pypi", "maven", "cargo"];

const DEPS_DEV = "https://api.deps.dev/v3";
const OSV = "https://api.osv.dev/v1";
const SCORECARD = "https://api.scorecard.dev";
const TIMEOUT_MS = 20000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE = 500;

const cache = new Map<string, { at: number; value: Promise<unknown> }>();

async function request<T>(url: string, init?: RequestInit): Promise<T | undefined> {
  const res = await fetch(url, {
    ...init,
    headers: { accept: "application/json", "content-type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err: Error) => {
    throw new ToolError(`${new URL(url).host} unreachable: ${err.message}`);
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new ToolError(`${new URL(url).host} returned ${res.status}`);
  return (await res.json()) as T;
}

/** GETs are cached for an hour, since the read server is long-lived and the data changes slowly. */
function get<T>(url: string): Promise<T | undefined> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as Promise<T | undefined>;
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value ?? "");
  const value = request<T>(url);
  cache.set(url, { at: Date.now(), value });
  value.catch(() => cache.delete(url));
  return value;
}

const enc = encodeURIComponent;

export interface VersionKey {
  system: string;
  name: string;
  version: string;
}

export interface PackageInfo {
  packageKey: { system: string; name: string };
  versions: {
    versionKey: VersionKey;
    publishedAt?: string;
    isDefault?: boolean;
    isDeprecated?: boolean;
  }[];
}

export interface VersionInfo {
  versionKey: VersionKey;
  publishedAt?: string;
  isDeprecated?: boolean;
  deprecatedReason?: string;
  licenses?: string[];
  advisoryKeys?: { id: string }[];
  links?: { label: string; url: string }[];
  attestations?: { type: string; verified?: boolean; sourceRepository?: string }[];
  relatedProjects?: {
    projectKey: { id: string };
    relationType: string;
    relationProvenance: string;
  }[];
  projectStatus?: { status?: string; reason?: string };
}

export interface DependencyGraph {
  nodes: { versionKey: VersionKey; relation: "SELF" | "DIRECT" | "INDIRECT"; errors?: string[] }[];
  error?: string;
}

export interface ScorecardCheck {
  name: string;
  score: number;
  reason?: string;
}

export interface ProjectInfo {
  projectKey: { id: string };
  openIssuesCount?: number;
  starsCount?: number;
  forksCount?: number;
  license?: string;
  description?: string;
  homepage?: string;
  scorecard?: { date: string; overallScore: number; checks: ScorecardCheck[] };
  ossFuzz?: { lineCount: number; lineCoverCount: number; date: string };
}

export interface Advisory {
  advisoryKey: { id: string };
  url?: string;
  title?: string;
  aliases?: string[];
  cvss3Score?: number;
}

export const getPackage = (system: System, name: string) =>
  get<PackageInfo>(`${DEPS_DEV}/systems/${system}/packages/${enc(name)}`);

export const getVersion = (system: System, name: string, version: string) =>
  get<VersionInfo>(`${DEPS_DEV}/systems/${system}/packages/${enc(name)}/versions/${enc(version)}`);

export const getDependencies = (system: System, name: string, version: string) =>
  get<DependencyGraph>(
    `${DEPS_DEV}/systems/${system}/packages/${enc(name)}/versions/${enc(version)}:dependencies`,
  );

export const getAdvisory = (id: string) => get<Advisory>(`${DEPS_DEV}/advisories/${enc(id)}`);

export const getProject = (id: string) => get<ProjectInfo>(`${DEPS_DEV}/projects/${enc(id)}`);

export const getProjectPackages = (id: string) =>
  get<{ versions: { versionKey: VersionKey }[] }>(
    `${DEPS_DEV}/projects/${enc(id)}:packageversions`,
  );

interface ScorecardResult {
  date: string;
  score: number;
  checks: ScorecardCheck[];
}

/** The published OpenSSF Scorecard, for projects deps.dev has no scorecard for. */
export const getScorecard = (id: string) =>
  get<ScorecardResult>(`${SCORECARD}/projects/${id.split("/").map(enc).join("/")}`);

/** OSV advisory IDs affecting each package version, in input order. */
export async function osvBatch(
  queries: { system: System; name: string; version: string }[],
): Promise<string[][]> {
  if (!queries.length) return [];
  const res = await request<{ results: { vulns?: { id: string }[] }[] }>(`${OSV}/querybatch`, {
    method: "POST",
    body: JSON.stringify({
      queries: queries.map((q) => ({
        package: { name: q.name, ecosystem: SYSTEMS[q.system] },
        version: q.version,
      })),
    }),
  });
  return queries.map((_, i) => (res?.results[i]?.vulns ?? []).map((v) => v.id));
}
