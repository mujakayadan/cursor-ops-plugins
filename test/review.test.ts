import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { deepMerge, loadConfig } from "../packages/core/config.ts";
import {
  displayPath,
  REVIEW_MARKER,
  recordEdit,
  recordPrompt,
  requestReview,
} from "../packages/core/review.ts";
import { referenceHints, removedIdentifiers, staleMentions } from "../packages/core/review-docs.ts";
import { scanEdit } from "../packages/core/review-scan.ts";
import type { Config, HookPayload } from "../packages/core/types.ts";

let dir: string;
let root: string;
let cfg: Config;

const turn = (gen: string, extra: Partial<HookPayload> = {}): HookPayload => ({
  conversation_id: "c1",
  generation_id: gen,
  workspace_roots: [root],
  ...extra,
});

function edit(gen: string, file: string, newString: string, oldString = ""): void {
  const payload = turn(gen, {
    file_path: join(root, file),
    edits: [{ old_string: oldString, new_string: newString }],
  });
  recordEdit(payload, "security", cfg);
  recordEdit(payload, "performance", cfg);
}

const stop = (gen: string, loop = 0) =>
  requestReview(turn(gen, { status: "completed", loop_count: loop }), cfg);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ops-review-"));
  root = join(dir, "ws");
  mkdirSync(join(root, "src"), { recursive: true });
  process.env.OPS_REVIEW_DIR = join(dir, "state");
  delete process.env.OPS_REVIEW;
  cfg = loadConfig({ reload: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.OPS_REVIEW_DIR;
});

describe("review coordination", () => {
  const CODE =
    "for (const id of ids) {\n  const row = await db.query(`SELECT * FROM t WHERE id = ${id}`);\n  out.push(row);\n}";

  it("requests one combined review covering every installed lens", () => {
    recordPrompt(turn("g1", { prompt: "load rows" }), "security", cfg);
    recordPrompt(turn("g1", { prompt: "load rows" }), "performance", cfg);
    edit("g1", "src/rows.ts", CODE);
    const message = stop("g1").followup_message ?? "";
    assert.ok(message.startsWith(REVIEW_MARKER));
    assert.ok(message.indexOf("### Performance") < message.indexOf("### Security"));
    assert.match(message, /security\/sql-injection/);
    assert.match(message, /performance\/query-in-loop/);
    assert.match(message, /ops-performance, ops-security/);
  });

  it("answers every stop hook of the same turn identically", () => {
    edit("g1", "src/rows.ts", CODE);
    const first = stop("g1");
    const second = stop("g1");
    assert.ok(first.followup_message);
    assert.deepEqual(second, first);
  });

  it("does not re-review fixes made during the review round", () => {
    recordPrompt(turn("g1", { prompt: "load rows" }), "security", cfg);
    edit("g1", "src/rows.ts", CODE);
    assert.ok(stop("g1").followup_message);
    recordPrompt(turn("g2", { prompt: `${REVIEW_MARKER} Automatic review` }), "security", cfg);
    edit("g2", "src/rows.ts", "const rows = await db.query(sql, [ids]);\nreturn rows;\n// batched");
    assert.deepEqual(stop("g2", 1), {});
  });

  it("reviews the next user turn again, but only its own changes", () => {
    edit("g1", "src/rows.ts", CODE);
    stop("g1");
    recordPrompt(turn("g3", { prompt: "now add caching" }), "security", cfg);
    edit(
      "g3",
      "src/cache.ts",
      "const cache = new Map();\nexport const get = (k) => cache.get(k);\nexport const set = (k, v) => cache.set(k, v);",
    );
    const message = stop("g3").followup_message ?? "";
    assert.match(message, /`src\/cache\.ts`/);
    assert.doesNotMatch(message, /rows\.ts/);
  });

  it("honours ignore patterns and the kill switch", () => {
    cfg = deepMerge(cfg, { review: { ignore: ["^src/generated/"] } });
    edit("g1", "src/generated/api.ts", CODE);
    assert.deepEqual(stop("g1"), {});

    process.env.OPS_REVIEW = "off";
    edit("g2", "src/rows.ts", CODE);
    assert.deepEqual(stop("g2"), {});
  });

  it("skips aborted turns and turns without a conversation", () => {
    edit("g1", "src/rows.ts", CODE);
    assert.deepEqual(requestReview(turn("g1", { status: "aborted" }), cfg), {});
    assert.deepEqual(requestReview({ status: "completed" }, cfg), {});
  });

  it("asks for subagents only on large changes", () => {
    for (let i = 0; i < 8; i++) edit("g1", `src/f${i}.ts`, CODE);
    assert.match(
      stop("g1").followup_message ?? "",
      /security-reviewer.*performance-reviewer|performance-reviewer.*security-reviewer/,
    );
  });
});

describe("review scanner", () => {
  it("reports hints with file line numbers when the file is readable", () => {
    const file = join(root, "src", "a.py");
    const added = "def run(cmd):\n    subprocess.run(cmd, shell=True)";
    writeFileSync(file, `import subprocess\n\n${added}\n`);
    const hints = scanEdit(
      "security",
      "src/a.py",
      [{ new_string: added }],
      `import subprocess\n\n${added}\n`,
    );
    assert.deepEqual(
      hints.map((h) => [h.rule, h.line]),
      [["security/shell-injection", 4]],
    );
  });

  it("flags secrets, TLS bypass and weak crypto but not ordinary code", () => {
    const rules = (text: string, path = "src/x.ts") =>
      scanEdit("security", path, [{ new_string: text }]).map((h) => h.rule);
    assert.deepEqual(rules('const key = "AKIAIOSFODNN7EXAMPLE";'), ["security/hardcoded-secret"]);
    assert.deepEqual(rules("https.request({ rejectUnauthorized: false })"), [
      "security/tls-disabled",
    ]);
    assert.deepEqual(rules('crypto.createHash("md5")'), ["security/weak-crypto"]);
    assert.deepEqual(rules("const total = items.reduce((a, b) => a + b, 0);"), []);
  });

  it("flags performance smells but leaves concurrent code alone", () => {
    const rules = (text: string) =>
      scanEdit("performance", "src/x.ts", [{ new_string: text }]).map((h) => h.rule);
    assert.deepEqual(rules("users.map((u) => orders.find((o) => o.user === u.id))"), [
      "performance/nested-scan",
    ]);
    assert.deepEqual(rules("for (const u of users) {\n  await notify(u);\n}"), [
      "performance/await-in-loop",
    ]);
    assert.deepEqual(rules("await Promise.all(users.map((u) => notify(u)));"), []);
  });

  it("flags history narration, dead code and shims but not present-tense code", () => {
    const rules = (text: string, path = "src/x.ts") =>
      scanEdit("standards", path, [{ new_string: text }]).map((h) => h.rule);
    assert.deepEqual(rules("// The parser no longer accepts YAML."), ["standards/history-comment"]);
    assert.deepEqual(rules("# previously returned None\nreturn []", "src/x.py"), [
      "standards/history-comment",
    ]);
    assert.deepEqual(rules("// const old = load(path);"), ["standards/commented-out-code"]);
    assert.deepEqual(rules("export const fetchUserV1 = fetchUser;"), ["standards/compat-shim"]);
    assert.deepEqual(rules("// @ts-ignore\nrun();"), ["standards/suppression"]);
    assert.deepEqual(rules("The `serve` command was renamed from `start`.", "docs/cli.md"), [
      "standards/history-doc",
    ]);
    assert.deepEqual(rules("// Parses JSON config; YAML is not supported.\nparse(text);"), []);
    assert.deepEqual(rules("Run `pnpm serve` to start the server.", "docs/cli.md"), []);
  });

  it("flags personal and machine-specific paths but not placeholders", () => {
    const rules = (text: string, path = "docs/setup.md") =>
      scanEdit("standards", path, [{ new_string: text }]).map((h) => h.rule);
    for (const text of [
      "Clone into C:\\Users\\alice\\code.",
      "Clone into c:\\users\\bob\\code.",
      "Open C:\\Users\\me.alice\\code.",
      "Projects live in D:\\Work\\app.",
      "Projects live in d:\\work\\app.",
      'const dir = "/home/alice/app";',
      "See file:///Users/alice/notes.",
      "Mounted at /mnt/c/Users/alice/code.",
    ]) {
      assert.deepEqual(rules(text), ["standards/personal-path"], text);
    }
    for (const text of [
      "Use `C:/Users/<you>/.ops/gh-read` or `~/code/app`.",
      "Shared files are in C:\\Users\\Public\\x and /Users/Shared/x.",
      "Expand C:\\Users\\%USERNAME%\\x or /home/$USER/app.",
      "Set %USERPROFILE% or $HOME; see https://example.com/home/docs.",
      "Create C:\\code\\app for the example.",
    ]) {
      assert.deepEqual(rules(text), [], text);
    }
  });

  it("finds docs that mention identifiers an edit removed", () => {
    writeFileSync(join(root, "README.md"), "# App\n\nCall `loadOrderTotals()` first.\n");
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(root, "node_modules", "dep", "README.md"), "loadOrderTotals");
    writeFileSync(join(root, "CHANGELOG.md"), "- added loadOrderTotals");
    const removed = removedIdentifiers(
      [
        {
          old_string: "export function loadOrderTotals() {",
          new_string: "export function orderTotals() {",
        },
      ],
      "export function orderTotals() {}\n",
    );
    assert.deepEqual(removed, ["loadOrderTotals"]);
    assert.deepEqual(
      staleMentions(root, removed).map((h) => h.message),
      [
        "`README.md:3` mentions `loadOrderTotals`, which this edit removed; update or delete that text if nothing defines it",
      ],
    );
  });

  it("checks links and repository paths in added doc lines", () => {
    writeFileSync(join(root, "src", "a.ts"), "");
    const doc = join(root, "docs", "guide.md");
    const hints = referenceHints(
      doc,
      root,
      [
        "See [a](../src/a.ts), [gone](../src/gone.ts), [web](https://x.dev) and [top](#top).",
        "Paths: `src/a.ts`, `src/b.ts`, `hooks/hooks.json`, `~/.ops/config.json`, `plugins/*/x`.",
      ],
      10,
    );
    assert.deepEqual(
      hints.map((h) => [h.rule, h.line, h.message]),
      [
        ["docs/broken-link", 10, "link target `../src/gone.ts` does not exist"],
        ["docs/missing-path", 11, "`src/b.ts` does not exist"],
      ],
    );
  });

  it("shows workspace-relative paths with forward slashes", () => {
    assert.equal(displayPath(join(root, "src", "a.ts"), [root]), "src/a.ts");
    assert.equal(
      displayPath(join(dir, "other.ts"), [root]),
      join(dir, "other.ts").replaceAll("\\", "/"),
    );
  });
});
