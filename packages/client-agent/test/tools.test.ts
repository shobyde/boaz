import { describe, expect, it } from 'vitest';
import { parseModelOutput, parseNativeToolCall } from '../src/core/tools.js';

describe('parseModelOutput', () => {
  it('reads a fenced JSON block surrounded by prose', () => {
    const output = parseModelOutput(
      'Sure, opening that for you.\n```json\n{"tool":"billing.navigate","arguments":{}}\n```',
    );
    expect(output).toEqual({ kind: 'tool', capabilityId: 'billing.navigate', args: {} });
  });

  it('reads an unlabelled fence', () => {
    const output = parseModelOutput('```\n{"tool":"cart.count","arguments":{"depth":2}}\n```');
    expect(output).toEqual({ kind: 'tool', capabilityId: 'cart.count', args: { depth: 2 } });
  });

  it('reads a bare JSON object', () => {
    const output = parseModelOutput('{"tool":"billing.filter_invoices","arguments":{"status":"paid"}}');
    expect(output.kind).toBe('tool');
  });

  it('accepts the common alias keys', () => {
    expect(parseModelOutput('{"name":"a.b","parameters":{"x":1}}')).toMatchObject({
      kind: 'tool',
      capabilityId: 'a.b',
      args: { x: 1 },
    });
    expect(parseModelOutput('{"action":"a.b"}')).toMatchObject({ kind: 'tool', capabilityId: 'a.b', args: {} });
  });

  it('parses arguments delivered as a JSON string', () => {
    const output = parseModelOutput('{"tool":"a.b","arguments":"{\\"status\\":\\"open\\"}"}');
    expect(output).toEqual({ kind: 'tool', capabilityId: 'a.b', args: { status: 'open' } });
  });

  it('stays prose when there is no JSON', () => {
    expect(parseModelOutput('You can find invoices under Settings.')).toEqual({
      kind: 'text',
      text: 'You can find invoices under Settings.',
    });
  });

  it('flags a broken JSON block instead of silently answering in prose', () => {
    const output = parseModelOutput('```json\n{"tool": "billing.navigate"\n```');
    expect(output.kind).toBe('malformed');
    if (output.kind === 'malformed') expect(output.error).toContain('did not parse');
  });

  it('flags an object with no tool field', () => {
    const output = parseModelOutput('```json\n{"id":"x"}\n```');
    expect(output.kind).toBe('malformed');
  });

  it('handles empty output', () => {
    expect(parseModelOutput('   ')).toEqual({ kind: 'text', text: '' });
  });
});

describe('parseNativeToolCall', () => {
  it('reads an OpenAI-style function call', () => {
    const output = parseNativeToolCall({
      function: { name: 'billing.filter_invoices', arguments: '{"status":"paid"}' },
    });
    expect(output).toEqual({ kind: 'tool', capabilityId: 'billing.filter_invoices', args: { status: 'paid' } });
  });

  it('reports malformed native arguments', () => {
    const output = parseNativeToolCall({ name: 'a.b', arguments: '{oops' });
    expect(output.kind).toBe('malformed');
  });
});
