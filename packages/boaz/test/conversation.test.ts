import { describe, expect, it } from 'vitest';
import { defineCapability } from '../src/core/define.js';
import { createConversation } from '../src/conversation/index.js';

const repo = (query: string) => {
  if (/\bboaz\b/i.test(query)) return 'boaz';
  if (/hobnob/i.test(query)) return 'hobnob';
  if (/readback/i.test(query)) return 'readback';
  return null;
};

const github = defineCapability({
  id: 'github.activity',
  kind: 'query',
  title: 'Read GitHub activity',
  description: 'Reads commit, release and star counts for a repository.',
  keywords: ['github', 'commits', 'releases', 'repo activity'],
  paramsSchema: {
    type: 'object',
    properties: { repo: { type: 'string', enum: ['boaz', 'hobnob', 'readback'] } },
    required: ['repo'],
    additionalProperties: false,
  },
  handler: async ({ repo: name }) => ({ answer: `${name}: 81 commits, 67 releases.` }),
});

const conversation = () =>
  createConversation({
    instructions: 'Answer from the project record.',
    subjects: ['Boaz', 'Hobnob', 'Readback'],
    tools: [{
      ...github,
      resolve: (query) => {
        const value = repo(query);
        return value ? { repo: value } : null;
      },
    }],
  });

describe('conversation facade', () => {
  it('accepts a system prompt as knowledge', async () => {
    const chat = createConversation({
      knowledge: 'Answer from the project record.',
      subjects: ['Boaz'],
      tools: [{
        ...github,
        resolve: (query) => (/boaz/i.test(query) ? { repo: 'boaz' } : null),
      }],
    });
    const turn = await chat.ask('how many commits does Boaz have?');
    expect(turn.text).toContain('boaz');
  });

  it('runs a direct tool and records the turn', async () => {
    const chat = conversation();
    const turn = await chat.ask('how many commits does Boaz have?');
    expect(turn.text).toContain('boaz');
    expect(turn.steps.some((step) => step.type === 'query')).toBe(true);
    expect(chat.memory.turns.at(-1)).toMatchObject({
      capabilityId: 'github.activity',
      args: { repo: 'boaz' },
      subject: 'Boaz',
    });
  });

  it('streams text, tool and completion events', async () => {
    const chat = conversation();
    const events = [];
    for await (const event of chat.stream('how many commits does Boaz have?')) {
      events.push(event);
    }
    const types = events.map((event) => event.type);
    expect(types[0]).toBe('turn.started');
    expect(types).toContain('tool.use');
    expect(types).toContain('tool.result');
    expect(types).toContain('text.delta');
    expect(types.at(-1)).toBe('turn.completed');
    expect(events.find((event) => event.type === 'turn.completed')?.turn.text).toContain('boaz');
  });

  it('continues the last tool with a new subject', async () => {
    const chat = conversation();
    await chat.ask('how many commits does Boaz have?');
    const turn = await chat.ask('what about Hobnob?');
    expect(turn.kind).toBe('continue-new-subject');
    expect(turn.followUp?.query).toBe('how many commits does Hobnob have?');
    expect(turn.text).toContain('hobnob');
    expect(turn.steps.some((step) => step.type === 'query' && step.capabilityId === 'github.activity')).toBe(true);
    expect(chat.memory.turns.at(-1)?.query).toBe('how many commits does Hobnob have?');
  });

  it('carries the effective query through another continuation', async () => {
    const chat = conversation();
    await chat.ask('how many commits does Boaz have?');
    await chat.ask('what about Hobnob?');
    const turn = await chat.ask('and Readback?');
    expect(turn.followUp?.query).toBe('how many commits does Readback have?');
    expect(turn.text).toContain('readback');
  });

  it('classifies recap, commands and fresh questions', async () => {
    const chat = conversation();
    await chat.ask('how many commits does Boaz have?');
    expect(chat.classify('what did we cover?').kind).toBe('recap');
    expect(chat.classify('show me the work').kind).toBe('command');
    expect(chat.classify('what is Hobnob?').kind).toBe('fresh');
  });

  it('answers a recap from memory without running the runtime', async () => {
    const chat = conversation();
    await chat.ask('how many commits does Boaz have?');
    const turn = await chat.ask('what did we cover?');
    expect(turn.kind).toBe('recap');
    expect(turn.text).toContain('Boaz');
    expect(turn.steps).toEqual([]);
  });

  it('resets runtime and memory together', async () => {
    const chat = conversation();
    await chat.ask('how many commits does Boaz have?');
    chat.reset();
    expect(chat.memory.turns).toEqual([]);
    expect(chat.runtime.conversation).toEqual([]);
  });
});

describe('conversation context resolution', () => {
  const makeContextChat = () => {
    const echo = defineCapability({
      id: 'echo',
      kind: 'query',
      title: 'Echo',
      description: 'Echoes the resolved question.',
      paramsSchema: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
        additionalProperties: false,
      },
      handler: async ({ q }) => ({
        answer: q.startsWith('what has he built')
          ? 'Hobnob, Readback, Groundglass'
          : q.includes('projects use python')
            ? 'Readback, Groundglass'
            : q,
      }),
    });
    let calls = [];
    const chat = createConversation({
      subjects: ['Hobnob', 'Readback', 'Groundglass', 'Boaz'],
      descriptions: [
        { match: /reading|books/i, subject: 'Readback' },
        { match: /meeting|notes/i, subject: 'Hobnob' },
        { match: /generated|interface|conformance/i, subject: 'Groundglass' },
      ],
      pointable: (name) => ['Hobnob', 'Readback', 'Groundglass', 'Boaz'].includes(name),
      sizeOf: (name) => ({ Hobnob: 8142, Readback: 7315, Groundglass: 1771, Boaz: 11374 })[name] ?? null,
      tools: [echo],
      getSnapshot: () => ({ currentRoute: '/' }),
      resolveTool: (q) => {
        calls.push(q);
        return { id: 'echo', args: { q } };
      },
    });
    return { chat, calls };
  };

  it('keeps the subject through a digression', async () => {
    const { chat, calls } = makeContextChat();
    await chat.ask('Tell me about Hobnob.');
    await chat.ask('What is his email?');
    await chat.ask('and its stack?');
    expect(calls.at(-1)).toMatch(/Hobnob.*stack|stack.*Hobnob/i);
  });

  it('resolves a description pointer', async () => {
    const { chat, calls } = makeContextChat();
    await chat.ask('What stack does Hobnob use?');
    await chat.ask('and the one for testing generated interfaces?');
    expect(calls.at(-1)).toContain('Groundglass');
  });

  it('resolves an ordinal from the last list', async () => {
    const { chat, calls } = makeContextChat();
    await chat.ask('what has he built?');
    await chat.ask('the third one?');
    expect(calls.at(-1)).toContain('Groundglass');
  });

  it('resolves an exclusion from the last list', async () => {
    const { chat, calls } = makeContextChat();
    await chat.ask('which projects use python?');
    await chat.ask('not Readback, the other one');
    expect(calls.at(-1)).toContain('Groundglass');
    expect(calls.at(-1)).not.toContain('Readback');
  });

  it('turns a size follow-up into a size comparison', async () => {
    const { chat, calls } = makeContextChat();
    await chat.ask('Compare Hobnob and Readback.');
    await chat.ask('which one is bigger?');
    expect(calls.at(-1)).toMatch(/compare .*Hobnob.*Readback.*size/i);
  });

  it('resolves a privacy follow-up against the current subject', async () => {
    const { chat, calls } = makeContextChat();
    await chat.ask('Tell me about Boaz.');
    await chat.ask('what about its privacy?');
    expect(calls.at(-1)).toMatch(/does Boaz send data/i);
  });
});
