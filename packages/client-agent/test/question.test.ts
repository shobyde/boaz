import { describe, expect, it } from 'vitest';
import { analyzeQuestion } from '../src/core/question.js';

const subjects = ['Hobnob', 'Readback', 'Groundglass', 'Python 3.10+', 'SQLite', 'the archive'];

function typeOf(query: string): string {
  return analyzeQuestion(query, { subjects }).type;
}

describe('analyzeQuestion', () => {
  it('classifies the eight interrogative frames', () => {
    expect(typeOf('who is sho')).toBe('who');
    expect(typeOf('what has he built')).toBe('what');
    expect(typeOf('where is he based')).toBe('where');
    expect(typeOf('when did groundglass ship')).toBe('when');
    expect(typeOf('how many posts are there')).toBe('how-many');
    expect(typeOf('which projects use python')).toBe('which');
    expect(typeOf('why did he build groundglass')).toBe('why');
    expect(typeOf('compare hobnob and readback')).toBe('compare');
  });

  it('prefers the frame that carries the request', () => {
    // A comparison is a comparison even when it opens with "what".
    expect(typeOf("what's the difference between hobnob and readback")).toBe('compare');
    expect(typeOf('how does readback compare with hobnob')).toBe('compare');
    // A count inside a date question is still a count.
    expect(typeOf('how many posts did he write in 2024')).toBe('how-many');
    expect(typeOf('how much has he written')).toBe('how-many');
  });

  it('leaves requests and bare nouns unclassified', () => {
    const request = analyzeQuestion('take me to the archive', { subjects });
    expect(request.type).not.toBe('which');
    expect(request.questionShaped).toBe(false);
    expect(analyzeQuestion('python', { subjects }).type).toBe('unknown');
  });

  it('marks a close call as contested rather than hiding it', () => {
    const analysis = analyzeQuestion('when and where did groundglass ship', { subjects });
    expect(analysis.type).toBe('where');
    expect(analysis.contested).toBe('when');
    expect(analyzeQuestion('which projects use python', { subjects }).contested).toBeNull();
  });

  it('canonicalises declared subjects through the same tokenizer', () => {
    const analysis = analyzeQuestion('which projects use sqlite and python', { subjects });
    expect(analysis.slots.entities).toEqual(['SQLite', 'Python 3.10+']);
    expect(analysis.slots.subject).toBe('SQLite');
  });

  it('fills the recency qualifier and the attribute', () => {
    const newest = analyzeQuestion('what is the newest post about', { subjects });
    expect(newest.slots.newest).toBe('newest');
    expect(newest.slots.attribute).toBe('writing');

    const stack = analyzeQuestion('which projects use python', { subjects });
    expect(stack.slots.attribute).toBe('stack');
  });

  it('reports words no subject or attribute accounted for', () => {
    const analysis = analyzeQuestion('which projects use typescript', { subjects });
    expect(analysis.slots.mentions).toContain('typescript');
    expect(analysis.slots.subject).toBeNull();
  });

  it('flags a pronoun referral instead of inventing a subject', () => {
    const analysis = analyzeQuestion('and its stack?', { subjects });
    expect(analysis.slots.referenced).toBe(true);
    expect(analysis.slots.subject).toBeNull();
  });

  it('is stable for the same input', () => {
    const a = analyzeQuestion('where can I read the newest post', { subjects });
    const b = analyzeQuestion('where can I read the newest post', { subjects });
    expect(a).toEqual(b);
    expect(a.type).toBe('where');
    expect(a.slots.newest).toBe('newest');
  });

  it('reads a negation scope as an exclusion, not an entity', () => {
    const analysis = analyzeQuestion('which projects use python but not readback', { subjects });
    expect(analysis.slots.entities).toEqual(['Python 3.10+']);
    expect(analysis.slots.exclude).toEqual(['Readback']);
  });

  it('handles the phrasing a visitor actually uses', () => {
    expect(analyzeQuestion('anything but hobnob', { subjects }).slots.exclude).toEqual(['Hobnob']);
    expect(analyzeQuestion('which projects use sqlite, excluding readback', { subjects }).slots.exclude).toEqual([
      'Readback',
    ]);
    expect(analyzeQuestion('explain groundglass without mentioning hobnob', { subjects }).slots.exclude).toEqual([
      'Hobnob',
    ]);
  });

  it('ends the exclusion when a new clause starts', () => {
    const analysis = analyzeQuestion('not the archive, take me to the blog', { subjects });
    expect(analysis.slots.exclude).toEqual(['the archive']);
  });

  it('does not read an idiom as an exclusion', () => {
    expect(analyzeQuestion('not sure, which projects use python', { subjects }).slots.exclude).toEqual([]);
    expect(analyzeQuestion('why not python', { subjects }).slots.exclude).toEqual([]);
    expect(analyzeQuestion('why is there no model in the assistant', { subjects }).slots.exclude).toEqual([]);
  });
});
