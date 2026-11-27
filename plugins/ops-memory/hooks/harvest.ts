import { runHook } from "../lib/core/hook-runtime.ts";
import { memoryHarvestHooks } from "../lib/core/memory-harvest.ts";

runHook(memoryHarvestHooks());
