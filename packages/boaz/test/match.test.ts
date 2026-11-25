import { describe, expect, it } from 'vitest';
import { createEntityResolver, createEvidenceIndex, editDistance, phoneticKey } from '../src/match/index.js';

const resolver = createEntityResolver({ names: ['Hobnob', 'Readback', 'Groundglass', 'Boaz'] });

describe('edit distance and phonetics', () => {
  it('measures one typo as one', () => {
    expect(editDistance('hobnob', 'hobnobb')).toBe(1);
    expect(editDistance('boaz', 'boas')).toBe(1);
  });
  it('gives similar spellings the same key', () => {
    expect(phoneticKey('boaz')).toBe(phoneticKey('boas'));
  });
});

describe('entity resolution', () => {
  it('rewrites a split name', () => {
    const result = resolver.resolve('what stack does hob knob use?');
    expect(result.text).toContain('Hobnob');
    expect(result.matches[0].from).toBe('hob knob');
  });

  it('rewrites a doubled letter', () => {
    expect(resolver.resolve('tell me about hobnobb').text).toContain('Hobnob');
  });

  it('rewrites a phonetic near miss', () => {
    expect(resolver.resolve('what is boas?').text).toContain('Boaz');
  });

  it('rewrites every hit in one sentence', () => {
    const result = resolver.resolve('compare hob knob and read back');
    expect(result.text).toContain('Hobnob');
    expect(result.text).toContain('Readback');
    expect(result.matches).toHaveLength(2);
  });

  it('reports an exact name with confidence 1 and no edits', () => {
    const [match] = resolver.resolve('what is hobnob?').matches;
    expect(match.edits).toBe(0);
    expect(match.confidence).toBe(1);
  });

  it('does not rewrite unrelated words', () => {
    expect(resolver.resolve('what is the weather in boise?').matches).toEqual([]);
  });

  it('reports confidence per match', () => {
    const [match] = resolver.resolve('what is boas?').matches;
    expect(match.confidence).toBeGreaterThan(0);
    expect(match.confidence).toBeLessThanOrEqual(1);
  });
});

describe('weighted evidence', () => {
  const index = createEvidenceIndex([
    { id: 'hobnob-labels', text: 'Real-time captions carry speaker labels, produced on-device.', subject: 'Hobnob' },
    { id: 'hobnob-problem', text: 'Meeting note-takers ship your conversations to a server.', subject: 'Hobnob' },
    { id: 'readback-quiz', text: 'The school picks the quizzes and parents never see them.', subject: 'Readback' },
    { id: 'boaz-no-model', text: 'No model, no API key, nothing leaving the page.', subject: 'Boaz' },
  ]);

  it('finds the clause that carries the head noun', () => {
    expect(index.find('does hobnob have speaker labels', { subject: 'Hobnob' })?.document.id).toBe('hobnob-labels');
  });

  it('refuses a clause that only shares a verb', () => {
    expect(index.find('does readback need a server', { subject: 'Readback' })?.document.id).not.toBe('readback-quiz');
  });

  it('marks a denial as a denial', () => {
    const hit = index.find('does boaz need a model file', { subject: 'Boaz' });
    expect(hit?.document.id).toBe('boaz-no-model');
    expect(hit?.denial).toBe(true);
  });

  it('weights a rare word above a common one', () => {
    expect(index.weight('speaker')).toBeGreaterThanOrEqual(index.weight('meeting'));
  });

  it('returns undefined when nothing is on point', () => {
    expect(index.find('does hobnob support klingon', { subject: 'Hobnob' })).toBeUndefined();
  });
});
