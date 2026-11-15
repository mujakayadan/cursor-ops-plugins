import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import { describe, it } from "vitest";
import { assertWorkBranch, worktreePath } from "../scripts/worktree.ts";

describe("ops worktree paths", () => {
  it("places linked checkouts under <repo>-wt/<kebab>", () => {
    const root = join("D:", "Codes", "cursor-ops-plugins");
    assert.equal(
      worktreePath(root, "octocat/feat/health-check"),
      join(dirname(root), `${basename(root)}-wt`, "health-check"),
    );
  });
  it("accepts GitOps work branch names and rejects the rest", () => {
    assertWorkBranch("octocat/fix/login-timeout");
    assert.throws(() => assertWorkBranch("dev"), /must be/);
    assert.throws(() => assertWorkBranch("octocat/feature/x"), /must be/);
    assert.throws(() => assertWorkBranch("octocat/feat/Health"), /must be/);
  });
});
