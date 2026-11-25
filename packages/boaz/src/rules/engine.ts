import type { AgentEngine, EngineCompletion, EngineRequest, ManifestCapability } from '../core/types.js';
import { CapabilityIndex, tokenize } from '../core/retriever.js';
import { analyzeQuestion, type Combine } from '../core/question.js';
import { createLexicalEngine } from '../core/lexical-engine.js';
import {
  createFieldScanner,
  requestedFields,
  type FieldKind,
  type FieldScanner,
  type ScanHit,
} from '../extract/index.js';
import { KnowledgeBase, type Bindings, type FactRow, type Solution } from './knowledge.js';

/**
 * An answer rule is the app's half of the deduction: what to look up, and how a
 * solution becomes a sentence. The library owns retrieval, rule evaluation, grounding
 * and the order of operations.
 */
export interface AnswerRule {
  id: string;
  /** Used for retrieval; write it the way a visitor would ask. */
  title: string;
  keywords?: string[];
  /** Datalog goal, e.g. `projects_using(?P)`. */
  goal: string;
  /**
   * Turns solutions into the reply. Return '' to decline and let the next
   * engine answer instead.
   */
  compose: (context: AnswerContext) => string;
  /**
   * One plain-language line describing what this rule did. It travels on the
   * rule step, so a host never prints a Datalog goal at a visitor.
   */
  explain?: (context: AnswerContext) => string;
  /**
   * A rule that lists everything ("what has he built") has no subject to look
   * for, so set this to false. Default true: a rule with tools waits until the
   * question names something worth looking up.
   */
  requiresSubject?: boolean;
  /**
   * Tools to run before composing, in order. The engine emits one call per turn
   * and picks up the result on the next pass, so a rule can reason over live app
   * data instead of a copy of it.
   */
  steps?: ToolStep[];
  /** Minimum retrieval score before this rule is tried. Default 1.0. */
  threshold?: number;
  /**
   * An explicit trigger for phrasings keyword matching cannot see. "What does he
   * do?" tokenizes to nothing but stopwords, so it can only be recognised by the
   * shape of the question. A matching rule is used ahead of retrieval.
   */
  match?: (query: string) => boolean;
}

export interface ToolStep {
  /** A read-only capability the engine should run before composing. */
  capabilityId: string;
  args?: Record<string, unknown>;
  /** Turns that capability's result into facts the goal can join on. */
  toFacts: (result: unknown) => FactRow[];
}

export interface AnswerContext {
  query: string;
  bindings: Bindings;
  solutions: Solution[];
  knowledge: KnowledgeBase;
  /** Constants the question mentioned, as declared in the facts. */
  terms: string[];
  /**
   * Words the question used that no fact or rule metadata accounted for. This
   * is how a rule answers "the data does not have that" instead of going quiet.
   */
  mentions: string[];
  /**
   * Declared constants the question ruled out ("not python", "anything but
   * hobnob"). The engine never asserts `asked()` for one, and a rule can use the
   * list to filter a tool result it already holds.
   */
  exclude: string[];
  /**
   * How the question joined the values it named: `all` for "python and sqlite",
   * `any` for "python or rust", null for one value or no connective. A rule
   * that answers over a set uses this instead of guessing from the query text.
   */
  combine: Combine | null;
  hits: ScanHit[];
  /** The app's capabilities, by id and title, so a rule can describe itself. */
  capabilities: Array<{ id: string; title?: string }>;
  /** Tool results this rule read, keyed by capability id. */
  observed: Record<string, unknown>;
  /** Runs another goal against the same knowledge and assumptions. */
  lookup: (goal: string) => Solution[];
}

/** What the engine carries between turns, so ellipsis and "and?" still work. */
export interface EngineMemory {
  ruleId: string | null;
  /**
   * Set when a rule planned a tool call this turn. It is how a harness can tell
   * "the rule asked for projects.list" from "the keyword engine happened to pick
   * projects.list" — the call text is identical, the intent is not.
   */
  planned: { ruleId: string; capabilityId: string } | null;
  terms: string[];
  fields: FieldKind[];
  hits: ScanHit[];
  entities: string[];
  recentQueries: string[];
  /** Constants the last answered question excluded. */
  excludes: string[];
  turns: number;
}

export interface RulesEngineOptions {
  knowledge: KnowledgeBase;
  answers: AnswerRule[];
  /** Capabilities for the fallback engine, so route/action/query questions still work. */
  capabilities?: ManifestCapability[];
  /** Retrieval score before an answer rule is tried. Default: scaled to the rule count. */
  threshold?: number;
  /**
   * Extra leading verbs that mean "do this", not "answer me" — "filter to
   * overdue" in a billing app. Defaults cover navigation and reading.
   */
  controllerVerbs?: string[];
  /** Replaces keyword matching as the fallback. */
  fallback?: AgentEngine;
  /** Extra facts for every query, e.g. synonyms the app wants to honour. */
  facts?: FactRow[];
  /**
   * Values the app knows about but does not assert yet — typically what a tool
   * will return. Declaring them means "does he have python projects?" recognises
   * the technology before the project list has been read.
   */
  constants?: string[];
  /**
   * The page (or document) to read when a question names a field the facts do
   * not cover. Results arrive as `field(<kind>, <value>)` assumptions.
   */
  grounding?: {
    read: (query: string) => string | Promise<string>;
    scanner?: FieldScanner;
    patterns?: Record<FieldKind, RegExp>;
  };
  /** Conversation carry-over. Default on; `false` makes every turn independent. */
  memory?: false | { turns?: number };
}

export type RulesEngine = AgentEngine & {
  readonly memory: EngineMemory;
  resetMemory(): void;
};

/** Facts the engine injects per turn: what the visitor asked about, and what the page said. */
const ASKED = 'asked';
const FIELD = 'field';

/**
 * A request that names a controller verb ("show me the archive", "open the
 * newest article") is asking the app to do something, not asking the knowledge
 * base a question. Answer rules stay out of the way so the capability decides.
 */
const DEFAULT_CONTROLLER =
  'show|open|go|take|read|expand|copy|download|print|visit|browse|scroll|jump|navigate|see';

function controllerPattern(extra: string[] = []): RegExp {
  const verbs = [
    ...DEFAULT_CONTROLLER.split('|'),
    ...extra.map((verb) => verb.replace(/[^a-z]/gi, '')).filter(Boolean),
  ];
  return new RegExp(`^(${verbs.join('|')})\\b`, 'i');
}

/** "and…", "what about…", "his…" and bare continuations lean on the last turn. */
const FOLLOW_UP = /^(and|also|what about|how about|then|more|why)\b|^(his|her|their|its)\b/i;

/** Words that carry no subject of their own: a query made only of these is an ellipsis. */
const ELLIPSIS_WORDS = new Set([
  'and', 'also', 'what', 'about', 'how', 'then', 'more', 'why', 'his', 'her', 'their', 'its',
  'it', 'that', 'those', 'them', 'one', 'ones', 'please', 'tell', 'me', 'again', 'else', 'any',
]);

function callTool(id: string, args: Record<string, unknown>): string {
  return ['```json', JSON.stringify({ tool: id, arguments: args }), '```'].join('\n');
}

const QUERY_RESULT = /^\[boaz\] Query "([^"]+)" returned ([\s\S]*)$/;
const ACTION_RESULT = /^\[boaz\] "([^"]+)" ran successfully and returned ([\s\S]*)$/;

/** Results of calls made since the visitor's last message, keyed by capability. */
function observationsThisTurn(request: EngineRequest): Map<string, unknown> {
  const users: number[] = [];
  request.messages.forEach((message, index) => {
    if (message.role === 'user' && !message.content.startsWith('[boaz]')) users.push(index);
  });
  const lastUser = users[users.length - 1] ?? -1;
  const found = new Map<string, unknown>();
  for (const message of request.messages.slice(lastUser + 1)) {
    if (message.role !== 'user') continue;
    const match = QUERY_RESULT.exec(message.content) ?? ACTION_RESULT.exec(message.content);
    if (!match) continue;
    const [, id, raw] = match;
    const body = (raw ?? '').replace(/\.\s*$/, '');
    try {
      found.set(id as string, JSON.parse(body));
    } catch {
      found.set(id as string, body);
    }
  }
  return found;
}

function lastUserMessage(request: EngineRequest): string {
  const users = request.messages.filter(
    (message) => message.role === 'user' && !message.content.startsWith('[boaz]'),
  );
  return users[users.length - 1]?.content ?? '';
}

/**
 * A rule that joins on `asked(?T)` exists to answer "which X uses the Y the
 * visitor named". When the question does name a declared constant, that rule is
 * the right one even if a rule about the same nouns scores a little higher.
 */
function joinsAskedConstant(rule: AnswerRule, knowledge: KnowledgeBase): boolean {
  const rel = rule.goal.split('(')[0]?.trim();
  if (!rel) return false;
  return knowledge.rules.some(
    (candidate) => candidate.head.rel === rel && candidate.body.some((atom) => atom.rel === 'asked'),
  );
}

function answerCapability(rule: AnswerRule): ManifestCapability {
  return {
    id: rule.id,
    kind: 'query',
    title: rule.title,
    description: rule.title,
    keywords: rule.keywords,
  };
}

export function createRulesEngine(options: RulesEngineOptions): RulesEngine {
  const { knowledge } = options;
  const answers = options.answers;
  const index = new CapabilityIndex(answers.map(answerCapability));
  const fallback = options.fallback ?? createLexicalEngine({ capabilities: options.capabilities ?? [] });
  const baseFacts = options.facts ?? [];
  for (const constant of options.constants ?? []) knowledge.declare(constant);
  const scanner = options.grounding
    ? (options.grounding.scanner ?? createFieldScanner(options.grounding.patterns ? { patterns: options.grounding.patterns } : {}))
    : undefined;
  const controller = controllerPattern(options.controllerVerbs);
  const memoryEnabled = options.memory !== false;
  const memoryLimit = (typeof options.memory === 'object' && options.memory.turns) || 6;

  const memory: EngineMemory = {
    ruleId: null,
    planned: null,
    terms: [],
    fields: [],
    hits: [],
    entities: [],
    recentQueries: [],
    excludes: [],
    turns: 0,
  };

  const runRule = (
    rule: AnswerRule,
    query: string,
    terms: string[],
    hits: ScanHit[],
    assume: FactRow[],
    observed: Record<string, unknown> = {},
    kb: KnowledgeBase = knowledge,
    mentions: string[] = [],
    excludes: string[] = [],
    combine: Combine | null = null,
  ): EngineCompletion | null => {
    const solutions = kb.query(rule.goal, { assume });
    const context: AnswerContext = {
      query,
      bindings: solutions[0]?.bindings ?? {},
      solutions,
      knowledge: kb,
      terms,
      mentions,
      exclude: excludes,
      combine,
      hits,
      observed,
      // What the app can do, so a rule can answer questions about the assistant
      // itself ("what can you do?") from the same manifest the UI advertises.
      capabilities: (options.capabilities ?? []).map((capability) => ({
        id: capability.id,
        ...(capability.title ? { title: capability.title } : {}),
      })),
      lookup: (goal) => kb.query(goal, { assume }),
    };
    const text = rule.compose(context).trim();
    if (!text) return null;

    if (memoryEnabled) {
      memory.ruleId = rule.id;
      memory.planned = null;
      memory.terms = terms;
      memory.fields = hits.map((hit) => hit.kind);
      memory.hits = hits;
      memory.entities = [...new Set(solutions.flatMap((solution) => Object.values(solution.bindings)))];
      memory.excludes = excludes;
      memory.recentQueries = [...memory.recentQueries, query].slice(-memoryLimit);
      memory.turns += 1;
    }

    return {
      text,
      steps: [
        {
          type: 'inference',
          capabilityId: rule.id,
          goal: rule.goal,
          terms,
          solutions: solutions.map((solution) => solution.bindings),
          rule: kb.rules.find((r) => r.head.rel === rule.goal.split('(')[0]?.trim())?.source,
          ...(rule.explain ? { label: rule.explain(context).trim() } : {}),
        },
      ],
    };
  };

  return {
    id: 'rules',
    memory,
    resetMemory() {
      memory.ruleId = null;
      memory.planned = null;
      memory.terms = [];
      memory.fields = [];
      memory.hits = [];
      memory.entities = [];
      memory.recentQueries = [];
      memory.excludes = [];
      memory.turns = 0;
    },

    async complete(request: EngineRequest): Promise<EngineCompletion> {
      const query = lastUserMessage(request).trim();
      if (!query) return fallback.complete(request);

      const followUp = FOLLOW_UP.test(query);

      // Fields the question names: read the host's text for them. Grounding runs
      // whether or not a fact exists, so a rule can prefer facts and fall back to
      // what the page actually says.
      const fields = requestedFields(query);
      const hits: ScanHit[] = [];
      if (scanner && options.grounding && fields.length > 0) {
        try {
          const text = await options.grounding.read(query);
          hits.push(...scanner.scan(text, fields));
        } catch {
          // Reading the page is best effort; a failure is not an answer failure.
        }
      }

      // Pick the rule before resolving terms: a rule with steps does not know
      // its vocabulary until the tool has run, so retrieval must use the words
      // the visitor typed, not the constants the page happens to declare.
      // A short question is still a question: "where is he based?" must not
      // inherit the previous rule just because it has two words.
      const shortEllipsis =
        tokenize(query).every((word) => ELLIPSIS_WORDS.has(word)) && fields.length === 0;
      const hint = memoryEnabled && (followUp || shortEllipsis) && shortEllipsis;
      const retrieval = [
        hint ? memory.ruleId : '',
        hint ? memory.recentQueries.slice(-2).join(' ') : '',
        query,
      ]
        .filter(Boolean)
        .join(' ');

      const controllerRequest = controller.test(query);
      let best;
      const explicit = controllerRequest ? undefined : answers.find((answer) => answer.match?.(query));
      if (explicit) {
        best = { capability: answerCapability(explicit), score: Number.POSITIVE_INFINITY };
      } else if (answers.length > 0 && !controllerRequest) {
        const hits = index.search(retrieval, { limit: 3, boost: false });
        const words = retrieval.split(/[^A-Za-z0-9+#.]+/).filter((word) => word.length > 1);
        const namesConstant = words.some((word) => knowledge.canonicalFor(word).length > 0);
        if (namesConstant) {
          // A question that names a declared value belongs to the rule that
          // consumes values, even when the phrasing shares no keyword with it
          // ("what's built with python?") — so that rule enters the shortlist
          // even when it scored nothing.
          const seen = new Set(hits.map((hit) => hit.capability.id));
          for (const answer of answers) {
            if (seen.has(answer.id) || !joinsAskedConstant(answer, knowledge)) continue;
            hits.push({ capability: answerCapability(answer), score: 2.5 });
          }
          for (const hit of hits) {
            const candidate = answers.find((answer) => answer.id === hit.capability.id);
            if (candidate && joinsAskedConstant(candidate, knowledge)) {
              hit.score = Math.max(hit.score * 1.4, 2.5);
            }
          }
          hits.sort((a, b) => b.score - a.score);
        }
        [best] = hits;
      }
      const rule = best ? answers.find((answer) => answer.id === best.capability.id) : undefined;
      // Absolute BM25 scores shrink with the corpus: with one answer rule the
      // best possible phrase match scores about 1.2, so a flat 1.0 threshold
      // silently drops real matches. Scale the default to how many rules exist.
      const threshold =
        rule?.threshold ?? options.threshold ?? Math.min(1, Math.max(0.35, 0.35 * answers.length));
      const byScore = rule && best && best.score >= threshold ? rule : undefined;

      // A rule with tools needs something to look up. "What is his stack?" is not
      // a question about a technology, so planning projects.list for it wastes a
      // call and a trace line before the keyword engine answers anyway.
      const ruleWordsForMatch = new Set(
        byScore ? tokenize([byScore.title, ...(byScore.keywords ?? [])].join(' ')) : [],
      );
      const wordsNow = [
        ...new Set(query.split(/[^A-Za-z0-9+#.]+/).filter((word) => word.length > 1)),
      ];
      const hasSubject = wordsNow.some((word) => {
        const [stem] = tokenize(word);
        return Boolean(stem) && !ruleWordsForMatch.has(stem);
      });
      // Only a rule that consumes constants needs a subject. A listing rule
      // ("which invoices are overdue") has nothing to look up by name and should
      // run whenever it matches; requiring a subject made it vanish silently.
      const needsSubject =
        byScore?.requiresSubject !== false && byScore ? joinsAskedConstant(byScore, knowledge) : false;
      const matched = byScore && byScore.steps?.length && needsSubject && !hasSubject ? undefined : byScore;

      // Run the rule's read-only tools first, one per turn, and turn their
      // results into facts. This is the loop an LLM gets from tool calling, with
      // the plan declared instead of guessed.
      // Structured results when the runtime supplies them (it does), plus the
      // transcript fallback for hosts that drive the engine by hand. Structured
      // values win: the transcript copy is clipped for prompt budgets.
      const observed = observationsThisTurn(request);
      for (const [id, value] of Object.entries(request.observations ?? {})) observed.set(id, value);
      const factErrors: string[] = [];
      const stepFacts: FactRow[] = [];
      if (matched?.steps?.length) {
        for (const step of matched.steps) {
          if (!observed.has(step.capabilityId)) {
            if (memoryEnabled) memory.planned = { ruleId: matched.id, capabilityId: step.capabilityId };
            return { text: callTool(step.capabilityId, step.args ?? {}) };
          }
        }
        for (const step of matched.steps) {
          try {
            stepFacts.push(...step.toFacts(observed.get(step.capabilityId)));
          } catch (error) {
            // A broken adapter must not crash the turn, but it must not vanish
            // either: silent fact failures once hid an undefined helper for a
            // whole deploy.
            const message = error instanceof Error ? error.message : String(error);
            factErrors.push(`${step.capabilityId} facts failed: ${message}`);
          }
        }
      }

      // Facts for this turn: declared rows, plus whatever the tools just read.
      const turnKnowledge =
        stepFacts.length > 0
          ? new KnowledgeBase({ facts: [...knowledge.facts(), ...stepFacts], rules: knowledge.rules })
          : knowledge;

      // Declared constants the question names, resolved against this turn's data.
      // A constant inside a negation scope is never asserted: "not sqlite" must
      // not let the stack rule answer "Readback uses SQLite".
      const analysis = analyzeQuestion(query, { subjects: turnKnowledge.constants() });
      const excludes = analysis.slots.exclude;
      const terms: string[] = [];
      for (const token of new Set(tokenize(query))) {
        for (const constant of turnKnowledge.canonicalFor(token)) {
          if (excludes.includes(constant)) continue;
          if (!terms.includes(constant)) terms.push(constant);
        }
      }
      // A continuation inherits the previous turn only when it has no subject of
      // its own: "and?" does, "and SQLite?" names a new term and must not repeat
      // the old answer if that term is unknown.
      const ellipsis = followUp && tokenize(query).every((word) => ELLIPSIS_WORDS.has(word));
      const effectiveTerms = terms.length === 0 && ellipsis ? memory.terms : terms;
      const effectiveHits = hits.length === 0 && ellipsis ? memory.hits : hits;

      const assume: FactRow[] = [
        ...baseFacts,
        ...effectiveTerms.map((term) => [ASKED, term] as FactRow),
        ...effectiveHits.map((hit) => [FIELD, hit.kind, hit.value] as FactRow),
      ];

      if (matched) {
        const ruleWords = new Set(tokenize([matched.title, ...(matched.keywords ?? [])].join(' ')));
        const resolved = new Set(effectiveTerms.flatMap((term) => tokenize(term)));
        // Surface words, not stems: an app writing "no stack lists TypeScript"
        // cannot use "type" because the stemmer ate the rest of the word.
        const mentions = [
          ...new Set(
            // Keep the visitor's own capitalisation: echoing "TypeScript" reads
            // like a person, echoing "typescript" reads like a log line.
            query.split(/[^A-Za-z0-9+#.]+/).filter((word) => word.length > 1),
          ),
        ].filter((word) => {
          const [stem] = tokenize(word);
          if (!stem) return false;
          return (
            !ruleWords.has(stem) &&
            !resolved.has(stem) &&
            !ELLIPSIS_WORDS.has(stem) &&
            !ELLIPSIS_WORDS.has(word)
          );
        });
        const completion = runRule(
          matched,
          query,
          effectiveTerms,
          effectiveHits,
          assume,
          Object.fromEntries(observed),
          turnKnowledge,
          mentions,
          excludes,
          analysis.slots.combine,
        );
        if (completion) {
          if (factErrors.length) {
            completion.steps = [
              ...factErrors.map((message) => ({ type: 'error' as const, message, capabilityId: matched.id })),
              ...(completion.steps ?? []),
            ];
          }
          return completion;
        }
      }

      // A bare continuation ("and?", "more") with no retrieval signal of its own
      // repeats the last rule against the new turn's assumptions.
      if (memoryEnabled && followUp && memory.ruleId) {
        const previous = answers.find((answer) => answer.id === memory.ruleId);
        if (previous && previous !== matched) {
          const completion = runRule(previous, query, effectiveTerms, effectiveHits, assume, Object.fromEntries(observed), turnKnowledge);
          if (completion) return completion;
        }
      }

      return fallback.complete(request);
    },
  };
}
