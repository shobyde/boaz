import { describe, expect, it } from 'vitest';
import { summarise, splitSentences } from '../src/core/summarise.js';

const corpus = [
  {
    id: 'a1',
    source: 'agent-post',
    sourceTitle: 'Streamed agent events',
    group: 'dev',
    text: 'Streamed agent events arrive as deltas, and the adapter buffers them until a frame completes.',
  },
  {
    id: 'a2',
    source: 'agent-post2',
    sourceTitle: 'Agent UI composition',
    group: 'dev',
    text: 'An agent UI composes tool steps, deltas and approvals from the same event stream, and each component owns one event type.',
  },
  {
    id: 'b1',
    source: 'jellyfin-post',
    sourceTitle: 'A media server in the basement',
    group: 'dev',
    text: 'Jellyfin runs on the home server and streams my film library to the TV without a subscription.',
  },
  {
    id: 'c1',
    source: 'readback-post',
    sourceTitle: 'Readback rewards',
    group: 'dev',
    text: 'Readback tracks reading for my kids, and the reward screen is the only part they ask about.',
  },
];

describe('summarise', () => {
  it('splits prose into sentences without a model', () => {
    expect(splitSentences('One thing. Two things! Three? Four')).toEqual([
      'One thing.',
      'Two things!',
      'Three?',
      'Four',
    ]);
  });

  it('answers with sentences from different documents', () => {
    const result = summarise(corpus, { query: 'what does he write about', k: 3 });
    expect(result.picks).toHaveLength(3);
    expect(new Set(result.picks.map((pick) => pick.source)).size).toBe(3);
  });

  it('follows the question when it names something', () => {
    const result = summarise(corpus, { query: 'what does he write about jellyfin', k: 2 });
    expect(result.picks[0].source).toBe('jellyfin-post');
    expect(result.unguided).toBe(false);
  });

  it('does not repeat one document when the corpus is one story', () => {
    const repeated = [
      { ...corpus[0], id: 'x1' },
      { ...corpus[0], id: 'x2' },
      { ...corpus[1], id: 'x3' },
    ];
    const result = summarise(repeated, { query: 'agent events', k: 3 });
    expect(result.picks.filter((pick) => pick.source === 'agent-post')).toHaveLength(1);
  });

  it('reports that an unguided question had no terms', () => {
    const result = summarise(corpus, { query: 'what?', k: 2 });
    expect(result.unguided).toBe(true);
    expect(result.picks).toHaveLength(2);
  });

  it('ignores fragments too short to be a sentence', () => {
    const result = summarise([...corpus, { id: 't', source: 'title', text: 'Notes' }], {
      query: 'notes',
      k: 4,
    });
    expect(result.picks.every((pick) => pick.source !== 'title')).toBe(true);
  });
});
