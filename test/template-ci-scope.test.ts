import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { templateCiShouldRun } from "../scripts/template-ci-scope.ts";

describe("template CI scope", () => {
  it("runs when a template, the copier questions, or the template test change", () => {
    assert.equal(templateCiShouldRun(["templates/java/AGENTS.md.jinja"]), true);
    assert.equal(templateCiShouldRun(["README.md", "copier.yml"]), true);
    assert.equal(templateCiShouldRun(["scripts/test-templates.ts"]), true);
    assert.equal(templateCiShouldRun(["scripts/template-ci-scope.ts"]), true);
  });

  it("skips a pull request that leaves the scaffold alone", () => {
    assert.equal(templateCiShouldRun(["README.md", "plugins/ops-models/route.ts"]), false);
    assert.equal(templateCiShouldRun(["templates-notes.md"]), false);
    assert.equal(templateCiShouldRun([""]), false);
  });
});
