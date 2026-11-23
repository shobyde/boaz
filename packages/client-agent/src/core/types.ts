/**
 * Public types for the capability registry, the manifest, and the tool loop.
 */

import type { RegistryLookup } from './registry.js';

export type CapabilityKind = 'route' | 'action' | 'query';

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
}

/** Anything that can turn messages into text: WebLLM, a remote adapter, a fake in tests. */
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
  | { type: 'navigate'; capabilityId: string; route: string }
  | { type: 'action'; capabilityId: string; args: Record<string, unknown>; result: unknown }
  | { type: 'query'; capabilityId: string; args: Record<string, unknown>; result: unknown }
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
  onEvent?: (event: AgentEvent) => void;
}
