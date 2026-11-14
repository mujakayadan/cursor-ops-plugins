import {
  freeform,
  int,
  list,
  obj,
  oneOf,
  PATTERNS,
  pick,
  str,
  ToolError,
  tool,
} from "./lib/core/schema-helpers.ts";
import type {
  Args,
  JsonObject,
  Provider,
  ProviderConfig,
  ShellRule,
  ToolContext,
} from "./lib/core/types.ts";

const region = str(
  "AWS region (defaults to providers.aws.defaultRegion or the CLI profile's region).",
  { pattern: PATTERNS.awsRegion },
);
const instanceIds = list(
  str("EC2 instance id.", { pattern: "^i-[0-9a-f]{8,17}$" }),
  "EC2 instance ids.",
  { minItems: 1, maxItems: 20 },
);
const stackName = str("CloudFormation stack name or id.", {
  pattern: "^[A-Za-z][A-Za-z0-9:/_.-]{0,255}$",
});
const changeSetName = str("Change set name.", { pattern: "^[A-Za-z][A-Za-z0-9-]{0,127}$" });
const cluster = str("ECS cluster name or ARN.", { pattern: "^[A-Za-z0-9:/_.-]{1,255}$" });
const service = str("ECS service name or ARN.", { pattern: "^[A-Za-z0-9:/_.-]{1,255}$" });

const READ_OPERATION = /^(describe|list|get|lookup|search|batch-get|head)-/;
const SECRET_OPERATIONS = [
  /^get-secret-value$/,
  /^batch-get-secret-value$/,
  /^get-parameters?(-by-path)?$/,
  /^get-password-data$/,
  /^get-login-password$/,
  /^get-authorization-token$/,
  /^get-session-token$/,
  /^get-federation-token$/,
  /^get-credentials/,
  /^get-role-credentials$/,
  /^get-cluster-credentials/,
  /^get-token$/,
  /^get-object(-torrent)?$/,
  /decrypt/,
  /^get-console-output$/,
  /^get-function$/,
  /^get-query-results$/,
];

type Tags = { Key?: string; Value?: string }[];

interface CallerIdentity {
  Account: string;
  Arn: string;
  UserId: string;
}

interface Ec2Instance {
  InstanceId: string;
  Tags?: Tags;
  State?: { Name?: string };
  InstanceType?: string;
  Placement?: { AvailabilityZone?: string };
  PrivateIpAddress?: string;
  PublicIpAddress?: string;
  LaunchTime?: string;
}

interface CfnStack extends JsonObject {
  DriftInformation?: { StackDriftStatus?: string };
  Parameters?: { ParameterKey: string; ParameterValue?: string }[];
  Capabilities?: string[];
}

interface EcsService extends JsonObject {
  deployments?: JsonObject[];
  events?: { createdAt: string; message: string }[];
}

interface CostResponse {
  ResultsByTime?: {
    Groups?: { Keys: string[]; Metrics: { UnblendedCost: { Amount: string } } }[];
  }[];
}

function regionArgs(a: { region?: string }, pcfg: ProviderConfig): string[] {
  const r = a.region ?? pcfg.defaultRegion;
  return r ? ["--region", r] : [];
}

let callerIdentity: CallerIdentity | undefined;
async function scope(a: Args, pcfg: ProviderConfig, ctx: ToolContext): Promise<string | undefined> {
  const regions = pcfg.scope.allowedRegions ?? [];
  const r = (typeof a.region === "string" ? a.region : undefined) ?? pcfg.defaultRegion;
  if (regions.length && r && !regions.includes(r)) {
    return `region "${r}" is not in providers.aws.scope.allowedRegions`;
  }
  const accounts = pcfg.scope.allowedAccounts ?? [];
  if (accounts.length) {
    callerIdentity ??= await ctx.cli<CallerIdentity>(["sts", "get-caller-identity"], {
      parse: "json",
    });
    if (!accounts.includes(callerIdentity.Account)) {
      return `account ${callerIdentity.Account} is not in providers.aws.scope.allowedAccounts`;
    }
  }
  return undefined;
}

/** Hide environment variable values (Lambda, ECS, Batch, ...) in API responses. */
export function hideEnvValues(value: unknown, parentKey = ""): unknown {
  if (Array.isArray(value)) {
    if (/^environment$/i.test(parentKey)) {
      return value.map((e: unknown) =>
        e && typeof e === "object" && "value" in e ? { ...e, value: "[hidden]" } : e,
      );
    }
    return value.map((v: unknown) => hideEnvValues(v, parentKey));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]: [string, unknown]) => {
        if (k === "Variables" && /^environment$/i.test(parentKey) && v && typeof v === "object") {
          return [k, Object.fromEntries(Object.keys(v).map((name) => [name, "[hidden]"]))];
        }
        return [k, hideEnvValues(v, k)];
      }),
    );
  }
  return value;
}

const tag = (tags: Tags | undefined, key: string) => tags?.find((t) => t.Key === key)?.Value;

const tools = [
  tool({
    name: "aws_whoami",
    title: "Caller identity",
    tier: "read",
    description:
      "Account, ARN and user id for this tier's AWS credentials (verifies which profile is active).",
    run: (_a, { cli }) => cli(["sts", "get-caller-identity"], { parse: "json" }),
  }),
  tool({
    name: "aws_ec2_instances",
    title: "List EC2 instances",
    tier: "read",
    description: "EC2 instances with state, type, AZ, IPs and Name tag.",
    input: obj({
      region,
      state: oneOf(
        ["pending", "running", "stopping", "stopped", "shutting-down", "terminated"],
        "Instance state filter.",
      ),
      nameContains: str("Filter on Name tag substring.", { maxLength: 100 }),
    }),
    scope,
    run: async (a, ctx) => {
      const args = ["ec2", "describe-instances", ...regionArgs(a, ctx.provider)];
      const filters: string[] = [];
      if (a.state) filters.push(`Name=instance-state-name,Values=${a.state}`);
      if (a.nameContains) {
        filters.push(`Name=tag:Name,Values=*${a.nameContains.replace(/[,*]/g, "")}*`);
      }
      if (filters.length) args.push("--filters", ...filters);
      const res = await ctx.cli<{ Reservations?: { Instances: Ec2Instance[] }[] }>(args, {
        parse: "json",
      });
      return (res.Reservations ?? [])
        .flatMap((r) => r.Instances)
        .map((i) => ({
          id: i.InstanceId,
          name: tag(i.Tags, "Name"),
          state: i.State?.Name,
          type: i.InstanceType,
          az: i.Placement?.AvailabilityZone,
          privateIp: i.PrivateIpAddress,
          publicIp: i.PublicIpAddress,
          launched: i.LaunchTime,
        }));
    },
  }),
  tool({
    name: "aws_s3_buckets",
    title: "List S3 buckets",
    tier: "read",
    description: "S3 buckets in the account.",
    run: async (_a, { cli }) =>
      (await cli<{ Buckets?: JsonObject[] }>(["s3api", "list-buckets"], { parse: "json" }))
        .Buckets ?? [],
  }),
  tool({
    name: "aws_s3_objects",
    title: "List S3 objects",
    tier: "read",
    description: "List object keys (metadata only, never content) under a prefix.",
    input: obj(
      {
        bucket: str("Bucket name.", { pattern: "^[a-z0-9][a-z0-9.-]{1,62}$" }),
        prefix: str("Key prefix.", { maxLength: 1024 }),
        maxItems: int("Maximum keys.", { minimum: 1, maximum: 1000, default: 100 }),
      },
      ["bucket"],
    ),
    scope,
    run: async (a, { cli }) => {
      const args = ["s3api", "list-objects-v2", "--bucket", a.bucket];
      args.push("--max-items", String(a.maxItems));
      if (a.prefix) args.push(`--prefix=${a.prefix}`);
      const res = await cli<{ Contents?: JsonObject[]; NextToken?: string } | null>(args, {
        parse: "json",
      });
      return {
        objects: (res?.Contents ?? []).map((o) =>
          pick(o, ["Key", "Size", "LastModified", "StorageClass"]),
        ),
        nextToken: res?.NextToken,
      };
    },
  }),
  tool({
    name: "aws_lambda_functions",
    title: "List Lambda functions",
    tier: "read",
    description:
      "Lambda functions with runtime, memory, timeout and last modified (env values hidden).",
    input: obj({ region }),
    scope,
    run: async (a, ctx) => {
      const res = await ctx.cli<{ Functions?: JsonObject[] }>(
        ["lambda", "list-functions", ...regionArgs(a, ctx.provider)],
        { parse: "json" },
      );
      return (res.Functions ?? []).map((f) =>
        pick(f, [
          "FunctionName",
          "Runtime",
          "MemorySize",
          "Timeout",
          "LastModified",
          "Handler",
          "PackageType",
        ]),
      );
    },
  }),
  tool({
    name: "aws_logs_search",
    title: "Search CloudWatch logs",
    tier: "read",
    description:
      "Search a CloudWatch Logs group over a recent time window with an optional filter pattern.",
    input: obj(
      {
        logGroup: str("Log group name.", { pattern: "^[A-Za-z0-9_./#-]{1,512}$" }),
        filterPattern: str(
          "CloudWatch filter pattern, e.g. 'ERROR' or '{ $.level = \"error\" }'.",
          { maxLength: 1024 },
        ),
        minutes: int("Look-back window in minutes.", { minimum: 1, maximum: 10080, default: 60 }),
        limit: int("Maximum events.", { minimum: 1, maximum: 1000, default: 100 }),
        region,
      },
      ["logGroup"],
    ),
    scope,
    run: async (a, ctx) => {
      const args = [
        "logs",
        "filter-log-events",
        "--log-group-name",
        a.logGroup,
        "--start-time",
        String(Date.now() - a.minutes * 60000),
        "--max-items",
        String(a.limit),
        ...regionArgs(a, ctx.provider),
      ];
      if (a.filterPattern) args.push(`--filter-pattern=${a.filterPattern}`);
      const res = await ctx.cli<{
        events?: { timestamp: number; logStreamName: string; message: string }[];
      }>(args, { parse: "json" });
      return (res.events ?? [])
        .map(
          (e) => `${new Date(e.timestamp).toISOString()} ${e.logStreamName} ${e.message.trimEnd()}`,
        )
        .join("\n");
    },
  }),
  tool({
    name: "aws_cfn_stacks",
    title: "List CloudFormation stacks",
    tier: "read",
    description: "Active CloudFormation stacks with status and drift.",
    input: obj({ region }),
    scope,
    run: async (a, ctx) => {
      const res = await ctx.cli<{ Stacks?: CfnStack[] }>(
        ["cloudformation", "describe-stacks", ...regionArgs(a, ctx.provider)],
        { parse: "json" },
      );
      return (res.Stacks ?? []).map((s) => ({
        ...pick(s, [
          "StackName",
          "StackStatus",
          "StackStatusReason",
          "LastUpdatedTime",
          "CreationTime",
        ]),
        drift: s.DriftInformation?.StackDriftStatus,
      }));
    },
  }),
  tool({
    name: "aws_cfn_stack_events",
    title: "CloudFormation stack events",
    tier: "read",
    description: "Most recent stack events, useful to find the failing resource in a rollback.",
    input: obj(
      {
        stack: stackName,
        limit: int("Maximum events.", { minimum: 1, maximum: 200, default: 40 }),
        region,
      },
      ["stack"],
    ),
    scope,
    run: async (a, ctx) => {
      const res = await ctx.cli<{ StackEvents?: JsonObject[] }>(
        [
          "cloudformation",
          "describe-stack-events",
          "--stack-name",
          a.stack,
          "--max-items",
          String(a.limit),
          ...regionArgs(a, ctx.provider),
        ],
        { parse: "json" },
      );
      return (res.StackEvents ?? []).map((e) =>
        pick(e, [
          "Timestamp",
          "LogicalResourceId",
          "ResourceType",
          "ResourceStatus",
          "ResourceStatusReason",
        ]),
      );
    },
  }),
  tool({
    name: "aws_ecs_services",
    title: "ECS services",
    tier: "read",
    description:
      "Services in an ECS cluster with desired/running counts, task definition and latest deployment state.",
    input: obj({ cluster, region }, ["cluster"]),
    scope,
    run: async (a, ctx) => {
      const r = regionArgs(a, ctx.provider);
      const listed = await ctx.cli<{ serviceArns?: string[] }>(
        ["ecs", "list-services", "--cluster", a.cluster, ...r],
        { parse: "json" },
      );
      const arns = listed.serviceArns ?? [];
      if (!arns.length) return [];
      const res = await ctx.cli<{ services?: EcsService[] }>(
        [
          "ecs",
          "describe-services",
          "--cluster",
          a.cluster,
          "--services",
          ...arns.slice(0, 10),
          ...r,
        ],
        { parse: "json" },
      );
      return (res.services ?? []).map((s) => ({
        ...pick(s, [
          "serviceName",
          "status",
          "desiredCount",
          "runningCount",
          "pendingCount",
          "taskDefinition",
          "launchType",
        ]),
        deployments: s.deployments?.map((d) =>
          pick(d, [
            "status",
            "rolloutState",
            "rolloutStateReason",
            "runningCount",
            "desiredCount",
            "updatedAt",
          ]),
        ),
        recentEvents: s.events?.slice(0, 5).map((e) => `${e.createdAt} ${e.message}`),
      }));
    },
  }),
  tool({
    name: "aws_cloudwatch_alarms",
    title: "CloudWatch alarms",
    tier: "read",
    description: "CloudWatch metric alarms, by default only those currently in ALARM.",
    input: obj({
      state: oneOf(["ALARM", "OK", "INSUFFICIENT_DATA"], "Alarm state.", "ALARM"),
      region,
    }),
    scope,
    run: async (a, ctx) => {
      const res = await ctx.cli<{ MetricAlarms?: JsonObject[] }>(
        ["cloudwatch", "describe-alarms", "--state-value", a.state, ...regionArgs(a, ctx.provider)],
        { parse: "json" },
      );
      return (res.MetricAlarms ?? []).map((m) =>
        pick(m, [
          "AlarmName",
          "StateValue",
          "StateReason",
          "StateUpdatedTimestamp",
          "MetricName",
          "Namespace",
        ]),
      );
    },
  }),
  tool({
    name: "aws_cost_by_service",
    title: "Cost by service",
    tier: "read",
    description:
      "Unblended cost grouped by service for the last N days (Cost Explorer; small per-request charge).",
    input: obj({ days: int("Look-back days.", { minimum: 1, maximum: 365, default: 30 }) }),
    run: async (a, { cli }) => {
      const end = new Date();
      const start = new Date(end.getTime() - a.days * 86400000);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const res = await cli<CostResponse>(
        [
          "ce",
          "get-cost-and-usage",
          "--region",
          "us-east-1",
          "--time-period",
          `Start=${fmt(start)},End=${fmt(end)}`,
          "--granularity",
          "MONTHLY",
          "--metrics",
          "UnblendedCost",
          "--group-by",
          "Type=DIMENSION,Key=SERVICE",
        ],
        { parse: "json" },
      );
      const totals: Record<string, number> = {};
      for (const period of res.ResultsByTime ?? []) {
        for (const g of period.Groups ?? []) {
          const key = g.Keys[0] ?? "unknown";
          totals[key] = (totals[key] ?? 0) + Number(g.Metrics.UnblendedCost.Amount);
        }
      }
      return Object.entries(totals)
        .filter(([, v]) => v >= 0.01)
        .sort((x, y) => y[1] - x[1])
        .map(([svc, usd]) => ({ service: svc, usd: Math.round(usd * 100) / 100 }));
    },
  }),
  tool({
    name: "aws_readonly_call",
    title: "AWS read-only API call",
    tier: "read",
    description:
      "Generic read-only AWS CLI call for operations without a dedicated tool. Only describe-/list-/get-/lookup-/search-/head- operations; secret-returning operations are blocked and env values hidden.",
    input: obj(
      {
        service: str("CLI service name, e.g. 'rds', 'elbv2', 'route53'.", {
          pattern: "^[a-z0-9-]{2,40}$",
        }),
        operation: str("CLI operation, e.g. 'describe-db-instances'.", {
          pattern: "^[a-z0-9-]{3,80}$",
        }),
        params: freeform(
          'Request parameters in API shape (passed via --cli-input-json), e.g. {"DBInstanceIdentifier": "prod"}.',
        ),
        region,
      },
      ["service", "operation"],
    ),
    scope,
    run: async (a, ctx) => {
      if (!READ_OPERATION.test(a.operation)) {
        throw new ToolError(
          `"${a.operation}" is not a read operation. Use a dedicated write tool or ask the user.`,
        );
      }
      if (
        SECRET_OPERATIONS.some((re) => re.test(a.operation)) ||
        (a.service === "secretsmanager" && a.operation.startsWith("get-"))
      ) {
        throw new ToolError(
          `${a.service} ${a.operation} can return secret material and is blocked by policy.`,
        );
      }
      const args = [a.service, a.operation, ...regionArgs(a, ctx.provider)];
      if (a.params && Object.keys(a.params).length) {
        args.push("--cli-input-json", JSON.stringify(a.params));
      }
      return hideEnvValues(await ctx.cli(args));
    },
  }),

  tool({
    name: "aws_ecs_force_deploy",
    title: "Force new ECS deployment",
    tier: "write",
    description: "Restart an ECS service's tasks with the current task definition (rolling).",
    input: obj({ cluster, service, region }, ["cluster", "service"]),
    scope,
    summarize: (a) =>
      `force new deployment: ${a.cluster}/${a.service}${a.region ? ` (${a.region})` : ""}`,
    run: async (a, ctx) => {
      const res = await ctx.cli<{ service: JsonObject }>(
        [
          "ecs",
          "update-service",
          "--cluster",
          a.cluster,
          "--service",
          a.service,
          "--force-new-deployment",
          ...regionArgs(a, ctx.provider),
        ],
        { parse: "json" },
      );
      return pick(res.service, ["serviceName", "desiredCount", "runningCount", "taskDefinition"]);
    },
  }),
  tool({
    name: "aws_ecs_scale",
    title: "Scale ECS service",
    tier: "write",
    description:
      "Set an ECS service's desired task count (0 is privileged-equivalent and refused).",
    input: obj(
      {
        cluster,
        service,
        desiredCount: int("Desired task count.", { minimum: 1, maximum: 100 }),
        region,
      },
      ["cluster", "service", "desiredCount"],
    ),
    scope,
    summarize: (a) => `${a.cluster}/${a.service} desiredCount → ${a.desiredCount}`,
    run: async (a, ctx) => {
      const res = await ctx.cli<{ service: JsonObject }>(
        [
          "ecs",
          "update-service",
          "--cluster",
          a.cluster,
          "--service",
          a.service,
          "--desired-count",
          String(a.desiredCount),
          ...regionArgs(a, ctx.provider),
        ],
        { parse: "json" },
      );
      return pick(res.service, ["serviceName", "desiredCount", "runningCount"]);
    },
  }),
  tool({
    name: "aws_ec2_start_instances",
    title: "Start EC2 instances",
    tier: "write",
    description: "Start stopped EC2 instances.",
    input: obj({ instanceIds, region }, ["instanceIds"]),
    scope,
    summarize: (a) => `start ${a.instanceIds.join(", ")}`,
    run: (a, ctx) =>
      ctx.cli(
        [
          "ec2",
          "start-instances",
          "--instance-ids",
          ...a.instanceIds,
          ...regionArgs(a, ctx.provider),
        ],
        { parse: "json" },
      ),
  }),
  tool({
    name: "aws_cfn_create_change_set",
    title: "Create CloudFormation change set",
    tier: "write",
    description:
      "Create a change set for an existing stack reusing its template with new parameter values. Review with aws_readonly_call describe-change-set before executing.",
    input: obj(
      {
        stack: stackName,
        changeSetName,
        parameters: freeform(
          "Parameter overrides as {Key: Value}. Unlisted parameters keep their previous values.",
        ),
        region,
      },
      ["stack", "changeSetName"],
    ),
    scope,
    summarize: (a) =>
      `${a.stack}: change set ${a.changeSetName} ${JSON.stringify(a.parameters ?? {})}`,
    run: async (a, ctx) => {
      const r = regionArgs(a, ctx.provider);
      const res = await ctx.cli<{ Stacks?: CfnStack[] }>(
        ["cloudformation", "describe-stacks", "--stack-name", a.stack, ...r],
        { parse: "json" },
      );
      const stack = res.Stacks?.[0];
      if (!stack) throw new ToolError(`stack ${a.stack} not found`);
      const overrides = a.parameters ?? {};
      const params = (stack.Parameters ?? []).map((p) =>
        p.ParameterKey in overrides
          ? { ParameterKey: p.ParameterKey, ParameterValue: String(overrides[p.ParameterKey]) }
          : { ParameterKey: p.ParameterKey, UsePreviousValue: true },
      );
      const input = {
        StackName: a.stack,
        ChangeSetName: a.changeSetName,
        UsePreviousTemplate: true,
        Parameters: params,
        Capabilities: stack.Capabilities ?? [],
      };
      return ctx.cli(
        ["cloudformation", "create-change-set", "--cli-input-json", JSON.stringify(input), ...r],
        { parse: "json" },
      );
    },
  }),

  tool({
    name: "aws_ec2_stop_instances",
    title: "Stop EC2 instances",
    tier: "privileged",
    description:
      "Stop running EC2 instances (outage for anything they serve). Termination is intentionally not exposed.",
    input: obj({ instanceIds, region }, ["instanceIds"]),
    confirmHint: '"stop:<comma-separated instance ids in the given order>"',
    confirm: (a) => `stop:${a.instanceIds.join(",")}`,
    scope,
    summarize: (a) => `STOP ${a.instanceIds.join(", ")}`,
    run: (a, ctx) =>
      ctx.cli(
        [
          "ec2",
          "stop-instances",
          "--instance-ids",
          ...a.instanceIds,
          ...regionArgs(a, ctx.provider),
        ],
        { parse: "json" },
      ),
  }),
  tool({
    name: "aws_cfn_execute_change_set",
    title: "Execute CloudFormation change set",
    tier: "privileged",
    description: "Apply a reviewed change set to its stack.",
    input: obj({ stack: stackName, changeSetName, region }, ["stack", "changeSetName"]),
    confirmHint: '"<stack>:<change set name>"',
    confirm: (a) => `${a.stack}:${a.changeSetName}`,
    scope,
    summarize: (a) => `EXECUTE ${a.changeSetName} on ${a.stack}`,
    run: (a, ctx) =>
      ctx.cli(
        [
          "cloudformation",
          "execute-change-set",
          "--stack-name",
          a.stack,
          "--change-set-name",
          a.changeSetName,
          ...regionArgs(a, ctx.provider),
        ],
        { parse: "text" },
      ),
  }),
];

const aws = String.raw`\baws(\.exe)?\s+`;
const shellRules: ShellRule[] = [
  {
    id: "aws-s3-recursive-rm",
    decision: "deny",
    re: new RegExp(`${aws}s3\\s+(rm\\b.*--recursive|rb\\b)`, "i"),
    reason: "Recursive S3 deletes and bucket removal are not allowed from the agent.",
  },
  {
    id: "aws-terminate",
    decision: "deny",
    re: new RegExp(`${aws}ec2\\s+terminate-instances\\b`, "i"),
    reason: "Terminating instances is not allowed from the agent.",
  },
  {
    id: "aws-stack-delete",
    decision: "deny",
    re: new RegExp(`${aws}cloudformation\\s+delete-stack\\b`, "i"),
    reason: "Deleting CloudFormation stacks is not allowed from the agent.",
  },
  {
    id: "aws-db-delete",
    decision: "deny",
    re: new RegExp(`${aws}(rds|dynamodb|redshift|docdb|neptune)\\s+delete-`, "i"),
    reason: "Deleting databases/tables is not allowed from the agent.",
  },
  {
    id: "aws-iam-write",
    decision: "ask",
    re: new RegExp(
      `${aws}(iam|organizations|sso-admin)\\s+(create|delete|attach|detach|put|update|add|remove)-`,
      "i",
    ),
    reason: "Changing IAM / organization permissions.",
  },
  {
    id: "aws-secret-read",
    decision: "ask",
    re: new RegExp(
      `${aws}(secretsmanager\\s+get-secret-value|ssm\\s+get-parameters?\\b.*--with-decryption)`,
      "i",
    ),
    reason: "Reading secret values into the agent context.",
  },
  {
    id: "aws-delete",
    decision: "ask",
    re: new RegExp(`${aws}\\S+\\s+(delete|remove|deregister|terminate|purge)-`, "i"),
    reason: "Deleting AWS resources.",
  },
  {
    id: "aws-s3-rm",
    decision: "ask",
    re: new RegExp(`${aws}s3\\s+(rm|mv|sync\\b.*--delete)\\b`, "i"),
    reason: "Removing or overwriting S3 objects.",
  },
  {
    id: "aws-mutation",
    decision: "ask",
    re: new RegExp(
      `${aws}\\S+\\s+(create|update|put|modify|stop|start|reboot|execute|invoke|run|attach|detach|authorize|revoke)-`,
      "i",
    ),
    reason: "Mutating AWS API call.",
  },
];

const provider: Provider = {
  id: "aws",
  displayName: "AWS",
  version: "1.0.0",
  bin: "aws",
  baseArgs: ["--output", "json", "--no-cli-pager"],
  baseEnv: { AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" },
  instructions: {
    read: "Read-only AWS access (EC2, S3 metadata, Lambda, CloudWatch, CloudFormation, ECS, Cost Explorer) plus a guarded generic read gateway.",
    write:
      "AWS write access. Every call requires user approval; privileged tools require typed confirmation. No delete/terminate tools exist by design.",
  },
  tools,
  shellRules,
};

export default provider;
