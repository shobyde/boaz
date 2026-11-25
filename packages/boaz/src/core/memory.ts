import { analyzeQuestion } from './question.js';
import type { ReferenceContext } from './question.js';
import { tokenize } from './retriever.js';

/**
 * Working memory with salience (0.7.10).
 *
 * The rules engine keeps one turn of memory: the rule that answered, the terms
 * that matched, and the entities that answer bound. That is enough to resolve
 * "and?" or "its stack" one turn later. It is not enough for a conversation,
 * because a visitor who changes subject twice and comes back expects "that
 * project" to still mean the project, and expects "what did we cover" to name
 * what actually happened rather than reciting the last answer.
 *
 * Two decisions make this measurable instead of magic:
 *
 *  - Salience is a number, not a ranking rule. Every mention adds weight, and
 *    weight halves every `halfLife` turns. Repeating an entity is the only way
 *    to keep it: this is why a one-off mention of an unrelated project decays
 *    out while a project discussed three times stays. No model, no embeddings,
 *    and the visitor can see the arithmetic in `salient()`.
 *  - Recall is scoped by turn, never global. `context()` hands the question
 *    analyzer the most salient subject and the items the last answer listed,
 *    so a pointer resolves against what was talked about, in the order it was
 *    talked about.
 *
 * The ceiling this buys: salience is frequency plus recency, so a single
 * mention of the thing the visitor actually cares about loses to a project
 * named incidentally three times. "What we covered" is a list of subjects, not
 * a summary of claims; the summariser (0.7.4) is a different rung for a
 * different question.
 */

export interface MemoryTurn {
  /** 1-based, so a trace line reads the way a person counts. */
  turn: number;
  /** What the visitor said. */
  text: string;
  /** What the host routed, after any continuation rewrite. Defaults to `text`. */
  query?: string | null;
  capabilityId: string | null;
  /** Arguments the capability ran with, when the host reports them. */
  args?: Record<string, unknown> | null;
  /** Subject the turn was about, canonicalised against `subjects`. */
  subject: string | null;
  /** Every declared subject the turn named, in order of appearance. */
  entities: string[];
  /** Content words no subject accounted for, for "what was that about". */
  topics: string[];
  /** What the answer listed, in order, so an ordinal can point at it. */
  items: string[];
}

export interface SalientEntity {
  name: string;
  /** Decayed weight, 0..n. Repeats accumulate; age divides. */
  salience: number;
  mentions: number;
  firstTurn: number;
  lastTurn: number;
}

export interface SalientTopic {
  term: string;
  salience: number;
  lastTurn: number;
}

export interface Coverage {
  entities: string[];
  topics: string[];
  /** One sentence a host can print, composed from the surviving turns. */
  sentence: string;
  /** True when everything in the session has decayed out of the working set. */
  faded: boolean;
  /** True when the session holds nothing above the salience floor. */
  empty: boolean;
}

export interface WorkingMemoryOptions {
  /** Values the app can name, handed to `analyzeQuestion`. */
  subjects?: string[];
  /** Attribute words per app, handed to `analyzeQuestion`. */
  attributes?: Record<string, string[]>;
  /** Turns after which a mention's weight halves. Default 2.5. */
  halfLife?: number;
  /** Weight below which a mention is gone. Default 0.2. */
  minSalience?: number;
  /** Turns kept verbatim. Default 12. */
  limit?: number;
}

export interface ObserveOptions {
  capabilityId?: string | null;
  /** The effective question after a host rewrite. Defaults to the visitor's text. */
  query?: string;
  /** Arguments the capability ran with, so a later turn can replay the shape. */
  args?: Record<string, unknown>;
  /** Entities the host knows about that the analyzer cannot see (a tool result). */
  entities?: string[];
  /** What the answer listed, in order. */
  items?: string[];
}

/**
 * A host-side tool call that can be replayed with a new subject. The query is
 * the previous effective question with the old subject replaced; a host can
 * hand it to its own tool resolver and let matching regenerate the arguments.
 */
export interface ToolFollowUp {
  /** The capability that answered the previous turn. */
  capabilityId: string;
  /** The previous effective question with its subject replaced. */
  query: string;
  /** The subject the previous turn was about. */
  previousSubject: string;
  /** The subject the visitor just named. */
  subject: string;
  /** The previous effective question, before replacement. */
  previousQuery: string;
  /** Arguments the previous call used, for a host that maps args directly. */
  previousArgs: Record<string, unknown> | null;
  /** The 1-based turn that produced the tool call. */
  turn: number;
}

export interface ToolFollowUpOptions {
  /** Values the app can name. Defaults to the memory's `subjects`. */
  subjects?: string[];
  /** Attribute words per app, handed to `analyzeQuestion`. */
  attributes?: Record<string, string[]>;
  /** How many recent turns to search for the tool. Default 1 (immediately prior). */
  within?: number;
}

export interface WorkingMemory {
  readonly turns: MemoryTurn[];
  /** The declared subjects this memory was built with. */
  readonly subjects: string[];
  observe(text: string, options?: ObserveOptions): MemoryTurn;
  /** The most recent turn that ran a capability, within `within` turns. */
  lastTool(options?: { within?: number }): MemoryTurn | null;
  /**
   * Rewrite a follow-up such as "what about Hobnob?" into the previous
   * question with the subject replaced. Returns null when there is no recent
   * tool turn, no new subject, or the old subject is not in the question.
   */
  followUpTool(query: string, options?: ToolFollowUpOptions): ToolFollowUp | null;
  salient(): SalientEntity[];
  salientTopics(): SalientTopic[];
  context(): ReferenceContext;
  covered(options?: { limit?: number; floor?: number }): Coverage;
  reset(): void;
}

const COVERAGE_PATTERNS: RegExp[] = [
  /\bwhat (?:did|have) we (?:cover|covered|discuss|discussed|talk(?:ed)? about|go over|gone over)\b/,
  /\bwhat have we (?:covered|discussed|been through)\b/,
  /\bwhere were we\b/,
  /\bwhat were we (?:talking|discussing) about\b/,
  /\bremind me what we\b/,
  /\brecap (?:of )?(?:this|our) (?:chat|conversation|session)\b/,
  /\bsummari[sz]e (?:our|this) (?:conversation|chat|session)\b/,
];

/**
 * True when the visitor is asking about the conversation instead of the site.
 * A closed list on purpose: this is the same trade rung 5's synonym table
 * makes, and the failure mode is the same, which is that a phrasing outside
 * the list is not recognised and routes to a capability instead.
 */
export function isCoverageQuery(query: string): boolean {
  const text = String(query ?? '').toLowerCase();
  return COVERAGE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Words about the asking, not about the subject. `tokenize()` already drops the
 * library's stopwords; these are the discourse words a recap should not repeat
 * back ("tell", "about", "anything").
 */
const DISCOURSE = new Set([
  'tell', 'about', 'cover', 'covered', 'discuss', 'discussed', 'say', 'said', 'anything',
  'something', 'else', 'again', 'more', 'now', 'then', 'also', 'just', 'really', 'thing',
  'things', 'know', 'show', 'give', 'list', 'use', 'used', 'using',
]);

/** Attributes ("stack", "writing") are not topics; they say what is asked. */
function topicWords(query: string, attribute: string | null, entities: string[]): string[] {
  const entityTokens = new Set(entities.flatMap((entity) => tokenize(entity)));
  const attributeTokens = new Set(attribute ? tokenize(attribute) : []);
  const words: string[] = [];
  for (const token of tokenize(query)) {
    if (token.length < 3) continue;
    if (DISCOURSE.has(token)) continue;
    if (entityTokens.has(token)) continue;
    if (attributeTokens.has(token)) continue;
    if (words.includes(token)) continue;
    words.push(token);
  }
  return words;
}

function listed(values: string[], limit = 4): string {
  const unique = [...new Set(values.filter(Boolean))];
  if (unique.length === 0) return '';
  if (unique.length === 1) return unique[0];
  if (unique.length <= limit) return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
  return `${unique.slice(0, limit).join(', ')}, and ${unique.length - limit} more`;
}

export function createWorkingMemory(options: WorkingMemoryOptions = {}): WorkingMemory {
  const halfLife = options.halfLife ?? 2.5;
  const minSalience = options.minSalience ?? 0.2;
  const limit = options.limit ?? 12;
  const subjects = options.subjects ?? [];
  const attributes = options.attributes ?? {};

  let turns: MemoryTurn[] = [];
  /**
   * Mentions are logged apart from the turns they came from, because a cap on
   * verbatim turns must not erase what the session talked about: a recap after
   * twenty turns would otherwise know only the last twelve.
   */
  let mentions: { name: string; turn: number }[] = [];
  let topicMentions: { term: string; turn: number }[] = [];

  const now = () => (turns.length ? turns[turns.length - 1].turn : 0);

  /** Weight of a mention `age` turns old. Exactly one at age 0. */
  const decay = (age: number) => Math.pow(0.5, age / halfLife);

  /** Every surviving entity with its decayed weight, newest turn last. */
  function scored(floor = minSalience): SalientEntity[] {
    const seen = new Map<string, SalientEntity>();
    for (const mention of mentions) {
      const age = now() - mention.turn;
      {
        const name = mention.name;
        const current = seen.get(name);
        const weight = decay(age);
        if (current) {
          current.salience += weight;
          current.mentions += 1;
          current.lastTurn = mention.turn;
        } else {
          seen.set(name, { name, salience: weight, mentions: 1, firstTurn: mention.turn, lastTurn: mention.turn });
        }
      }
    }
    return [...seen.values()]
      .filter((entity) => entity.salience >= floor)
      .sort((a, b) => b.salience - a.salience || b.lastTurn - a.lastTurn || a.name.localeCompare(b.name));
  }

  function scoredTopics(floor = minSalience): SalientTopic[] {
    const seen = new Map<string, SalientTopic>();
    for (const mention of topicMentions) {
      const age = now() - mention.turn;
      {
        const term = mention.term;
        const weight = decay(age);
        const current = seen.get(term);
        if (current) {
          current.salience += weight;
          current.lastTurn = mention.turn;
        } else {
          seen.set(term, { term, salience: weight, lastTurn: mention.turn });
        }
      }
    }
    return [...seen.values()]
      .filter((topic) => topic.salience >= floor)
      .sort((a, b) => b.salience - a.salience || b.lastTurn - a.lastTurn || a.term.localeCompare(b.term));
  }

  function observe(text: string, observeOptions: ObserveOptions = {}): MemoryTurn {
    const last = turns[turns.length - 1];
    const small = turns.length === 0 ? undefined : { subject: scored()[0]?.name ?? null, items: last.items };
    const analysis = analyzeQuestion(text, { subjects, attributes, context: small });
    const named = analysis.slots.entities;
    const extra = (observeOptions.entities ?? []).filter((entity) => !named.includes(entity));
    const entities = [...named, ...extra];
    const turn = (last?.turn ?? 0) + 1;
    const record: MemoryTurn = {
      turn,
      text,
      query: observeOptions.query ?? text,
      capabilityId: observeOptions.capabilityId ?? null,
      args: observeOptions.args ?? null,
      subject: analysis.slots.subject ?? entities[0] ?? null,
      entities,
      topics: topicWords(text, analysis.slots.attribute, entities),
      items: observeOptions.items ?? analysis.slots.entities,
    };
    mentions = [...mentions, ...entities.map((name) => ({ name, turn }))].slice(-limit * 4);
    topicMentions = [...topicMentions, ...record.topics.map((term) => ({ term, turn }))].slice(-limit * 8);
    turns = [...turns, record].slice(-limit);
    return record;
  }

  function context(): ReferenceContext {
    const salient = scored();
    return {
      subject: salient[0]?.name ?? null,
      items: turns.length ? turns[turns.length - 1].items : [],
    };
  }

  function covered(coveredOptions: { limit?: number; floor?: number } = {}): Coverage {
    // A recap reports the session, so it keeps what the working set has already
    // let go: a subject named once at turn 1 is gone from `salient()` by turn 7
    // and must still appear here, or the answer quietly rewrites history.
    const floor = coveredOptions.floor ?? minSalience / 4;
    const ranked = scored(floor);
    const entities = ranked.map((entity) => entity.name);
    const topics = scoredTopics(floor).map((topic) => topic.term);
    // The sentence reads in the order things came up; `entities` stays ranked.
    const names = [...ranked].sort((a, b) => a.firstTurn - b.firstTurn).slice(0, coveredOptions.limit ?? 4).map((entity) => entity.name);
    const count = entities.length;
    const sentence = count === 0
      ? 'Nothing yet. This is the first thing you have asked in this session.'
      : `So far we covered ${listed(names)}${count > names.length ? `, and ${count - names.length} more` : ''}.`;
    const faded = scored().length === 0 && (count > 0 || topics.length > 0);
    return { entities, topics, sentence, empty: count === 0 && topics.length === 0, faded };
  }

  function lastTool(lastToolOptions: { within?: number } = {}): MemoryTurn | null {
    const within = Math.max(1, lastToolOptions.within ?? 1);
    return turns.slice(-within).reverse().find((turn) => Boolean(turn.capabilityId)) ?? null;
  }

  return {
    get turns() {
      return turns;
    },
    get subjects() {
      return subjects;
    },
    observe,
    lastTool,
    followUpTool(query, options = {}) {
      return resolveToolFollowUp(
        { turns, subjects, context },
        query,
        options,
      );
    },
    salient: scored,
    salientTopics: scoredTopics,
    context,
    covered,
    reset() {
      turns = [];
      mentions = [];
      topicMentions = [];
    },
  };
}

const TOOL_FOLLOW_UP = /^(and|also|what about|how about|then|now|more)\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function subjectKey(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * "What about Hobnob?" after "how many commits does Boaz have?" is the same
 * operation with a new subject. This primitive keeps that relation in working
 * memory: the previous effective question, the capability that ran, and the
 * subject it was about. It rewrites the question rather than guessing at the
 * capability's arguments, so the app's normal matcher and schema still decide
 * what a valid call looks like.
 */
export function resolveToolFollowUp(
  memory: Pick<WorkingMemory, 'turns' | 'subjects' | 'context'>,
  query: string,
  options: ToolFollowUpOptions = {},
): ToolFollowUp | null {
  const text = String(query ?? '').trim();
  if (!TOOL_FOLLOW_UP.test(text)) return null;
  const within = Math.max(1, options.within ?? 1);
  const previous = memory.turns
    .slice(-within)
    .reverse()
    .find((turn) => turn.capabilityId && turn.subject);
  if (!previous?.capabilityId || !previous.subject) return null;

  const analysis = analyzeQuestion(text, {
    subjects: options.subjects ?? memory.subjects,
    ...(options.attributes ? { attributes: options.attributes } : {}),
    context: memory.context(),
  });
  const candidates = [
    ...(analysis.slots.entities ?? []),
    analysis.slots.reference?.value,
  ].filter((value): value is string => Boolean(value));
  const newSubjects = [...new Set(candidates)].filter(
    (value) => subjectKey(value) !== subjectKey(previous.subject),
  );
  if (newSubjects.length !== 1) return null;
  const subject = newSubjects[0];

  const previousQuery = previous.query ?? previous.text;
  if (!previousQuery) return null;
  const boundary = new RegExp(
    `(^|[^A-Za-z0-9])(${escapeRegExp(previous.subject)})(?=$|[^A-Za-z0-9])`,
    'i',
  );
  if (!boundary.test(previousQuery)) return null;
  const rewritten = previousQuery.replace(boundary, (_match, prefix: string) => `${prefix}${subject}`);

  return {
    capabilityId: previous.capabilityId,
    query: rewritten,
    previousSubject: previous.subject,
    subject,
    previousQuery,
    previousArgs: previous.args ?? null,
    turn: previous.turn,
  };
}
