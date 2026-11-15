import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { loadProfile, profileContext, saveProfile } from "../packages/core/profile.ts";
import { forget, loadGraph, openEntities, remember, search } from "../plugins/ops-memory/graph.ts";
import memory from "../plugins/ops-memory/provider.ts";
import { classifyLicense } from "../plugins/ops-oss/vet.ts";

let dir: string;
const saved = { home: process.env.OPS_HOME, memory: process.env.OPS_MEMORY_FILE };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ops-knowledge-"));
  process.env.OPS_HOME = dir;
  process.env.OPS_MEMORY_FILE = join(dir, "graph.json");
});

afterEach(() => {
  for (const [name, value] of [
    ["OPS_HOME", saved.home],
    ["OPS_MEMORY_FILE", saved.memory],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("user profile", () => {
  it("asks once when no profile exists", () => {
    assert.equal(loadProfile(), undefined);
    assert.match(profileContext(undefined), /unknown.*AskQuestion.*control_profile_set/s);
  });
  it("round-trips and renders the communication style", () => {
    saveProfile({
      expertise: "senior-engineer",
      role: "platform engineer",
      notes: ["Prefers pnpm"],
    });
    const context = profileContext(loadProfile());
    assert.match(context, /senior software engineer/);
    assert.match(context, /Role: platform engineer\./);
    assert.match(context, /- Prefers pnpm/);
    assert.match(context, /models_route/);
  });
  it("ignores a profile with an unknown expertise level", () => {
    writeFileSync(join(dir, "profile.json"), '{"expertise":"wizard"}');
    assert.equal(loadProfile(), undefined);
  });
});

describe("memory graph", () => {
  it("upserts entities, skips repeated observations and links existing entities", () => {
    remember({
      entities: [
        { name: "Cognee", type: "oss-project", observations: ["Apache-2.0", "Scorecard 7.3"] },
        { name: "acme/app", type: "project", scope: "project:acme/app" },
      ],
      relations: [{ from: "cognee", to: "acme/app", type: "studied-for" }],
    });
    const second = remember({
      entities: [{ name: "cognee", type: "oss-project", observations: ["Apache-2.0", "Trial"] }],
    });
    assert.deepEqual(second, { created: 0, observed: 1, related: 0 });
    const graph = loadGraph();
    assert.equal(graph.entities.length, 2);
    assert.deepEqual(
      graph.entities[0]?.observations.map((o) => o.text),
      ["Apache-2.0", "Scorecard 7.3", "Trial"],
    );
    assert.deepEqual(graph.relations, [{ from: "Cognee", to: "acme/app", type: "studied-for" }]);
  });
  it("refuses relations to unknown entities", () => {
    assert.throws(
      () => remember({ relations: [{ from: "a", to: "b", type: "uses" }] }),
      /"a" is not an entity/,
    );
  });
  it("ranks name matches above body matches and filters by scope", () => {
    remember({
      entities: [
        { name: "pnpm", type: "tool", observations: ["package manager"] },
        { name: "user", type: "person", scope: "user", observations: ["prefers pnpm"] },
      ],
    });
    assert.deepEqual(
      search(loadGraph(), "pnpm", {}, 10).entities.map((e) => e.name),
      ["pnpm", "user"],
    );
    assert.deepEqual(
      search(loadGraph(), "pnpm", { scope: "user" }, 10).entities.map((e) => e.name),
      ["user"],
    );
    assert.deepEqual(openEntities(loadGraph(), ["PNPM", "nope"]).missing, ["nope"]);
  });
  it("forgets entities with their relations, and single observations", () => {
    remember({
      entities: [
        { name: "a", type: "x", observations: ["one", "two"] },
        { name: "b", type: "x" },
      ],
      relations: [{ from: "a", to: "b", type: "uses" }],
    });
    assert.deepEqual(forget({ entities: ["b"], observations: [{ entity: "a", text: "one" }] }), {
      entities: 1,
      relations: 1,
      observations: 1,
    });
    assert.deepEqual(
      loadGraph().entities.map((e) => [e.name, e.observations.map((o) => o.text)]),
      [["a", ["two"]]],
    );
  });
  it("rejects credentials before they are stored", async () => {
    const tool = memory.tools.find((t) => t.name === "memory_remember");
    const observations = ["token=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"];
    await assert.rejects(
      async () =>
        tool?.run({ entities: [{ name: "ci", type: "note", observations }] } as never, {} as never),
      /must not hold credentials/,
    );
    assert.equal(loadGraph().entities.length, 0);
  });
});

describe("license classes", () => {
  it("reads SPDX expressions by their best OR branch and worst AND term", () => {
    assert.equal(classifyLicense(["MIT"]), "permissive");
    assert.equal(classifyLicense(["MIT OR GPL-3.0-only"]), "permissive");
    assert.equal(classifyLicense(["Apache-2.0 AND LGPL-2.1-or-later"]), "weak-copyleft");
    assert.equal(
      classifyLicense(["(GPL-2.0-only WITH Classpath-exception-2.0)"]),
      "strong-copyleft",
    );
    assert.equal(classifyLicense(["BUSL-1.1"]), "restrictive");
    assert.equal(classifyLicense(["non-standard"]), "unknown");
    assert.equal(classifyLicense([]), "unknown");
  });
});
