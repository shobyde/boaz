import type { AgentEngine, EngineCompletion, EngineRequest, ManifestCapability } from '../core/types.js';
import { CapabilityIndex, tokenize } from '../core/retriever.js';
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
 * An answer rule is the app's half of the reasoning: what to look up, and how a
 * solution becomes a sentence. The library owns retrieval, inference, grounding
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
   * inference step, so a host never prints a Datalog goal at a visitor.
   */
  explain?: (context: AnswerContext) => string;
  /**
   * Tools to run before composing, in order. The engine emits one call per turn
   * and picks up the result on the next pass, so a rule can reason over live app
   * data instead of a copy of it.
   */
  steps?: ToolStep[];
  /** Minimum retrieval score before this rule is tried. Default 1.0. */
  threshold?: number;
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
  /** Fields the question named and the page scan found, e.g. an email address. */
  hits: ScanHit[];
  /** Tool results this rule read, keyed by capability id. */
  observed: Record<string, unknown>;
  /** Runs another goal against the same knowledge and assumptions. */
  lookup: (goal: string) => Solution[];
}

/** What the engine carries between turns, so ellipsis and "and?" still work. */
export interface EngineMemory {
  ruleId: string | null;
  terms: string[];
  fields: FieldKind[];
  hits: ScanHit[];
  entities: string[];
  recentQueries: string[];
  turns: number;
}

export interface RulesEngineOptions {
  knowledge: KnowledgeBase;
  answers: AnswerRule[];
  /** Capabilities for the fallback engine, so route/action/query questions still work. */
  capabilities?: ManifestCapability[];
  /** Retrieval score before an answer rule is tried. Default 1.0. */
  threshold?: number;
  /** Replaces keyword matching as the fallback. */
  fallback?: AgentEngine;
  /** Extra facts for every query, e.g. synonyms the app wants to honour. */
  facts?: FactRow[];
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

const QUERY_RESULT = /^\[client-agent\] Query "([^"]+)" returned ([\s\S]*)$/;
const ACTION_RESULT = /^\[client-agent\] "([^"]+)" ran successfully and returned ([\s\S]*)$/;

/** Results of calls made since the visitor's last message, keyed by capability. */
function observationsThisTurn(request: EngineRequest): Map<string, unknown> {
  const users: number[] = [];
  request.messages.forEach((message, index) => {
    if (message.role === 'user' && !message.content.startsWith('[client-agent]')) users.push(index);
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
    (message) => message.role === 'user' && !message.content.startsWith('[client-agent]'),
  );
  return users[users.length - 1]?.content ?? '';
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
  const scanner = options.grounding
    ? (options.grounding.scanner ?? createFieldScanner(options.grounding.patterns ? { patterns: options.grounding.patterns } : {}))
    : undefined;
  const memoryEnabled = options.memory !== false;
  const memoryLimit = (typeof options.memory === 'object' && options.memory.turns) || 6;

  const memory: EngineMemory = {
    ruleId: null,
    terms: [],
    fields: [],
    hits: [],
    entities: [],
    recentQueries: [],
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
  ): EngineCompletion | null => {
    const solutions = kb.query(rule.goal, { assume });
    const context: AnswerContext = {
      query,
      bindings: solutions[0]?.bindings ?? {},
      solutions,
      knowledge: kb,
      terms,
      mentions,
      hits,
      observed,
      lookup: (goal) => kb.query(goal, { assume }),
    };
    const text = rule.compose(context).trim();
    if (!text) return null;

    if (memoryEnabled) {
      memory.ruleId = rule.id;
      memory.terms = terms;
      memory.fields = hits.map((hit) => hit.kind);
      memory.hits = hits;
      memory.entities = [...new Set(solutions.flatMap((solution) => Object.values(solution.bindings)))];
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
      memory.terms = [];
      memory.fields = [];
      memory.hits = [];
      memory.entities = [];
      memory.recentQueries = [];
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
      const short = tokenize(query).length <= 2;
      const hint = memoryEnabled && (followUp || short) && fields.length === 0;
      const retrieval = [
        hint ? memory.ruleId : '',
        hint ? memory.recentQueries.slice(-2).join(' ') : '',
        query,
      ]
        .filter(Boolean)
        .join(' ');

      const [best] = answers.length > 0 ? index.search(retrieval, { limit: 1, boost: false }) : [];
      const rule = best ? answers.find((answer) => answer.id === best.capability.id) : undefined;
      const threshold = rule?.threshold ?? options.threshold ?? 1;
      const matched = rule && best && best.score >= threshold ? rule : undefined;

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
      const terms: string[] = [];
      for (const token of new Set(tokenize(query))) {
        for (const constant of turnKnowledge.canonicalFor(token)) {
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
        const completion = runRule(matched, query, effectiveTerms, effectiveHits, assume, Object.fromEntries(observed), turnKnowledge, mentions);
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
