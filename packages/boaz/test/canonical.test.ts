import { describe, expect, it } from 'vitest';
import { KnowledgeBase, fact } from '../src/rules/knowledge.js';

describe('canonicalFor: camel-case names', () => {
  it('finds a camel-case constant by the spelling the visitor typed', () => {
    const knowledge = new KnowledgeBase({ facts: [fact('uses', 'boaz', 'TypeScript')] });
    expect(knowledge.canonicalFor('TypeScript')).toEqual(['TypeScript']);
    expect(knowledge.canonicalFor('typescript')).toEqual(['TypeScript']);
  });

  it('keeps punctuation spellings reachable', () => {
    const knowledge = new KnowledgeBase({ facts: [fact('uses', 'engine', 'C++')] });
    expect(knowledge.canonicalFor('C++')).toEqual(['C++']);
    expect(knowledge.canonicalFor('cpp')).toEqual(['C++']);
  });
});
