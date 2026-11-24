// Facts are a table; these are the two questions a table cannot answer by
// joining alone.
//
// A join finds the row that matches. It cannot say which row is the largest,
// and it cannot answer a question that names a topic instead of a subject
// ("what happens during a sev 1?"). Both are ordinary questions to a person and
// both are reachable without a model: rank the values, or rank the sentences.

import type { FactRow } from './knowledge.js';

/** Text of one fact, the way a reader would say it. */
export function factText(row: FactRow): string {
  const [relation, ...args] = row;
  if (args.length === 0) return relation;
  if (args.length === 1) return `${args[0]} is a ${relation}.`;
  if (args.length === 2) return `${args[0]}: ${args[1]}.`;
  if (args.length === 3) return `${args[0]}: ${args[1]} is ${args[2]}.`;
  return `${args[0]} ${args[1]} is ${args.slice(2).join(' ')}.`;
}

/**
 * A number in a fact value: "99.95%", "12", "4", "tier 2", "400 days".
 * Percentages and counts compare directly once the unit is stripped; a tier is
 * a rank, so the digit is the value. Returns undefined when there is no number,
 * which keeps the caller from ranking on a misread.
 */
export function numberOf(value: string): number | undefined {
  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : undefined;
}

export interface RankedFact {
  /** The subject, the first argument of the row. */
  subject: string;
  /** The attribute, the second argument, when the row has one. */
  attribute?: string;
  /** The value the number came from. */
  value: string;
  number: number;
  row: FactRow;
}

/**
 * Ranks facts of one relation and attribute by the number inside the value.
 *
 *   rankFacts(facts, { relation: 'product', attribute: 'sla', direction: 'max' })
 *
 * Only rows that carry a number are ranked: a fact with "high" in it is not a
 * contender for the highest, and silently treating it as zero would let it win.
 */
export function rankFacts(
  facts: FactRow[],
  options: { relation: string; attribute?: string; direction?: 'max' | 'min' },
): RankedFact[] {
  const direction = options.direction ?? 'max';
  const ranked: RankedFact[] = [];
  for (const row of facts) {
    const [relation, subject, ...rest] = row;
    if (relation !== options.relation || !subject) continue;
    const attribute = options.attribute;
    const value = attribute ? (rest[0] === attribute ? rest[1] : undefined) : rest[rest.length - 1];
    if (value === undefined) continue;
    const number = numberOf(value);
    if (number === undefined) continue;
    ranked.push({ subject, attribute, value, number, row });
  }
  ranked.sort((a, b) => (direction === 'max' ? b.number - a.number : a.number - b.number));
  return ranked;
}

/** The one row that wins a ranking, or undefined when nothing is rankable. */
export function topFact(
  facts: FactRow[],
  options: { relation: string; attribute?: string; direction?: 'max' | 'min' },
): RankedFact | undefined {
  return rankFacts(facts, options)[0];
}

export interface FactIndexOptions {
  /** A floor on the score, so a single shared word is not a match. */
  minScore?: number;
  /** BM25 constants; the defaults are the usual ones. */
  k1?: number;
  b?: number;
}

export interface FactHit {
  row: FactRow;
  text: string;
  score: number;
}

const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'to', 'in', 'on', 'for', 'and', 'or',
  'what', 'which', 'who', 'how', 'does', 'do', 'did', 'with', 'at', 'by', 'it', 'its', 'that',
  'this', 'there', 'when', 'where', 'why', 'can', 'i', 'we', 'you', 'me', 'my', 'our',
]);

export function indexTokens(text: string): string[] {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9%]+/)
    .filter((word) => word.length > 1 && !STOP.has(word));
}

/**
 * A small BM25 over the fact sentences. It is the retrieval an app needs for
 * prose facts (a policy, a description) where the question names the topic and
 * not the subject. Same shape as the capability index, different corpus.
 */
export function createFactIndex(facts: FactRow[], options: FactIndexOptions = {}) {
  // The floor is what keeps one shared noun from being an answer. It is a score,
  // not a match count, because a policy question may share exactly one word and
  // still be the right one ("sev 1").
  const minScore = options.minScore ?? 1.15;
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;
  const docs = facts.map((row) => ({ row, text: factText(row), tokens: indexTokens(factText(row)) }));
  const average = docs.length ? docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / docs.length : 0;
  const documentFrequency = new Map<string, number>();
  for (const doc of docs) {
    for (const token of new Set(doc.tokens)) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }

  function search(query: string, limit = 3): FactHit[] {
    const terms = [...new Set(indexTokens(query))];
    if (!terms.length) return [];
    const scored = docs.map((doc) => {
      let score = 0;
      for (const term of terms) {
        const frequency = doc.tokens.filter((token) => token === term).length;
        if (!frequency) continue;
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
        score += idf * ((frequency * (k1 + 1)) / (frequency + k1 * (1 - b + (b * doc.tokens.length) / (average || 1))));
      }
      return { row: doc.row, text: doc.text, score };
    });
    return scored
      .filter((hit) => hit.score >= minScore)
      .sort((a, b2) => b2.score - a.score)
      .slice(0, limit);
  }

  return { size: docs.length, search };
}

export type FactIndex = ReturnType<typeof createFactIndex>;
