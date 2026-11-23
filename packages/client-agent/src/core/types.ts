/**
 * Public types for the capability registry, the manifest, and the tool loop.
 */

import type { RegistryLookup } from './registry.js';

export type CapabilityKind = 'route' | 'action' | 'query' | 'knowledge';

/** JSON Schema draft-07 subset accepted by the runtime validator. */
export type JSONSchemaObject = {
  type?: string | string[];
  properties?: Record<string, JSONSchemaObject>;
  required?: string[];
  additionalProperties?: boolean | JSONSchemaObject;
  items?: JSONSchemaObject | JSONSchemaObject[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JSONSchemaObject[];
  oneOf?: JSONSchemaObject[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  description?: string;
  title?: string;
  default?: unknown;
  [keyword: string]: unknown;
};

export interface ExecutionContext {
  currentRoute: string;
  navigate(to: string): void | Promise<void>;
  dispatch(event: string, payload?: unknown): void;
  read<T = unknown>(key: string): T | undefined;
  signal?: AbortSignal;
}

export interface CapabilityDeclaration<
  TParams = Record<string, unknown>,
  TResult = unknown,
> {
  /** Stable unique identifier, e.g. "billing.open_invoices". */
  id: string;
  kind: CapabilityKind;
  /** Short label a human reads on a suggestion card. */
  title: string;
  /** Intent-focused guidance for the model: what the user gets, not how it is built. */
  description: string;
  /** Extra retrieval synonyms. */
  keywords?: string[];
  /** Target path or pattern for route navigation. */
  route?: string;
  paramsSchema?: JSONSchemaObject;
  requiresConfirmation?: boolean;
  /** Declarative facts the assistant can quote to answer questions without driving the browser. */
  knowledge?: string;
  handler?: (params: TParams, ctx: ExecutionContext) => Promise<TResult> | TResult;
}

/** A capability with no runtime handler: what the build plugin emits. */
export type ManifestCapability = Omit<CapabilityDeclaration, 'handler'>;

export interface AgentManifest {
  version: 1;
  capabilities: ManifestCapability[];
}

export interface RuntimeSnapshot {
  currentRoute: string;
  /** Free-form small state the app wants the model to see (cart count, filters). */
  state?: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JSONSchemaObject;
}

export interface EngineRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

export interface EngineCompletion {
  text: string;
  /**
   * Steps the engine already took (a rule it applied, a fact set it read).
   * The runtime emits them before the text so a host can show provenance.
   */
  steps?: TurnStep[];
}

/** Anything that can turn messages into text: the rules engine, keyword search, a fake in tests. */
export interface AgentEngine {
  readonly id: string;
  complete(request: EngineRequest): Promise<EngineCompletion>;
}

export interface ConfirmationRequest {
  capabilityId: string;
  title: string;
  description: string;
  args: Record<string, unknown>;
}

export type TurnStep =
  | { type: 'text'; text: string }
  | {
      type: 'inference';
      capabilityId: string;
      goal: string;
      terms: string[];
      solutions: Record<string, string>[];
      rule?: string;
    }
  | { type: 'navigate'; capabilityId: string; route: string }
  | { type: 'action'; capabilityId: string; args: Record<string, unknown>; result: unknown }
  | { type: 'query'; capabilityId: string; args: Record<string, unknown>; result: unknown }
  | { type: 'surface'; capabilityId: string; messages: unknown[] }
  | { type: 'confirmation'; capabilityId: string; approved: boolean }
  | {
      type: 'validation-error';
      capabilityId: string;
      errors: string[];
      retried: boolean;
    }
  | { type: 'error'; message: string; capabilityId?: string };

export interface TurnResult {
  /** Final assistant prose, always present (may be a fallback sentence). */
  text: string;
  steps: TurnStep[];
  stoppedBy: 'final' | 'max-tool-calls' | 'aborted';
}

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

export interface AgentRuntimeOptions {
  engine: AgentEngine;
  /** Static capabilities from the build-time manifest (or declared in code). */
  capabilities: ManifestCapability[];
  /** Live handlers, keyed by capability id. */
  registry: RegistryLookup;
  getSnapshot: () => RuntimeSnapshot;
  navigate?: (route: string) => void | Promise<void>;
  dispatch?: (event: string, payload?: unknown) => void;
  confirm?: (request: ConfirmationRequest) => Promise<boolean>;
  /** Sequential tool calls allowed per user message. Default 3. */
  maxToolCalls?: number;
  /** Capabilities injected into the prompt per turn. Default 8. */
  topK?: number;
  /** Approximate prompt budget for the capability list, in tokens. Default 1500. */
  promptBudgetTokens?: number;
  /** Extra system instructions appended after the generated policy. */
  instructions?: string;
  /**
   * Returns extra grounding text for one turn: page content, retrieved docs, a
   * transcript. Called with the visitor's message so the host can pick what is
   * relevant; failures are ignored rather than breaking the turn.
   */
  readContext?: (query: string) => string | Promise<string>;
  /** Token budget for that grounding text. Default 700. */
  contextBudgetTokens?: number;
  /**
   * Reveal the reply as `delta` events instead of one block. Pacing is
   * presentation only: the text is already known when the first delta fires.
   * Off by default.
   */
  streaming?: false | { chunkChars?: number; paceMs?: number };
  onEvent?: (event: AgentEvent) => void;
}
