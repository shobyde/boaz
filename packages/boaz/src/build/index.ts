export {
  extractCapabilities,
  buildManifest,
  scanSource,
  hasErrors,
} from './extract.js';
export type {
  ExtractOptions,
  ExtractResult,
  StaticCapability,
  Diagnostic,
  DiscoveredRoute,
  SourcePosition,
} from './extract.js';
export { DIAGNOSTIC_CODES, CODE_INDEX, codeSeverity } from './codes.js';
export type { DiagnosticCode, Severity } from './codes.js';
export { generateProbes, serializeProbes, normalizePhrase } from './probes.js';
export type {
  GeneratedProbes,
  GenerateOptions,
  ProbeCollision,
  ProbeSuggestion,
  UncoveredCapability,
} from './probes.js';
