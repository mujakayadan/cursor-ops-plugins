import { ToolError } from "./lib/core/schema-helpers.ts";

/** Icon packages of the Python `diagrams` library that a spec may use. */
export const ICON_PROVIDERS = [
  "alibabacloud",
  "aws",
  "azure",
  "c4",
  "digitalocean",
  "elastic",
  "firebase",
  "gcp",
  "generic",
  "gis",
  "ibm",
  "k8s",
  "oci",
  "onprem",
  "openstack",
  "outscale",
  "programming",
  "saas",
] as const;

const DIRECTIONS = ["LR", "TB", "RL", "BT"] as const;
const EDGE_STYLES = ["solid", "dashed", "dotted", "bold"] as const;
const EDGE_DIRECTIONS = ["forward", "back", "both", "none"] as const;
const ID = /^[a-z][a-z0-9_]{0,40}$/;
const ICON = new RegExp(`^(?:${ICON_PROVIDERS.join("|")})\\.[a-z0-9_]+\\.[A-Z][A-Za-z0-9]*$`);
const COLOR = /^(?:#[0-9A-Fa-f]{6}|[a-z]{3,20})$/;
const MAX_LABEL = 80;
/** Graphviz reads `<...>` as an HTML label, which can reference local files. */
const LABEL_FORBIDDEN = /[<>\p{Cc}]/u;
const MAX_NODES = 80;
const MAX_EDGES = 200;
const MAX_CLUSTER_DEPTH = 5;

interface DiagramNode {
  id: string;
  icon: string;
  label?: string;
}

interface DiagramCluster {
  label: string;
  direction?: (typeof DIRECTIONS)[number];
  nodes?: string[];
  clusters?: DiagramCluster[];
}

interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  style?: (typeof EDGE_STYLES)[number];
  color?: string;
  direction?: (typeof EDGE_DIRECTIONS)[number];
}

export interface DiagramSpec {
  title: string;
  direction?: (typeof DIRECTIONS)[number];
  nodes: DiagramNode[];
  clusters?: DiagramCluster[];
  edges?: DiagramEdge[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validate a diagram spec and return it typed. Every problem is reported at once so the agent can
 * fix the spec in one pass; the Python renderer only ever sees specs that passed.
 */
export function parseSpec(value: unknown): DiagramSpec {
  const problems: string[] = [];
  const at = (path: string, message: string) => problems.push(`${path}: ${message}`);
  const allowed = (path: string, obj: Record<string, unknown>, keys: string[]) => {
    for (const key of Object.keys(obj)) if (!keys.includes(key)) at(path, `unknown field "${key}"`);
  };
  const label = (path: string, v: unknown, required: boolean) => {
    if (v === undefined && !required) return;
    if (typeof v !== "string" || !v.trim() || v.length > MAX_LABEL) {
      at(path, `must be a non-empty string of at most ${MAX_LABEL} characters`);
    } else if (LABEL_FORBIDDEN.test(v)) {
      at(path, "must not contain < > or control characters");
    }
  };
  const member = (path: string, v: unknown, options: readonly string[]) => {
    if (v !== undefined && !options.includes(v as string))
      at(path, `must be one of ${options.join(", ")}`);
  };

  if (!isRecord(value)) throw new ToolError("spec must be a JSON object");
  allowed("spec", value, ["title", "direction", "nodes", "clusters", "edges"]);
  label("title", value.title, true);
  member("direction", value.direction, DIRECTIONS);

  const ids = new Set<string>();
  const nodes = Array.isArray(value.nodes) ? value.nodes : [];
  if (!nodes.length || nodes.length > MAX_NODES) at("nodes", `needs 1 to ${MAX_NODES} nodes`);
  nodes.forEach((n, i) => {
    const path = `nodes[${i}]`;
    if (!isRecord(n)) {
      at(path, "must be an object");
      return;
    }
    allowed(path, n, ["id", "icon", "label"]);
    if (typeof n.id !== "string" || !ID.test(n.id))
      at(`${path}.id`, "must match ^[a-z][a-z0-9_]{0,40}$");
    else if (ids.has(n.id)) at(`${path}.id`, `duplicate id "${n.id}"`);
    else ids.add(n.id);
    if (typeof n.icon !== "string" || !ICON.test(n.icon)) {
      at(`${path}.icon`, "must be provider.category.Class, such as aws.compute.Lambda");
    }
    label(`${path}.label`, n.label, false);
  });

  const placed = new Set<string>();
  const cluster = (path: string, c: unknown, depth: number) => {
    if (!isRecord(c)) return at(path, "must be an object");
    if (depth > MAX_CLUSTER_DEPTH)
      return at(path, `clusters nest at most ${MAX_CLUSTER_DEPTH} deep`);
    allowed(path, c, ["label", "direction", "nodes", "clusters"]);
    label(`${path}.label`, c.label, true);
    member(`${path}.direction`, c.direction, DIRECTIONS);
    for (const id of Array.isArray(c.nodes) ? c.nodes : []) {
      if (typeof id !== "string" || !ids.has(id))
        at(`${path}.nodes`, `unknown node "${String(id)}"`);
      else if (placed.has(id)) at(`${path}.nodes`, `node "${id}" is already in another cluster`);
      else placed.add(id);
    }
    (Array.isArray(c.clusters) ? c.clusters : []).forEach((child, i) => {
      cluster(`${path}.clusters[${i}]`, child, depth + 1);
    });
  };
  (Array.isArray(value.clusters) ? value.clusters : []).forEach((c, i) => {
    cluster(`clusters[${i}]`, c, 1);
  });

  const edges = Array.isArray(value.edges) ? value.edges : [];
  if (edges.length > MAX_EDGES) at("edges", `at most ${MAX_EDGES} edges`);
  edges.forEach((e, i) => {
    const path = `edges[${i}]`;
    if (!isRecord(e)) {
      at(path, "must be an object");
      return;
    }
    allowed(path, e, ["from", "to", "label", "style", "color", "direction"]);
    for (const end of ["from", "to"] as const) {
      if (typeof e[end] !== "string" || !ids.has(e[end]))
        at(`${path}.${end}`, `unknown node "${String(e[end])}"`);
    }
    label(`${path}.label`, e.label, false);
    member(`${path}.style`, e.style, EDGE_STYLES);
    member(`${path}.direction`, e.direction, EDGE_DIRECTIONS);
    if (e.color !== undefined && (typeof e.color !== "string" || !COLOR.test(e.color))) {
      at(`${path}.color`, "must be #rrggbb or a color name");
    }
  });

  if (problems.length) throw new ToolError(`invalid diagram spec:\n- ${problems.join("\n- ")}`);
  return value as unknown as DiagramSpec;
}
