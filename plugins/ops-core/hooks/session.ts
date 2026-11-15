import { runHook } from "../lib/core/hook-runtime.ts";
import { loadProfile, profileContext } from "../lib/core/profile.ts";

runHook({
  sessionStart: () => ({ additional_context: profileContext(loadProfile()) }),
});
