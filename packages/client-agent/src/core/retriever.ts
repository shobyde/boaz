import type { ManifestCapability } from './types.js';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are',
  'be', 'this', 'that', 'it', 'as', 'at', 'by', 'from', 'can', 'i', 'me', 'my', 'we',
  'you', 'your', 'they', 'their', 'do', 'does', 'how', 'what', 'where', 'when', 'which',
  'please', 'want', 'wants', 'need', 'needs', 'would', 'like', 'help', 'user', 'users',
]);

/**
 * Splits a query into searchable terms. Handles camelCase, dotted ids and the
 * plural forms that show up in UI copy ("invoices" should match "invoice").
 */
export function tokenize(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

function stem(term: string): string {
  if (term.length > 4 && term.endsWith('ies')) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && term.endsWith('es')) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1);
  return term;
}

export interface ScoredCapability {
  capability: ManifestCapability;
  score: number;
}

interface Doc {
  capability: ManifestCapability;
  terms: Map<string, number>;
  length: number;
}

export interface RetrieverOptions {
  /** BM25 term-frequency saturation. */
  k1?: number;
  /** BM25 length normalisation. */
  b?: number;
  /** Score added when a capability's route is the current route. */
  routeExactBoost?: number;
  /** Score added when the current route is a prefix of the capability route. */
  routePrefixBoost?: number;
}

/** Weighted fields: the title and keywords carry intent better than prose. */
const FIELD_WEIGHTS = { title: 3, keywords: 2, description: 1, id: 1.5, knowledge: 2.5 } as const;

/**
 * A BM25 index over capability metadata. Small local models cannot hold the
 * whole app in context, so retrieval decides what the prompt contains; a
 * deterministic lexical scorer is easier to test than an embedding model and
 * costs no download.
 */
export class CapabilityIndex {
  private docs: Doc[] = [];
  private df = new Map<string, number>();
  private avgLength = 0;
  private readonly k1: number;
  private readonly b: number;
  private readonly routeExactBoost: number;
  private readonly routePrefixBoost: number;

  constructor(capabilities: ManifestCapability[], options: RetrieverOptions = {}) {
    this.k1 = options.k1 ?? 1.4;
    this.b = options.b ?? 0.75;
    this.routeExactBoost = options.routeExactBoost ?? 3;
    this.routePrefixBoost = options.routePrefixBoost ?? 1.2;
    this.setCapabilities(capabilities);
  }

  setCapabilities(capabilities: ManifestCapability[]): void {
    this.docs = capabilities.map((capability) => {
      const terms = new Map<string, number>();
      const add = (text: string | undefined, weight: number) => {
        if (!text) return;
        for (const token of tokenize(text)) {
          terms.set(token, (terms.get(token) ?? 0) + weight);
        }
      };
      add(capability.title, FIELD_WEIGHTS.title);
      add(capability.id, FIELD_WEIGHTS.id);
      add(capability.keywords?.join(' '), FIELD_WEIGHTS.keywords);
      add(capability.description, FIELD_WEIGHTS.description);
      add(capability.knowledge, FIELD_WEIGHTS.knowledge);
      const length = [...terms.values()].reduce((sum, v) => sum + v, 0);
      return { capability, terms, length };
    });
    this.df.clear();
    for (const doc of this.docs) {
      for (const term of doc.terms.keys()) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }
    this.avgLength =
      this.docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(this.docs.length, 1);
  }

  /**
   * Ranks capabilities for a query. `currentRoute` boosts what the user can
   * see right now, which is the strongest signal an SPA has.
   */
  search(
    query: string,
    options: { currentRoute?: string; limit?: number; boost?: boolean } = {},
  ): ScoredCapability[] {
    const queryTerms = tokenize(query);
    const { currentRoute, limit } = options;
    const boost = options.boost ?? true;
    const total = this.docs.length;
    const scored = this.docs.map((doc) => {
      let score = 0;
      for (const term of queryTerms) {
        const tf = doc.terms.get(term);
        if (!tf) continue;
        const df = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
        const norm = this.k1 * (1 - this.b + (this.b * doc.length) / (this.avgLength || 1));
        score += idf * ((tf * (this.k1 + 1)) / (tf + norm));
      }
      if (boost && score > 0 && currentRoute) {
        const route = doc.capability.route;
        if (route === currentRoute) score += this.routeExactBoost;
        else if (route && route !== '/' && currentRoute.startsWith(route)) score += this.routePrefixBoost;
      }
      return { capability: doc.capability, score };
    });
    const ranked = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
    return typeof limit === 'number' ? ranked.slice(0, limit) : ranked;
  }
}

export function createCapabilityIndex(
  capabilities: ManifestCapability[],
  options?: RetrieverOptions,
): CapabilityIndex {
  return new CapabilityIndex(capabilities, options);
}
