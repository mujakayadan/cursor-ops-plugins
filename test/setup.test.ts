import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { Install } from "../packages/core/types.ts";
import { methodFor } from "../scripts/setup.ts";

const latex: Install = {
  bin: "pdflatex",
  winget: "MiKTeX.MiKTeX",
  brew: "--cask basictex",
  docs: "https://miktex.org",
};
const vercel: Install = { bin: "vercel", pnpm: "vercel", winget: "x", docs: "https://vercel.com" };
const all = () => true;

describe("ops setup methods", () => {
  it("prefers pnpm into the suite tools dir", () => {
    const m = methodFor(vercel, "win32", all);
    assert.equal(m?.kind, "pnpm");
    assert.deepEqual(m?.argv.slice(0, 3), ["pnpm", "add", "--dir"]);
    assert.equal(m?.argv.at(-1), "vercel");
  });

  it("uses winget on Windows and Homebrew elsewhere, splitting casks", () => {
    assert.equal(methodFor(latex, "win32", all)?.argv[3], "MiKTeX.MiKTeX");
    assert.deepEqual(methodFor(latex, "darwin", all)?.argv, [
      "brew",
      "install",
      "--cask",
      "basictex",
    ]);
  });

  it("falls back to manual when the package manager is missing", () => {
    assert.equal(
      methodFor(latex, "win32", (b) => b !== "winget"),
      undefined,
    );
    assert.equal(
      methodFor(vercel, "linux", (b) => b !== "pnpm"),
      undefined,
    );
  });
});
