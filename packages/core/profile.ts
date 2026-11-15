import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { opsHome } from "./config.ts";

/** How technical the user is, which sets how the agent talks to them and what it asks. */
export const EXPERTISE = ["senior-engineer", "engineer", "technical", "non-technical"] as const;
export type Expertise = (typeof EXPERTISE)[number];

export interface Profile {
  expertise: Expertise;
  /** Free text such as "staff backend engineer" or "product manager". */
  role?: string;
  /** Standing preferences the user stated, one per entry. */
  notes?: string[];
}

export const MAX_NOTE = 300;
export const MAX_NOTES = 20;

export function profilePath(): string {
  return join(opsHome(), "profile.json");
}

export function loadProfile(): Profile | undefined {
  const path = profilePath();
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Profile>;
    if (!raw.expertise || !EXPERTISE.includes(raw.expertise)) return undefined;
    return {
      expertise: raw.expertise,
      ...(typeof raw.role === "string" && raw.role ? { role: raw.role.slice(0, MAX_NOTE) } : {}),
      ...(Array.isArray(raw.notes)
        ? {
            notes: raw.notes
              .filter((n): n is string => typeof n === "string" && n.trim() !== "")
              .slice(0, MAX_NOTES)
              .map((n) => n.slice(0, MAX_NOTE)),
          }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export function saveProfile(profile: Profile): void {
  const path = profilePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`);
  renameSync(tmp, path);
}

function styleFor(expertise: Expertise): string {
  switch (expertise) {
    case "senior-engineer":
      return [
        "The user is a senior software engineer. Communicate peer to peer: precise technical vocabulary, no explanations of fundamentals, lead with the result and the trade-offs, and give exact commands, paths, versions and numbers.",
        "Resolve everything you can yourself. Ask only what is genuinely the user's call, framed as a technical trade-off with a recommended option.",
        "Finish work end to end. Leave an item open only when the user has to act (a sign-in, an approval, something physical) or decide; ask that decision with AskQuestion instead of listing it as remaining.",
      ].join(" ");
    case "engineer":
      return "The user is a software engineer. Use technical vocabulary and skip basics, give a one-line rationale for non-obvious choices, and ask about design decisions with a recommended option.";
    case "technical":
      return "The user is technical but not a software engineer. Explain engineering terms on first use, ask about goals and constraints rather than implementation details, and recommend defaults for technical choices.";
    case "non-technical":
      return "The user is not technical. Use plain language without jargon, ask about outcomes rather than implementation, make technical choices with safe defaults and say what you chose, and explain what will happen before any action with side effects.";
    default: {
      const unknown: never = expertise;
      return unknown;
    }
  }
}

/** Context injected at the start of every conversation. */
export function profileContext(profile: Profile | undefined): string {
  if (!profile) {
    return [
      "User profile: unknown. Before your first question to the user in this conversation, ask once with AskQuestion which describes them best: senior software engineer, software engineer, technical but not an engineer, or not technical.",
      "Save the answer with control_profile_set (ops-control) so later conversations know it. Until then, infer the level from how they write.",
    ].join(" ");
  }
  const lines = [`User profile: ${styleFor(profile.expertise)}`];
  if (profile.role) lines.push(`Role: ${profile.role}.`);
  for (const note of profile.notes ?? []) lines.push(`- ${note}`);
  lines.push(
    "Update the profile with control_profile_set when the user states a lasting preference.",
    "Model routing: call models_route (ops-models) before a substantial task or a subagent. Included Cursor models are the default (Composer 2.5 for routine and parallel work, Grok 4.7 at medium effort for implementation). Raise effort only when the route says high. A third-party model spends prepaid credit; use one only when the route's billing is credit.",
  );
  return lines.join("\n");
}
