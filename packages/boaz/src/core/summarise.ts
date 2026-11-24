/* ============================================================
   Extractive summarisation without a model.

   Given a handful of candidate sentences (each tagged with the
   document it came from), pick k of them: the ones most related to
   the question, and not saying the same thing as each other. That
   is Maximal Marginal Relevance over tf-idf cosine, which needs no
   weights, no training data and no inference budget.

   The two failures this exists to avoid:
   - a plain relevance ranking returns one document's family of
     sentences and calls it a summary;
   - a plain first-k-by-date list ignores the question entirely.

   It returns the picks with their scores so the caller can show
   what was used, and so a harness can score a summary instead of
   trusting it.
   ============================================================ */

import { tokenize } from './retriever.js';

export interface SummarySentence {
  /** Stable id, unique within the corpus. */
  id: string;
  /** One sentence. Titles and headings are not sentences. */
  text: string;
  /** The document this sentence came from; the citation the caller shows. */
  source: string;
  /** Human label for the source, e.g. a post title. */
  sourceTitle?: string;
  /** Optional grouping (tag, section) used to keep picks from one cluster. */
  group?: string;
}

export interface SummaryPick extends SummarySentence {
  /** Cosine similarity to the question, 0 when the question names nothing. */
  relevance: number;
  /** 1 - the closest similarity to an already picked sentence. */
  novelty: number;
  /** The MMR score that decided the pick. */
  score: number;
}

export interface SummaryOptions {
  /** The visitor's words. Empty means "diversify over everything". */
  query?: string;
  /** How many sentences to return. Default 3. */
  k?: number;
  /** Relevance weight in MMR; 1 is pure relevance, 0 pure novelty. Default 0.7. */
  lambda?: number;
  /** At most this many picks per source document. Default 1. */
  maxPerSource?: number;
  /** Sentences shorter than this (in characters) are not summarised. Default 24. */
  minLength?: number;
}

export interface SummaryResult {
  picks: SummaryPick[];
  /** Candidate sentences considered after filtering. */
  considered: number;
  /** The query terms actually used, after tokenizing and stemming. */
  terms: string[];
  /** True when the question named nothing in the corpus. */
  unguided: boolean;
}

type Vector = Record<string, number>;

function termCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function cosine(a: Vector, b: Vector): number {
  let dot = 0;
  for (const [term, weight] of Object.entries(a)) dot += weight * (b[term] ?? 0);
  return dot; // both sides are unit vectors
}

function normalise(vector: Vector): Vector {
  let sum = 0;
  for (const weight of Object.values(vector)) sum += weight * weight;
  const length = Math.sqrt(sum);
  if (length === 0) return {};
  for (const term of Object.keys(vector)) vector[term] /= length;
  return vector;
}

/** Split prose into sentences without a model: punctuation, then length. */
export function splitSentences(text: string): string[] {
  return String(text)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'\u201c(])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

export function summarise(
  sentences: SummarySentence[],
  options: SummaryOptions = {},
): SummaryResult {
  const k = Math.max(1, options.k ?? 3);
  const lambda = Math.min(1, Math.max(0, options.lambda ?? 0.7));
  const maxPerSource = Math.max(1, options.maxPerSource ?? 1);
  const minLength = options.minLength ?? 24;

  const candidates = sentences.filter(
    (sentence) => sentence.text && sentence.text.trim().length >= minLength,
  );
  const terms = tokenize(options.query ?? '');

  if (candidates.length === 0) {
    return { picks: [], considered: 0, terms, unguided: terms.length === 0 };
  }

  const tokenised = candidates.map((sentence) =>
    tokenize(`${sentence.text} ${sentence.sourceTitle ?? ''} ${sentence.group ?? ''}`),
  );
  const documentFrequency = new Map<string, number>();
  for (const tokens of tokenised) {
    for (const term of new Set(tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const total = candidates.length;
  const idf = (term: string) => Math.log(1 + total / (1 + (documentFrequency.get(term) ?? 0)));

  const vectors: Vector[] = tokenised.map((tokens) => {
    const vector: Vector = {};
    for (const [term, count] of termCounts(tokens)) vector[term] = count * idf(term);
    return normalise(vector);
  });

  const queryVector: Vector = {};
  for (const [term, count] of termCounts(terms)) queryVector[term] = count * idf(term);
  normalise(queryVector);

  const relevance = vectors.map((vector) =>
    Object.keys(queryVector).length === 0 ? 1 : cosine(queryVector, vector),
  );
  const unguided = Object.keys(queryVector).length === 0;

  const picked: number[] = [];
  const perSource = new Map<string, number>();
  const used = new Set<number>();

  while (picked.length < Math.min(k, candidates.length)) {
    let bestIndex = -1;
    let bestScore = -Infinity;
    let bestNovelty = 0;

    for (let index = 0; index < candidates.length; index += 1) {
      if (used.has(index)) continue;
      const source = candidates[index].source;
      if ((perSource.get(source) ?? 0) >= maxPerSource) continue;

      let nearest = 0;
      for (const selected of picked) {
        nearest = Math.max(nearest, cosine(vectors[index], vectors[selected]));
      }
      const novelty = 1 - nearest;
      const score = lambda * relevance[index] + (1 - lambda) * novelty;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
        bestNovelty = novelty;
      }
    }

    if (bestIndex === -1) break;
    used.add(bestIndex);
    picked.push(bestIndex);
    perSource.set(candidates[bestIndex].source, (perSource.get(candidates[bestIndex].source) ?? 0) + 1);
    (candidates[bestIndex] as SummaryPick).relevance = round(relevance[bestIndex]);
    (candidates[bestIndex] as SummaryPick).novelty = round(bestNovelty);
    (candidates[bestIndex] as SummaryPick).score = round(bestScore);
  }

  return {
    picks: picked.map((index) => candidates[index] as SummaryPick),
    considered: candidates.length,
    terms,
    unguided,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
