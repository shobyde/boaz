import type { AgentEngine, EngineCompletion, EngineRequest, ManifestCapability } from '../core/types.js';
import { CapabilityIndex, tokenize } from '../core/retriever.js';
import { createLexicalEngine } from '../core/lexical-engine.js';
import { KnowledgeBase, type Bindings, type FactRow, type Solution } from './knowledge.js';

/**
 * An answer rule is the app's half of the reasoning: what to look up, and how a
 * solution becomes a sentence. The library owns retrieval, inference, and the
 * order of operations.
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
  /** Minimum retrieval score before this rule is tried. Default 1.0. */
  threshold?: number;
}

export interface AnswerContext {
  /** The visitor's message. */
  query: string;
  /** Bindings from the first solution. */
  bindings: Bindings;
  /** Every distinct solution, in inference order. */
  solutions: Solution[];
  knowledge: KnowledgeBase;
  /** Constants the question mentioned, as declared in the facts. */
  terms: string[];
  /** Runs another goal against the same knowledge and assumptions. */
  lookup: (goal: string) => Solution[];
}

export interface RulesEngineOptions {
  knowledge: KnowledgeBase;
  answers: AnswerRule[];
  /**
   * Capabilities for the fallback engine, so route/action/query questions still
   * work when no answer rule matches.
   */
  capabilities?: ManifestCapability[];
  /** Retrieval score before an answer rule is tried. Default 1.0. */
  threshold?: number;
  /** Replaces keyword matching as the fallback. */
  fallback?: AgentEngine;
  /** Extra facts for every query, e.g. synonyms the app wants to honour. */
  facts?: FactRow[];
}

/** Facts the engine injects per turn: what the visitor asked about. */
const ASKED = 'asked';

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

export function createRulesEngine(options: RulesEngineOptions): AgentEngine {
  const { knowledge } = options;
  const answers = options.answers;
  const index = new CapabilityIndex(answers.map(answerCapability));
  const fallback = options.fallback ?? createLexicalEngine({ capabilities: options.capabilities ?? [] });
  const baseFacts = options.facts ?? [];

  return {
    id: 'rules',

    async complete(request: EngineRequest): Promise<EngineCompletion> {
      const query = lastUserMessage(request).trim();
      if (!query) return fallback.complete(request);

      // Which declared constants does the question mention? This is the only
      // "understanding" step, and it never guesses past the app's own data.
      const terms: string[] = [];
      for (const token of new Set(tokenize(query))) {
        for (const constant of knowledge.canonicalFor(token)) {
          if (!terms.includes(constant)) terms.push(constant);
        }
      }
      const assume: FactRow[] = [...baseFacts, ...terms.map((term) => [ASKED, term] as FactRow)];

      if (answers.length > 0) {
        const [best] = index.search(query, { limit: 1, boost: false });
        const threshold = best ? (answers.find((answer) => answer.id === best.capability.id)?.threshold ?? options.threshold ?? 1) : Infinity;
        if (best && best.score >= threshold) {
          const rule = answers.find((answer) => answer.id === best.capability.id);
          if (rule) {
            // Compose even with no solutions: "no project lists TypeScript" is a
            // better answer than unrelated prose from the keyword engine. An empty
            // string still declines.
            const solutions = knowledge.query(rule.goal, { assume });
            const text = rule
              .compose({
                query,
                bindings: solutions[0]?.bindings ?? {},
                solutions,
                knowledge,
                terms,
                lookup: (goal) => knowledge.query(goal, { assume }),
              })
              .trim();
            if (text) {
              return {
                text,
                steps: [
                  {
                    type: 'inference',
                    capabilityId: rule.id,
                    goal: rule.goal,
                    terms,
                    solutions: solutions.map((solution) => solution.bindings),
                    rule: knowledge.rules.find((r) => r.head.rel === rule.goal.split('(')[0]?.trim())?.source,
                  },
                ],
              };
            }
          }
        }
      }

      return fallback.complete(request);
    },
  };
}
