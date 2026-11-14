import {
  bool,
  int,
  obj,
  oneOf,
  PATTERNS,
  pick,
  str,
  ToolError,
  tool,
} from "./lib/core/schema-helpers.ts";
import type { JsonObject, Provider, ShellRule, ToolContext } from "./lib/core/types.ts";

const dropletId = str("Droplet id.", { pattern: PATTERNS.numericId });
const appId = str("App Platform app id (UUID).", { pattern: PATTERNS.uuid });
const domain = str("Domain name, e.g. example.com.", { pattern: PATTERNS.hostname });

interface Droplet {
  id: number;
  name: string;
  status: string;
  region?: { slug?: string };
  size_slug?: string;
  networks?: { v4?: { type: string; ip_address: string }[] };
  tags?: string[];
  created_at?: string;
}

interface App {
  id: string;
  spec?: { name?: string };
  live_url?: string;
  region?: { slug?: string };
  active_deployment?: JsonObject;
  in_progress_deployment?: JsonObject;
  updated_at?: string;
}

interface Deployment extends JsonObject {
  progress?: JsonObject;
}

interface KubernetesCluster extends JsonObject {
  status?: { state?: string };
  node_pools?: JsonObject[];
}

type DropletArgs = { id: string };

function protectedTagScope(tagsFor: (args: DropletArgs, ctx: ToolContext) => Promise<string[]>) {
  return async (args: DropletArgs, ctx: ToolContext): Promise<void> => {
    const protectedTags = ctx.provider.scope.protectedTags ?? [];
    if (!protectedTags.length) return;
    const tags = await tagsFor(args, ctx);
    const hit = tags.find((t) => protectedTags.includes(t));
    if (hit) {
      throw new ToolError(
        `Droplet is tagged "${hit}", which is in providers.digitalocean.scope.protectedTags.`,
      );
    }
  };
}

const first = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] : v) ?? null;

const dropletTags = async (a: DropletArgs, { cli }: ToolContext) => {
  const d = first(
    await cli<Droplet | Droplet[]>(["compute", "droplet", "get", a.id], { parse: "json" }),
  );
  return d?.tags ?? [];
};
const guardProtected = protectedTagScope(dropletTags);

const compactDroplet = (d: Droplet) => ({
  id: d.id,
  name: d.name,
  status: d.status,
  region: d.region?.slug,
  size: d.size_slug,
  publicIp: d.networks?.v4?.find((n) => n.type === "public")?.ip_address,
  tags: d.tags,
  created: d.created_at,
});

const compactApp = (a: App) => ({
  id: a.id,
  name: a.spec?.name,
  liveUrl: a.live_url,
  region: a.region?.slug,
  activeDeployment:
    a.active_deployment && pick(a.active_deployment, ["id", "phase", "cause", "updated_at"]),
  inProgressDeployment:
    a.in_progress_deployment && pick(a.in_progress_deployment, ["id", "phase", "cause"]),
  updated: a.updated_at,
});

const tools = [
  tool({
    name: "digitalocean_account_get",
    title: "Account info",
    tier: "read",
    description: "Authenticated DigitalOcean account (email, team, status, limits).",
    run: async (_a, { cli }) =>
      first(await cli<JsonObject | JsonObject[]>(["account", "get"], { parse: "json" })),
  }),
  tool({
    name: "digitalocean_balance_get",
    title: "Billing balance",
    tier: "read",
    description: "Month-to-date usage and account balance.",
    run: (_a, { cli }) => cli(["balance", "get"], { parse: "json" }),
  }),
  tool({
    name: "digitalocean_droplet_list",
    title: "List droplets",
    tier: "read",
    description: "Droplets with status, region, size, public IP and tags.",
    input: obj({ tag: str("Only droplets with this tag.", { pattern: PATTERNS.slug }) }),
    run: async (a, { cli }) => {
      const args = ["compute", "droplet", "list"];
      if (a.tag) args.push("--tag-name", a.tag);
      return ((await cli<Droplet[] | null>(args, { parse: "json" })) ?? []).map(compactDroplet);
    },
  }),
  tool({
    name: "digitalocean_droplet_get",
    title: "Get droplet",
    tier: "read",
    description: "Full details for one droplet.",
    input: obj({ id: dropletId }, ["id"]),
    run: async (a, { cli }) =>
      first(
        await cli<JsonObject | JsonObject[]>(["compute", "droplet", "get", a.id], {
          parse: "json",
        }),
      ),
  }),
  tool({
    name: "digitalocean_app_list",
    title: "List apps",
    tier: "read",
    description: "App Platform apps with live URL and active/in-progress deployment phase.",
    run: async (_a, { cli }) =>
      ((await cli<App[] | null>(["apps", "list"], { parse: "json" })) ?? []).map(compactApp),
  }),
  tool({
    name: "digitalocean_app_get",
    title: "Get app",
    tier: "read",
    description: "Full App Platform app including spec (env values are redacted by the server).",
    input: obj({ appId }, ["appId"]),
    run: async (a, { cli }) =>
      first(await cli<JsonObject | JsonObject[]>(["apps", "get", a.appId], { parse: "json" })),
  }),
  tool({
    name: "digitalocean_app_deployments",
    title: "List app deployments",
    tier: "read",
    description: "Recent deployments for an app with phase, cause and progress.",
    input: obj(
      { appId, limit: int("Maximum deployments.", { minimum: 1, maximum: 50, default: 10 }) },
      ["appId"],
    ),
    run: async (a, { cli }) =>
      (
        (await cli<Deployment[] | null>(["apps", "list-deployments", a.appId], {
          parse: "json",
        })) ?? []
      )
        .slice(0, a.limit)
        .map((d) => ({
          ...pick(d, ["id", "phase", "cause", "created_at", "updated_at"]),
          progress: d.progress && pick(d.progress, ["success_steps", "error_steps", "total_steps"]),
        })),
  }),
  tool({
    name: "digitalocean_app_logs",
    title: "App logs",
    tier: "read",
    description: "Recent build, deploy or runtime logs for an app component.",
    input: obj(
      {
        appId,
        component: str("Component name (omit for all).", { pattern: PATTERNS.slug }),
        type: oneOf(["build", "deploy", "run"], "Log type.", "run"),
        tail: int("Number of lines.", { minimum: 1, maximum: 2000, default: 200 }),
      },
      ["appId"],
    ),
    run: (a, { cli }) => {
      const args = ["apps", "logs", a.appId];
      if (a.component) args.push(a.component);
      args.push("--type", a.type, "--tail", String(a.tail));
      return cli(args, { parse: "text", withBaseArgs: false });
    },
  }),
  tool({
    name: "digitalocean_database_list",
    title: "List managed databases",
    tier: "read",
    description:
      "Managed database clusters (engine, version, status, size). Connection secrets are stripped.",
    run: async (_a, { cli }) =>
      ((await cli<JsonObject[] | null>(["databases", "list"], { parse: "json" })) ?? []).map((d) =>
        pick(d, [
          "id",
          "name",
          "engine",
          "version",
          "status",
          "region",
          "size",
          "num_nodes",
          "created_at",
          "tags",
        ]),
      ),
  }),
  tool({
    name: "digitalocean_kubernetes_list",
    title: "List Kubernetes clusters",
    tier: "read",
    description: "DOKS clusters with version, status and node pools.",
    run: async (_a, { cli }) =>
      (
        (await cli<KubernetesCluster[] | null>(["kubernetes", "cluster", "list"], {
          parse: "json",
        })) ?? []
      ).map((c) => ({
        ...pick(c, ["id", "name", "region", "version", "created_at"]),
        status: c.status?.state,
        nodePools: c.node_pools?.map((p) =>
          pick(p, ["name", "size", "count", "auto_scale", "min_nodes", "max_nodes"]),
        ),
      })),
  }),
  tool({
    name: "digitalocean_domain_records",
    title: "List DNS records",
    tier: "read",
    description: "DNS records for a domain.",
    input: obj({ domain }, ["domain"]),
    run: (a, { cli }) => cli(["compute", "domain", "records", "list", a.domain], { parse: "json" }),
  }),

  tool({
    name: "digitalocean_app_redeploy",
    title: "Redeploy app",
    tier: "write",
    description: "Trigger a new deployment of an app's current spec. Does not wait for completion.",
    input: obj(
      {
        appId,
        forceRebuild: bool("Force a rebuild instead of reusing the previous build.", false),
      },
      ["appId"],
    ),
    summarize: (a) => `app ${a.appId}${a.forceRebuild ? " (force rebuild)" : ""}`,
    run: (a, { cli }) =>
      cli(["apps", "create-deployment", a.appId, ...(a.forceRebuild ? ["--force-rebuild"] : [])], {
        parse: "json",
      }),
  }),
  tool({
    name: "digitalocean_droplet_snapshot",
    title: "Snapshot droplet",
    tier: "write",
    description: "Take a snapshot of a droplet (safe pre-change backup).",
    input: obj({ id: dropletId, name: str("Snapshot name.", { pattern: PATTERNS.slug }) }, [
      "id",
      "name",
    ]),
    summarize: (a) => `droplet ${a.id} → snapshot "${a.name}"`,
    run: (a, { cli }) =>
      cli(["compute", "droplet-action", "snapshot", a.id, "--snapshot-name", a.name], {
        parse: "json",
      }),
  }),
  tool({
    name: "digitalocean_domain_record_create",
    title: "Create DNS record",
    tier: "write",
    description: "Create a DNS record on a DigitalOcean-managed domain.",
    input: obj(
      {
        domain,
        type: oneOf(["A", "AAAA", "CNAME", "TXT", "MX", "CAA", "NS", "SRV"], "Record type."),
        name: str("Record name ('@' for apex).", { pattern: "^(@|[A-Za-z0-9_.*-]{1,253})$" }),
        data: str("Record data.", { minLength: 1, maxLength: 1024 }),
        ttl: int("TTL in seconds.", { minimum: 30, maximum: 86400, default: 1800 }),
      },
      ["domain", "type", "name", "data"],
    ),
    summarize: (a) => `${a.type} ${a.name}.${a.domain} → ${a.data} (ttl ${a.ttl})`,
    run: (a, { cli }) =>
      cli(
        [
          "compute",
          "domain",
          "records",
          "create",
          a.domain,
          "--record-type",
          a.type,
          "--record-name",
          a.name,
          `--record-data=${a.data}`,
          "--record-ttl",
          String(a.ttl),
        ],
        { parse: "json" },
      ),
  }),

  tool({
    name: "digitalocean_droplet_reboot",
    title: "Reboot droplet",
    tier: "privileged",
    description: "Gracefully reboot a droplet (causes downtime).",
    input: obj({ id: dropletId }, ["id"]),
    confirmHint: '"reboot:<droplet id>"',
    confirm: (a) => `reboot:${a.id}`,
    summarize: (a) => `reboot droplet ${a.id}`,
    run: async (a, ctx) => {
      await guardProtected(a, ctx);
      return ctx.cli(["compute", "droplet-action", "reboot", a.id], { parse: "json" });
    },
  }),
  tool({
    name: "digitalocean_droplet_power_off",
    title: "Power off droplet",
    tier: "privileged",
    description: "Hard power-off a droplet (immediate outage; billing continues).",
    input: obj({ id: dropletId }, ["id"]),
    confirmHint: '"power-off:<droplet id>"',
    confirm: (a) => `power-off:${a.id}`,
    summarize: (a) => `power off droplet ${a.id}`,
    run: async (a, ctx) => {
      await guardProtected(a, ctx);
      return ctx.cli(["compute", "droplet-action", "power-off", a.id], { parse: "json" });
    },
  }),
  tool({
    name: "digitalocean_domain_record_delete",
    title: "Delete DNS record",
    tier: "privileged",
    description: "Delete a DNS record by id.",
    input: obj({ domain, recordId: str("Record id.", { pattern: PATTERNS.numericId }) }, [
      "domain",
      "recordId",
    ]),
    confirmHint: '"<domain>/<record id>"',
    confirm: (a) => `${a.domain}/${a.recordId}`,
    summarize: (a) => `delete record ${a.recordId} on ${a.domain}`,
    run: (a, { cli }) =>
      cli(["compute", "domain", "records", "delete", a.domain, a.recordId, "--force"], {
        parse: "text",
      }),
  }),
];

const doctl = String.raw`\bdoctl(\.exe)?\s+`;
const shellRules: ShellRule[] = [
  {
    id: "do-cluster-delete",
    decision: "deny",
    re: new RegExp(`${doctl}(kubernetes|k8s)\\s+cluster\\s+(delete|rm)\\b`, "i"),
    reason: "Deleting Kubernetes clusters is not allowed from the agent.",
  },
  {
    id: "do-db-delete",
    decision: "deny",
    re: new RegExp(`${doctl}databases\\s+(delete|rm)\\b`, "i"),
    reason: "Deleting managed databases is not allowed from the agent.",
  },
  {
    id: "do-apps-delete",
    decision: "deny",
    re: new RegExp(`${doctl}apps\\s+(delete|rm)\\b`, "i"),
    reason: "Deleting App Platform apps is not allowed from the agent.",
  },
  {
    id: "do-delete",
    decision: "ask",
    re: new RegExp(`${doctl}.*\\b(delete|rm|destroy|purge)\\b`, "i"),
    reason: "Deleting DigitalOcean resources.",
  },
  {
    id: "do-power",
    decision: "ask",
    re: new RegExp(
      `${doctl}compute\\s+droplet-action\\s+(power-off|power-cycle|shutdown|reboot|restore|rebuild|resize)\\b`,
      "i",
    ),
    reason: "Disruptive droplet action.",
  },
  {
    id: "do-firewall",
    decision: "ask",
    re: new RegExp(
      `${doctl}compute\\s+firewall\\s+(create|update|add-rules|remove-rules|add-droplets|remove-droplets)\\b`,
      "i",
    ),
    reason: "Changing cloud firewall rules.",
  },
  {
    id: "do-apps-update",
    decision: "ask",
    re: new RegExp(`${doctl}apps\\s+(update|create|create-deployment)\\b`, "i"),
    reason: "Changing or deploying an App Platform app.",
  },
  {
    id: "do-auth",
    decision: "ask",
    re: new RegExp(`${doctl}auth\\s+(init|remove|switch)\\b`, "i"),
    reason: "Changing doctl authentication context.",
  },
];

const provider: Provider = {
  id: "digitalocean",
  displayName: "DigitalOcean",
  version: "1.0.0",
  bin: "doctl",
  baseArgs: ["--output", "json"],
  baseEnv: { NO_COLOR: "1" },
  instructions: {
    read: "Read-only DigitalOcean access (droplets, App Platform, databases, DOKS, DNS, billing).",
    write:
      "DigitalOcean write access. Every call requires user approval; privileged tools require typed confirmation.",
  },
  tools,
  shellRules,
};

export default provider;
