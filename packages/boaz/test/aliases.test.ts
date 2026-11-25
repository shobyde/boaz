import { describe, expect, it } from 'vitest';
import { aliasMap, deriveAliases, mechanicalAliases } from '../src/match/index.js';

describe('mechanical aliases', () => {
  it('splits a camel-case name every way a visitor might type it', () => {
    const aliases = mechanicalAliases('TypeScript');
    expect(aliases).toContain('type script');
    expect(aliases).toContain('typescript');
    expect(aliases).toContain('type-script');
  });

  it('handles a dotted product name', () => {
    const aliases = mechanicalAliases('shobyde.com');
    expect(aliases).toContain('shobyde com');
    expect(aliases).toContain('shobyde');
  });

  it('adds a plural and an acronym', () => {
    const aliases = mechanicalAliases('Live Captions');
    expect(aliases).toContain('livecaptions');
    expect(aliases).toContain('lc');
  });
});

describe('learned aliases', () => {
  const sources = [
    {
      name: 'Groundglass',
      documents: [
        'Groundglass rebuilds the surface a stream describes and reports what a renderer would silently skip.',
        'The conformance tests run against A2UI v1.0.',
        'Conformance checks catch a missing component before a visitor does.',
      ],
    },
    {
      name: 'Hobnob',
      documents: ['Hobnob transcribes meetings on-device.', 'Speaker labels are produced locally.'],
    },
    {
      name: 'Readback',
      documents: ['Readback is self-hosted reading for families.', 'Quizzes are chosen by a human reviewer.'],
    },
  ];

  it('learns a word that only one entity uses', () => {
    const aliases = deriveAliases(sources);
    expect(aliases.some((alias) => alias.alias === 'conformance' && alias.entity === 'Groundglass')).toBe(true);
  });

  it('does not learn a word from the entity name', () => {
    const aliases = deriveAliases(sources);
    expect(aliases.some((alias) => alias.kind === 'learned' && alias.alias === 'groundglass')).toBe(false);
  });

  it('does not learn a word every entity uses', () => {
    const aliases = deriveAliases([
      { name: 'A', documents: ['alpha uses rules daily', 'rules again here'] },
      { name: 'B', documents: ['beta uses rules daily', 'rules again here'] },
    ]);
    expect(aliases.some((alias) => alias.kind === 'learned' && alias.alias === 'rules')).toBe(false);
  });

  it('ignores an entity with one clause', () => {
    const aliases = deriveAliases([{ name: 'Solo', documents: ['conformance conformance conformance'] }]);
    expect(aliases.some((alias) => alias.kind === 'learned')).toBe(false);
  });

  it('builds a name map', () => {
    const map = aliasMap(deriveAliases(sources));
    expect(map['conformance']).toContain('Groundglass');
  });
});
