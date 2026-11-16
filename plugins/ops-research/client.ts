const TIMEOUT_MS = 20_000;
const USER_AGENT = "ops-research (https://github.com/mujakayadan/cursor-ops-plugins)";

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

export interface ResearchClient {
  json<T>(url: string, headers?: Record<string, string>): Promise<T | undefined>;
  text(url: string): Promise<string | undefined>;
}

function mailto(): string | undefined {
  const value = process.env.OPENALEX_MAILTO?.trim();
  return value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : undefined;
}

/** Optional higher Semantic Scholar quota. The key is never returned or logged. */
export function scholarHeaders(): Record<string, string> {
  const key = process.env.SEMANTIC_SCHOLAR_API_KEY?.trim();
  return key ? { "x-api-key": key } : {};
}

export function openAlexUrl(url: string): string {
  const email = mailto();
  if (!email) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("mailto", email);
  return parsed.toString();
}

async function read(url: string, headers?: Record<string, string>): Promise<Response | undefined> {
  const host = new URL(url).host;
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json", ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err: Error) => {
    throw new SourceError(`${host} unreachable: ${err.message}`);
  });
  if (res.status === 404) return undefined;
  if (res.status === 429) {
    const hint = host.includes("semanticscholar")
      ? " Set SEMANTIC_SCHOLAR_API_KEY for a higher quota."
      : "";
    throw new SourceError(`${host} rate-limited.${hint}`);
  }
  if (!res.ok) throw new SourceError(`${host} returned ${res.status}`);
  return res;
}

export function liveClient(): ResearchClient {
  return {
    async json<T>(url: string, headers?: Record<string, string>): Promise<T | undefined> {
      const res = await read(url, headers);
      if (!res) return undefined;
      return (await res.json()) as T;
    },
    async text(url: string): Promise<string | undefined> {
      const res = await read(url, { accept: "application/atom+xml" });
      if (!res) return undefined;
      return res.text();
    },
  };
}
