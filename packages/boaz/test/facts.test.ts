import { describe, expect, it } from 'vitest';
import { fact } from '../src/rules/knowledge.js';
import { createFactIndex, factText, numberOf, rankFacts, topFact } from '../src/rules/facts.js';

const facts = [
  fact('product', 'Atlas', 'sla', '99.95%'),
  fact('product', 'Delta', 'sla', '99.99%'),
  fact('product', 'Beacon', 'sla', '99.9%'),
  fact('product', 'Cinder', 'sla', 'unknown'),
  fact('policy', 'Severity', 'text', 'Sev 1 is customer visible downtime, paged immediately to the owning team.'),
  fact('policy', 'Retention', 'text', 'Application logs are kept 30 days. Audit logs are kept 400 days.'),
];

describe('fact text', () => {
  it('reads like a sentence', () => {
    expect(factText(fact('product', 'Atlas', 'sla', '99.95%'))).toBe('Atlas: sla is 99.95%.');
    expect(factText(fact('team', 'Platform'))).toBe('Platform is a team.');
  });
});

describe('numbers', () => {
  it('finds the number inside a unit', () => {
    expect(numberOf('99.95%')).toBe(99.95);
    expect(numberOf('400 days')).toBe(400);
    expect(numberOf('tier 2')).toBe(2);
    expect(numberOf('unknown')).toBeUndefined();
  });
});

describe('ranking', () => {
  it('ranks the comparable rows and skips the rest', () => {
    const ranked = rankFacts(facts, { relation: 'product', attribute: 'sla' });
    expect(ranked.map((row) => row.subject)).toEqual(['Delta', 'Atlas', 'Beacon']);
    expect(topFact(facts, { relation: 'product', attribute: 'sla' })?.subject).toBe('Delta');
  });

  it('can rank the other way', () => {
    expect(topFact(facts, { relation: 'product', attribute: 'sla', direction: 'min' })?.subject).toBe('Beacon');
  });

  it('returns nothing when no row holds a number', () => {
    expect(topFact([fact('product', 'Atlas', 'sla', 'high')], { relation: 'product', attribute: 'sla' })).toBeUndefined();
  });
});

describe('topic retrieval', () => {
  it('finds a policy by the words in its text', () => {
    const index = createFactIndex(facts);
    const [hit] = index.search('what happens during a sev 1');
    expect(hit.text).toContain('Sev 1');
  });

  it('finds retention numbers by topic', () => {
    const index = createFactIndex(facts);
    const [hit] = index.search('how long are audit logs kept');
    expect(hit.text).toContain('400 days');
  });

  it('does not answer from a single shared word', () => {
    const index = createFactIndex(facts);
    expect(index.search('what is the capital of France')).toEqual([]);
  });

  it('reports how many facts it holds', () => {
    expect(createFactIndex(facts).size).toBe(facts.length);
  });
});
