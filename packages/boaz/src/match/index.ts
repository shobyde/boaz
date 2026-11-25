// Matching, as a library concern: names that are nearly right, and evidence
// that is weighted by how rare a word is.
//
// Neither function knows what the app is about. The app supplies the names, the
// clauses and the vocabulary; this decides which name the words meant and which
// clause carries the question.

export interface ResolverMatch {
  /** The spelling the visitor typed. */
  from: string;
  /** The canonical name it resolved to. */
  to: string;
  /** Edit distance between the compacted forms. */
  edits: number;
  /** 1 for an exact match, lower for a fuzzier one. */
  confidence: number;
}

export interface ResolvedQuestion {
  text: string;
  matches: ResolverMatch[];
}

const compact = (text: string) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '');
const words = (text: string) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);

/** Bounded Damerau-Levenshtein: enough for a typo, cheap enough to run per span. */
export function editDistance(a: string, b: string, limit = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit;
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, index) => [index, ...Array(b.length).fill(0)]);
  for (let column = 1; column <= b.length; column += 1) rows[0][column] = column;
  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      rows[row][column] = Math.min(rows[row - 1][column] + 1, rows[row][column - 1] + 1, rows[row - 1][column - 1] + cost);
      if (row > 1 && column > 1 && a[row - 1] === b[column - 2] && a[row - 2] === b[column - 1]) {
        rows[row][column] = Math.min(rows[row][column], rows[row - 2][column - 2] + cost);
      }
    }
  }
  return rows[a.length][b.length];
}

/** A phonetic key. Two spellings of the same name usually agree on it. */
export function phoneticKey(word: string): string {
  const key = String(word).toUpperCase().replace(/[^A-Z]/g, '');
  if (!key) return '';
  const map: Record<string, number> = {
    B: 1, F: 1, P: 1, V: 1, C: 2, G: 2, J: 2, K: 2, Q: 2, S: 2, X: 2, Z: 2, D: 3, T: 3, L: 4, M: 5, N: 5, R: 6,
  };
  let tail = '';
  let last = map[key[0]] ?? 0;
  for (const char of key.slice(1)) {
    const code = map[char] ?? 0;
    if (code && code !== last) tail += String(code);
    last = code || last;
  }
  return `${key[0]}${tail.padEnd(3, '0').slice(0, 3)}`;
}

export interface EntityResolverOptions {
  /** The names the app can be asked about, in the spelling it wants back. */
  names: string[];
  /** Longest span to try, in words. "hob knob" is two. */
  maxSpan?: number;
}

/**
 * Rewrites near-miss names to the canonical one, before routing.
 *
 *   const resolver = createEntityResolver({ names: ['Hobnob', 'Readback'] });
 *   resolver.resolve('what stack does hob knob use').text
 *     // 'what stack does Hobnob use'
 *
 * Two signals must agree for a fuzzy match, unless the spelling is exact: the
 * phonetic key, or the first three letters. One signal alone matches too much:
 * "boas" is one edit from "boaz" and also from "bias".
 */
export function createEntityResolver(options: EntityResolverOptions) {
  const names = [...new Set(options.names.filter(Boolean))];
  const maxSpan = options.maxSpan ?? 3;
  const targets = names.map((name) => ({ name, compact: compact(name), phonetic: phoneticKey(name) }));

  function resolve(input: string): ResolvedQuestion {
    const original = String(input);
    const tokens = words(original.replace(/\bdot\b/gi, ' '));
    if (!tokens.length) return { text: original, matches: [] };
    const hits: Array<ResolverMatch & { start: number; span: number }> = [];

    for (const target of targets) {
      if (target.compact.length < 4) continue;
      const allowed = target.compact.length >= 8 ? 2 : 1;
      for (let span = 1; span <= maxSpan; span += 1) {
        for (let start = 0; start + span <= tokens.length; start += 1) {
          // Three tokens joined is usually a phrase, not a name; cap the bytes.
          const candidate = tokens.slice(start, start + span).join('');
          if (candidate.length < 4 || candidate.length > target.compact.length + 3) continue;
          const edits = editDistance(candidate, target.compact, 3);
          if (edits > 2) continue;
          const phonetic = phoneticKey(candidate) === target.phonetic;
          const prefix = candidate.slice(0, 3) === target.compact.slice(0, 3);
          const exact = candidate === target.compact;
          if (!exact && !(edits <= allowed && (phonetic || prefix))) continue;
          hits.push({
            from: tokens.slice(start, start + span).join(' '),
            to: target.name,
            edits,
            confidence: exact ? 1 : Math.round((1 - edits / Math.max(4, target.compact.length)) * 100) / 100,
            start,
            span,
          });
        }
      }
    }

    if (!hits.length) return { text: original, matches: [] };

    // Non-overlapping, best first, then apply every accepted hit right to left so
    // the earlier indices stay valid.
    hits.sort((a, b) => a.edits - b.edits || b.span - a.span);
    const chosen: typeof hits = [];
    for (const hit of hits) {
      if (chosen.some((other) => hit.start < other.start + other.span && other.start < hit.start + hit.span)) continue;
      chosen.push(hit);
    }

    let text = original;
    for (const hit of [...chosen].sort((a, b) => b.start - a.start)) {
      const parts = text.split(/(\s+)/);
      const out: string[] = [];
      let index = -1;
      let skip = 0;
      for (const part of parts) {
        if (/^\s+$/.test(part)) {
          out.push(part);
          continue;
        }
        index += 1;
        if (index < hit.start) {
          out.push(part);
          continue;
        }
        if (index === hit.start) {
          out.push(hit.to);
          skip = hit.span - 1;
          continue;
        }
        if (skip > 0) {
          skip -= 1;
          continue;
        }
        out.push(part);
      }
      text = out.join('').replace(/\s{2,}/g, ' ');
    }

    return {
      text,
      matches: chosen.map(({ from, to, edits, confidence }) => ({ from, to, edits, confidence })),
    };
  }

  return { names, resolve };
}

export type EntityResolver = ReturnType<typeof createEntityResolver>;

/* ------------------------------------------------------------------------- */

export interface EvidenceDocument {
  /** Stable id for the clause, so a caller can name what it quoted. */
  id: string;
  /** One sentence or fact, in the app's own words. */
  text: string;
  /** Optional subject, for asking "what does X say about Y". */
  subject?: string;
}

export interface EvidenceHit {
  document: EvidenceDocument;
  score: number;
  /** Words the clause and the question share. */
  shared: string[];
  /** True when the clause asserts absence ("no model", "never uploads"). */
  denial: boolean;
}

export interface EvidenceOptions {
  /** A clause must cover this share of the question's weight. */
  minScore?: number;
}

const STOP = new Set([
  'the', 'a', 'an', 'does', 'do', 'is', 'are', 'was', 'were', 'can', 'could', 'it', 'its', 'this', 'that',
  'with', 'for', 'and', 'or', 'to', 'in', 'on', 'of', 'any', 'have', 'has', 'had', 'be', 'by', 'from', 'as',
  'at', 'about', 'support', 'supports', 'use', 'uses', 'using', 'work', 'works', 'need', 'needs',
]);

export const contentWords = (text: string): string[] =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .split(' ')
    .filter((word) => word.length > 2 && !STOP.has(word));

/**
 * Weighted evidence over the app's own clauses.
 *
 *   const index = createEvidenceIndex(kb.clauses);
 *   index.find('does hobnob label speakers', { subject: 'Hobnob' })
 *
 * A word's weight is inverse document frequency in this corpus, so "speaker"
 * outranks "project". The head noun (the last content word of the question) has
 * to appear: sharing a verb is not evidence. A clause that asserts absence is
 * returned as a denial, which is an answer, not a miss.
 */
export function createEvidenceIndex(documents: EvidenceDocument[], options: EvidenceOptions = {}) {
  const minScore = options.minScore ?? 0.6;
  const prepared = documents.map((document) => ({ document, words: new Set(contentWords(document.text)) }));
  const documentFrequency = new Map<string, number>();
  for (const { words: set } of prepared) {
    for (const word of set) documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
  }
  const total = Math.max(1, prepared.length);
  const weight = (word: string) => Math.log(1 + total / (1 + (documentFrequency.get(word) ?? 0)));

  function find(question: string, findOptions: { subject?: string } = {}): EvidenceHit | undefined {
    const subjectWords = new Set(contentWords(findOptions.subject ?? ''));
    // Words the corpus has never seen cannot be evidence, and the subject's own
    // name is not evidence either: it is the filter, not the question. Scoring
    // over them would mark a correct clause as a miss.
    const asked = contentWords(question).filter((word) => !subjectWords.has(word) && (documentFrequency.get(word) ?? 0) > 0);
    if (!asked.length) return undefined;
    // The head noun is the last content word that is not a generic wrapper
    // ("model file", "kind of thing"): "file" is not the subject of the question,
    // "model" is.
    const GENERIC = new Set(['file', 'thing', 'kind', 'type', 'way', 'feature', 'option', 'version']);
    const head = [...asked].reverse().find((word) => !GENERIC.has(word)) ?? asked[asked.length - 1];
    let best: EvidenceHit | undefined;
    for (const { document, words: set } of prepared) {
      if (findOptions.subject && document.subject && document.subject.toLowerCase() !== findOptions.subject.toLowerCase()) continue;
      const shared = asked.filter((word) => set.has(word));
      if (!shared.length) continue;
      // The head noun is the gate: a clause about "server" for a question about
      // "quizzes" shares nothing that matters.
      if (!set.has(head)) continue;
      const totalWeight = asked.reduce((sum, word) => sum + weight(word), 0);
      const sharedWeight = shared.reduce((sum, word) => sum + weight(word), 0);
      const score = totalWeight ? sharedWeight / totalWeight : 0;
      if (score < minScore) continue;
      const denial = /\b(no|not|never|without|nobody|nothing)\b/i.test(document.text);
      if (!best || score > best.score) best = { document, score: Math.round(score * 100) / 100, shared, denial };
    }
    return best;
  }

  return {
    size: prepared.length,
    find,
    /** For diagnostics: the words the corpus makes expensive. */
    weight,
  };
}

export type EvidenceIndex = ReturnType<typeof createEvidenceIndex>;


export { aliasMap, deriveAliases, mechanicalAliases } from './aliases.js';
export type { AliasSource, DeriveOptions, DerivedAlias } from './aliases.js';
