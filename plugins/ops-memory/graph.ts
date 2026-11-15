import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { opsHome } from "./lib/core/config.ts";
import { ToolError } from "./lib/core/schema-helpers.ts";

export const MAX_OBSERVATIONS = 100;
export const MAX_ENTITIES = 10000;
const LOCK_WAIT_MS = 3000;
const STALE_LOCK_MS = 15000;

export interface Observation {
  text: string;
  /** Day the observation was recorded (YYYY-MM-DD), so readers can judge freshness. */
  at: string;
}

export interface Entity {
  name: string;
  type: string;
  scope: string;
  observations: Observation[];
}

export interface Relation {
  from: string;
  to: string;
  type: string;
}

export interface Graph {
  entities: Entity[];
  relations: Relation[];
}

export function memoryPath(): string {
  return process.env.OPS_MEMORY_FILE || join(opsHome(), "memory", "graph.json");
}

const key = (name: string) => name.trim().toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);
const sameRelation = (a: Relation, b: Relation) =>
  key(a.from) === key(b.from) && key(a.to) === key(b.to) && a.type === b.type;

let cache: { path: string; mtimeMs: number; size: number; graph: Graph } | undefined;

export function loadGraph(): Graph {
  const path = memoryPath();
  if (!existsSync(path)) return { entities: [], relations: [] };
  const { mtimeMs, size } = statSync(path);
  if (cache?.path === path && cache.mtimeMs === mtimeMs && cache.size === size) return cache.graph;
  let graph: Graph;
  try {
    graph = JSON.parse(readFileSync(path, "utf8")) as Graph;
  } catch (err) {
    throw new ToolError(`Memory file ${path} is not valid JSON: ${(err as Error).message}`);
  }
  cache = { path, mtimeMs, size, graph };
  return graph;
}

/** Serializes writers across the per-call write servers with an exclusive lock file. */
function withLock<T>(fn: () => T): T {
  const lock = `${memoryPath()}.lock`;
  mkdirSync(join(lock, ".."), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
        rmSync(lock, { force: true });
      } else if (Date.now() > deadline) {
        throw new ToolError("memory is locked by another write; retry");
      } else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

function save(graph: Graph): void {
  const path = memoryPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(graph, null, 1)}\n`);
  renameSync(tmp, path);
}

export interface Remember {
  entities?: { name: string; type: string; scope?: string; observations?: string[] }[];
  relations?: Relation[];
}

export function remember(input: Remember) {
  return withLock(() => {
    const graph = structuredClone(loadGraph());
    const byKey = new Map(graph.entities.map((e) => [key(e.name), e]));
    let created = 0;
    let observed = 0;
    for (const e of input.entities ?? []) {
      let entity = byKey.get(key(e.name));
      if (!entity) {
        entity = {
          name: e.name.trim(),
          type: e.type,
          scope: e.scope ?? "global",
          observations: [],
        };
        graph.entities.push(entity);
        byKey.set(key(e.name), entity);
        created++;
      } else {
        entity.type = e.type;
        if (e.scope) entity.scope = e.scope;
      }
      for (const text of e.observations ?? []) {
        if (entity.observations.some((o) => o.text === text)) continue;
        entity.observations.push({ text, at: today() });
        observed++;
      }
      if (entity.observations.length > MAX_OBSERVATIONS) {
        throw new ToolError(
          `${entity.name} would have more than ${MAX_OBSERVATIONS} observations; forget outdated ones first`,
        );
      }
    }
    if (graph.entities.length > MAX_ENTITIES) {
      throw new ToolError(`memory holds at most ${MAX_ENTITIES} entities`);
    }
    let related = 0;
    for (const r of input.relations ?? []) {
      for (const end of [r.from, r.to]) {
        if (!byKey.has(key(end)))
          throw new ToolError(`relation endpoint "${end}" is not an entity`);
      }
      if (graph.relations.some((x) => sameRelation(x, r))) continue;
      graph.relations.push({
        from: byKey.get(key(r.from))?.name ?? r.from,
        to: byKey.get(key(r.to))?.name ?? r.to,
        type: r.type,
      });
      related++;
    }
    save(graph);
    return { created, observed, related };
  });
}

export interface Forget {
  entities?: string[];
  observations?: { entity: string; text: string }[];
  relations?: Relation[];
}

export function forget(input: Forget) {
  return withLock(() => {
    const graph = structuredClone(loadGraph());
    const gone = new Set((input.entities ?? []).map(key));
    const entityCount = graph.entities.length;
    const relationCount = graph.relations.length;
    graph.entities = graph.entities.filter((e) => !gone.has(key(e.name)));
    graph.relations = graph.relations.filter(
      (r) =>
        !gone.has(key(r.from)) &&
        !gone.has(key(r.to)) &&
        !(input.relations ?? []).some((x) => sameRelation(x, r)),
    );
    let observations = 0;
    for (const o of input.observations ?? []) {
      const entity = graph.entities.find((e) => key(e.name) === key(o.entity));
      if (!entity) continue;
      const count = entity.observations.length;
      entity.observations = entity.observations.filter((x) => x.text !== o.text);
      observations += count - entity.observations.length;
    }
    save(graph);
    return {
      entities: entityCount - graph.entities.length,
      relations: relationCount - graph.relations.length,
      observations,
    };
  });
}

const tokens = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? [];

/** Entities ranked by how many query terms their name, type and observations contain. */
export function search(
  graph: Graph,
  query: string,
  filter: { scope?: string; type?: string },
  limit: number,
) {
  const terms = [...new Set(tokens(query))];
  const ranked = graph.entities
    .filter(
      (e) =>
        (!filter.scope || e.scope === filter.scope) && (!filter.type || e.type === filter.type),
    )
    .map((e) => {
      const name = e.name.toLowerCase();
      const body = `${e.type} ${e.observations.map((o) => o.text).join(" ")}`.toLowerCase();
      const score = terms.reduce(
        (sum, t) => sum + (name.includes(t) ? 3 : 0) + (body.includes(t) ? 1 : 0),
        0,
      );
      return { e, score };
    })
    .filter((x) => !terms.length || x.score > 0)
    .sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name))
    .slice(0, limit)
    .map((x) => x.e);
  return neighborhood(graph, ranked);
}

/** The entities with every relation that touches them. */
export function neighborhood(graph: Graph, entities: Entity[]) {
  const names = new Set(entities.map((e) => key(e.name)));
  return {
    entities,
    relations: graph.relations.filter((r) => names.has(key(r.from)) || names.has(key(r.to))),
  };
}

export function openEntities(graph: Graph, names: string[]) {
  const wanted = new Set(names.map(key));
  const found = graph.entities.filter((e) => wanted.has(key(e.name)));
  const missing = names.filter((n) => !found.some((e) => key(e.name) === key(n)));
  return { ...neighborhood(graph, found), ...(missing.length ? { missing } : {}) };
}
