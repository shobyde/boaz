import { describe, expect, it } from 'vitest';
import { createFieldScanner, requestedFields } from '../src/extract/index.js';
import { KnowledgeBase, fact } from '../src/rules/knowledge.js';
import { createRulesEngine } from '../src/rules/engine.js';
import type { AgentEngine } from '../src/core/types.js';

const page = `Contact
Email me at sho@example.com and I reply within a day.
You can also find me at https://linkedin.com/in/sho-byde-556954138/ or read the archive.`;

const projects = new KnowledgeBase({
  facts: [
    fact('project', 'readback', 'Readback'),
    fact('project', 'groundglass', 'Groundglass'),
    fact('uses', 'readback', 'Python 3.10+'),
    fact('uses', 'readback', 'SQLite'),
    fact('uses', 'groundglass', 'Python 3.10+'),
  ],
  rules: ['projects_using(?P) :- uses(?P, ?T), asked(?T).'],
});

const projectsAnswer = {
  id: 'projects.using',
  title: 'Which projects use a technology',
  keywords: ['which projects use', 'built with', 'uses'],
  goal: 'projects_using(?P)',
  compose: ({ solutions }: { solutions: { bindings: Record<string, string> }[] }) =>
    solutions.map((solution) => solution.bindings['?P']).join(' and '),
};

const contactKnowledge = new KnowledgeBase({
  rules: ['email(?V) :- field(email, ?V).', 'linkedin(?V) :- field(linkedin, ?V).'],
});

const emailRule = {
  id: 'contact.email',
  title: 'His email address',
  keywords: ['email', 'mail', 'reach him'],
  goal: 'email(?V)',
  compose: ({ bindings }: { bindings: Record<string, string> }) =>
    bindings['?V'] ? `His email is ${bindings['?V']}.` : '',
  explain: () => 'Read the email address off this page',
};

const linkedinRule = {
  id: 'contact.linkedin',
  title: 'His LinkedIn profile',
  keywords: ['linkedin', 'profile'],
  goal: 'linkedin(?V)',
  compose: ({ bindings }: { bindings: Record<string, string> }) =>
    bindings['?V'] ? `His LinkedIn is ${bindings['?V']}.` : '',
};

const ask = (engine: AgentEngine, text: string) =>
  engine.complete({ messages: [{ role: 'user', content: text }], tools: [] });

describe('field scanner', () => {
  it('finds an email, a linkedin handle and a url', () => {
    const hits = createFieldScanner().scan(page);
    expect(hits.map((hit) => hit.kind)).toEqual(['email', 'linkedin', 'url']);
    expect(hits[0]?.value).toBe('sho@example.com');
    expect(hits[1]?.value).toBe('linkedin.com/in/sho-byde-556954138');
  });

  it('does not carry lastIndex between calls', () => {
    const scanner = createFieldScanner();
    expect(scanner.scan(page).length).toBe(3);
    expect(scanner.scan(page).length).toBe(3);
  });

  it('matches a constant through the retriever tokenizer', () => {
    const kb = new KnowledgeBase({ facts: [fact('uses', 'readback', 'SQLite'), fact('uses', 'x', 'Python 3.10+')] });
    expect(kb.canonicalFor('sqlite')).toEqual(['SQLite']);
    expect(kb.canonicalFor('python')).toEqual(['Python 3.10+']);
    expect(kb.canonicalFor('projects')).toEqual([]);
  });

  it('only scans the kinds the question names', () => {
    const hits = createFieldScanner().scan(page, ['email']);
    expect(hits).toHaveLength(1);
    expect(requestedFields('what is his email?')).toEqual(['email']);
    expect(requestedFields('which projects use python?')).toEqual([]);
  });

  it('keeps the mailbox when the page writes mailto:', () => {
    const hits = createFieldScanner().scan('<a href="mailto:sho@example.com">Email</a>', ['email']);
    expect(hits[0]?.value).toBe('sho@example.com');
  });
});

describe('grounding', () => {
  it('answers an undeclared value by reading the page', async () => {
    const engine = createRulesEngine({
      knowledge: contactKnowledge,
      answers: [emailRule, linkedinRule],
      capabilities: [],
      grounding: { read: () => page },
    });
    const completion = await ask(engine, 'what is his email?');
    expect(completion.text).toBe('His email is sho@example.com.');
    expect(completion.steps?.[0]).toMatchObject({
      label: 'Read the email address off this page',
      terms: [],
    });
  });

  it('still answers when reading the page fails', async () => {
    const engine = createRulesEngine({
      knowledge: contactKnowledge,
      answers: [emailRule],
      capabilities: [],
      grounding: {
        read: () => {
          throw new Error('page blocked');
        },
      },
    });
    const completion = await ask(engine, 'what is his email?');
    expect(completion.text).not.toBe('');
  });

  it('hands back to keyword matching when nothing grounds', async () => {
    const engine = createRulesEngine({ knowledge: contactKnowledge, answers: [emailRule], capabilities: [] });
    const completion = await ask(engine, 'what is his email?');
    expect(completion.text).not.toContain('@');
    expect(completion.text).toMatch(/only help|not sure|couldn't/i);
  });
});

describe('conversation memory', () => {
  it('carries the intent across an ellipsis', async () => {
    const engine = createRulesEngine({ knowledge: projects, answers: [projectsAnswer], capabilities: [] });
    expect((await ask(engine, 'which projects use python?')).text).toBe('readback and groundglass');
    expect((await ask(engine, 'and sqlite?')).text).toBe('readback');
  });

  it('switches attribute when the follow-up names a different field', async () => {
    const engine = createRulesEngine({
      knowledge: contactKnowledge,
      answers: [emailRule, linkedinRule],
      capabilities: [],
      grounding: { read: () => page },
    });
    expect((await ask(engine, 'what is his email?')).text).toBe('His email is sho@example.com.');
    expect((await ask(engine, 'and his linkedin?')).text).toBe('His LinkedIn is linkedin.com/in/sho-byde-556954138.');
  });

  it('repeats the last rule for a bare continuation', async () => {
    const engine = createRulesEngine({ knowledge: projects, answers: [projectsAnswer], capabilities: [] });
    await ask(engine, 'which projects use python?');
    const completion = await ask(engine, 'and?');
    expect(completion.text).toBe('readback and groundglass');
  });

  it('does not repeat the last answer when the follow-up names an unknown term', async () => {
    const engine = createRulesEngine({ knowledge: projects, answers: [projectsAnswer], capabilities: [] });
    expect((await ask(engine, 'which projects use python?')).text).toBe('readback and groundglass');
    const completion = await ask(engine, 'and cobol?');
    expect(completion.text).not.toBe('readback and groundglass');
  });

  it('does not carry over when memory is off', async () => {
    const engine = createRulesEngine({
      knowledge: projects,
      answers: [projectsAnswer],
      capabilities: [],
      memory: false,
    });
    await ask(engine, 'which projects use python?');
    const completion = await ask(engine, 'and sqlite?');
    expect(completion.text).not.toBe('readback');
  });

  it('records what it answered for diagnostics', async () => {
    const engine = createRulesEngine({ knowledge: projects, answers: [projectsAnswer], capabilities: [] });
    await ask(engine, 'which projects use python?');
    expect(engine.memory.ruleId).toBe('projects.using');
    expect(engine.memory.terms).toEqual(['Python 3.10+']);
    expect(engine.memory.turns).toBe(1);
    engine.resetMemory();
    expect(engine.memory.ruleId).toBeNull();
  });
});


describe('tool reasoning', () => {
  const listResult = {
    projects: [
      { title: 'Readback', stack: ['Python 3.10+', 'Flask 3', 'SQLite'] },
      { title: 'Groundglass', stack: ['Python 3.10+', 'pytest'] },
    ],
  };

  const reasonedRule = {
    id: 'projects.reasoned',
    title: 'Which projects use a technology',
    keywords: ['which projects use'],
    goal: 'projects_using(?P)',
    steps: [
      {
        capabilityId: 'projects.list',
        toFacts: (result: unknown) => {
          const payload = result as typeof listResult;
          return payload.projects.flatMap((project) => [
            fact('project', project.title, project.title),
            ...project.stack.map((tech) => fact('uses', project.title, tech)),
          ]);
        },
      },
    ],
    compose: ({ solutions }: { solutions: { bindings: Record<string, string> }[] }) =>
      solutions.map((solution) => solution.bindings['?P']).join(', '),
    explain: ({ solutions }: { solutions: unknown[] }) => `Read the project list and found ${solutions.length}`,
  };

  const reasonedEngine = () =>
    createRulesEngine({
      knowledge: new KnowledgeBase({ rules: ['projects_using(?P) :- uses(?P, ?T), asked(?T).'] }),
      answers: [reasonedRule],
      capabilities: [],
    });

  it('asks for the tool first, then answers from its result', async () => {
    const engine = reasonedEngine();
    const first = await ask(engine, 'which projects use python?');
    expect(first.text).toContain('projects.list');
    expect(first.text).toContain('```json');

    const second = await engine.complete({
      messages: [
        { role: 'user', content: 'which projects use python?' },
        { role: 'user', content: `[client-agent] Query "projects.list" returned ${JSON.stringify(listResult)}.` },
      ],
      tools: [],
    });
    expect(second.text).toBe('Readback, Groundglass');
    expect(second.steps?.[0]).toMatchObject({ label: 'Read the project list and found 2' });
  });

  it('surfaces a broken fact adapter instead of hiding it', async () => {
    const engine = createRulesEngine({
      knowledge: new KnowledgeBase(),
      answers: [
        {
          id: 'projects.broken',
          title: 'List the projects',
          keywords: ['list projects'],
          goal: 'project(?P, ?T)',
          steps: [
            {
              capabilityId: 'projects.list',
              toFacts: () => {
                throw new Error('slugOf is not defined');
              },
            },
          ],
          compose: ({ solutions }) => (solutions.length ? 'ok' : 'No project data.'),
        },
      ],
      capabilities: [],
    });
    const completion = await engine.complete({
      messages: [{ role: 'user', content: 'list projects' }],
      tools: [],
      observations: { 'projects.list': { projects: [] } },
    });
    expect(completion.steps?.[0]).toMatchObject({ type: 'error', message: expect.stringContaining('slugOf') });
  });

  it('tells the app which word the data did not have', async () => {
    const engine = createRulesEngine({
      knowledge: new KnowledgeBase({ rules: ['projects_using(?P) :- uses(?P, ?T), asked(?T).'] }),
      answers: [
        {
          id: 'projects.using',
          title: 'Which projects use a technology',
          keywords: ['which projects use'],
          goal: 'projects_using(?P)',
          steps: [
            {
              capabilityId: 'projects.list',
              toFacts: (result: unknown) =>
                ((result as typeof listResult).projects ?? []).flatMap((project) => [
                  fact('project', project.title, project.title),
                  ...project.stack.map((tech) => fact('uses', project.title, tech)),
                ]),
            },
          ],
          compose: ({ solutions, terms, mentions }) =>
            solutions.length
              ? 'matched'
              : `No project stack lists ${terms[0] ?? mentions[0] ?? 'that'}.`,
        },
      ],
      capabilities: [],
    });
    const completion = await engine.complete({
      messages: [{ role: 'user', content: 'which projects use TypeScript?' }],
      tools: [],
      observations: { 'projects.list': listResult },
    });
    expect(completion.text).toBe('No project stack lists typescript.');
  });

  it('does not call the tool again when the result is already in the turn', async () => {
    const engine = reasonedEngine();
    const completion = await engine.complete({
      messages: [
        { role: 'user', content: 'which projects use python?' },
        { role: 'user', content: `[client-agent] Query "projects.list" returned ${JSON.stringify(listResult)}.` },
      ],
      tools: [],
    });
    expect(completion.text).not.toContain('```json');
  });

  it('ignores results from earlier turns', async () => {
    const engine = reasonedEngine();
    const completion = await engine.complete({
      messages: [
        { role: 'user', content: 'which projects use python?' },
        { role: 'user', content: `[client-agent] Query "projects.list" returned ${JSON.stringify(listResult)}.` },
        { role: 'assistant', content: 'Readback, Groundglass' },
        { role: 'user', content: 'which projects use sqlite?' },
      ],
      tools: [],
    });
    expect(completion.text).toContain('projects.list');
  });
});
