function typeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  return actual === type;
}

/** Minimal JSON Schema validator covering the subset used by tool definitions. Applies defaults. */
export function validate(schema, value, path = "input") {
  const errors = [];
  if (value === undefined && schema.default !== undefined) {
    value = structuredClone(schema.default);
  }
  if (value === undefined) return { value, errors };

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path} must be ${schema.type}`);
    return { value, errors };
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of: ${schema.enum.join(", ")}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path} has an invalid format`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} allows at most ${schema.maxItems} items`);
    if (schema.items) {
      value = value.map((item, i) => {
        const r = validate(schema.items, item, `${path}[${i}]`);
        errors.push(...r.errors);
        return r.value;
      });
    }
  }
  if (typeOf(value) === "object" && schema.type === "object") {
    const props = schema.properties ?? {};
    const out = {};
    for (const key of schema.required ?? []) {
      if (value[key] === undefined && props[key]?.default === undefined) errors.push(`${path}.${key} is required`);
    }
    for (const [key, sub] of Object.entries(props)) {
      const r = validate(sub, value[key], `${path}.${key}`);
      errors.push(...r.errors);
      if (r.value !== undefined) out[key] = r.value;
    }
    for (const key of Object.keys(value)) {
      if (props[key]) continue;
      if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
      else out[key] = value[key];
    }
    value = out;
  }
  return { value, errors };
}
