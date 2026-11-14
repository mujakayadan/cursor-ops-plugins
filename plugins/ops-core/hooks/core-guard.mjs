import { audit } from "../lib/core/audit.mjs";
import { loadConfig } from "../lib/core/config.mjs";
import { runHook } from "../lib/core/hook-runtime.mjs";
import { decideThirdPartyMcp, evaluateShell, shellResponse, strictest } from "../lib/core/policy.mjs";
import { findSecrets, truncate } from "../lib/core/redact.mjs";
import { EXEC_TOOL, SHELL_RULES, inputStrings, isTextOnly, normalizeCommand, withOverrides } from "./guardrails.mjs";

function secretResponse(kinds, where) {
  return {
    permission: "deny",
    user_message: `ops guardrail: ${where} contains credential material (${kinds.join(", ")}).`,
    agent_message: `Blocked: ${where} contains credentials (${kinds.join(", ")}). Never inline secrets; use CLI profiles, environment variables or a secret manager.`,
  };
}

function shellRules(cfg) {
  return withOverrides(SHELL_RULES, cfg.guardrails?.shell?.overrides);
}

function evaluateCommand(command, cfg) {
  if (isTextOnly(command ?? "")) return { permission: "allow", matches: [] };
  return evaluateShell(normalizeCommand(command), shellRules(cfg));
}

function parseInput(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    return JSON.parse(raw ?? "{}");
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
      return { continue: false, user_message: `Your prompt looks like it contains credentials (${kinds.join(", ")}). Remove them and reference a profile or env var instead.` };
    },

    beforeShellExecution(payload) {
      const kinds = findSecrets(payload.command);
      if (kinds.length) return secretResponse(kinds, "this command");
      const result = evaluateCommand(payload.command, loadConfig());
      if (result.permission !== "allow") audit({ source: "hook", event: "beforeShellExecution", command: truncate(payload.command ?? "", 500), decision: result.permission, rules: result.matches.map((m) => m.id) });
      return shellResponse(result, "ops-core");
    },

    beforeMCPExecution(payload) {
      const cfg = loadConfig();
      const input = parseInput(payload.tool_input);
      const kinds = findSecrets(typeof payload.tool_input === "string" ? payload.tool_input : JSON.stringify(payload.tool_input ?? {}));
      if (kinds.length) return secretResponse(kinds, "these MCP tool arguments");

      const exec = EXEC_TOOL.test(payload.tool_name ?? "") ? evaluateCommand(inputStrings(input), cfg) : { permission: "allow", matches: [] };
      const server = decideThirdPartyMcp(payload, cfg);
      const permission = strictest(exec.permission, server.permission);
      if (permission !== "allow") audit({ source: "hook", event: "beforeMCPExecution", server: payload.mcp_server_name, tool: payload.tool_name, decision: permission, rules: exec.matches.map((m) => m.id) });
      if (exec.permission === permission && permission !== "allow") return shellResponse(exec, `ops-core (${payload.mcp_server_name} › ${payload.tool_name})`);
      return server;
    },

    afterShellExecution(payload) {
      audit({ source: "shell", command: payload.command, durationMs: payload.duration, sandbox: payload.sandbox, output: truncate(payload.output ?? "", 1500), conversation: payload.conversation_id });
      return {};
    },

    afterMCPExecution(payload) {
      audit({ source: "mcp-hook", server: payload.mcp_server_name, tool: payload.tool_name, args: payload.tool_input, durationMs: payload.duration, result: truncate(payload.result_json ?? "", 1000), conversation: payload.conversation_id });
      return {};
    },
  },
  { failClosed: ["beforeShellExecution", "beforeMCPExecution"] },
);
