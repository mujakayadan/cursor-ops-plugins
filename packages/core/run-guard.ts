import provider from "../../provider.ts";
import { loadConfig } from "./config.ts";
import { runHook } from "./hook-runtime.ts";
import { decideOwnMcp, evaluateShell, shellResponse } from "./policy.ts";

runHook(
  {
    beforeMCPExecution: (payload) =>
      decideOwnMcp(provider, payload, loadConfig()) ?? { permission: "allow" },
    beforeShellExecution: (payload) =>
      shellResponse(
        evaluateShell(payload.command, provider.shellRules ?? [], payload),
        provider.displayName,
      ),
  },
  { failClosed: ["beforeMCPExecution", "beforeShellExecution"] },
);
