import { tokenize } from './retriever.js';

/**
 * The shape of a question, decided without a model.
 *
 * A visitor's sentence carries two things a router needs: what kind of answer
 * would satisfy it (a name, a place, a date, a count, a comparison) and which
 * entities it is about. Both are recoverable from the interrogative frame plus
 * the app's own vocabulary, which is why this lives next to the retriever
 * rather than in a host app.
 *
 * It classifies the question, never the request. "Take me to the archive" is a
 * navigation command and stays one: controller verbs are decided by the engine,
 * and a caller must not let `type` override that.
 */
export type QuestionType =
  | 'who'
  | 'what'
  | 'where'
  | 'when'
  | 'how-many'
  | 'which'
  | 'why'
  | 'compare'
  | 'unknown';

export interface QuestionSlots {
  /** The entity the question is about, canonicalised against `subjects`. */
  subject: string | null;
  /** What is being asked about that subject: stack, writing, contact, date… */
  attribute: string | null;
  /** Every declared subject the query names, in order of appearance. */
  entities: string[];
  /** Recency qualifier, when the question names one. */
  newest: 'newest' | 'oldest' | null;
  /** True when the question points back at something instead of naming it. */
  referenced: boolean;
  /**
   * Subjects named inside a negation scope: "python but not readback" excludes
   * Readback. A negated subject is never also an entity, because the visitor is
   * asking about everything else.
   */
  exclude: string[];
  /** Content words no subject or attribute accounted for. */
  mentions: string[];
}

export interface QuestionAnalysis {
  type: QuestionType;
  /** Share of the winning frame's evidence, capped at 1. Ties lower this. */
  confidence: number;
  /** The runner-up when it is close enough that the label is a judgement call. */
  contested: QuestionType | null;
  questionShaped: boolean;
  slots: QuestionSlots;
  /** Which cue patterns fired, for a trace line. */
  cues: string[];
}

export interface AnalyzeOptions {
  /**
   * Values the app can name: project names, technologies, sections, declared
   * constants. Matched through `tokenize()` so "SQLite" and "sqlite" agree.
   */
  subjects?: string[];
  /** Attribute words per app, merged over the defaults. */
  attributes?: Record<string, string[]>;
}

interface Cue {
  type: QuestionType;
  weight: number;
  patterns: RegExp[];
  label: string;
}

/**
 * Ordered by precedence, which is also the tie-break. `compare` sits first
 * because "what's the difference between A and B" is a comparison before it is
 * a `what`, and `how-many` before `when` because "how many posts did he write in
 * 2024" asks for a count, not a date.
 */
const CUES: Cue[] = [
  {
    type: 'compare',
    weight: 3,
    label: 'compare',
    patterns: [
      /^compare\b/,
      /\bcompar(?:e|ed|ing) (?:to|with|against)\b/,
      /\bcompare\b.{1,60}\b(?:and|to|with)\b/,
      /\b(?:the )?difference(?:s)? between\b/,
      /\bhow (?:does|do|did) .{0,48}?(?:compare|differ)\b/,
      /\bwhat(?:'s| is| are) (?:the )?difference\b/,
      /\bvs\.?\b/,
      /\bversus\b/,
      /\bwhich is (?:better|faster|newer|older)\b/,
    ],
  },
  {
    type: 'how-many',
    weight: 3,
    label: 'how-many',
    patterns: [
      /\bhow (?:many|much)\b/,
      /\bnumber of\b/,
      /\bcount (?:the|all|every|of)\b/,
      /^count\b/,
      /\btotal (?:number|count)\b/,
    ],
  },
  {
    type: 'why',
    weight: 3,
    label: 'why',
    patterns: [/\bwhy\b/, /\breason(?:s)? (?:for|why|behind)\b/, /\bwhat(?:'s| is| was) the reason\b/],
  },
  {
    type: 'where',
    weight: 2,
    label: 'where',
    patterns: [/\bwhere\b/, /\bin (?:which|what) (?:part|section|page)\b/],
  },
  {
    type: 'when',
    weight: 2,
    label: 'when',
    patterns: [
      /\bwhen\b/,
      /\bwhat (?:year|date|month|time)\b/,
      /\bhow long (?:ago|since|did)\b/,
      /\bhow (?:recent|old)\b/,
    ],
  },
  {
    type: 'who',
    weight: 2.5,
    label: 'who',
    patterns: [/\bwho\b/, /\bwhose\b/, /\bwhom\b/],
  },
  {
    type: 'which',
    weight: 2,
    label: 'which',
    patterns: [/\bwhich\b/],
  },
  {
    type: 'what',
    weight: 1.5,
    label: 'what',
    patterns: [
      /\bwhat\b/,
      /\btell me (?:about|what|how)\b/,
      /\bdescribe\b/,
      /\bexplain\b/,
      /\bsummar(?:y|ise|ize)\b/,
    ],
  },
];

const DEFAULT_ATTRIBUTES: Record<string, string[]> = {
  stack: ['stack', 'tech', 'technology', 'technologies', 'language', 'languages', 'framework', 'use', 'uses', 'using'],
  writing: ['post', 'posts', 'write', 'writes', 'written', 'wrote', 'blog', 'article', 'articles', 'essay'],
  contact: ['email', 'contact', 'reach', 'message', 'mail', 'linkedin'],
  count: ['count', 'number', 'total', 'many'],
  date: ['date', 'released', 'release', 'published', 'year', 'when'],
  location: ['based', 'live', 'lives', 'location', 'located', 'where'],
  identity: ['name', 'role', 'job', 'who', 'headline'],
  reason: ['reason', 'motivation', 'why'],
  projects: ['project', 'projects', 'work', 'card', 'cards'],
};

/**
 * When a question names both a container and a property ("which projects use
 * python"), the property is the question. Priority breaks count ties.
 */
const ATTRIBUTE_PRIORITY: Record<string, number> = {
  stack: 5,
  count: 4,
  contact: 4,
  writing: 3,
  identity: 3,
  date: 2,
  location: 2,
  reason: 2,
  projects: 1,
};

/** Words that only frame the question; they say nothing about its subject. */
const FRAME_WORDS = new Set([
  'who', 'what', 'where', 'when', 'why', 'which', 'whose', 'whom',
  'how', 'many', 'much', 'tell', 'about', 'describe', 'explain', 'summar',
  'there', 'here', 'any', 'all', 'some', 'one', 'ones', 'thing', 'things',
  'between', 'difference', 'differences', 'compare', 'compared', 'versus', 'vs',
  'newest', 'latest', 'recent', 'oldest', 'earliest', 'first', 'last',
]);

const PRONOUNS = new Set([
  'he', 'him', 'his', 'she', 'her', 'hers', 'it', 'its', 'they', 'them', 'their',
  'that', 'this', 'those', 'these', 'theirs', 'ours', 'yours',
]);

/**
 * Cues that put what follows them out of scope. Longest alternation first so
 * "anything but" is not read as a bare clause break.
 */
const NEGATION_CUE = /\b(?:anything but|other than|apart from|excluding|excludes?|except|besides|without|not)\b/g;

/** Words that turn "not" into an idiom ("not sure", "not to like") rather than an exclusion. */
const NEGATION_IDIOMS = new Set([
  'sure', 'bad', 'only', 'just', 'much', 'really', 'necessarily', 'quite', 'even', 'to', 'so', 'yet', 'at', 'all',
]);

/**
 * Where an exclusion stops. A sentence end or "but" always closes it; a comma
 * closes it only when what follows starts a new question or a command, so
 * "not readback, take me to the blog" excludes one thing and still navigates.
 */
const NEGATION_BREAK =
  /[.;?!]|\bbut\b|,\s*(?:who|what|where|when|why|which|how|take|open|show|go|give|tell|and then)\b/;

/** The text inside each negation scope, in order of appearance. */
function negationScopes(text: string): string[] {
  const scopes: string[] = [];
  NEGATION_CUE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NEGATION_CUE.exec(text)) !== null) {
    const rest = text.slice(match.index + match[0].length);
    const nextWord = (rest.trimStart().match(/^[a-z']+/) ?? [''])[0];
    if (NEGATION_IDIOMS.has(nextWord)) continue;
    // "why not python" is a suggestion, not an exclusion.
    if (/\bwhy\s*$/.test(text.slice(0, match.index))) continue;
    const stop = rest.search(NEGATION_BREAK);
    scopes.push(stop < 0 ? rest : rest.slice(0, stop));
  }
  return scopes;
}

function allDigits(token: string): boolean {
  return /^[0-9]+$/.test(token);
}

/** Subject tokens with digits dropped, so "Python 3.10+" matches "python". */
function subjectTokens(value: string): string[] {
  return tokenize(value).filter((token) => !allDigits(token));
}

function matchIndex(needle: string[], haystack: string[]): number {
  if (needle.length === 0) return -1;
  for (let start = 0; start < haystack.length; start += 1) {
    if (haystack[start] !== needle[0]) continue;
    let at = 0;
    for (let i = start; i < haystack.length && at < needle.length; i += 1) {
      if (haystack[i] === needle[at]) at += 1;
    }
    if (at === needle.length) return start;
  }
  return -1;
}

function attributeIndex(extra: Record<string, string[]> | undefined): Map<string, string> {
  const merged: Record<string, string[]> = { ...DEFAULT_ATTRIBUTES };
  for (const [name, words] of Object.entries(extra ?? {})) {
    merged[name] = [...(merged[name] ?? []), ...words];
  }
  const index = new Map<string, string>();
  for (const [name, words] of Object.entries(merged)) {
    for (const word of words) {
      for (const token of tokenize(word)) {
        if (!index.has(token)) index.set(token, name);
      }
    }
  }
  return index;
}

/**
 * Classifies a question and fills the slots a router can act on.
 *
 * Deterministic: same string, same analysis, no state between calls.
 */
export function analyzeQuestion(query: string, options: AnalyzeOptions = {}): QuestionAnalysis {
  const text = query.toLowerCase();
  const queryTokens = tokenize(query);
  const cues: string[] = [];
  const scores = new Map<QuestionType, number>();

  for (const cue of CUES) {
    let score = 0;
    for (const pattern of cue.patterns) {
      if (pattern.test(text)) {
        score += cue.weight;
        cues.push(cue.label);
      }
    }
    if (score > 0) scores.set(cue.type, score);
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const type: QuestionType = ranked.length > 0 ? ranked[0][0] : 'unknown';
  const topScore = ranked.length > 0 ? ranked[0][1] : 0;
  const second = ranked.length > 1 ? ranked[1] : null;
  const contested = second && topScore - second[1] < 1 ? second[0] : null;

  // Entity slots: longest declared subject wins a shared span, then the rest in
  // the order the visitor named them, so `subject` is what they asked about first.
  const subjects = [...(options.subjects ?? [])].sort(
    (a, b) => subjectTokens(b).length - subjectTokens(a).length,
  );
  const matched: { subject: string; at: number }[] = [];
  for (const subject of subjects) {
    const tokens = subjectTokens(subject);
    const at = matchIndex(tokens, queryTokens);
    if (at < 0) continue;
    if (matched.some((entry) => entry.subject === subject)) continue;
    matched.push({ subject, at });
  }
  matched.sort((a, b) => a.at - b.at);
  // A subject inside a negation scope is what the visitor ruled out, not what
  // they asked about: "which projects use python but not readback" has one
  // entity and one exclusion.
  const scopes = negationScopes(text);
  const exclude = matched
    .filter((entry) => {
      const tokens = subjectTokens(entry.subject);
      return scopes.some((scope) => matchIndex(tokens, tokenize(scope)) >= 0);
    })
    .map((entry) => entry.subject);
  const entities = matched.map((entry) => entry.subject).filter((subject) => !exclude.includes(subject));
  // Mentions stay keyed on everything the visitor named, including the ones they
  // excluded: "not Django" is still a word the answer should acknowledge.
  const entityTokens = new Set(matched.flatMap((entry) => subjectTokens(entry.subject)));

  const attributes = attributeIndex(options.attributes);
  const attributeHits = new Map<string, number>();
  for (const token of queryTokens) {
    const attribute = attributes.get(token);
    if (!attribute) continue;
    attributeHits.set(attribute, (attributeHits.get(attribute) ?? 0) + 1);
  }
  const attribute =
    [...attributeHits.entries()].sort(
      (a, b) =>
        b[1] - a[1] || (ATTRIBUTE_PRIORITY[b[0]] ?? 0) - (ATTRIBUTE_PRIORITY[a[0]] ?? 0),
    )[0]?.[0] ?? null;

  const referenced =
    /\b(?:he|him|his|she|her|it|its|they|them|their|that|those)\b/.test(text) &&
    entities.length === 0;

  const newest = /\b(?:newest|latest|most recent)\b/.test(text)
    ? 'newest'
    : /\b(?:oldest|earliest|first ever)\b/.test(text)
      ? 'oldest'
      : null;

  const mentions = [
    ...new Set(
      queryTokens.filter(
        (token) =>
          !entityTokens.has(token) &&
          !attributes.has(token) &&
          !FRAME_WORDS.has(token) &&
          !PRONOUNS.has(token),
      ),
    ),
  ];

  const subject = entities[0] ?? null;
  const confidence = topScore === 0 ? 0 : Math.min(1, topScore / 3);

  return {
    type,
    confidence,
    contested,
    questionShaped: type !== 'unknown' || /\?\s*$/.test(query),
    slots: { subject, attribute, entities, newest, referenced, exclude, mentions },
    cues: [...new Set(cues)],
  };
}
