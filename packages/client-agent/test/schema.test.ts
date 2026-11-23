import { describe, expect, it } from 'vitest';
import { formatSchemaErrors, unsupportedKeywords, validateParams } from '../src/core/schema.js';
import type { JSONSchemaObject } from '../src/core/types.js';

const invoiceSchema: JSONSchemaObject = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['paid', 'open', 'overdue'] },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    note: { type: 'string', maxLength: 10 },
  },
  required: ['status'],
  additionalProperties: false,
};

describe('validateParams', () => {
  it('accepts a valid object', () => {
    const result = validateParams({ status: 'paid', limit: 10 }, invoiceSchema);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toEqual({ status: 'paid', limit: 10 });
  });

  it('reports a missing required field by path', () => {
    const result = validateParams({ limit: 5 }, invoiceSchema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]).toMatchObject({ path: 'status', keyword: 'required' });
      expect(formatSchemaErrors(result.errors)).toContain(
        'arguments.status is required but was not provided (required)',
      );
    }
  });

  it('rejects an enum value and names the allowed values', () => {
    const result = validateParams({ status: 'unpaid' }, invoiceSchema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]?.message).toContain('"paid", "open", "overdue"');
      expect(result.errors[0]?.path).toBe('status');
    }
  });

  it('rejects unknown arguments when additionalProperties is false', () => {
    const result = validateParams({ status: 'open', extra: true }, invoiceSchema);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors[0]).toMatchObject({ path: 'extra', keyword: 'additionalProperties' });
  });

  it('distinguishes integers from floats', () => {
    const result = validateParams({ status: 'open', limit: 2.5 }, invoiceSchema);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors[0]?.keyword).toBe('type');
  });

  it('enforces numeric and string bounds', () => {
    const tooBig = validateParams({ status: 'open', limit: 500 }, invoiceSchema);
    const tooLong = validateParams({ status: 'open', note: 'far too long for the schema' }, invoiceSchema);
    expect(tooBig.valid).toBe(false);
    expect(tooLong.valid).toBe(false);
    if (!tooBig.valid) expect(tooBig.errors[0]?.keyword).toBe('maximum');
    if (!tooLong.valid) expect(tooLong.errors[0]?.keyword).toBe('maxLength');
  });

  it('validates nested objects and arrays', () => {
    const schema: JSONSchemaObject = {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: { sku: { type: 'string', pattern: '^[A-Z]{3}-\\d+$' } },
            required: ['sku'],
            additionalProperties: false,
          },
        },
      },
      required: ['lines'],
      additionalProperties: false,
    };
    const result = validateParams({ lines: [{ sku: 'abc-1' }, {}] }, schema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((error) => error.path)).toEqual(['lines[0].sku', 'lines[1].sku']);
    }
  });

  it('requires exactly one branch for oneOf', () => {
    const schema: JSONSchemaObject = {
      oneOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
        { type: 'object', properties: { b: { type: 'string' } }, required: ['b'], additionalProperties: false },
      ],
    };
    expect(validateParams({ a: 'x' }, schema).valid).toBe(true);
    expect(validateParams({ a: 'x', b: 'y' }, schema).valid).toBe(false);
    expect(validateParams({ c: 'x' }, schema).valid).toBe(false);
  });

  it('treats a schema-less capability as accepting any object', () => {
    expect(validateParams({ anything: 1 }, undefined).valid).toBe(true);
    expect(validateParams('nope', undefined).valid).toBe(false);
  });

  it('reports the keywords the runtime cannot enforce', () => {
    const found = unsupportedKeywords({
      type: 'object',
      properties: { role: { $ref: '#/$defs/role' }, email: { type: 'string', format: 'email' } },
    });
    expect(found).toContain('role.$ref');
    expect(found).toContain('email.format');
  });
});
