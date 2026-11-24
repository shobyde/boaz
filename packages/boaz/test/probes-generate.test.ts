import { describe, expect, it } from 'vitest';
import { generateProbes, normalizePhrase, serializeProbes } from '../src/build/probes.js';
import type { AgentManifest, ManifestCapability } from '../src/core/types.js';

function capability(partial: Partial<ManifestCapability> & Pick<ManifestCapability, 'id' | 'kind'>): ManifestCapability {
  return {
    title: partial.id,
    description: `${partial.id} does something`,
    keywords: [],
    ...partial,
  } as ManifestCapability;
}

function manifest(capabilities: ManifestCapability[]): AgentManifest {
  return { version: 1, capabilities };
}

describe('normalizePhrase', () => {
  it('folds case and whitespace so one phrase is one phrase', () => {
    expect(normalizePhrase('  All   Posts ')).toBe('all posts');
  });
});

describe('generateProbes', () => {
  it('turns each title and keyword into a probe that expects its own capability', () => {
    const result = generateProbes(
      manifest([
        capability({ id: 'billing.open', kind: 'action', title: 'Open the invoice list', keywords: ['invoices', 'show bills'] }),
      ]),
    );
    expect(result.questions.map((question) => question.question)).toEqual([
      'invoices',
      'open the invoice list',
      'show bills',
    ]);
    expect(result.questions.every((question) => question.expect === 'billing.open')).toBe(true);
    expect(result.questions.every((question) => question.intent === 'billing.open')).toBe(true);
    expect(result.collisions).toEqual([]);
    expect(result.uncovered).toEqual([]);
  });

  it('makes a route probe a request, because a route is reached by asking to go there', () => {
    const result = generateProbes(manifest([capability({ id: 'site.faq', kind: 'route', title: 'FAQ', keywords: [] })]));
    expect(result.questions[0]?.question).toBe('take me to faq');
  });

  it('reports a keyword two capabilities in the same class claim', () => {
    const result = generateProbes(
      manifest([
        capability({ id: 'about.sho', kind: 'knowledge', title: 'Who he is', keywords: ['about', 'bio'] }),
        capability({ id: 'about.team', kind: 'knowledge', title: 'Team', keywords: ['about', 'history'] }),
      ]),
    );
    expect(result.collisions.some((collision) => collision.phrase === 'about' && collision.source === 'keyword')).toBe(true);
    const questions = result.questions.map((question) => question.question);
    expect(questions).not.toContain('about');
    expect(questions).toContain('bio');
    expect(questions).toContain('history');
  });

  it('lets a question and a request share a phrase, because the form of the probe differs', () => {
    const result = generateProbes(
      manifest([
        capability({ id: 'about.sho', kind: 'knowledge', title: 'About Sho', keywords: ['about'] }),
        capability({ id: 'site.about', kind: 'route', title: 'About Sho', keywords: ['about'] }),
      ]),
    );
    expect(result.questions.map((question) => question.question)).toEqual([
      'about',
      'about sho',
      'take me to about',
      'take me to about sho',
    ]);
    expect(result.collisions).toEqual([]);
  });

  it('reports two capabilities that write the same title', () => {
    const result = generateProbes(
      manifest([
        capability({ id: 'one', kind: 'action', title: 'Show the card', keywords: [] }),
        capability({ id: 'two', kind: 'action', title: 'show the  card', keywords: [] }),
      ]),
    );
    expect(result.questions).toEqual([]);
    expect(result.collisions[0]?.claimants).toEqual(['one', 'two']);
    expect(result.uncovered.map((gap) => gap.id)).toEqual(['one', 'two']);
  });

  it('names a capability nothing can ask for', () => {
    const result = generateProbes(
      manifest([
        capability({ id: 'x.y', kind: 'action', title: '', keywords: [] }),
        capability({ id: 'a.b', kind: 'action', title: 'Show a card', keywords: ['card'] }),
        capability({ id: 'c.d', kind: 'action', title: 'Show the card', keywords: ['card'] }),
      ]),
    );
    expect(result.uncovered.map((gap) => gap.id)).toEqual(['x.y']);
    expect(result.uncovered[0]?.reason).toMatch(/nothing to ask/);
  });

  it('drops a capability whose every phrase belongs to someone else', () => {
    const result = generateProbes(
      manifest([
        capability({ id: 'one', kind: 'action', title: 'Email me', keywords: ['email'] }),
        capability({ id: 'two', kind: 'action', title: 'Copy email', keywords: ['email'] }),
      ]),
      { titles: false },
    );
    expect(result.questions).toEqual([]);
    expect(result.uncovered.map((gap) => gap.id).sort()).toEqual(['one', 'two']);
    expect(result.uncovered[0]?.reason).toMatch(/claimed by another request capability/);
  });

  it('reports a capability that needs arguments instead of guessing one', () => {
    const result = generateProbes(
      manifest([
        capability({
          id: 'projects.open',
          kind: 'action',
          title: 'Open a project link',
          keywords: ['repo', 'website'],
          paramsSchema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
        } as Partial<ManifestCapability> & Pick<ManifestCapability, 'id' | 'kind'>),
        capability({ id: 'site.top', kind: 'route', title: 'Top of the page', keywords: ['top'] }),
      ]),
    );
    expect(result.questions.map((question) => question.expect)).toEqual(['site.top', 'site.top']);
    expect(result.uncovered).toEqual([
      { id: 'projects.open', reason: 'needs arguments (project), which a phrase alone cannot supply', needsArgs: ['project'] },
    ]);
  });

  it('serializes to a probe file the loader accepts', () => {
    const result = generateProbes(manifest([capability({ id: 'a.b', kind: 'action', title: 'Show the map', keywords: [] })]));
    const parsed = JSON.parse(serializeProbes(result)) as { questions: Array<Record<string, string>> };
    expect(parsed.questions).toEqual([{ question: 'show the map', expect: 'a.b', intent: 'a.b' }]);
  });
});
