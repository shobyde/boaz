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

import { createRulesEngine } from '../src/rules/engine.js';
import type { AnswerRule } from '../src/rules/engine.js';

describe('rule steps: camel-case terms', () => {
  it('keeps TypeScript as a term after the tool returns facts', async () => {
    const knowledge = new KnowledgeBase({ rules: ['projects_using(?P) :- uses(?P, ?T), asked(?T).'] });
    const answers: AnswerRule[] = [{
      id: 'projects.using',
      title: 'Which projects use a technology',
      keywords: ['which projects use'],
      goal: 'projects_using(?P)',
      steps: [{
        capabilityId: 'projects.list',
        toFacts: (result) => {
          const projects = (result as { projects: Array<{ title: string; stack: string[] }> }).projects;
          return projects.flatMap((project) => [
            fact('project', project.title, project.title),
            ...project.stack.map((tech) => fact('uses', project.title, tech)),
          ]);
        },
      }],
      compose: ({ solutions, terms }) => `${terms.join(',')}:${solutions.length}`,
    }];
    const engine = createRulesEngine({
      knowledge,
      answers,
      capabilities: [{ id: 'projects.list', kind: 'query', title: 'List projects', description: 'List projects', paramsSchema: { type: 'object', properties: {}, additionalProperties: false } }],
      constants: ['TypeScript', 'Python'],
    });
    const messages = [{ role: 'user' as const, content: 'which projects use TypeScript?' }];
    await engine.complete({ messages, tools: [] });
    const result = await engine.complete({
      messages,
      tools: [],
      observations: { 'projects.list': { projects: [{ title: 'Boaz', stack: ['TypeScript'] }, { title: 'Readback', stack: ['Python'] }] } },
    });
    expect(result.text).toBe('TypeScript:1');
  });
});
