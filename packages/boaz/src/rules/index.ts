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
export {
  createFactIndex,
  factText,
  indexTokens,
  numberOf,
  rankFacts,
  topFact,
} from './facts.js';
export type { FactHit, FactIndex, FactIndexOptions, RankedFact } from './facts.js';
export { createRulesEngine } from './engine.js';
export type { AnswerContext, AnswerRule, RulesEngineOptions } from './engine.js';
export type { Combine } from '../core/question.js';
export { createFieldScanner, requestedFields, DEFAULT_PATTERNS, FIELD_SYNONYMS } from '../extract/index.js';
export type { FieldKind, FieldScanner, FieldScannerOptions, ScanHit } from '../extract/index.js';
