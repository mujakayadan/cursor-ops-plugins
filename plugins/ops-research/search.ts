import {
  liveClient,
  openAlexUrl,
  type ResearchClient,
  SourceError,
  scholarHeaders,
} from "./client.ts";
import { ToolError } from "./lib/core/schema-helpers.ts";
import {
  abstractFromIndex,
  clip,
  dedupe,
  httpsUrl,
  parseId,
  type Work,
  worksFromArxiv,
} from "./records.ts";

export const SOURCES = ["openalex", "arxiv", "semanticscholar"] as const;
export type Source = (typeof SOURCES)[number];

const SELECT = [
  "id",
  "display_name",
  "publication_year",
  "doi",
  "ids",
  "authorships",
  "primary_location",
  "open_access",
  "abstract_inverted_index",
  "cited_by_count",
].join(",");

const S2_FIELDS = [
  "title",
  "year",
  "authors",
  "externalIds",
  "abstract",
  "url",
  "openAccessPdf",
  "citationCount",
  "venue",
].join(",");

interface OpenAlexWork {
  id?: string;
  display_name?: string;
  publication_year?: number;
  doi?: string;
  ids?: { doi?: string; openalex?: string };
  authorships?: { author?: { display_name?: string } }[];
  primary_location?: { source?: { display_name?: string }; landing_page_url?: string };
  open_access?: { oa_url?: string };
  abstract_inverted_index?: Record<string, number[]> | null;
  cited_by_count?: number;
}

interface S2Paper {
  paperId?: string;
  title?: string;
  year?: number;
  authors?: { name?: string }[];
  externalIds?: { DOI?: string; ArXiv?: string };
  abstract?: string;
  url?: string;
  openAccessPdf?: { url?: string } | null;
  citationCount?: number;
  venue?: string;
}

function yearOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1000 ? value : undefined;
}

function doiOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value
    .match(/10\.\d{4,9}\/[^\s?#]+/i)?.[0]
    .replace(/[.,;)]+$/, "")
    .toLowerCase();
}

function openAlexId(value: string | undefined): string | undefined {
  return value?.match(/W\d{5,}/)?.[0];
}

function pageUrl(direct: unknown, doi: string | undefined): string | undefined {
  return httpsUrl(direct) ?? (doi ? `https://doi.org/${doi}` : undefined);
}

function fromOpenAlex(row: OpenAlexWork): Work | undefined {
  const title = row.display_name?.trim();
  if (!title) return undefined;
  const doi = doiOf(row.doi) ?? doiOf(row.ids?.doi);
  const openAlex = openAlexId(row.id) ?? openAlexId(row.ids?.openalex);
  const year = yearOf(row.publication_year);
  const pdf = httpsUrl(row.open_access?.oa_url);
  const url = pageUrl(row.primary_location?.landing_page_url, doi);
  const abstract = abstractFromIndex(row.abstract_inverted_index);
  return {
    title,
    authors: (row.authorships ?? [])
      .map((item) => item.author?.display_name?.trim())
      .filter((name) => name !== undefined)
      .slice(0, 24),
    ...(year ? { year } : {}),
    ...(row.primary_location?.source?.display_name
      ? { venue: row.primary_location.source.display_name }
      : {}),
    ...(doi ? { doi } : {}),
    ...(openAlex ? { openAlex } : {}),
    ...(url ? { url } : {}),
    ...(pdf ? { pdf } : {}),
    ...(abstract ? { abstract } : {}),
    ...(typeof row.cited_by_count === "number" ? { citations: row.cited_by_count } : {}),
  };
}

function fromS2(row: S2Paper): Work | undefined {
  const title = row.title?.trim();
  if (!title) return undefined;
  const doi = doiOf(row.externalIds?.DOI);
  const arxiv = row.externalIds?.ArXiv?.replace(/v\d+$/i, "").toLowerCase();
  const year = yearOf(row.year);
  const pdf = httpsUrl(row.openAccessPdf?.url);
  const url = pageUrl(row.url, doi);
  const abstract = clip(row.abstract);
  return {
    title,
    authors: (row.authors ?? [])
      .map((author) => author.name?.trim())
      .filter((name) => name !== undefined)
      .slice(0, 24),
    ...(year ? { year } : {}),
    ...(row.venue ? { venue: row.venue } : {}),
    ...(doi ? { doi } : {}),
    ...(arxiv ? { arxiv } : {}),
    ...(url ? { url } : {}),
    ...(pdf ? { pdf } : {}),
    ...(abstract ? { abstract } : {}),
    ...(typeof row.citationCount === "number" ? { citations: row.citationCount } : {}),
  };
}

function since(works: Work[], yearFrom: number | undefined): Work[] {
  if (yearFrom === undefined) return works;
  return works.filter((work) => work.year !== undefined && work.year >= yearFrom);
}

async function openAlexList(client: ResearchClient, url: string): Promise<Work[]> {
  const page = await client.json<{ results?: OpenAlexWork[] }>(openAlexUrl(url));
  return (page?.results ?? []).flatMap((row) => {
    const work = fromOpenAlex(row);
    return work ? [work] : [];
  });
}

async function searchOpenAlex(
  client: ResearchClient,
  query: string,
  limit: number,
  yearFrom: number | undefined,
): Promise<Work[]> {
  const params = new URLSearchParams({
    search: query,
    "per-page": String(limit),
    select: SELECT,
  });
  if (yearFrom !== undefined) params.set("filter", `publication_year:>${yearFrom - 1}`);
  return openAlexList(client, `https://api.openalex.org/works?${params}`);
}

async function searchArxiv(
  client: ResearchClient,
  query: string,
  limit: number,
  yearFrom: number | undefined,
): Promise<Work[]> {
  const params = new URLSearchParams({
    search_query: `all:"${query.replace(/["\\]/g, " ")}"`,
    start: "0",
    max_results: String(limit),
  });
  const xml = await client.text(`https://export.arxiv.org/api/query?${params}`);
  return since(xml ? worksFromArxiv(xml) : [], yearFrom);
}

async function searchScholar(
  client: ResearchClient,
  query: string,
  limit: number,
  yearFrom: number | undefined,
): Promise<Work[]> {
  const params = new URLSearchParams({ query, limit: String(limit), fields: S2_FIELDS });
  if (yearFrom !== undefined) params.set("year", `${yearFrom}-`);
  const page = await client.json<{ data?: S2Paper[] }>(
    `https://api.semanticscholar.org/graph/v1/paper/search?${params}`,
    scholarHeaders(),
  );
  return (page?.data ?? []).flatMap((row) => {
    const work = fromS2(row);
    return work ? [work] : [];
  });
}

async function oneSource(
  client: ResearchClient,
  source: Source,
  query: string,
  limit: number,
  yearFrom: number | undefined,
): Promise<Work[]> {
  switch (source) {
    case "openalex":
      return searchOpenAlex(client, query, limit, yearFrom);
    case "arxiv":
      return searchArxiv(client, query, limit, yearFrom);
    case "semanticscholar":
      return searchScholar(client, query, limit, yearFrom);
    default: {
      const never: never = source;
      throw new ToolError(String(never));
    }
  }
}

export interface SearchResult {
  works: Work[];
  warnings: string[];
}

export async function searchWorks(
  query: string,
  sources: Source[],
  limit: number,
  yearFrom: number | undefined,
  client: ResearchClient = liveClient(),
): Promise<SearchResult> {
  const settled = await Promise.all(
    sources.map(async (source) => {
      try {
        return { source, works: await oneSource(client, source, query, limit, yearFrom) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { source, works: [] as Work[], warning: `${source}: ${message}` };
      }
    }),
  );
  const warnings = settled.flatMap((item) => (item.warning ? [item.warning] : []));
  const works = dedupe(settled.flatMap((item) => item.works)).slice(0, limit);
  if (works.length === 0 && warnings.length === sources.length) {
    throw new ToolError(warnings.join(" "));
  }
  return { works, warnings };
}

async function firstWork(attempts: (() => Promise<Work | undefined>)[]): Promise<Work | undefined> {
  const errors: SourceError[] = [];
  for (const attempt of attempts) {
    try {
      const work = await attempt();
      if (work) return work;
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      errors.push(err);
    }
  }
  if (errors.length > 0) throw errors[0];
  return undefined;
}

async function fromOpenAlexId(client: ResearchClient, path: string): Promise<Work | undefined> {
  const row = await client.json<OpenAlexWork>(
    openAlexUrl(`https://api.openalex.org/works/${path}`),
  );
  return row ? fromOpenAlex(row) : undefined;
}

async function fromArxivId(client: ResearchClient, id: string): Promise<Work | undefined> {
  const xml = await client.text(
    `https://export.arxiv.org/api/query?${new URLSearchParams({ id_list: id })}`,
  );
  return xml ? worksFromArxiv(xml)[0] : undefined;
}

async function fromScholarId(client: ResearchClient, id: string): Promise<Work | undefined> {
  const row = await client.json<S2Paper>(
    `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}?fields=${S2_FIELDS}`,
    scholarHeaders(),
  );
  return row ? fromS2(row) : undefined;
}

export async function getWork(rawId: string, client: ResearchClient = liveClient()): Promise<Work> {
  const parsed = parseId(rawId);
  if (!parsed)
    throw new ToolError("id must be a DOI, arXiv id, OpenAlex id or Semantic Scholar id");
  try {
    const work = await (async () => {
      switch (parsed.kind) {
        case "doi":
          return firstWork([
            () => fromOpenAlexId(client, `doi:${parsed.value}`),
            () => fromScholarId(client, `DOI:${parsed.value}`),
          ]);
        case "arxiv":
          return firstWork([
            () => fromArxivId(client, parsed.value),
            () => fromScholarId(client, `ARXIV:${parsed.value}`),
          ]);
        case "openalex":
          return fromOpenAlexId(client, parsed.value);
        case "s2":
          return fromScholarId(client, parsed.value);
        default: {
          const never: never = parsed.kind;
          throw new ToolError(String(never));
        }
      }
    })();
    if (!work) throw new ToolError(`no record for ${rawId}`);
    return work;
  } catch (err) {
    if (err instanceof ToolError) throw err;
    if (err instanceof SourceError) throw new ToolError(err.message);
    throw err;
  }
}

export interface Related {
  references: Work[];
  citations: Work[];
}

async function scholarHop(
  client: ResearchClient,
  paperId: string,
  edge: "references" | "citations",
  limit: number,
): Promise<Work[]> {
  const nested = edge === "references" ? "citedPaper" : "citingPaper";
  const fields = S2_FIELDS.split(",")
    .map((field) => `${nested}.${field}`)
    .join(",");
  const page = await client.json<{ data?: { citedPaper?: S2Paper; citingPaper?: S2Paper }[] }>(
    `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(paperId)}/${edge}?limit=${limit}&fields=${fields}`,
    scholarHeaders(),
  );
  return (page?.data ?? []).flatMap((row) => {
    const paper = edge === "references" ? row.citedPaper : row.citingPaper;
    const work = paper ? fromS2(paper) : undefined;
    return work ? [work] : [];
  });
}

export type Direction = "references" | "citations" | "both";

export async function relatedWorks(
  rawId: string,
  limit: number,
  direction: Direction = "both",
  client: ResearchClient = liveClient(),
): Promise<Related> {
  const work = await getWork(rawId, client);
  const wantRefs = direction !== "citations";
  const wantCites = direction !== "references";
  if (work.openAlex) {
    const params = (filter: string) =>
      new URLSearchParams({
        filter,
        "per-page": String(limit),
        sort: "cited_by_count:desc",
        select: SELECT,
      });
    const [references, citations] = await Promise.all([
      wantRefs
        ? openAlexList(
            client,
            `https://api.openalex.org/works?${params(`cited_by:${work.openAlex}`)}`,
          )
        : [],
      wantCites
        ? openAlexList(client, `https://api.openalex.org/works?${params(`cites:${work.openAlex}`)}`)
        : [],
    ]);
    return { references: references.slice(0, limit), citations: citations.slice(0, limit) };
  }
  const paperId = work.doi ? `DOI:${work.doi}` : work.arxiv ? `ARXIV:${work.arxiv}` : undefined;
  if (!paperId) throw new ToolError(`${rawId} has no DOI, arXiv id or OpenAlex id to follow`);
  const [references, citations] = await Promise.all([
    wantRefs ? scholarHop(client, paperId, "references", limit) : [],
    wantCites ? scholarHop(client, paperId, "citations", limit) : [],
  ]);
  return { references, citations };
}
