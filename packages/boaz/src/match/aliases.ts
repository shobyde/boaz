// Aliases, derived at build time instead of hand-written by the app.
//
// Two tiers, and the difference matters:
//
//   mechanical: things that are the same name written differently. A camel-case
//   word, a hyphen, a plural, an acronym, a ".com". These are safe because they
//   are spelling, not meaning, and every one is reversible by inspection.
//
//   learned: words that this entity's own clauses use and other entities do not.
//   "conformance" describes Groundglass and nothing else on the page, so a
//   visitor who types it means Groundglass. These are accepted only when they
//   discriminate: common inside the entity, rare outside it, and never a word
//   from the entity's own name.

export interface AliasSource {
  /** The entity's canonical name, as the app prints it. */
  name: string;
  /** The clauses the app holds about this entity. */
  documents: string[];
}

export interface DerivedAlias {
  alias: string;
  entity: string;
  kind: 'mechanical' | 'learned';
  /** How discriminating the term is: entity share minus global share. */
  score?: number;
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'over', 'under', 'than', 'then', 'them', 'they',
  'their', 'there', 'here', 'when', 'what', 'which', 'while', 'your', 'you', 'our', 'its', 'it', 'is', 'are',
  'was', 'were', 'has', 'have', 'had', 'not', 'but', 'all', 'any', 'can', 'will', 'would', 'could', 'should',
  'one', 'two', 'each', 'every', 'more', 'most', 'some', 'such', 'own', 'same', 'only', 'also', 'because',
]);

const words = (text: string) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .split(' ')
    .filter(Boolean);

const stem = (word: string) => word.replace(/(ies)$/, 'y').replace(/(es|s)$/, '');

function splitCamel(name: string): string[] {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s._-]+/)
    .filter(Boolean);
}

/** Spelling aliases for one name: same word, different punctuation or number. */
export function mechanicalAliases(name: string): string[] {
  const out = new Set<string>();
  const parts = splitCamel(name);
  const joined = parts.join('');
  out.add(joined);
  out.add(parts.join(' '));
  out.add(parts.join('-'));
  out.add(parts.join('_'));
  // A dotted product name is typed with a space, a dot, or neither.
  if (/\./.test(name)) {
    out.add(name.replace(/\./g, ' '));
    out.add(name.replace(/\./g, ''));
    out.add(name.replace(/\.com$/, ''));
  }
  // Plural and singular of the last word.
  const last = parts[parts.length - 1] ?? '';
  if (last.endsWith('s') && last.length > 3) out.add([...parts.slice(0, -1), last.slice(0, -1)].join(''));
  else if (last) out.add([...parts.slice(0, -1), `${last}s`].join(''));
  // An acronym, when the name is two or more words.
  if (parts.length >= 2) out.add(parts.map((part) => part[0]).join(''));
  const acronym = parts.length >= 2 ? parts.map((part) => part[0]).join('') : '';
  out.delete('');
  out.delete(String(name).toLowerCase());
  // Aliases are compared, not printed: lowercase them once here so every caller
  // does not have to remember. An acronym can be two letters and still count.
  return [...out]
    .map((alias) => alias.toLowerCase())
    .filter((alias) => alias.length >= 3 || alias === acronym.toLowerCase());
}

export interface DeriveOptions {
  /** Minimum share of an entity's clauses a learned alias must appear in. */
  minEntityShare?: number;
  /** Maximum share of all other entities' clauses it may appear in. */
  maxGlobalShare?: number;
  /** Ignore entities with fewer clauses than this: one sentence is not a habit. */
  minDocuments?: number;
  /** Words that belong to the schema, not to any entity ("role", "sla"). */
  exclude?: string[];
}

/**
 * Derives aliases for every entity in one pass.
 *
 *   const aliases = deriveAliases([{ name: 'Groundglass', documents: [...] }]);
 *   // -> [{ alias: 'conformance', entity: 'Groundglass', kind: 'learned', ... }]
 */
export function deriveAliases(sources: AliasSource[], options: DeriveOptions = {}): DerivedAlias[] {
  const minEntityShare = options.minEntityShare ?? 0.5;
  const maxGlobalShare = options.maxGlobalShare ?? 0.25;
  const minDocuments = options.minDocuments ?? 2;
  // A fact table's attribute names appear in every entity's clauses, so they look
  // discriminating per entity and are worthless as aliases. The app knows its
  // schema; it passes the words here.
  const excluded = new Set((options.exclude ?? []).flatMap((word) => words(word)));

  const prepared = sources.map((source) => ({
    name: source.name,
    tokens: source.documents.map((document) => new Set(words(document))),
  }));
  const totals = new Map<string, number>();
  for (const entity of prepared) for (const set of entity.tokens) for (const word of set) totals.set(word, (totals.get(word) ?? 0) + 1);
  const totalDocuments = prepared.reduce((sum, entity) => sum + entity.tokens.length, 0) || 1;

  const result: DerivedAlias[] = [];
  const seen = new Set<string>();

  for (const entity of prepared) {
    const nameWords = new Set(words(entity.name));
    for (const alias of mechanicalAliases(entity.name)) {
      const key = `${alias}:${entity.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ alias, entity: entity.name, kind: 'mechanical' });
    }

    if (entity.tokens.length < minDocuments) continue;
    const counts = new Map<string, number>();
    for (const set of entity.tokens) for (const word of set) counts.set(word, (counts.get(word) ?? 0) + 1);

    for (const [word, count] of counts) {
      if (word.length < 4 || STOP.has(word) || excluded.has(word) || /^\d+$/.test(word)) continue;
      if (nameWords.has(word) || [...nameWords].some((nameWord) => stem(nameWord) === stem(word))) continue;
      const entityShare = count / entity.tokens.length;
      if (entityShare < minEntityShare) continue;
      const global = (totals.get(word) ?? 0) - count;
      const globalShare = global / Math.max(1, totalDocuments - entity.tokens.length);
      if (globalShare > maxGlobalShare) continue;
      const key = `${word}:${entity.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        alias: word,
        entity: entity.name,
        kind: 'learned',
        score: Math.round((entityShare - globalShare) * 100) / 100,
      });
    }
  }

  return result.sort((a, b) => (a.entity === b.entity ? (b.score ?? 0) - (a.score ?? 0) : a.entity.localeCompare(b.entity)));
}

/** The aliases as a name→aliases map, which is what a resolver wants. */
export function aliasMap(aliases: DerivedAlias[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const { alias, entity } of aliases) {
    map[alias] = [...new Set([...(map[alias] ?? []), entity])];
  }
  return map;
}
