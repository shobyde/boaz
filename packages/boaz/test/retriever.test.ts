import { describe, expect, it } from 'vitest';
import { CapabilityIndex, tokenize } from '../src/core/retriever.js';
import { buildSystemPrompt, estimateTokens } from '../src/core/prompt.js';
import type { ManifestCapability } from '../src/core/types.js';

export const catalog: ManifestCapability[] = [
  {
    id: 'billing.navigate',
    kind: 'route',
    title: 'Billing & subscription',
    description: 'Navigate to the billing page where users can update payment cards, change plans, or download PDF invoices.',
    keywords: ['invoice', 'payment', 'credit card', 'subscription', 'plan'],
    route: '/settings/billing',
  },
  {
    id: 'billing.filter_invoices',
    kind: 'action',
    title: 'Filter invoices by status',
    description: 'Filter the visible invoice table on the billing page by payment status (paid, open, or overdue).',
    keywords: ['filter', 'overdue', 'unpaid'],
    route: '/settings/billing',
    paramsSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['paid', 'open', 'overdue'] } },
      required: ['status'],
    },
  },
  {
    id: 'team.invite',
    kind: 'action',
    title: 'Invite a teammate',
    description: 'Sends an email invitation so another person can join the workspace.',
    keywords: ['invite', 'member', 'colleague', 'email'],
    route: '/team',
  },
  {
    id: 'reports.export',
    kind: 'action',
    title: 'Export monthly report as CSV',
    description: 'Downloads the selected month of activity as a CSV file for accounting.',
    keywords: ['csv', 'download', 'spreadsheet', 'accounting'],
    route: '/reports',
  },
  {
    id: 'account.delete',
    kind: 'action',
    title: 'Delete account',
    description: 'Permanently deletes the workspace and all stored documents.',
    route: '/settings/account',
    requiresConfirmation: true,
  },
];

describe('tokenize', () => {
  it('splits camelCase, dotted ids and plurals', () => {
    expect(tokenize('openBilling')).toEqual(['open', 'billing']);
    expect(tokenize('billing.filter_invoices')).toEqual(['billing', 'filter', 'invoic']);
    expect(tokenize('the invoices for me')).toEqual(['invoic']);
  });

  it('carries a technology whose name is punctuation', () => {
    // Both halves were one letter after the split, which the two-character
    // floor dropped: tokenize('C++') was [], so no question could name it.
    expect(tokenize('C++')).toEqual(['cpp']);
    expect(tokenize('c++')).toEqual(['cpp']);
    expect(tokenize('C#')).toEqual(['csharp']);
    expect(tokenize('which projects use C++')).toEqual(['project', 'use', 'cpp']);
    // Normalising must not swallow a version number that ends in "+".
    expect(tokenize('Python 3.10+')).toEqual(['python', '10']);
  });
});

describe('CapabilityIndex', () => {
  const index = new CapabilityIndex(catalog);

  it('finds the capability the visitor meant', () => {
    const [top] = index.search('I want to download my invoices', { currentRoute: '/' });
    expect(top?.capability.id).toBe('billing.navigate');
  });

  it('separates filtering from navigating', () => {
    const [top] = index.search('show only overdue invoices', { currentRoute: '/settings/billing' });
    expect(top?.capability.id).toBe('billing.filter_invoices');
  });

  it('matches a paraphrase without the exact words', () => {
    const [top] = index.search('let a colleague join my workspace', { currentRoute: '/team' });
    expect(top?.capability.id).toBe('team.invite');
  });

  it('boosts capabilities on the current route', () => {
    const withoutRoute = index.search('export report', { currentRoute: '/nowhere' })[0];
    const withRoute = index.search('export report', { currentRoute: '/reports' })[0];
    expect(withoutRoute?.capability.id).toBe('reports.export');
    expect(withRoute?.score ?? 0).toBeGreaterThan(withoutRoute?.score ?? 0);
  });

  it('returns nothing for an unrelated question', () => {
    expect(index.search('what is the weather in Berlin', { currentRoute: '/' })).toHaveLength(0);
  });

  it('respects the limit', () => {
    expect(index.search('invoice', { currentRoute: '/settings/billing', limit: 1 })).toHaveLength(1);
  });
});

describe('buildSystemPrompt', () => {
  it('states the route, the protocol, and the retrieved capabilities', () => {
    const prompt = buildSystemPrompt({
      capabilities: [catalog[0]!, catalog[1]!, catalog[4]!],
      snapshot: { currentRoute: '/settings/billing', state: { plan: 'pro' } },
    });
    expect(prompt).toContain('Current route: /settings/billing');
    expect(prompt).toContain('Client state: {"plan":"pro"}');
    expect(prompt).toContain('billing.navigate (route [/settings/billing])');
    expect(prompt).toContain('args{status:"paid"|"open"|"overdue"}');
    expect(prompt).toContain('asks the user to confirm');
  });

  it('trims the list to the token budget and says so', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      ...catalog[3]!,
      id: `reports.export_${i}`,
      description: 'Downloads the selected month of activity as a CSV file for accounting and reconciliation.',
    }));
    const prompt = buildSystemPrompt({
      capabilities: many,
      snapshot: { currentRoute: '/' },
      budgetTokens: 200,
    });
    expect(estimateTokens(prompt)).toBeLessThan(320);
    expect(prompt).toMatch(/more capabilities are not listed/);
  });
});
