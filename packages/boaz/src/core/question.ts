import { tokenize } from './retriever.js';
import { canonicalTerm, DOMAIN_SYNONYMS, LEMMAS } from './lemmas.js';

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
  /** How two or more named things are joined, or null when there is nothing to join. */
  combine: Combine | null;
  /** Recency qualifier, when the question names one. */
  newest: 'newest' | 'oldest' | null;
  /** True when the question points back at something instead of naming it. */
  referenced: boolean;
  /** The subject a pointer resolves to, or null when it points nowhere. */
  reference: Reference | null;
  /**
   * Subjects named inside a negation scope: "python but not readback" excludes
   * Readback. A negated subject is never also an entity, because the visitor is
   * asking about everything else.
   */
  exclude: string[];
  /** Content words no subject or attribute accounted for. */
  mentions: string[];
}

/** How a visitor pointed back at something instead of naming it. */
export interface Reference {
  kind: 'ordinal' | 'pronoun' | 'partial';
  /** The declared subject the pointer resolves to. */
  value: string;
  /** The words that pointed, kept for a trace line. */
  cue: string;
}

/**
 * How a question combines the things it names. "which projects use python and
 * sqlite" wants the projects with both; "python or rust" wants either. The
 * distinction lives in the words between the two names, which is why it is
 * extracted here and not left to the app's keyword list.
 */
export interface Combine {
  /** `all` = every named value must hold, `any` = one is enough. */
  op: 'all' | 'any';
  /** The two names the connective joins, in the order they were said. */
  between: [string, string];
  /** The word that decided it, for a trace line. */
  cue: string;
}

/** What the previous turn left behind, for a pointer to resolve against. */
export interface ReferenceContext {
  /** Subjects in the order the previous answer listed them, for ordinals. */
  items?: string[];
  /** The subject the previous turn was about, for pronouns. */
  subject?: string | null;
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
  /** The previous turn's subject and listing, so a pointer can resolve. */
  context?: ReferenceContext;
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
  // A bundled synonym only ever points at an attribute the app already
  // declares, so "toolset" reads as stack only where stack is one of the
  // attributes in play. It is also what keeps the word out of `mentions`, which
  // would otherwise report "toolset" as something no fact accounted for.
  for (const [from, to] of [...Object.entries(DOMAIN_SYNONYMS), ...Object.entries(LEMMAS)]) {
    if (index.has(from)) continue;
    // `to` is either an attribute name ("stack") or a word inside one.
    const name = merged[to] ? to : (index.get(to) ?? index.get(canonicalTerm(to)));
    if (name) index.set(from, name);
  }
  return index;
}

/**
 * Ordinal words that point at a position in the previous answer's list. The
 * spelled-out number is the common form; digits show up as "number 2".
 */
const ORDINALS: Record<string, number> = {
  first: 0,
  '1st': 0,
  one: 0,
  second: 1,
  '2nd': 1,
  two: 1,
  third: 2,
  '3rd': 2,
  three: 2,
  fourth: 3,
  '4th': 3,
  four: 3,
  fifth: 4,
  '5th': 4,
  five: 4,
};

/** A bare ordinal word counts only when it names a list item. */
const ORDINAL_NOUN = '(?:one|project|item|entry|card|result|option|thing)';

/**
 * Singular pointers that can stand for a project. Personal pronouns (he, his,
 * they) are excluded on purpose: on this site they refer to the person, and
 * resolving "his stack" to the last project mentioned was the first wrong
 * answer this slot produced.
 */
const OBJECT_PRONOUNS = new Set(['it', 'its', "it's", 'that', 'this', 'those', 'these']);

/** A query that opens with one of these is a command, so a partial name is not a pointer. */
const CONTROLLER_OPEN =
  /^(?:show|open|go|take|read|expand|copy|download|print|visit|browse|scroll|jump|navigate|see|filter|sort)\b/;

/**
 * Words that join two names conjunctively ("python and sqlite" wants both) and
 * disjunctively ("python or rust" wants either). Read only in the gap between
 * the two names, nearest first: a connective elsewhere in the sentence joins
 * something else, and "neither A nor B" is an exclusion, so `nor` is absent on
 * purpose rather than quietly read as `or`.
 */
const ALL_CUES = new Set(['and', 'plus', 'both', 'with', 'also', 'along', 'well', 'as']);
const ANY_CUES = new Set(['or', 'either', 'versus', 'vs']);

/**
 * Where a subject name starts inside a token list, trying the camel-split form
 * and the joined spelling the visitor actually types ("TypeScript" vs
 * "typescript"). Every caller that matches a name against text goes through
 * this, so the slot, the span and the exclusion scope cannot disagree.
 */
function subjectAt(subject: string, haystack: string[]): number {
  // Both sides go through the bundled lemma table before comparison, so "js"
  // reaches JavaScript and "postgres" reaches PostgreSQL without either name
  // having to be spelled out in the app's manifest.
  const tokens = subjectTokens(subject).map(canonicalTerm);
  const words = haystack.map(canonicalTerm);
  const at = matchIndex(tokens, words);
  if (at >= 0) return at;
  const joined = tokenize(subject.toLowerCase().replace(/[^a-z0-9]+/g, '')).map(canonicalTerm);
  if (joined.length === 0 || joined.join(' ') === tokens.join(' ')) return -1;
  return matchIndex(joined, words);
}

/** Word index range of a subject name inside the query's plain words. */
function subjectSpan(subject: string, words: string[]): { start: number; end: number } | null {
  const forms = [subjectTokens(subject), tokenize(subject.toLowerCase().replace(/[^a-z0-9]+/g, ''))]
    .filter((form) => form.length > 0)
    .filter((form, i, all) => all.findIndex((other) => other.join(' ') === form.join(' ')) === i);
  for (const needle of forms) {
    for (let start = 0; start < words.length; start += 1) {
      let at = 0;
      let i = start;
      for (; i < words.length && at < needle.length; i += 1) {
        if (allDigits(words[i])) continue;
        if (words[i] !== needle[at]) break;
        at += 1;
      }
      if (at === needle.length) return { start, end: i - 1 };
    }
  }
  return null;
}

/**
 * Decides whether two named things are joined by "and" or "or", from the words
 * between them. Two names with no connective get null: "python sqlite" is a
 * half-written list, and answering it as either a union or an intersection
 * would be a guess.
 */
function resolveCombine(text: string, entities: string[]): Combine | null {
  if (entities.length < 2) return null;
  const words = plainWords(text);
  const spans = entities
    .map((subject) => ({ subject, span: subjectSpan(subject, words) }))
    .filter((entry): entry is { subject: string; span: { start: number; end: number } } => entry.span !== null)
    .sort((a, b) => a.span.start - b.span.start);
  if (spans.length < 2) return null;
  const [first, second] = [spans[0], spans[1]];
  if (second.span.start <= first.span.end) return null;
  const gap = words.slice(first.span.end + 1, second.span.start);
  for (let i = gap.length - 1; i >= 0; i -= 1) {
    const word = gap[i];
    if (ANY_CUES.has(word)) return { op: 'any', between: [first.subject, second.subject], cue: word };
    if (ALL_CUES.has(word)) return { op: 'all', between: [first.subject, second.subject], cue: word };
  }
  return null;
}

/** The plain words of a query, used for prefix matching against subject names. */
function plainWords(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Resolves a pointer to a declared subject, or returns null.
 *
 * Three cues, in the order a reader would try them: an ordinal position in the
 * list the last answer produced, a singular pronoun standing in for the last
 * subject, then a truncated name ("ground" for Groundglass). Each needs the
 * context that makes it meaningful, and returns null without it, which is the
 * honest answer: "the second one" with no list behind it points nowhere.
 */
function resolveReference(
  text: string,
  query: string,
  subjects: string[],
  named: string[],
  attributes: Map<string, string>,
  context: ReferenceContext | undefined,
): Reference | null {
  // A question that names what it is about still points elsewhere with a
  // pronoun: "does it use sqlite" names SQLite and points at the project.
  const items = context?.items ?? [];
  const previous = context?.subject ?? null;

  const ordinalNoun = new RegExp(`\\b(?:the\\s+)?(${Object.keys(ORDINALS).join('|')})\\s+${ORDINAL_NOUN}\\b`);
  const ordinalNumber = new RegExp(`\\bnumber\\s+(${Object.keys(ORDINALS).join('|')})\\b`);
  const lastNoun = new RegExp(`\\b(?:the\\s+)?last\\s+${ORDINAL_NOUN}\\b`);
  const ordinalMatch = text.match(ordinalNoun) ?? text.match(ordinalNumber);
  if (ordinalMatch) {
    // "the second one" only means something after a list.
    if (items.length === 0) return null;
    const index = ORDINALS[ordinalMatch[1]];
    if (index === undefined || index >= items.length) return null;
    return { kind: 'ordinal', value: items[index], cue: ordinalMatch[0].trim() };
  }
  const lastMatch = text.match(lastNoun);
  if (lastMatch) {
    if (items.length === 0) return null;
    return { kind: 'ordinal', value: items[items.length - 1], cue: lastMatch[0].trim() };
  }

  const words = plainWords(text);
  const pronounAt = words.findIndex((word) => OBJECT_PRONOUNS.has(word));
  // "the one that uses sqlite" is a description, not a pointer: the demonstrative
  // is a relative pronoun introducing a filter, so no antecedent answers it.
  const RELATIVE_VERBS = new Set([
    'is', 'are', 'was', 'were', 'has', 'have', 'had', 'does', 'do', 'did',
    'use', 'uses', 'used', 'link', 'links', 'links', 'costs', 'cost', 'supports',
    'runs', 'run', 'ships', 'ship', 'works', 'work', 'needs', 'need',
  ]);
  const relative =
    pronounAt >= 0 &&
    ['that', 'this', 'those', 'these'].includes(words[pronounAt]) &&
    RELATIVE_VERBS.has(words[pronounAt + 1] ?? '');
  const pronoun = pronounAt >= 0 && !relative ? words[pronounAt] : null;
  if (pronoun && previous) {
    return { kind: 'pronoun', value: previous, cue: pronoun };
  }

  // A partial name is the last resort, and only for a question that named no
  // subject: "read the newest post" opens with a command and must reach the
  // read action, not the Readback project that shares its first four letters.
  if (named.length > 0 || CONTROLLER_OPEN.test(text.trim())) return null;
  const frame = new Set([...FRAME_WORDS, ...PRONOUNS]);
  for (const subject of subjects) {
    for (const token of subjectTokens(subject)) {
      if (token.length < 4 || allDigits(token)) continue;
      const hit = words.find(
        (word) =>
          word.length >= 4 &&
          word !== token &&
          token.startsWith(word) &&
          !frame.has(word) &&
          !attributes.has(word),
      );
      if (hit) return { kind: 'partial', value: subject, cue: hit };
    }
  }

  return null;
}

/**
 * Classifies a question and fills the slots a router can act on.
 *
 * Deterministic: same string and context, same analysis, no state between calls.
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
    const at = subjectAt(subject, queryTokens);
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
    .filter((entry) => scopes.some((scope) => subjectAt(entry.subject, tokenize(scope)) >= 0))
    .map((entry) => entry.subject);
  const entities = matched.map((entry) => entry.subject).filter((subject) => !exclude.includes(subject));
  // Two things the visitor named are joined by whatever sits between them:
  // "python and sqlite" is an intersection, "python or rust" a union.
  const combine = resolveCombine(text, entities);
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
  // "written in" asks which language, not about the writing: the token form
  // scored as `writing` and outranked nothing, so the phrase is read first.
  // "shipped in", "built on" and "powered by" are the same shape, and they are
  // how visitors describe a finished stack without ever saying "stack".
  const stackPhrase =
    /\b(?:written|built|coded|implemented|made|shipped|powered|runs|running) (?:in|with|on|by)\b/.test(text);
  const winner =
    [...attributeHits.entries()].sort(
      (a, b) =>
        b[1] - a[1] || (ATTRIBUTE_PRIORITY[b[0]] ?? 0) - (ATTRIBUTE_PRIORITY[a[0]] ?? 0),
    )[0]?.[0] ?? null;
  const attribute =
    stackPhrase && (!winner || winner === 'writing' || winner === 'projects') ? 'stack' : winner;

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

  const resolved = resolveReference(text, query, subjects, entities, attributes, options.context);
  const subject = entities[0] ?? resolved?.value ?? null;
  const confidence = topScore === 0 ? 0 : Math.min(1, topScore / 3);

  return {
    type,
    confidence,
    contested,
    questionShaped: type !== 'unknown' || /\?\s*$/.test(query),
    slots: {
      subject,
      attribute,
      entities,
      combine,
      newest,
      referenced: referenced || resolved !== null,
      reference: resolved,
      exclude,
      mentions,
    },
    cues: [...new Set([...cues, ...(resolved ? [`reference:${resolved.kind}`] : [])])],
  };
}

