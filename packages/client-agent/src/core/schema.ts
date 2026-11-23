import type { JSONSchemaObject } from './types.js';

export interface SchemaErrorDetail {
  /** Dotted path inside the arguments object, "" for the root. */
  path: string;
  keyword: string;
  message: string;
}

export type SchemaValidation =
  | { valid: true; value: Record<string, unknown> }
  | { valid: false; errors: SchemaErrorDetail[] };

/** Keywords the runtime validator actually enforces. Anything else is reported by the build. */
export const SUPPORTED_KEYWORDS = new Set([
  '$schema',
  '$id',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'description',
  'title',
  'default',
  'examples',
]);

/** Keywords accepted in a declaration but never enforced at runtime. */
export const IGNORED_KEYWORDS = new Set(['format', 'examples', 'default', 'title', 'description', '$schema', '$id']);

export function unsupportedKeywords(schema: JSONSchemaObject | undefined, prefix = ''): string[] {
  if (!schema) return [];
  const found: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) found.push(prefix ? `${prefix}.${key}` : key);
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    if (child === null || typeof child !== 'object' || Array.isArray(child)) continue;
    found.push(...unsupportedKeywords(child, prefix ? `${prefix}.${name}` : name));
  }
  if (schema.items && !Array.isArray(schema.items)) {
    found.push(...unsupportedKeywords(schema.items, prefix ? `${prefix}.items` : 'items'));
  }
  for (const [i, child] of (schema.anyOf ?? []).entries()) {
    found.push(...unsupportedKeywords(child, `${prefix ? `${prefix}.` : ''}anyOf[${i}]`));
  }
  for (const [i, child] of (schema.oneOf ?? []).entries()) {
    found.push(...unsupportedKeywords(child, `${prefix ? `${prefix}.` : ''}oneOf[${i}]`));
  }
  return found;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, declared: string): boolean {
  const actual = typeOf(value);
  if (declared === 'number') return actual === 'number' || actual === 'integer';
  if (declared === 'integer') return actual === 'integer';
  return actual === declared;
}

function joinPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

/**
 * Validates extracted tool arguments against the capability's schema.
 * Errors are ordered by path so a model can read them top-down.
 */
export function validateParams(
  value: unknown,
  schema: JSONSchemaObject | undefined,
): SchemaValidation {
  const errors: SchemaErrorDetail[] = [];
  if (!schema) {
    if (value === undefined) return { valid: true, value: {} };
    if (value === null) return { valid: true, value: {} };
    if (typeof value !== 'object' || Array.isArray(value)) {
      return {
        valid: false,
        errors: [{ path: '', keyword: 'type', message: 'arguments must be an object' }],
      };
    }
    return { valid: true, value: value as Record<string, unknown> };
  }
  walk(value, schema, '', errors);
  const root = typeof value === 'object' && value !== null && !Array.isArray(value);
  if (errors.length === 0) {
    return { valid: true, value: root ? (value as Record<string, unknown>) : {} };
  }
  errors.sort((a, b) => a.path.localeCompare(b.path));
  return { valid: false, errors };
}

/** Turns validator output into the single line the model sees on a retry. */
export function formatSchemaErrors(errors: SchemaErrorDetail[]): string[] {
  return errors.map((e) => {
    const where = e.path ? `arguments.${e.path}` : 'arguments';
    return `${where} ${e.message} (${e.keyword})`;
  });
}

function walk(value: unknown, schema: JSONSchemaObject, path: string, errors: SchemaErrorDetail[]): void {
  const push = (keyword: string, message: string) => errors.push({ path, keyword, message });
  const where = path ? `arguments.${path}` : 'arguments';

  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    push('const', `must equal ${JSON.stringify(schema.const)}`);
  }

  if (schema.enum) {
    const ok = schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value));
    if (!ok) push('enum', `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }

  if (schema.type) {
    const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!declared.some((t) => matchesType(value, t))) {
      push('type', `must be ${declared.join(' | ')}, got ${typeOf(value)}`);
      return; // further keywords assume the type held
    }
  }

  if (schema.anyOf && schema.anyOf.length > 0) {
    const attempts = schema.anyOf.map((sub) => {
      const local: SchemaErrorDetail[] = [];
      walk(value, sub, path, local);
      return local;
    });
    if (!attempts.some((a) => a.length === 0)) {
      const summary = attempts
        .map((a, i) => `option ${i + 1}: ${a.map((e) => e.message).join(', ') || 'no match'}`)
        .join('; ');
      push('anyOf', `must match one of the allowed shapes (${summary})`);
    }
  }

  if (schema.oneOf && schema.oneOf.length > 0) {
    const passing = schema.oneOf.filter((sub) => {
      const local: SchemaErrorDetail[] = [];
      walk(value, sub, path, local);
      return local.length === 0;
    }).length;
    if (passing !== 1) push('oneOf', `must match exactly one shape, matched ${passing}`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      push('minLength', `must be at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      push('maxLength', `must be at most ${schema.maxLength} characters`);
    }
    if (schema.pattern) {
      let re: RegExp | undefined;
      try {
        re = new RegExp(schema.pattern);
      } catch {
        push('pattern', `schema pattern is not a valid regular expression`);
      }
      if (re && !re.test(value)) push('pattern', `must match /${schema.pattern}/`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      push('minimum', `must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      push('maximum', `must be <= ${schema.maximum}`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      push('exclusiveMinimum', `must be > ${schema.exclusiveMinimum}`);
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      push('exclusiveMaximum', `must be < ${schema.exclusiveMaximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      push('minItems', `must contain at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      push('maxItems', `must contain at most ${schema.maxItems} items`);
    }
    if (schema.items && !Array.isArray(schema.items)) {
      value.forEach((item, i) => walk(item, schema.items as JSONSchemaObject, joinPath(path, i), errors));
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record) || record[key] === undefined) {
        const missingPath = joinPath(path, key);
        errors.push({
          path: missingPath || key,
          keyword: 'required',
          message: `is required but was not provided`,
        });
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in record && record[key] !== undefined) {
        walk(record[key], sub, joinPath(path, key), errors);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in (schema.properties ?? {}))) {
          errors.push({
            path: joinPath(path, key),
            keyword: 'additionalProperties',
            message: `is not an allowed argument (allowed: ${Object.keys(schema.properties ?? {}).join(', ') || 'none'})`,
          });
        }
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const key of Object.keys(record)) {
        if (!(key in (schema.properties ?? {}))) {
          walk(record[key], schema.additionalProperties, joinPath(path, key), errors);
        }
      }
    }
  }
}
