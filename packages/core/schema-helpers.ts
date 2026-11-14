import type { Tool } from "./types.ts";

/** An expected, user-facing tool failure (bad input, policy, CLI error). */
export class ToolError extends Error {}

/** The JSON Schema subset tool inputs use. */
export interface JsonSchema {
  type?: "string" | "integer" | "number" | "boolean" | "object" | "array";
  description?: string;
  enum?: readonly unknown[];
  default?: unknown;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
}

declare const VALUE: unique symbol;

/** A JSON schema that also carries the validated value type `T` and whether it has a default. */
export interface Schema<T, D extends boolean = boolean> extends JsonSchema {
  readonly [VALUE]?: { value: T; hasDefault: D };
}

type AnySchema = Schema<unknown>;
type ValueOf<S> = S extends Schema<infer T> ? T : never;
/** The validated value type of a schema, e.g. a tool's arguments from its `input`. */
export type Infer<S> = ValueOf<S>;
type HasDefault<S> = S extends Schema<unknown, true> ? true : false;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type DefaultFlag<E> = E extends { default: unknown } ? true : false;

/** Required keys and keys with defaults are always present after validation; the rest are optional. */
export type InferObject<P extends Record<string, AnySchema>, R extends keyof P> = Simplify<
  {
    [K in keyof P as K extends R ? K : HasDefault<P[K]> extends true ? K : never]: ValueOf<P[K]>;
  } & {
    [K in keyof P as K extends R ? never : HasDefault<P[K]> extends true ? never : K]?: ValueOf<
      P[K]
    >;
  }
>;

type StringExtra = Pick<JsonSchema, "pattern" | "minLength" | "maxLength"> & { default?: string };
type NumberExtra = Pick<JsonSchema, "minimum" | "maximum"> & { default?: number };
type ListExtra<T> = Pick<JsonSchema, "minItems" | "maxItems"> & { default?: T[] };

export const str = <E extends StringExtra = Record<never, never>>(
  description: string,
  extra?: E,
): Schema<string, DefaultFlag<E>> => ({ type: "string", description, ...extra });

export const int = <E extends NumberExtra = Record<never, never>>(
  description: string,
  extra?: E,
): Schema<number, DefaultFlag<E>> => ({ type: "integer", description, ...extra });

export const bool = <V extends boolean | undefined = undefined>(
  description: string,
  defaultValue?: V,
): Schema<boolean, V extends boolean ? true : false> =>
  defaultValue === undefined
    ? { type: "boolean", description }
    : { type: "boolean", description, default: defaultValue };

export const oneOf = <
  const V extends readonly string[],
  D extends V[number] | undefined = undefined,
>(
  values: V,
  description: string,
  defaultValue?: D,
): Schema<V[number], D extends string ? true : false> =>
  defaultValue === undefined
    ? { type: "string", enum: values, description }
    : { type: "string", enum: values, description, default: defaultValue };

export const list = <I extends AnySchema, E extends ListExtra<ValueOf<I>> = Record<never, never>>(
  items: I,
  description: string,
  extra?: E,
): Schema<ValueOf<I>[], DefaultFlag<E>> => ({ type: "array", items, description, ...extra });

export const obj = <P extends Record<string, AnySchema>, R extends keyof P & string = never>(
  properties: P,
  required: readonly R[] = [],
): Schema<InferObject<P, R>, false> => ({
  type: "object",
  properties,
  required: [...required],
  additionalProperties: false,
});

/** Arbitrary JSON object (e.g. API parameters passed through as-is). */
export const freeform = (description: string): Schema<Record<string, unknown>, false> => ({
  type: "object",
  description,
  additionalProperties: true,
});

/** Object with string values only (e.g. query parameters). */
export const dict = (description: string): Schema<Record<string, string>, false> => ({
  type: "object",
  description,
  additionalProperties: { type: "string" },
});

/** Declare a tool with its argument type inferred from `input`. */
export const tool = <A extends object = Record<never, never>>(definition: Tool<A>): Tool<A> =>
  definition;

export function pick<T extends object, K extends string>(
  value: T | null | undefined,
  keys: readonly K[],
): Partial<Record<K, unknown>> {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    keys.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]),
  ) as Partial<Record<K, unknown>>;
}

export const PATTERNS = {
  slug: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$",
  githubRepo: "^[A-Za-z0-9-]{1,39}/[A-Za-z0-9_.-]{1,100}$",
  numericId: "^[0-9]{1,20}$",
  uuid: "^[0-9a-fA-F-]{8,64}$",
  awsRegion: "^[a-z]{2}(-gov)?-[a-z]+-[0-9]$",
  hostname: "^[A-Za-z0-9.-]{1,253}$",
} as const;

/** Reject strings that a CLI would parse as a flag (argument injection). */
export function notFlag(value: string, field: string): string {
  if (value.startsWith("-")) throw new ToolError(`${field} must not start with "-"`);
  return value;
}
