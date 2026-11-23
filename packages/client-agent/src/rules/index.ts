export {
  KnowledgeBase,
  fact,
  parseAtom,
  parseRule,
  formatAtom,
} from './knowledge.js';
export type {
  Atom,
  Bindings,
  FactRow,
  KnowledgeBaseOptions,
  ProofStep,
  QueryOptions,
  Rule,
  Solution,
  Term,
} from './knowledge.js';
export { createRulesEngine } from './engine.js';
export type { AnswerContext, AnswerRule, RulesEngineOptions } from './engine.js';
