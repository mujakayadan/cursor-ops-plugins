import { audit } from "../lib/core/audit.mjs";
import { loadConfig } from "../lib/core/config.mjs";
import { runHook } from "../lib/core/hook-runtime.mjs";
import { decideThirdPartyMcp, evaluateShell, shellResponse } from "../lib/core/policy.mjs";
import { findSecrets, truncate } from "../lib/core/redact.mjs";

const PROTECTED_BRANCHES = "(main|master|production|prod|release)";

const shellRules = [
  { id: "git-force-push-protected", decision: "deny", re: new RegExp(`\\bgit\\s+push\\b(?=.*\\s(--force|-f)(\\s|$))(?=.*\\b${PROTECTED_BRANCHES}\\b)`, "i"), reason: "Force-pushing to a protected branch is not allowed." },
  { id: "git-force-push", decision: "ask", re: /\bgit\s+push\b.*\s(--force|-f)(\s|$)/i, reason: "Force push rewrites remote history (prefer --force-with-lease)." },
  { id: "rm-root", decision: "deny", re: /\brm\s+-[a-z]*(rf|fr)[a-z]*\s+(\/|~|\$HOME|\/\*)(\s|$)/i, reason: "Recursive delete of the filesystem root or home directory." },
  { id: "ps-remove-root", decision: "deny", re: /\bRemove-Item\b(?=.*-Recurse)(?=.*\s(['"]?[A-Za-z]:\\?['"]?|~|\$HOME|\$env:USERPROFILE)(\s|$))/i, reason: "Recursive delete of a drive root or home directory." },
  { id: "pipe-to-shell", decision: "ask", re: /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b|\|\s*(iex|Invoke-Expression)\b/i, reason: "Piping a remote script into a shell." },
  { id: "iac-destroy", decision: "ask", re: /\b(terraform|tofu|pulumi|cdk)\s+(destroy|apply\b.*-auto-approve|up\b.*--yes)/i, reason: "Infrastructure-as-code apply/destroy without review." },
  { id: "k8s-delete", decision: "ask", re: /\b(kubectl\s+(delete|drain|cordon|scale)|helm\s+(uninstall|delete|rollback))\b/i, reason: "Disruptive Kubernetes operation." },
  { id: "sql-destructive", decision: "ask", re: /\b(DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, reason: "Destructive SQL statement." },
];

function secretResponse(kinds, where) {
  return {
    permission: "deny",
    user_message: `ops guardrail: ${where} contains credential material (${kinds.join(", ")}).`,
    agent_message: `Blocked: ${where} contains credentials (${kinds.join(", ")}). Never inline secrets; use CLI profiles, environment variables or a secret manager.`,
  };
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
      return shellResponse(evaluateShell(payload.command, shellRules), "ops-core");
    },

    beforeMCPExecution(payload) {
      const cfg = loadConfig();
      const kinds = findSecrets(typeof payload.tool_input === "string" ? payload.tool_input : JSON.stringify(payload.tool_input ?? {}));
      if (kinds.length) return secretResponse(kinds, "these MCP tool arguments");
      const decision = decideThirdPartyMcp(payload, cfg);
      if (decision.permission !== "allow") audit({ source: "hook", event: "beforeMCPExecution", server: payload.mcp_server_name, tool: payload.tool_name, decision: decision.permission });
      return decision;
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
