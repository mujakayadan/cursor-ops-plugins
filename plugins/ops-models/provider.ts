import { loadAccount } from "./account.ts";
import { bool, list, obj, oneOf, str, tool } from "./lib/core/schema-helpers.ts";
import type { Provider } from "./lib/core/types.ts";
import { route, TASKS } from "./route.ts";

const MODEL = "^[A-Za-z0-9][A-Za-z0-9._:+-]{0,80}$";

const tools = [
  tool({
    name: "models_account",
    title: "Cursor plan and models",
    tier: "read",
    description:
      "The signed-in Cursor plan, how much of the included model pool is left, and which models the Cursor CLI lists. Included models (Grok 4.7, Grok 4.6, Grok 4.5, Composer 2.5) draw from the subscription pool. Third-party models spend prepaid credit. When the CLI is not installed the plan is unknown and routing stays on included models at medium effort.",
    run: async () => {
      const account = await loadAccount();
      return {
        ...account,
        ...(account.cli
          ? {}
          : {
              install:
                "Install the Cursor CLI from https://cursor.com/docs/cli/installation and run `agent login` in a terminal. Do not pipe the install script.",
            }),
      };
    },
  }),
  tool({
    name: "models_route",
    title: "Choose model and effort",
    tier: "read",
    description:
      "Choose the model, effort and subagent id for one task from the account's plan and remaining included usage. routine and parallel work use Composer 2.5. Implementation uses Grok 4.7 at medium effort. Hard work raises effort only when the plan allows it and the included pool is healthy. A third-party model is used only when `prefer` names one and the account lists third-party models. `taskModel` is null when the subagent should inherit the chat model. Pass the session's subagent allowlist as `subagents`.",
    input: obj(
      {
        task: oneOf(TASKS, "How heavy the work is."),
        subagents: list(
          str("Subagent model id this session is allowed to launch.", { pattern: MODEL }),
          "Subagent model ids from this session's allowlist.",
          { maxItems: 30 },
        ),
        prefer: str("Model the user named.", { pattern: MODEL }),
        longContext: bool("The task needs more than the 256k window.", false),
      },
      ["task"],
    ),
    run: async (a) => route({ ...a, account: await loadAccount(), subagents: a.subagents ?? [] }),
  }),
];

const provider: Provider = {
  id: "models",
  displayName: "Models",
  version: "1.0.0",
  bin: "node",
  onboarding: { status: "models_account", skill: "model-routing" },
  instructions: {
    read: "Reads the Cursor plan and included-usage headroom from the Cursor CLI, and chooses a model and effort per task. Included Cursor models are the default. Third-party models are chosen only when the account lists them and the user named one.",
    write: "No write tools.",
  },
  tools,
};

export default provider;
