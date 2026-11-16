/** A bibliographic record from a public index. Abstracts are truncated; full text is never stored. */
export interface Work {
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  doi?: string;
  arxiv?: string;
  openAlex?: string;
  url?: string;
  /** Open-access PDF the source API itself returned. */
  pdf?: string;
  abstract?: string;
  citations?: number;
}

export type IdKind = "doi" | "arxiv" | "openalex" | "s2";

export interface ParsedId {
  kind: IdKind;
  value: string;
}

const ARXIV_IN_TEXT =
  /(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:)((?:[a-z-]+(?:\.[a-z]{2})?\/\d{7})|\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?/i;
const ARXIV_BARE = /^((?:[a-z-]+(?:\.[a-z]{2})?\/\d{7})|\d{4}\.\d{4,5})(?:v\d+)?$/i;
const DOI_IN_TEXT = /10\.\d{4,9}\/[^\s?#]+/i;
const OPENALEX = /(?:openalex\.org\/)?(W\d{5,})\b/;
const S2 = /^[0-9a-f]{40}$/i;
const ABSTRACT_MAX = 800;
const STOP = new Set(["a", "an", "the", "of", "on", "for", "and", "in", "with", "to", "from"]);

export function clip(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > ABSTRACT_MAX ? `${flat.slice(0, ABSTRACT_MAX)}…` : flat;
}

/** Reconstruct an OpenAlex inverted abstract. Positions are word indexes. */
export function abstractFromIndex(
  index: Record<string, number[]> | null | undefined,
): string | undefined {
  if (!index) return undefined;
  const words: [number, string][] = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (Number.isInteger(position)) words.push([position, word]);
    }
  }
  words.sort((a, b) => a[0] - b[0]);
  return clip(words.map(([, word]) => word).join(" "));
}

export function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function normTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** DOI, arXiv id, OpenAlex id or Semantic Scholar paper id. URLs are accepted. */
export function parseId(raw: string): ParsedId | undefined {
  const text = raw.trim();
  const arxiv = text.match(ARXIV_IN_TEXT)?.[1] ?? text.match(ARXIV_BARE)?.[1];
  if (arxiv && (/arxiv/i.test(text) || ARXIV_BARE.test(text))) {
    return { kind: "arxiv", value: arxiv.toLowerCase() };
  }
  const openAlex = text.match(OPENALEX)?.[1];
  if (openAlex && (/openalex/i.test(text) || /^W\d{5,}$/.test(text))) {
    return { kind: "openalex", value: openAlex };
  }
  const doi = text.match(DOI_IN_TEXT)?.[0].replace(/[.,;)]+$/, "");
  if (doi) return { kind: "doi", value: doi.toLowerCase() };
  if (S2.test(text)) return { kind: "s2", value: text.toLowerCase() };
  return undefined;
}

/** First occurrence wins, so pass the richer index first. Match DOI, then arXiv id, then title. */
export function dedupe(works: Work[]): Work[] {
  const seen = new Set<string>();
  const out: Work[] = [];
  for (const work of works) {
    const keys = [
      work.doi ? `doi:${work.doi}` : undefined,
      work.arxiv ? `arxiv:${work.arxiv}` : undefined,
      `title:${normTitle(work.title)}`,
    ].filter((key) => key !== undefined);
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    out.push(work);
  }
  return out;
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/\s+/g, " ")
    .trim();
}

function xmlValues(block: string, name: string): string[] {
  const re = new RegExp(
    `<(?:[\\w]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w]+:)?${name}>`,
    "gi",
  );
  return [...block.matchAll(re)].map((match) => decodeXml(match[1] ?? "")).filter(Boolean);
}

/** Atom entries from the arXiv API. */
export function worksFromArxiv(xml: string): Work[] {
  const works: Work[] = [];
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const entry = match[1] ?? "";
    const title = xmlValues(entry, "title")[0];
    if (!title) continue;
    const id = xmlValues(entry, "id")[0] ?? "";
    const arxiv = id.match(ARXIV_IN_TEXT)?.[1]?.toLowerCase();
    const published = xmlValues(entry, "published")[0];
    const year = published ? Number(published.slice(0, 4)) : undefined;
    const doi = xmlValues(entry, "doi")[0]?.toLowerCase();
    const venue = xmlValues(entry, "journal_ref")[0];
    const url = arxiv ? `https://arxiv.org/abs/${arxiv}` : httpsUrl(id);
    const pdf = arxiv ? `https://arxiv.org/pdf/${arxiv}` : undefined;
    const abstract = clip(xmlValues(entry, "summary")[0]);
    works.push({
      title,
      authors: xmlValues(entry, "name").slice(0, 24),
      ...(year && Number.isInteger(year) ? { year } : {}),
      ...(venue ? { venue } : {}),
      ...(doi ? { doi } : {}),
      ...(arxiv ? { arxiv } : {}),
      ...(url ? { url } : {}),
      ...(pdf ? { pdf } : {}),
      ...(abstract ? { abstract } : {}),
    });
  }
  return works;
}

export function escapeBib(value: string): string {
  return value
    .replace(/[\\&%$#_]/g, (char) => `\\${char}`)
    .replace(/~/g, "\\~{}")
    .replace(/\^/g, "\\^{}")
    .replace(/[{}]/g, "");
}

function bibAuthor(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return escapeBib(name.trim());
  const family = parts.pop() ?? "";
  return `${escapeBib(family)}, ${escapeBib(parts.join(" "))}`;
}

export function citeKey(work: Work): string {
  const family = (work.authors[0] ?? "anon")
    .split(/\s+/)
    .pop()
    ?.toLowerCase()
    .replace(/[^a-z]/g, "");
  const word =
    normTitle(work.title)
      .split(" ")
      .find((token) => token.length > 3 && !STOP.has(token)) ?? "work";
  return `${family || "anon"}${work.year ?? ""}${word}`.slice(0, 48);
}

export function toBibtex(work: Work, key: string): string {
  const kind = work.venue || work.doi ? "article" : "misc";
  const authors = work.authors.slice(0, 12).map(bibAuthor);
  if (work.authors.length > 12) authors.push("others");
  const fields = [
    authors.length ? `  author = {${authors.join(" and ")}},` : undefined,
    `  title = {${escapeBib(work.title)}},`,
    work.year ? `  year = {${work.year}},` : undefined,
    work.venue ? `  journal = {${escapeBib(work.venue)}},` : undefined,
    work.doi ? `  doi = {${work.doi}},` : undefined,
    work.arxiv ? `  eprint = {${work.arxiv}},` : undefined,
    work.arxiv ? "  archiveprefix = {arXiv}," : undefined,
    work.url ? `  url = {${work.url}},` : undefined,
  ].filter((line) => line !== undefined);
  return `@${kind}{${key},\n${fields.join("\n")}\n}\n`;
}

export interface BibMerge {
  text: string;
  added: { key: string; doi?: string; arxiv?: string; title: string }[];
  skipped: { title: string; reason: string }[];
}

/** Append records whose cite key and DOI are not already in the file. */
export function mergeBib(existing: string, works: Work[]): BibMerge {
  const keys = new Set(
    [...existing.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((match) => match[1] ?? ""),
  );
  const dois = new Set(
    [...existing.matchAll(/doi\s*=\s*\{([^}]+)\}/gi)].map((match) =>
      (match[1] ?? "").trim().toLowerCase(),
    ),
  );
  const originalKeys = new Set(keys);
  const added: BibMerge["added"] = [];
  const skipped: BibMerge["skipped"] = [];
  const blocks: string[] = [];
  for (const work of works) {
    if (work.doi && dois.has(work.doi)) {
      skipped.push({ title: work.title, reason: `doi ${work.doi} is already in the file` });
      continue;
    }
    const base = citeKey(work);
    if (originalKeys.has(base)) {
      skipped.push({ title: work.title, reason: `cite key ${base} is already in the file` });
      continue;
    }
    let key = base;
    let n = 2;
    while (keys.has(key)) {
      key = `${base}${n}`;
      n += 1;
    }
    keys.add(key);
    if (work.doi) dois.add(work.doi);
    blocks.push(toBibtex(work, key));
    added.push({
      key,
      title: work.title,
      ...(work.doi ? { doi: work.doi } : {}),
      ...(work.arxiv ? { arxiv: work.arxiv } : {}),
    });
  }
  const prefix = existing.length === 0 ? "" : existing.endsWith("\n") ? existing : `${existing}\n`;
  const gap = prefix && blocks.length ? "\n" : "";
  return { text: `${prefix}${gap}${blocks.join("\n")}`, added, skipped };
}
