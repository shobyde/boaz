/**
 * Field extraction: the "read the page" half of grounding.
 *
 * A deterministic assistant can answer from declared facts, but only for the
 * facts someone declared. This scans text the host already has (the visible
 * page, a README, a retrieved document) for well-known field kinds, so an
 * undeclared value like an email address can still be answered, and cited.
 */

export type FieldKind = 'email' | 'linkedin' | 'url' | 'phone';

export interface ScanHit {
  kind: FieldKind;
  value: string;
  /** Where it was found, for the sentence the host writes. */
  evidence: string;
}

export interface FieldScannerOptions {
  /** Override or extend the built-in patterns, keyed by kind. */
  patterns?: Partial<Record<FieldKind, RegExp>>;
  /** Kinds to look for by default. */
  kinds?: FieldKind[];
}

/** Ordered worst-to-best: the first match wins per kind, so keep them tight. */
export const DEFAULT_PATTERNS: Record<FieldKind, RegExp> = {
  email: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  linkedin: /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[a-z0-9_-]+/i,
  phone: /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/,
  // Last: it would otherwise swallow the email's domain or a mailto wrapper.
  url: /https?:\/\/[^\s<>"')]+/i,
};

const CLEAN_TRAILING = /[.,;:!?)]+$/;

/** Trims punctuation and a `mailto:` wrapper, without touching the address. */
function tidy(kind: FieldKind, raw: string): string {
  let value = raw.trim().replace(CLEAN_TRAILING, '');
  if (kind === 'email') value = value.replace(/^mailto:/i, '');
  if (kind === 'linkedin') value = value.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return value;
}

/** The sentence around a hit, trimmed, so a host can say where it came from. */
function evidenceFor(text: string, index: number, length: number): string {
  const before = text.lastIndexOf('.', index);
  const start = before === -1 ? Math.max(0, index - 60) : before + 1;
  const after = text.indexOf('.', index + length);
  const end = after === -1 ? Math.min(text.length, index + length + 60) : after;
  const sentence = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return sentence.length > 140 ? `${sentence.slice(0, 137)}...` : sentence;
}

export interface FieldScanner {
  scan(text: string, kinds?: FieldKind[]): ScanHit[];
  kinds: FieldKind[];
}

export function createFieldScanner(options: FieldScannerOptions = {}): FieldScanner {
  const patterns = { ...DEFAULT_PATTERNS, ...(options.patterns ?? {}) };
  const kinds = options.kinds ?? (Object.keys(patterns) as FieldKind[]);

  return {
    kinds,
    scan(text: string, wanted: FieldKind[] = kinds): ScanHit[] {
      if (!text) return [];
      const hits: ScanHit[] = [];
      for (const kind of wanted) {
        const pattern = patterns[kind];
        if (!pattern) continue;
        // A fresh RegExp per call: a shared /g pattern carries lastIndex between
        // visitors and silently skips every other match.
        const match = new RegExp(pattern.source, pattern.flags.replace('g', '')).exec(text);
        if (!match) continue;
        const value = tidy(kind, match[0]);
        if (!value) continue;
        hits.push({ kind, value, evidence: evidenceFor(text, match.index, match[0].length) });
      }
      return hits;
    },
  };
}

/**
 * Which field kinds a question names. Kept deliberately small and literal:
 * this decides whether the engine reads the page, so a false positive costs a
 * scan and a wrong answer costs trust.
 */
export const FIELD_SYNONYMS: Record<FieldKind, string[]> = {
  email: ['email', 'e-mail', 'mail', 'mailto', 'address'],
  linkedin: ['linkedin', 'profile', 'social'],
  phone: ['phone', 'telephone', 'number', 'call'],
  url: ['website', 'site', 'url', 'link'],
};

export function requestedFields(query: string): FieldKind[] {
  const words = new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9+@.-]+/)
      .filter(Boolean),
  );
  const wanted: FieldKind[] = [];
  for (const [kind, synonyms] of Object.entries(FIELD_SYNONYMS) as [FieldKind, string[]][]) {
    if (synonyms.some((word) => words.has(word))) wanted.push(kind);
  }
  return wanted;
}
