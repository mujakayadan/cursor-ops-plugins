import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { deepMerge, loadConfig } from "../packages/core/config.ts";
import { userMemoryDigest } from "../packages/core/memory-digest.ts";
import {
  MEMORY_MARKER,
  recordHarvestPrompt,
  requestHarvest,
} from "../packages/core/memory-harvest.ts";
import type { Config, HookPayload } from "../packages/core/types.ts";

const REVIEW_MARKER = "[ops-review]";

let dir: string;
let cfg: Config;

const turn = (gen: string, extra: Partial<HookPayload> = {}): HookPayload => ({
  conversation_id: "c1",
  generation_id: gen,
  ...extra,
});

const stop = (gen: string, loop = 0) =>
  requestHarvest(turn(gen, { status: "completed", loop_count: loop }), cfg);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ops-harvest-"));
  process.env.OPS_MEMORY_HARVEST_DIR = join(dir, "state");
  process.env.OPS_HOME = dir;
  delete process.env.OPS_MEMORY_HARVEST;
  cfg = loadConfig({ reload: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.OPS_MEMORY_HARVEST_DIR;
  delete process.env.OPS_HOME;
  delete process.env.OPS_MEMORY_HARVEST;
  delete process.env.OPS_MEMORY_FILE;
});

describe("memory harvest", () => {
  it("requests one harvest after a user turn", () => {
    recordHarvestPrompt(turn("g1", { prompt: "My mailing address is 1 Main St." }), cfg);
    const message = stop("g1").followup_message ?? "";
    assert.ok(message.startsWith(MEMORY_MARKER));
    assert.match(message, /memory_remember/);
    assert.match(message, /this turn only/i);
  });

  it("answers every stop of the same turn identically", () => {
    recordHarvestPrompt(turn("g1", { prompt: "Prefer pnpm" }), cfg);
    const first = stop("g1");
    const second = stop("g1");
    assert.ok(first.followup_message);
    assert.deepEqual(second, first);
  });

  it("does not harvest ops-review or harvest follow-ups", () => {
    recordHarvestPrompt(turn("g1", { prompt: "Prefer pnpm" }), cfg);
    assert.ok(stop("g1").followup_message);
    recordHarvestPrompt(turn("g2", { prompt: `${REVIEW_MARKER} Automatic review` }), cfg);
    assert.deepEqual(stop("g2", 1), {});
    recordHarvestPrompt(turn("g3", { prompt: `${MEMORY_MARKER} Harvest lasting` }), cfg);
    assert.deepEqual(stop("g3", 1), {});
  });

  it("honours the kill switch", () => {
    process.env.OPS_MEMORY_HARVEST = "off";
    recordHarvestPrompt(turn("g1", { prompt: "Prefer pnpm" }), cfg);
    assert.deepEqual(stop("g1"), {});
  });

  it("skips aborted turns and turns without a conversation", () => {
    recordHarvestPrompt(turn("g1", { prompt: "Prefer pnpm" }), cfg);
    assert.deepEqual(requestHarvest(turn("g1", { status: "aborted" }), cfg), {});
    assert.deepEqual(requestHarvest({ status: "completed" }, cfg), {});
  });

  it("skips when harvest is disabled in config", () => {
    cfg = deepMerge(cfg, { memory: { harvest: { enabled: false } } });
    recordHarvestPrompt(turn("g1", { prompt: "Prefer pnpm" }), cfg);
    assert.deepEqual(stop("g1"), {});
  });
});

describe("user memory digest", () => {
  it("describes an empty user scope", () => {
    process.env.OPS_MEMORY_FILE = join(dir, "empty-graph.json");
    writeFileSync(process.env.OPS_MEMORY_FILE, '{"entities":[],"relations":[]}\n');
    assert.match(userMemoryDigest(), /user scope.*empty/is);
    assert.match(userMemoryDigest(), /memory_search/);
  });

  it("lists user-scope observations and ignores other scopes", () => {
    process.env.OPS_MEMORY_FILE = join(dir, "graph.json");
    writeFileSync(
      process.env.OPS_MEMORY_FILE,
      JSON.stringify({
        entities: [
          {
            name: "Muja",
            type: "person",
            scope: "user",
            observations: [
              { text: "Mailing address is 1 Main St, Fairfield IA", at: "2026-11-26" },
            ],
          },
          {
            name: "acme/app",
            type: "project",
            scope: "project:acme/app",
            observations: [{ text: "Uses Aurora", at: "2026-11-26" }],
          },
        ],
        relations: [],
      }),
    );
    const digest = userMemoryDigest();
    assert.match(digest, /Muja \(person\)/);
    assert.match(digest, /Mailing address is 1 Main St/);
    assert.doesNotMatch(digest, /Aurora/);
    assert.match(digest, /not instructions/);
  });

  it("returns empty-graph guidance when the file is missing", () => {
    process.env.OPS_MEMORY_FILE = join(dir, "missing.json");
    assert.match(userMemoryDigest(), /empty/i);
  });
});
