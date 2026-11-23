import { describe, expect, it } from 'vitest';
import { KnowledgeBase, fact, parseAtom, parseRule } from '../src/rules/knowledge.js';
import { createRulesEngine } from '../src/rules/engine.js';
import { AgentRuntime } from '../src/core/loop.js';
import { CapabilityRegistry } from '../src/core/registry.js';
import type { AgentEngine, AgentEvent, ManifestCapability } from '../src/core/types.js';

const projects = new KnowledgeBase({
  facts: [
    fact('project', 'readback', 'Readback'),
    fact('project', 'groundglass', 'Groundglass'),
    fact('project', 'hobnob', 'Hobnob'),
    fact('uses', 'readback', 'Python 3.10+'),
    fact('uses', 'readback', 'SQLite'),
    fact('uses', 'groundglass', 'Python 3.10+'),
    fact('uses', 'hobnob', 'Whisper'),
  ],
  rules: ['projects_using(?P) :- uses(?P, ?T), asked(?T).'],
});

describe('parse', () => {
  it('reads a rule with a join and a constant', () => {
    const rule = parseRule('hit(?P) :- uses(?P, ?T), status(?T, "current").');
    expect(rule.head).toEqual({ rel: 'hit', args: ['?P'] });
    expect(rule.body).toHaveLength(2);
    expect(rule.body[1]).toEqual({ rel: 'status', args: ['?T', '"current"'] });
  });

  it('reads a zero-argument atom', () => {
    expect(parseAtom('ready()')).toEqual({ rel: 'ready', args: [] });
  });

  it('rejects a rule without a body', () => {
    expect(() => parseRule('hit(?P)')).toThrow(/needs ":-"/);
  });
});

describe('KnowledgeBase', () => {
  it('joins facts with an assumed fact from the question', () => {
    const solutions = projects.query('projects_using(?P)', { assume: [['asked', 'Python 3.10+']] });
    expect(solutions.map((solution) => solution.bindings['?P']).sort()).toEqual(['groundglass', 'readback']);
  });

  it('keeps assumptions scoped to one query', () => {
    projects.query('projects_using(?P)', { assume: [['asked', 'SQLite']] });
    // No leak: a later query without assumptions finds nothing.
    expect(projects.query('projects_using(?P)')).toHaveLength(0);
  });

  it('dedupes repeated solutions and honours the limit', () => {
    const dup = new KnowledgeBase({
      facts: [fact('uses', 'a', 'X'), fact('uses', 'a', 'X'), fact('uses', 'b', 'X')],
      rules: ['hit(?P) :- uses(?P, ?T), asked(?T).'],
    });
    expect(dup.query('hit(?P)', { assume: [['asked', 'X']] })).toHaveLength(2);
    expect(dup.query('hit(?P)', { assume: [['asked', 'X']], limit: 1 })).toHaveLength(1);
  });

  it('terminates on a recursive rule', () => {
    const chain = new KnowledgeBase({
      facts: [fact('below', 'a', 'b'), fact('below', 'b', 'c'), fact('below', 'c', 'd')],
      rules: ['above(?X, ?Y) :- below(?Y, ?X).', 'above(?X, ?Z) :- below(?Y, ?X), above(?Y, ?Z).'],
    });
    const reached = chain.query('above(?X, ?Y)', { assume: [] });
    expect(reached.some((solution) => solution.bindings['?X'] === 'd' && solution.bindings['?Y'] === 'a')).toBe(true);
  });

  it('indexes constants so a question can name them', () => {
    expect(projects.canonicalFor('python')).toEqual(['Python 3.10+']);
    expect(projects.canonicalFor('sqlite')).toEqual(['SQLite']);
    expect(projects.canonicalFor('nonsense')).toEqual([]);
  });
});

const routeCapability: ManifestCapability = {
  id: 'site.projects',
  kind: 'route',
  title: 'Selected projects',
  description: 'Scrolls the page to the project cards.',
  keywords: ['projects', 'work'],
  route: '#projects',
};

function answerRule(overrides: Partial<Parameters<typeof createRulesEngine>[0]['answers'][number]> = {}) {
  return {
    id: 'projects.using',
    title: 'Which projects use a technology',
    keywords: ['which projects use', 'built with', 'stack'],
    goal: 'projects_using(?P)',
    compose: ({ solutions, knowledge }: { solutions: { bindings: Record<string, string> }[]; knowledge: KnowledgeBase }) => {
      const titles = solutions.map((solution) => {
        const title = knowledge
          .query('project(?P, ?T)', { assume: [['asked', solution.bindings['?P'] ?? '']] })
          .find((hit) => hit.bindings['?P'] === solution.bindings['?P'])?.bindings['?T'];
        return title ?? solution.bindings['?P'];
      });
      return titles.length ? `${titles.join(' and ')} use it.` : '';
    },
    ...overrides,
  };
}

const ask = (engine: AgentEngine, text: string) =>
  engine.complete({ messages: [{ role: 'user', content: text }], tools: [] });

describe('createRulesEngine', () => {
  it('answers a rule question and reports the inference', async () => {
    const engine = createRulesEngine({ knowledge: projects, answers: [answerRule()], capabilities: [routeCapability] });
    const completion = await ask(engine, 'which projects use python?');

    expect(completion.text).toBe('Readback and Groundglass use it.');
    expect(completion.steps?.[0]).toMatchObject({ type: 'inference', goal: 'projects_using(?P)', terms: ['Python 3.10+'] });
    expect(completion.steps?.[0]).toMatchObject({ rule: 'projects_using(?P) :- uses(?P, ?T), asked(?T)' });
  });

  it('falls back to keyword matching when no rule applies', async () => {
    const engine = createRulesEngine({ knowledge: projects, answers: [answerRule()], capabilities: [routeCapability] });
    const completion = await ask(engine, 'take me to the projects');
    expect(completion.text).toContain('Selected projects');
    expect(completion.steps ?? []).toHaveLength(0);
  });

  it('composes an answer even when the rule finds nothing', async () => {
    const engine = createRulesEngine({
      knowledge: projects,
      answers: [
        answerRule({
          compose: ({ solutions, terms }) =>
            solutions.length ? `${solutions.length} matched.` : terms.length ? `No project lists ${terms.join(' or ')}.` : '',
        }),
      ],
      capabilities: [routeCapability],
    });
    // "Readback" is a declared constant (a project title), not a technology, so
    // the rule matches while the join finds nothing.
    const completion = await ask(engine, 'which projects use readback?');
    expect(completion.text).toMatch(/^No project lists /);
  });

  it('falls back when compose declines on an empty result', async () => {
    const engine = createRulesEngine({ knowledge: projects, answers: [answerRule()], capabilities: [routeCapability] });
    const completion = await ask(engine, 'which projects use cobol?');
    expect(completion.text).toContain('Selected projects');
  });

  it('falls back when compose declines with an empty string', async () => {
    const engine = createRulesEngine({
      knowledge: projects,
      answers: [answerRule({ compose: () => '' })],
      capabilities: [routeCapability],
    });
    const completion = await ask(engine, 'which projects use python?');
    expect(completion.text).not.toContain('use it');
    expect(completion.text).toContain('Selected projects');
  });
});

describe('streaming', () => {
  function runtimeWith(events: AgentEvent[], text: string, streaming?: { chunkChars?: number; paceMs?: number }) {
    const engine: AgentEngine = { id: 'fake', complete: async () => ({ text }) };
    return new AgentRuntime({
      engine,
      capabilities: [routeCapability],
      registry: new CapabilityRegistry(),
      getSnapshot: () => ({ currentRoute: '/' }),
      dispatch: () => undefined,
      streaming: streaming ?? false,
      onEvent: (event) => events.push(event),
    });
  }

  it('emits deltas that rebuild the reply, then the turn', async () => {
    const events: AgentEvent[] = [];
    const text = 'Readback and Groundglass both use Python in production.';
    const runtime = runtimeWith(events, text, { chunkChars: 12, paceMs: 0 });
    await runtime.send('which projects use python?');

    const deltas = events.filter((event) => event.type === 'delta').map((event) => String(event.text));
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(text);
    expect(events.at(-1)?.type).toBe('turn');
    expect(events.findIndex((event) => event.type === 'turn')).toBeGreaterThan(
      events.findLastIndex((event) => event.type === 'delta'),
    );
  });

  it('stays silent when streaming is off', async () => {
    const events: AgentEvent[] = [];
    const runtime = runtimeWith(events, 'Plain reply.');
    await runtime.send('hello');
    expect(events.some((event) => event.type === 'delta')).toBe(false);
  });
});
