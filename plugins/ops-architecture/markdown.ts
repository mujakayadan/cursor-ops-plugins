import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ToolError } from "./lib/core/schema-helpers.ts";

const MAX_DOC_BYTES = 2000000;

export interface Section {
  title: string;
  line: number;
  lines: string[];
}

export interface Doc {
  file: string;
  lines: string[];
  /** Line numbers (1-based) that sit inside fenced code blocks. */
  fenced: Set<number>;
}

export function readDoc(root: string, file: string): Doc | undefined {
  const path = join(root, file);
  if (!existsSync(path)) return undefined;
  if (statSync(path).size > MAX_DOC_BYTES)
    throw new ToolError(`${file} is larger than ${MAX_DOC_BYTES / 1000000} MB`);
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

/** A heading without its section number, such as `Deployment` for `6. Deployment`. */
export const headingTitle = (text: string) => text.replace(/^\d+(?:\.\d+)*\.?\s+/, "").trim();

/** H2 sections outside code fences. */
export function sections(doc: Doc): Section[] {
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
export function mermaidTypes(lines: string[]): string[] {
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
