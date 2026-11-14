import { audit } from "../lib/core/audit.ts";
import { loadConfig } from "../lib/core/config.ts";
import { runHook } from "../lib/core/hook-runtime.ts";
import {
  decideThirdPartyMcp,
  evaluateShell,
  type ShellEvaluation,
  shellResponse,
  strictest,
} from "../lib/core/policy.ts";
import { findSecrets, truncate } from "../lib/core/redact.ts";
import type { Config, HookPayload, HookResponse } from "../lib/core/types.ts";
import {
  EXEC_TOOL,
  inputStrings,
  isTextOnly,
  normalizeCommand,
  SHELL_RULES,
  withOverrides,
} from "./guardrails.ts";

const ALLOW: ShellEvaluation = { permission: "allow", matches: [] };

function secretResponse(kinds: string[], where: string): HookResponse {
  return {
    permission: "deny",
    user_message: `ops guardrail: ${where} contains credential material (${kinds.join(", ")}).`,
    agent_message: `Blocked: ${where} contains credentials (${kinds.join(", ")}). Never inline secrets; use CLI profiles, environment variables or a secret manager.`,
  };
}

function evaluateCommand(
  command: string | undefined,
  cfg: Config,
  payload: HookPayload,
): ShellEvaluation {
  if (isTextOnly(command ?? "")) return ALLOW;
  return evaluateShell(
    normalizeCommand(command),
    withOverrides(SHELL_RULES, cfg.guardrails?.shell?.overrides),
    payload,
  );
}

function parseInput(raw: unknown): unknown {
  if (raw && typeof raw === "object") return raw;
  try {
    return JSON.parse(typeof raw === "string" ? raw : "{}");
  } catch {
    return { raw };
  }
}

runHook(
  {
    beforeSubmitPrompt(payload) {
      const cfg = loadConfig();
      const kinds = cfg.prompts.blockSecrets ? findSecrets(payload.prompt) : [];
      if (!kinds.length) return { continue: true };
      audit({ source: "hook", event: "beforeSubmitPrompt", blocked: true, kinds });
      return {
        continue: false,
        user_message: `Your prompt looks like it contains credentials (${kinds.join(", ")}). Remove them and reference a profile or env var instead.`,
      };
    },

    beforeShellExecution(payload) {
      const kinds = findSecrets(payload.command);
      if (kinds.length) return secretResponse(kinds, "this command");
      const result = evaluateCommand(payload.command, loadConfig(), payload);
      if (result.permission !== "allow") {
        audit({
          source: "hook",
          event: "beforeShellExecution",
          command: truncate(payload.command ?? "", 500),
          decision: result.permission,
          rules: result.matches.map((m) => m.id),
        });
      }
      return shellResponse(result, "ops-core");
    },

    beforeMCPExecution(payload) {
      const cfg = loadConfig();
      const input = parseInput(payload.tool_input);
      const kinds = findSecrets(
        typeof payload.tool_input === "string"
          ? payload.tool_input
          : JSON.stringify(payload.tool_input ?? {}),
      );
      if (kinds.length) return secretResponse(kinds, "these MCP tool arguments");

      const exec = EXEC_TOOL.test(payload.tool_name ?? "")
        ? evaluateCommand(inputStrings(input), cfg, payload)
        : ALLOW;
      const server = decideThirdPartyMcp(payload, cfg);
      const permission = strictest(exec.permission, server.permission);
      if (permission !== "allow") {
        audit({
          source: "hook",
          event: "beforeMCPExecution",
          server: payload.mcp_server_name,
          tool: payload.tool_name,
          decision: permission,
          rules: exec.matches.map((m) => m.id),
        });
      }
      if (exec.permission === permission && permission !== "allow") {
        return shellResponse(exec, `ops-core (${payload.mcp_server_name} › ${payload.tool_name})`);
      }
      return server;
    },

    afterShellExecution(payload) {
      audit({
        source: "shell",
        command: payload.command,
        durationMs: payload.duration,
        sandbox: payload.sandbox,
        output: truncate(payload.output ?? "", 1500),
        conversation: payload.conversation_id,
      });
      return {};
    },

    afterMCPExecution(payload) {
      audit({
        source: "mcp-hook",
        server: payload.mcp_server_name,
        tool: payload.tool_name,
        args: payload.tool_input,
        durationMs: payload.duration,
        result: truncate(payload.result_json ?? "", 1000),
        conversation: payload.conversation_id,
      });
      return {};
    },
  },
  { failClosed: ["beforeShellExecution", "beforeMCPExecution"] },
);
