#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGINS_DIR, REPO_ROOT } from "./lib.ts";

/**
 * Each review plugin's always-on rule is generated from a shared fragment, and scaffolded
 * projects include the same fragments in AGENTS.md, so both always state one standard.
 */
interface Standard {
  fragment: string;
  plugin: string;
  title: string;
  description: string;
  review: string;
  scope: string;
}

const STANDARDS: Standard[] = [
  {
    fragment: "clean-code",
    plugin: "ops-standards",
    title: "Clean code, current state only",
    description:
      "Clean-code standard applied to every change while ops-standards is installed; code and docs describe only the current state.",
    review: "standards-review",
    scope: "code or docs",
  },
  {
    fragment: "docs-current",
    plugin: "ops-docs",
    title: "Docs match the code",
    description:
      "Documentation stays exactly in step with the code; update docs in the same change as the code they describe.",
    review: "docs-review",
    scope: "code or docs",
  },
  {
    fragment: "secure-by-default",
    plugin: "ops-security",
    title: "Secure by default",
    description:
      "Secure-by-default coding baseline applied to every change while ops-security is installed.",
    review: "security-review",
    scope: "code",
  },
  {
    fragment: "performance-aware",
    plugin: "ops-performance",
    title: "Performance aware",
    description:
      "Performance-aware coding baseline applied to every change while ops-performance is installed.",
    review: "performance-review",
    scope: "code",
  },
];

const FRAGMENT_DIR = join(REPO_ROOT, "templates", "_shared", "standards");

function render(s: Standard, body: string): string {
  return [
    "---",
    `description: ${s.description}`,
    "alwaysApply: true",
    "---",
    "",
    `<!-- Generated from templates/_shared/standards/${s.fragment}.md by scripts/sync-standards.ts. -->`,
    "",
    `# ${s.title}`,
    "",
    body.trimEnd(),
    `- When a turn changes ${s.scope}, the ${s.plugin} stop hook asks for a \`${s.review}\`. Do it properly and briefly. Don't skip it, and don't review work you didn't change.`,
    "",
  ].join("\n");
}

const check = process.argv.includes("--check");
let drift = 0;
for (const s of STANDARDS) {
  const body = readFileSync(join(FRAGMENT_DIR, `${s.fragment}.md`), "utf8");
  if (/\{[{%#]/.test(body)) {
    console.error(`templates/_shared/standards/${s.fragment}.md must not contain Jinja syntax`);
    process.exit(1);
  }
  const target = join(PLUGINS_DIR, s.plugin, "rules", `${s.fragment}.mdc`);
  const expected = render(s, body);
  if (existsSync(target) && readFileSync(target, "utf8") === expected) continue;
  drift++;
  if (check) console.error(`drift: plugins/${s.plugin}/rules/${s.fragment}.mdc`);
  else writeFileSync(target, expected);
}

if (check && drift) {
  console.error(`\n${drift} generated rule(s) out of date. Run \`pnpm run sync\`.`);
  process.exit(1);
}
console.log(check ? "standards rules are in sync" : `synced ${STANDARDS.length} standards rules`);
