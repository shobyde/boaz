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
