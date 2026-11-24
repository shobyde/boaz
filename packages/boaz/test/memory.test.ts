import { describe, expect, it } from 'vitest';
import { createWorkingMemory, isCoverageQuery } from '../src/core/memory.js';

const SUBJECTS = ['Hobnob', 'Readback', 'Groundglass', 'Boaz', 'Python 3.10+', 'TypeScript', 'SQLite'];

const memory = (options = {}) => createWorkingMemory({ subjects: SUBJECTS, ...options });

const say = (mem: ReturnType<typeof memory>, turns: string[]) => {
  for (const turn of turns) mem.observe(turn);
  return mem;
};

describe('working memory: entity tracking', () => {
  it('records the declared subject a turn is about', () => {
    const mem = say(memory(), ['tell me about hobnob']);
    expect(mem.turns[0].entities).toEqual(['Hobnob']);
    expect(mem.turns[0].subject).toBe('Hobnob');
  });

  it('keeps a subject across an intervening change of topic', () => {
    const mem = say(memory(), ['tell me about hobnob', 'what is his email', 'and its stack']);
    const first = mem.salient()[0];
    expect(first.name).toBe('Hobnob');
  });

  it('resolves a pointer through context() rather than the raw last sentence', () => {
    const mem = say(memory(), ['tell me about hobnob', 'what is his email']);
    expect(mem.context().subject).toBe('Hobnob');
  });

  it('accepts an entity the analyzer cannot see, from a tool result', () => {
    const mem = memory();
    mem.observe('which projects use python', { entities: ['Groundglass'] });
    expect(mem.turns[0].entities).toContain('Groundglass');
  });

  it('does not treat an excluded subject as the turn subject', () => {
    const mem = say(memory(), ['which projects use python but not hobnob']);
    expect(mem.turns[0].entities).not.toContain('Hobnob');
  });
});

describe('working memory: salience and decay', () => {
  it('ranks a repeated subject above a one-off mention', () => {
    const mem = say(memory(), ['hobnob', 'readback', 'hobnob again', 'hobnob and its stack']);
    expect(mem.salient()[0].name).toBe('Hobnob');
    expect(mem.salient()[0].mentions).toBe(3);
  });

  it('halves a mention every halfLife turns', () => {
    const mem = say(memory(), ['hobnob', 'something unrelated', 'something unrelated again']);
    const entry = mem.salient().find((entity) => entity.name === 'Hobnob');
    expect(entry?.salience).toBeCloseTo(Math.pow(0.5, 2 / 2.5), 5);
  });

  it('drops a subject that has not been mentioned for six turns', () => {
    const mem = say(memory(), [
      'hobnob',
      'which projects use python',
      'what is his email',
      'what did he build with typescript',
      'how many posts',
      'read the newest article',
      'take me to the archive',
    ]);
    expect(mem.salient().map((entity) => entity.name)).not.toContain('Hobnob');
  });

  it('keeps the working set empty on a fresh session', () => {
    const mem = memory();
    expect(mem.salient()).toEqual([]);
    expect(mem.context()).toEqual({ subject: null, items: [] });
  });

  it('reset() clears turns and salience together', () => {
    const mem = say(memory(), ['hobnob']);
    mem.reset();
    expect(mem.turns).toEqual([]);
    expect(mem.salient()).toEqual([]);
  });

  it('keeps only `limit` turns but does not reset ages', () => {
    const mem = memory({ limit: 3 });
    say(mem, ['hobnob', 'a', 'b', 'c']);
    expect(mem.turns).toHaveLength(3);
    expect(mem.turns[2].turn).toBe(4);
    expect(mem.salient().find((entity) => entity.name === 'Hobnob')?.salience).toBeCloseTo(Math.pow(0.5, 3 / 2.5), 5);
  });
});

describe('working memory: coverage', () => {
  it('recognises the phrasings it claims, and only those', () => {
    for (const query of ['what did we cover', 'what have we discussed', 'where were we', 'recap this chat', 'remind me what we covered']) {
      expect(isCoverageQuery(query), query).toBe(true);
    }
    for (const query of ['which projects use python', 'what is his email', 'cover the archive']) {
      expect(isCoverageQuery(query), query).toBe(false);
    }
  });

  it('names what was covered in the order it came up', () => {
    const mem = say(memory(), ['tell me about hobnob', 'which projects use python', 'which projects use typescript']);
    const coverage = mem.covered();
    expect(coverage.sentence).toMatch(/^So far we covered Hobnob, Python 3\.10\+ and TypeScript\.$/);
  });

  it('reports a subject the working set has already dropped', () => {
    const mem = say(memory(), ['hobnob', 'a', 'b', 'c', 'd', 'e', 'f']);
    expect(mem.salient().map((entity) => entity.name)).not.toContain('Hobnob');
    expect(mem.covered().entities).toContain('Hobnob');
  });

  it('says nothing rather than inventing a first turn', () => {
    const coverage = memory().covered();
    expect(coverage.sentence).toBe('Nothing yet. This is the first thing you have asked in this session.');
    expect(coverage.empty).toBe(true);
  });

  it('counts what it did not name', () => {
    const mem = say(memory(), ['hobnob', 'readback', 'groundglass', '@shobyde/boaz', 'typescript', 'python 3.10+']);
    const coverage = mem.covered({ limit: 3 });
    expect(coverage.sentence).toMatch(/, and 3 more\.$/);
  });
});
