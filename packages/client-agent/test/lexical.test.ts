import { describe, expect, it } from 'vitest';
import { createLexicalEngine } from '../src/core/lexical-engine.js';
import { parseModelOutput } from '../src/core/tools.js';
import { buildSystemPrompt } from '../src/core/prompt.js';
import type { ChatMessage, ManifestCapability } from '../src/core/types.js';

const capabilities: ManifestCapability[] = [
  {
    id: 'billing.navigate',
    kind: 'route',
    title: 'Billing & invoices',
    description: 'Takes the visitor to the billing page where invoices and payment cards live.',
    keywords: ['invoice', 'payment', 'bill'],
    route: '/settings/billing',
  },
  {
    id: 'billing.filter_invoices',
    kind: 'action',
    title: 'Filter invoices by status',
    description: 'Filters the invoice table down to paid, open, or overdue invoices.',
    keywords: ['filter', 'overdue', 'unpaid', 'show only'],
    route: '/settings/billing',
    paramsSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['paid', 'open', 'overdue'] } },
      required: ['status'],
      additionalProperties: false,
    },
  },
  {
    id: 'team.invite',
    kind: 'action',
    title: 'Invite a teammate',
    description: 'Sends an invitation email so a new person can join the workspace with a role.',
    keywords: ['invite', 'member', 'colleague'],
    route: '/team',
    requiresConfirmation: true,
    paramsSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
        role: { type: 'string', enum: ['Admin', 'Member', 'Viewer'] },
      },
      required: ['email', 'role'],
      additionalProperties: false,
    },
  },
];

const engine = createLexicalEngine({ capabilities });
const system = buildSystemPrompt({ capabilities, snapshot: { currentRoute: '/' } });

function request(query: string, after: ChatMessage[] = []) {
  return {
    messages: [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: query },
      ...after,
    ],
    tools: [],
  };
}

describe('createLexicalEngine', () => {
  it('navigates when the destination is unambiguous', async () => {
    const reply = await engine.complete(request('take me to billing'));
    expect(parseModelOutput(reply.text)).toEqual({
      kind: 'tool',
      capabilityId: 'billing.navigate',
      args: {},
    });
  });

  it('prefers the route when the visitor asks for a place', async () => {
    // Three capabilities about invoices can tie on score; "take me to" is a
    // request for a destination, so the route wins without a margin contest.
    const reply = await engine.complete(request('take me to billing'));
    expect(parseModelOutput(reply.text)).toMatchObject({ kind: 'tool', capabilityId: 'billing.navigate' });
  });

  it('does not rewrite a controller request as navigation', async () => {
    const reply = await engine.complete(request('show only the overdue invoices'));
    expect(parseModelOutput(reply.text)).toMatchObject({ kind: 'tool', capabilityId: 'billing.filter_invoices' });
  });

  it('fills an enum argument from the visitor words', async () => {
    const reply = await engine.complete(request('show only the overdue invoices'));
    expect(parseModelOutput(reply.text)).toEqual({
      kind: 'tool',
      capabilityId: 'billing.filter_invoices',
      args: { status: 'overdue' },
    });
  });

  it('extracts an email and a role for an invitation', async () => {
    const reply = await engine.complete(request('invite priya@ledger.dev as a viewer'));
    expect(parseModelOutput(reply.text)).toEqual({
      kind: 'tool',
      capabilityId: 'team.invite',
      args: { email: 'priya@ledger.dev', role: 'Viewer' },
    });
  });

  it('asks instead of guessing when a required argument is missing', async () => {
    const reply = await engine.complete(request('invite someone to the team'));
    expect(parseModelOutput(reply.text).kind).toBe('text');
    expect(reply.text).toContain('needs');
  });

  it('declines an unrelated question without inventing a capability', async () => {
    const reply = await engine.complete(request('what is the weather in Berlin'));
    expect(parseModelOutput(reply.text).kind).toBe('text');
  });

  it('reads a query result back in words', async () => {
    const reply = await engine.complete(
      request('how many invoices are open?', [
        { role: 'assistant', content: '{"tool":"billing.count","arguments":{}}' },
        { role: 'user', content: '[client-agent] Query "billing.count" returned {"openInvoices":3,"overdueInvoices":2}.' },
      ]),
    );
    expect(reply.text).toBe('Right now: open invoices 3, overdue invoices 2.');
  });

  it('lets a query phrase its own answer', async () => {
    const reply = await engine.complete(
      request('what is his current role?', [
        { role: 'assistant', content: '{"tool":"profile.summary","arguments":{}}' },
        {
          role: 'user',
          content:
            '[client-agent] Query "profile.summary" returned {"answer":"Sho is an engineering manager and IC at Conversica.","years":"12+"}.',
        },
      ]),
    );
    expect(reply.text).toBe('Sho is an engineering manager and IC at Conversica.');
  });

  it('never echoes a clipped payload as the answer', async () => {
    const clipped = '{"projects":[{"title":"Hobnob: private meeting notes, no cloud","stack":["Whisper (large-v3-turbo)","Local GGUF LLMs","Live captions","macOS (Apple Silicon)","Li…';
    const reply = await engine.complete({
      messages: [
        { role: 'user', content: 'which projects has he built?' },
        { role: 'user', content: `[client-agent] Query "projects.list" returned ${clipped}.` },
      ],
      tools: [],
    });
    expect(reply.text.startsWith('{')).toBe(false);
    expect(reply.text).not.toContain('"projects"');
    expect(reply.text).toContain('too large');
  });

  it('reads the structured observation when the runtime supplies one', async () => {
    const reply = await engine.complete({
      messages: [
        { role: 'user', content: 'how many posts?' },
        { role: 'user', content: '[client-agent] Query "blog.stats" returned {"posts":58…' },
      ],
      observations: { 'blog.stats': { answer: '58 posts are published.' } },
      tools: [],
    });
    expect(reply.text).toBe('58 posts are published.');
  });

  it('keeps a multi-sentence answer intact', async () => {
    const reply = await engine.complete(
      request('what is his current role?', [
        { role: 'assistant', content: '{"tool":"profile.summary","arguments":{}}' },
        {
          role: 'user',
          content:
            '[client-agent] Query "profile.summary" returned {"answer":"Sho is an engineering manager. He has been at Conversica since Jul 2021.","years":"12+"}.',
        },
      ]),
    );
    expect(reply.text).toBe('Sho is an engineering manager. He has been at Conversica since Jul 2021.');
  });

  it('names the action that ran', async () => {
    const reply = await engine.complete(
      request('show only paid invoices', [
        { role: 'assistant', content: '{"tool":"billing.filter_invoices","arguments":{"status":"paid"}}' },
        {
          role: 'user',
          content: '[client-agent] "billing.filter_invoices" ran successfully and returned {"appliedFilter":"paid"}.',
        },
      ]),
    );
    expect(reply.text).toBe('Done: Filter invoices by status.');
  });

  it('stays quiet when a surface is the reply', async () => {
    const reply = await engine.complete(
      request('show me the hobnob card', [
        { role: 'assistant', content: '{"tool":"projects.card","arguments":{"project":"hobnob"}}' },
        {
          role: 'user',
          content:
            '[client-agent] "projects.card" rendered a surface. Describe it in one sentence if the visitor still needs words.',
        },
      ]),
    );
    expect(reply.text).toBe('');
  });

  it('reports the outcome instead of repeating the call', async () => {
    const reply = await engine.complete(
      request('take me to billing', [
        { role: 'assistant', content: '{"tool":"billing.navigate","arguments":{}}' },
        { role: 'user', content: '[client-agent] Navigation succeeded. The visitor is now on /settings/billing.' },
      ]),
    );
    expect(parseModelOutput(reply.text).kind).toBe('text');
    expect(reply.text).toContain('Anything else');
  });
});
