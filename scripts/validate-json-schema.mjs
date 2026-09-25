function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported schema reference ${ref}`);
  return ref.slice(2).split('/').reduce((value, part) => value[part.replace(/~1/g, '/').replace(/~0/g, '~')], root);
}

export function validateJsonSchema(value, schema, root = schema, location = '$') {
  const errors = [];
  if (schema.$ref) return validateJsonSchema(value, resolveRef(root, schema.$ref), root, location);
  if (schema.const !== undefined && !sameValue(value, schema.const)) errors.push(`${location} must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((candidate) => sameValue(value, candidate))) {
    errors.push(`${location} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) errors.push(`${location} must be ${types.join(' or ')}`);
  }
  if (schema.format === 'date-time' && value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) {
    errors.push(`${location} must be an ISO date-time`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${location} is shorter than ${schema.minLength}`);
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) errors.push(`${location} does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${location} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${location} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${location} has fewer than ${schema.minItems} items`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${location} must contain unique items`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateJsonSchema(item, schema.items, root, `${location}[${index}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${location} is missing ${key}`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) errors.push(...validateJsonSchema(value[key], childSchema, root, `${location}.${key}`));
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key)) errors.push(`${location} has unexpected property ${key}`);
      }
    }
  }
  return errors;
}
