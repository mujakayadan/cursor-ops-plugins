import { ToolError } from "./lib/core/schema-helpers.ts";

const DEFAULT_API = "https://api.yarba.app";
const CONTENT_PATH = "/api/v1/public/portfolio/content";
const TOKEN_HEADER = "X-Portfolio-Site-Token";
const TIMEOUT_MS = 15_000;

const SHORT = 200;
const BULLET = 500;
const STORY = 4_000;
const LIST = 40;
const BULLETS = 40;

export interface PortfolioStatus {
  ready: boolean;
  host: string | null;
}

export interface PortfolioContent {
  personal: {
    fullName: string | null;
    email: string | null;
    phone: string | null;
    linkedin: string | null;
    github: string | null;
    website: string | null;
  };
  careerSummary: {
    jobTitles: string[];
    defaultJobTitle: string;
    defaultSummary: string;
    yearsOfExperience: string;
  };
  lifeStory: string | null;
  workExperience: {
    jobTitle: string;
    company: string;
    location: string;
    time: string;
    responsibilities: string[];
  }[];
  education: {
    degreeType: string;
    degree: string;
    universityName: string;
    time: string;
    location: string;
  }[];
  skills: { category: string; skills: string[] }[];
  projects: { name: string; bulletPoints: string[]; date: string; link: string | null }[];
  awards: { name: string; explanation: string }[];
  publications: { name: string; publisher: string; link: string; time: string }[];
  truncated: boolean;
}

interface Endpoint {
  url: string;
  token: string;
  host: string;
}

function clip(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  let clean = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    const keep = code === 9 || code === 10 || code === 13;
    clean += (code < 32 && !keep) || code === 127 ? " " : char;
  }
  clean = clean.trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function optional(value: unknown, max: number): string | null {
  const text = clip(value, max);
  return text.length > 0 ? text : null;
}

function texts(
  value: unknown,
  maxItems: number,
  maxLen: number,
  truncated: { value: boolean },
): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > maxItems) truncated.value = true;
  return value.slice(0, maxItems).map((item) => clip(item, maxLen));
}

function rows<T>(
  value: unknown,
  maxItems: number,
  map: (item: Record<string, unknown>, truncated: { value: boolean }) => T,
  truncated: { value: boolean },
): T[] {
  if (!Array.isArray(value)) return [];
  if (value.length > maxItems) truncated.value = true;
  return value.slice(0, maxItems).map((item) => {
    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return map(record, truncated);
  });
}

/** The published portfolio. Unknown fields are dropped. The token is never read from the body. */
export function parsePortfolio(body: unknown): PortfolioContent {
  if (!body || typeof body !== "object")
    throw new ToolError("portfolio response was not an object");
  const root = body as Record<string, unknown>;
  const personal =
    root.personal && typeof root.personal === "object"
      ? (root.personal as Record<string, unknown>)
      : {};
  const summary =
    root.career_summary && typeof root.career_summary === "object"
      ? (root.career_summary as Record<string, unknown>)
      : {};
  const truncated = { value: false };
  const jobTitles = texts(summary.job_titles, LIST, SHORT, truncated);
  return {
    personal: {
      fullName: optional(personal.full_name, SHORT),
      email: optional(personal.email, SHORT),
      phone: optional(personal.phone, SHORT),
      linkedin: optional(personal.linkedin, SHORT),
      github: optional(personal.github, SHORT),
      website: optional(personal.website, SHORT),
    },
    careerSummary: {
      jobTitles,
      defaultJobTitle: clip(summary.default_job_title, SHORT),
      defaultSummary: clip(summary.default_summary, STORY),
      yearsOfExperience: clip(summary.years_of_experience, SHORT),
    },
    lifeStory: optional(root.life_story, STORY),
    workExperience: rows(
      root.work_experience,
      LIST,
      (item, flag) => ({
        jobTitle: clip(item.job_title, SHORT),
        company: clip(item.company, SHORT),
        location: clip(item.location, SHORT),
        time: clip(item.time, SHORT),
        responsibilities: texts(item.responsibilities, BULLETS, BULLET, flag),
      }),
      truncated,
    ),
    education: rows(
      root.education,
      LIST,
      (item) => ({
        degreeType: clip(item.degree_type, SHORT),
        degree: clip(item.degree, SHORT),
        universityName: clip(item.university_name, SHORT),
        time: clip(item.time, SHORT),
        location: clip(item.location, SHORT),
      }),
      truncated,
    ),
    skills: rows(
      root.skills,
      LIST,
      (item, flag) => ({
        category: clip(item.category, SHORT),
        skills: texts(item.skills, LIST, SHORT, flag),
      }),
      truncated,
    ),
    projects: rows(
      root.projects,
      LIST,
      (item, flag) => ({
        name: clip(item.name, SHORT),
        bulletPoints: texts(item.bullet_points, BULLETS, BULLET, flag),
        date: clip(item.date, SHORT),
        link: optional(item.link, SHORT),
      }),
      truncated,
    ),
    awards: rows(
      root.awards,
      LIST,
      (item) => ({
        name: clip(item.name, SHORT),
        explanation: clip(item.explanation, BULLET),
      }),
      truncated,
    ),
    publications: rows(
      root.publications,
      LIST,
      (item) => ({
        name: clip(item.name, SHORT),
        publisher: clip(item.publisher, SHORT),
        link: clip(item.link, SHORT),
        time: clip(item.time, SHORT),
      }),
      truncated,
    ),
    truncated: truncated.value,
  };
}

export function portfolioEndpoint(env: NodeJS.ProcessEnv = process.env): Endpoint | null {
  const token = env.YARBA_PORTFOLIO_TOKEN?.trim() ?? "";
  if (!token) return null;
  let url: URL;
  try {
    url = new URL(env.YARBA_API_URL?.trim() || DEFAULT_API);
  } catch {
    throw new ToolError("YARBA_API_URL is not a URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && local))
  ) {
    throw new ToolError("YARBA_API_URL must be https, or http on localhost");
  }
  const path = url.pathname.replace(/\/$/, "");
  url.pathname = path.endsWith(CONTENT_PATH) ? path : `${path}${CONTENT_PATH}`;
  url.search = "";
  url.hash = "";
  return { url: url.toString(), token, host: url.host };
}

export function portfolioStatus(env: NodeJS.ProcessEnv = process.env): PortfolioStatus {
  const endpoint = portfolioEndpoint(env);
  return endpoint ? { ready: true, host: endpoint.host } : { ready: false, host: null };
}

export async function fetchPortfolio(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<PortfolioContent> {
  const endpoint = portfolioEndpoint(env);
  if (!endpoint) {
    throw new ToolError(
      "Set YARBA_PORTFOLIO_TOKEN to the portfolio site token. This plugin does not use an agent access token.",
    );
  }
  let res: Response;
  try {
    res = await fetchImpl(endpoint.url, {
      headers: { [TOKEN_HEADER]: endpoint.token, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ToolError(`${endpoint.host} unreachable`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ToolError(`${endpoint.host} rejected the portfolio site token`);
  }
  if (!res.ok) throw new ToolError(`${endpoint.host} returned ${res.status}`);
  return parsePortfolio(await res.json());
}
