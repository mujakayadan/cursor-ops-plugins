// GENERATED from packages/core/schema-helpers.mjs by scripts/sync-core.mjs. Edit the source, then run `npm run sync`.
/** An expected, user-facing tool failure (bad input, policy, CLI error). */
export class ToolError extends Error {}

export const str = (description, extra = {}) => ({ type: "string", description, ...extra });
export const int = (description, extra = {}) => ({ type: "integer", description, ...extra });
export const bool = (description, defaultValue) => ({ type: "boolean", description, default: defaultValue });
export const oneOf = (values, description, defaultValue) => ({ type: "string", enum: values, description, default: defaultValue });
export const list = (items, description, extra = {}) => ({ type: "array", items, description, ...extra });
export const obj = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
export const freeform = (description) => ({ type: "object", description, additionalProperties: true });

export function pick(value, keys) {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(keys.filter((k) => value[k] !== undefined).map((k) => [k, value[k]]));
}

export const PATTERNS = {
  slug: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$",
  githubRepo: "^[A-Za-z0-9-]{1,39}/[A-Za-z0-9_.-]{1,100}$",
  numericId: "^[0-9]{1,20}$",
  uuid: "^[0-9a-fA-F-]{8,64}$",
  awsRegion: "^[a-z]{2}(-gov)?-[a-z]+-[0-9]$",
  hostname: "^[A-Za-z0-9.-]{1,253}$",
};

/** Reject strings that a CLI would parse as a flag (argument injection). */
export function notFlag(value, field) {
  if (typeof value === "string" && value.startsWith("-")) {
    throw new ToolError(`${field} must not start with "-"`);
  }
  return value;
}
