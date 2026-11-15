import type { Schema } from "./schema-helpers.ts";

export type Tier = "read" | "write" | "privileged";
export type ServerTier = "read" | "write";
export type Decision = "allow" | "ask" | "deny";
export type ToolClass = Tier | "unknown";

export type Args = Record<string, unknown>;
export type JsonObject = Record<string, unknown>;

export interface Credentials {
  env: Record<string, string>;
  args: string[];
}

/** Union of every provider's `scope` settings; each provider reads only its own keys. */
export interface ProviderScope {
  owners?: string[];
  protectedTags?: string[];
  teamId?: string | null;
  allowedTeams?: string[];
  allowedRegions?: string[];
  allowedAccounts?: string[];
  allowedRoots?: string[];
  allowedRecipientDomains?: string[];
}

export interface ProviderConfig {
  allowPrivileged: boolean;
  credentials: { read: Credentials; write: Credentials };
  scope: ProviderScope;
  defaultRegion?: string | null;
  timeZone?: string | null;
  /** Chrome/Chromium/Edge executable for mermaid-cli. */
  browserPath?: string | null;
  /** TeX engine used when a LaTeX tool call doesn't pick one. */
  engine?: string | null;
  source?: string | null;
  ref?: string | null;
}

export interface ThirdPartyMcpPolicy extends Record<ToolClass, Decision> {
  trustedServers: string[];
  serverOverrides: Record<string, Partial<Record<ToolClass, Decision>>>;
  deniedTools: string[];
}

export interface Config {
  audit: { enabled: boolean; dir: string | null; maxFieldChars: number };
  execution: { timeoutMs: number; maxOutputChars: number };
  providers: Record<string, Partial<ProviderConfig>>;
  thirdPartyMcp: ThirdPartyMcpPolicy;
  guardrails: { shell: { overrides: Record<string, Decision> } };
  prompts: { blockSecrets: boolean };
  review: ReviewConfig;
  suite: { disabledPlugins: string[] };
}

export type ReviewLensId = "security" | "performance" | "standards" | "docs";

export interface ReviewConfig {
  enabled: boolean;
  lenses: Record<ReviewLensId, boolean>;
  /** Follow-up review requests per user prompt; fixes made during a review are not re-reviewed beyond this. */
  maxRounds: number;
  /** Turns with fewer changed lines and no static hints are not reviewed. */
  minChangedLines: number;
  /** Changed files listed in the review request. */
  maxFiles: number;
  /** Workspace-relative path regexes that are never reviewed. */
  ignore: string[];
}

export interface CliOptions {
  okCodes?: number[];
  input?: string;
  parse?: "auto" | "json" | "text";
  withBaseArgs?: boolean;
  timeoutMs?: number;
  cwd?: string;
}

/** Runs the provider CLI with this tier's credentials. JSON output is typed by the caller. */
export interface Cli {
  (args: string[], options: CliOptions & { parse: "text" }): Promise<string>;
  <T = unknown>(args: string[], options?: CliOptions): Promise<T>;
}

export interface ToolContext {
  tier: Tier;
  cfg: Config;
  provider: ProviderConfig;
  cli: Cli;
}

export interface Tool<A extends object = Args> {
  name: string;
  title: string;
  tier: Tier;
  description: string;
  input?: Schema<A>;
  /** Privileged tools: the exact `confirm` value the user must type. */
  confirm?(args: NoInfer<A>): string;
  confirmHint?: string;
  summarize?(args: NoInfer<A>): string;
  /** Returns a reason string when the call is outside the configured scope. */
  scope?(
    args: NoInfer<A>,
    provider: ProviderConfig,
    ctx: ToolContext,
  ): string | undefined | Promise<string | undefined>;
  run(args: NoInfer<A>, ctx: ToolContext): unknown;
}

export interface HookPayload {
  hook_event_name?: string;
  conversation_id?: string;
  generation_id?: string;
  command?: string;
  cwd?: string;
  workspace_roots?: string[];
  mcp_server_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  prompt?: string;
  output?: string;
  duration?: number;
  sandbox?: boolean;
  result_json?: string;
  file_path?: string;
  edits?: { old_string?: string; new_string?: string }[];
  status?: "completed" | "aborted" | "error";
  loop_count?: number;
}

export interface HookResponse {
  permission?: Decision;
  continue?: boolean;
  user_message?: string;
  agent_message?: string;
  followup_message?: string;
}

export interface ShellRule {
  id: string;
  decision: Decision;
  re: RegExp;
  reason: string;
  /** Applies the rule only in some contexts (e.g. inside a uv project). */
  when?(payload: HookPayload): boolean;
}

export interface Provider {
  id: string;
  displayName: string;
  version: string;
  bin: string;
  baseArgs?: string[];
  baseEnv?: Record<string, string>;
  /** Extra binaries the tools need besides `bin`. */
  requires?: string[];
  instructions?: Partial<Record<ServerTier, string>>;
  tools: Tool[];
  shellRules?: ShellRule[];
}
