import { describe, expect, it } from 'vitest';
import { analyzeQuestion } from '../src/core/question.js';
import { DOMAIN_SYNONYMS, LEMMAS } from '../src/core/lemmas.js';
import { tokenize } from '../src/core/retriever.js';

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

describe('pointer resolution', () => {
  const items = ['Readback', 'Groundglass', 'Hobnob'];
  const context = { items, subject: 'Readback' };

  it('resolves an ordinal against the list the last answer produced', () => {
    const analysis = analyzeQuestion('what about the second one', { subjects, context });
    expect(analysis.slots.reference).toEqual({ kind: 'ordinal', value: 'Groundglass', cue: 'the second one' });
    expect(analysis.slots.subject).toBe('Groundglass');
  });

  it('resolves the last item and number forms', () => {
    expect(analyzeQuestion('what is the last one written in', { subjects, context }).slots.reference?.value).toBe(
      'Hobnob',
    );
    expect(analyzeQuestion('number two, what stack does it use', { subjects, context }).slots.reference?.value).toBe(
      'Groundglass',
    );
  });

  it('resolves nothing when there is no list or the position is past it', () => {
    expect(analyzeQuestion('the second one', { subjects, context: { items: [] } }).slots.reference).toBeNull();
    expect(analyzeQuestion('the fifth one', { subjects, context }).slots.reference).toBeNull();
  });

  it('resolves a demonstrative to the previous subject', () => {
    expect(analyzeQuestion('what is its stack', { subjects, context }).slots.reference?.value).toBe('Readback');
    expect(analyzeQuestion('who built this', { subjects, context }).slots.reference?.value).toBe('Readback');
  });

  it('resolves a demonstrative even when the question names a technology', () => {
    const analysis = analyzeQuestion('does it use sqlite', { subjects, context });
    expect(analysis.slots.reference?.value).toBe('Readback');
    expect(analysis.slots.entities).toEqual(['SQLite']);
    // The named subject still wins the subject slot.
    expect(analysis.slots.subject).toBe('SQLite');
  });

  it('never resolves a personal pronoun to a project', () => {
    expect(analyzeQuestion('what has he built', { subjects, context }).slots.reference).toBeNull();
    expect(analyzeQuestion('what is his email', { subjects, context }).slots.reference).toBeNull();
  });

  it('resolves a partial name, but not a command that shares its prefix', () => {
    expect(analyzeQuestion('tell me about ground', { subjects }).slots.reference?.value).toBe('Groundglass');
    expect(analyzeQuestion('what is the arch', { subjects }).slots.reference?.value).toBe('the archive');
    expect(analyzeQuestion('read the newest post', { subjects }).slots.reference).toBeNull();
  });

  it('does not treat a relative clause as a pointer', () => {
    expect(analyzeQuestion('the one that uses sqlite', { subjects, context }).slots.reference).toBeNull();
  });

  it('reports the cue kind so a trace can say how it resolved', () => {
    expect(analyzeQuestion('the third project', { subjects, context }).cues).toContain('reference:ordinal');
    expect(analyzeQuestion('its stack', { subjects, context }).cues).toContain('reference:pronoun');
    expect(analyzeQuestion('tell me about ground', { subjects }).cues).toContain('reference:partial');
  });

  it('reads the connective between two names as all or any', () => {
    const all = analyzeQuestion('which projects use python and sqlite', { subjects });
    expect(all.slots.combine).toEqual({ op: 'all', between: ['Python 3.10+', 'SQLite'], cue: 'and' });

    const any = analyzeQuestion('which projects use python or sqlite', { subjects });
    expect(any.slots.combine).toEqual({ op: 'any', between: ['Python 3.10+', 'SQLite'], cue: 'or' });

    // Nothing to join with one name, and nothing to guess with no connective.
    expect(analyzeQuestion('which projects use python', { subjects }).slots.combine).toBeNull();
    expect(analyzeQuestion('which projects use python sqlite', { subjects }).slots.combine).toBeNull();
  });

  it('does not read a connective from outside the pair', () => {
    // The "and" joins a second command, not the two technologies.
    const split = analyzeQuestion('which projects use python, and tell me who he is', { subjects });
    expect(split.slots.combine).toBeNull();

    // The exclusion removes the second name, so there is no pair left to join.
    const excluded = analyzeQuestion('which projects use sqlite and not python', { subjects });
    expect(excluded.slots.combine).toBeNull();
    expect(excluded.slots.exclude).toEqual(['Python 3.10+']);
  });
});

describe('the bundled vocabulary', () => {
  const stack = ['Hobnob', 'JavaScript', 'PostgreSQL', 'TypeScript', 'Python 3.10+'];

  it('keys every lemma by a token tokenize() emits', () => {
    // A surface word used as a key would be a second tokenizer, which is the
    // 0.5.1 bug: constants indexed one way, queries matched another. Some keys
    // are only reachable through a suffix ("utilis" from "utilises"), so both
    // spellings are checked.
    for (const from of [...Object.keys(LEMMAS), ...Object.keys(DOMAIN_SYNONYMS)]) {
      expect(tokenize(from).includes(from) || tokenize(`${from}es`).includes(from)).toBe(true);
    }
  });

  it('reaches a declared name through the abbreviation a visitor types', () => {
    expect(analyzeQuestion('does anything use js', { subjects: stack }).slots.entities).toEqual(['JavaScript']);
    expect(analyzeQuestion('what runs on postgres', { subjects: stack }).slots.entities).toEqual(['PostgreSQL']);
    expect(analyzeQuestion('which projects use ts', { subjects: stack }).slots.entities).toEqual(['TypeScript']);
  });

  it('does not expand an alias inside a longer word', () => {
    expect(analyzeQuestion('which projects use charts', { subjects: stack }).slots.entities).toEqual([]);
    expect(analyzeQuestion('does the site use json', { subjects: stack }).slots.entities).toEqual([]);
  });

  it('reads a synonym as the attribute the app declared', () => {
    expect(analyzeQuestion('what is the toolset behind hobnob', { subjects: stack }).slots.attribute).toBe('stack');
    expect(analyzeQuestion('what is his bio', { subjects: stack }).slots.attribute).toBe('identity');
    expect(analyzeQuestion('what is his background', { subjects: stack }).slots.attribute).toBe('identity');
    expect(analyzeQuestion('how do i get in touch', { subjects: stack }).slots.attribute).toBe('contact');
    // And the synonym does not linger in mentions as an unexplained word.
    expect(analyzeQuestion('what is the toolset behind hobnob', { subjects: stack }).slots.mentions).not.toContain('toolset');
  });

  it('reads a completed-work phrase as the stack', () => {
    for (const query of [
      'what is built on python',
      'which projects are shipped in typescript',
      'which project runs on postgres',
      'which projects are powered by sqlite',
    ]) {
      expect(analyzeQuestion(query, { subjects: stack }).slots.attribute).toBe('stack');
    }
  });
});
