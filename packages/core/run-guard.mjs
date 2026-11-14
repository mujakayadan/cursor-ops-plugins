import { loadConfig } from "./config.mjs";
import { runHook } from "./hook-runtime.mjs";
import { decideOwnMcp, evaluateShell, shellResponse } from "./policy.mjs";
import provider from "../../provider.mjs";

runHook(
  {
    beforeMCPExecution: (payload) => decideOwnMcp(provider, payload, loadConfig()) ?? { permission: "allow" },
    beforeShellExecution: (payload) => shellResponse(evaluateShell(payload.command, provider.shellRules ?? []), provider.displayName),
  },
  { failClosed: ["beforeMCPExecution", "beforeShellExecution"] },
);
