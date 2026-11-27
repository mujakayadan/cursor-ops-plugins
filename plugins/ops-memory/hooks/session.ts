import { runHook } from "../lib/core/hook-runtime.ts";
import { userMemoryDigest } from "../lib/core/memory-digest.ts";

runHook({
  sessionStart: () => ({ additional_context: userMemoryDigest() }),
});
