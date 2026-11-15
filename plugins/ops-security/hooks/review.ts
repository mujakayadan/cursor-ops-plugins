import { runHook } from "../lib/core/hook-runtime.ts";
import { reviewHooks } from "../lib/core/review.ts";

runHook(reviewHooks("security"));
