import { AgentRuntime } from '../core/loop.js';
import { CapabilityRegistry, type RegistryLookup } from '../core/registry.js';
import { isCoverageQuery, createWorkingMemory, type MemoryTurn, type WorkingMemory } from '../core/memory.js';
import type {
  AgentEngine,
  AgentEvent,
  CapabilityDeclaration,
  ManifestCapability,
  RuntimeSnapshot,
  TurnStep,
} from '../core/types.js';
import { createRulesEngine, type AnswerRule, type RulesEngineOptions } from '../rules/engine.js';
import { KnowledgeBase, type FactRow, type Rule } from '../rules/knowledge.js';

export type TurnKind =
  | 'fresh'
  | 'continue-same-subject'
  | 'continue-new-subject'
  | 'command'
  | 'recap'
  | 'correction'
  | 'preference';

export interface TurnClassification {
  kind: TurnKind;
  confidence: number;
  cues: string[];
  subject?: string;
  newSubject?: string;
  previousSubject?: string;
}

export interface ConversationKnowledge {
  base?: KnowledgeBase;
  facts?: FactRow[];
  rules?: Array<string | Rule>;
  answers?: AnswerRule[];
  constants?: string[];
}

/**
 * A tool with an optional host-side resolver. The resolver is for tools the
 * app wants to dispatch directly from the visitor's words, before retrieval:
 * GitHub repo names and chart subjects are the obvious cases. It returns the
 * args for the capability, or null when the turn is not for this tool.
 */
export type ConversationTool = CapabilityDeclaration & {
  resolve?: (
    query: string,
    context: {
      memory: WorkingMemory;
      turn: TurnClassification;
      lastTool: MemoryTurn | null;
    },
  ) => Record<string, unknown> | null;
};

export interface ToolCall {
  id: string;
  args: Record<string, unknown>;
}

export interface ConversationOptions {
  /** The system prompt. Held for the runtime and shown in traces. */
  instructions?: string;
  /** Alias for `instructions`, for SDK-style call sites. */
  system?: string;
  /**
   * Domain knowledge: a KnowledgeBase, facts/rules/answers to build one, or a
   * system-prompt string used when the app has no structured knowledge yet.
   */
  knowledge?: KnowledgeBase | ConversationKnowledge | string;
  /** Declared constants a tool can return, so the matcher knows them early. */
  constants?: string[];
  /** Page or document grounding for questions the facts do not cover. */
  grounding?: RulesEngineOptions['grounding'];
  /** Answer rules when knowledge is passed as a KnowledgeBase. */
  answers?: AnswerRule[];
  /** Tools with handlers. The facade builds the manifest and registry. */
  tools?: ConversationTool[];
  /** Prebuilt manifest/registry, for hosts that already have them. */
  capabilities?: ManifestCapability[];
  registry?: RegistryLookup;
  /** Subject vocabulary for working memory and follow-ups. */
  subjects?: string[];
  attributes?: Record<string, string[]>;
  /** Reuse a session across conversation objects. */
  memory?: WorkingMemory;
  /** Override the engine; otherwise a rules engine is built. */
  engine?: AgentEngine;
  /** A host resolver for tools that are not declared with `resolve`. */
  resolveTool?: (
    query: string,
    context: {
      memory: WorkingMemory;
      turn: TurnClassification;
      lastTool: MemoryTurn | null;
    },
  ) => ToolCall | null;
  /** Runtime host callbacks. */
  getSnapshot?: () => RuntimeSnapshot;
  navigate?: (route: string) => void | Promise<void>;
  dispatch?: (event: string, payload?: unknown) => void;
  confirm?: (request: { title: string; description?: string }) => Promise<boolean>;
  maxToolCalls?: number;
  topK?: number;
  streaming?: false | { chunkChars?: number; paceMs?: number; leadInMs?: number };
  /** Receives the same typed events as `stream()`. */
  onEvent?: (event: ConversationEvent) => void;
}

export interface ConversationTurn {
  text: string;
  steps: TurnStep[];
  surfaces: unknown[];
  turn: MemoryTurn;
  kind: TurnKind;
  followUp: ReturnType<WorkingMemory['followUpTool']>;
}

export type ConversationEvent =
  | { type: 'turn.started'; kind: TurnKind; classification: TurnClassification }
  | { type: 'retrieval'; ids: string[] }
  | { type: 'text.delta'; text: string }
  | { type: 'step'; step: TurnStep }
  | { type: 'tool.use'; id: string; args: Record<string, unknown> }
  | { type: 'tool.result'; id: string; ok: boolean; text: string; result?: unknown; steps: TurnStep[] }
  | { type: 'surface'; messages: unknown[] }
  | { type: 'turn.completed'; turn: ConversationTurn }
  | { type: 'error'; message: string };

export interface Conversation {
  readonly memory: WorkingMemory;
  readonly runtime: AgentRuntime;
  readonly capabilities: ManifestCapability[];
  /** Collect the turn and return its final object. */
  ask(text: string): Promise<ConversationTurn>;
  /** Stream typed text, tool, step and surface events as they happen. */
  stream(text: string): AsyncIterable<ConversationEvent>;
  /** Alias for `stream`, for SDK call sites that expect `query()`. */
  query(text: string): AsyncIterable<ConversationEvent>;
  classify(text: string): TurnClassification;
  suggestions(limit?: number): string[];
  reset(): void;
}

const FOLLOW_UP = /^(and|also|what about|how about|then|more|why)\b/i;
const CONTROLLER = /^(show|open|go|take|read|expand|copy|download|print|visit|browse|scroll|jump|navigate|see)\b/i;
const CORRECTION = /^(not|except|other than|the other|why not)\b/i;

function sentence(text: string): string {
  return String(text ?? '').split(/(?<=[.!?])\s+/)[0] ?? '';
}

function entitiesIn(text: string, subjects: string[]): string[] {
  const body = sentence(text).toLowerCase();
  return subjects.filter((subject) => body.includes(subject.toLowerCase()));
}

function buildKnowledge(options: ConversationOptions): {
  base: KnowledgeBase;
  answers: AnswerRule[];
  constants: string[];
} {
  if (typeof options.knowledge === 'string') {
    return { base: new KnowledgeBase(), answers: [], constants: [] };
  }
  if (options.knowledge instanceof KnowledgeBase) {
    return {
      base: options.knowledge,
      answers: options.answers ?? [],
      constants: [],
    };
  }
  const knowledge = options.knowledge ?? {};
  return {
    base: knowledge.base ?? new KnowledgeBase({ facts: knowledge.facts, rules: knowledge.rules }),
    answers: options.answers ?? knowledge.answers ?? [],
    constants: knowledge.constants ?? [],
  };
}

export function createConversation(options: ConversationOptions = {}): Conversation {
  const instructions = options.instructions
    ?? options.system
    ?? (typeof options.knowledge === 'string' ? options.knowledge : undefined);
  const { base, answers, constants: knowledgeConstants } = buildKnowledge(options);
  const constants = options.constants ?? knowledgeConstants;
  const memory = options.memory
    ?? createWorkingMemory({
      subjects: options.subjects,
      attributes: options.attributes,
    });

  const ownRegistry = options.registry ? null : new CapabilityRegistry();
  const registry = options.registry ?? ownRegistry;
  const tools = options.tools ?? [];
  for (const tool of tools) {
    if (tool.handler) registry?.register(tool);
  }
  const manifest: ManifestCapability[] = options.capabilities ?? tools.map(({ handler: _handler, resolve: _resolve, ...meta }) => meta);

  const engine = options.engine ?? createRulesEngine({
    knowledge: base,
    answers,
    capabilities: manifest,
    constants,
    grounding: options.grounding,
  });
  let activeSink: ((event: ConversationEvent) => void) | null = null;
  let sawDelta = false;
  const viaSink = (event: ConversationEvent) => {
    activeSink?.(event);
    options.onEvent?.(event);
  };

  const runtime = new AgentRuntime({
    engine,
    capabilities: manifest,
    registry: registry ?? new CapabilityRegistry(),
    getSnapshot: options.getSnapshot ?? (() => ({ currentRoute: '/' })),
    navigate: options.navigate,
    dispatch: options.dispatch,
    confirm: options.confirm,
    maxToolCalls: options.maxToolCalls,
    topK: options.topK,
    instructions,
    streaming: options.streaming ?? { chunkChars: 16, paceMs: 0, leadInMs: 0 },
    onEvent: (event: AgentEvent) => {
      if (event.type === 'retrieval' && Array.isArray(event.ids)) {
        viaSink({ type: 'retrieval', ids: event.ids.map(String) });
      } else if (event.type === 'step' && event.step) {
        viaSink({ type: 'step', step: event.step as TurnStep });
      } else if (event.type === 'delta') {
        sawDelta = true;
        viaSink({ type: 'text.delta', text: String(event.text ?? '') });
      }
    },
  });


  function classify(text: string): TurnClassification {
    const query = String(text ?? '').trim();
    if (!query) return { kind: 'fresh', confidence: 1, cues: ['empty'] };
    if (isCoverageQuery(query)) {
      return { kind: 'recap', confidence: 0.98, cues: ['coverage phrase'] };
    }
    if (CORRECTION.test(query)) {
      return { kind: 'correction', confidence: 0.9, cues: ['correction prefix'] };
    }
    const follow = memory.followUpTool(query);
    if (follow) {
      return {
        kind: 'continue-new-subject',
        confidence: 0.95,
        cues: ['follow-up prefix', 'new subject', 'recent tool'],
        subject: follow.subject,
        newSubject: follow.subject,
        previousSubject: follow.previousSubject,
      };
    }
    if (FOLLOW_UP.test(query) && memory.context().subject) {
      return {
        kind: 'continue-same-subject',
        confidence: 0.72,
        cues: ['follow-up prefix', 'previous subject'],
        subject: memory.context().subject ?? undefined,
      };
    }
    if (CONTROLLER.test(query)) {
      return { kind: 'command', confidence: 0.86, cues: ['controller verb'] };
    }
    return { kind: 'fresh', confidence: 0.5, cues: ['no continuation cue'] };
  }

  function direct(query: string, turn: TurnClassification): ToolCall | null {
    const resolved = options.resolveTool?.(query, { memory, turn, lastTool: memory.lastTool() });
    if (resolved) return resolved;
    for (const tool of tools) {
      if (!tool.resolve) continue;
      try {
        const args = tool.resolve(query, { memory, turn, lastTool: memory.lastTool() });
        if (args) return { id: tool.id, args };
      } catch {
        // A resolver is app code and may be partial; a miss is not a turn failure.
      }
    }
    return null;
  }

  function stepCapability(steps: TurnStep[]): string | null {
    const step = steps.find((entry) =>
      entry.type === 'query' || entry.type === 'action' || entry.type === 'navigate',
    );
    return step?.capabilityId ?? null;
  }

  async function run(
    text: string,
    sink: (event: ConversationEvent) => void,
  ): Promise<ConversationTurn> {
    const query = String(text ?? '').trim();
    const turn = classify(query);
    sawDelta = false;
    activeSink = sink;
    try {
      viaSink({ type: 'turn.started', kind: turn.kind, classification: turn });

      const finish = (out: ConversationTurn): ConversationTurn => {
        if (out.surfaces.length > 0) viaSink({ type: 'surface', messages: out.surfaces });
        viaSink({ type: 'turn.completed', turn: out });
        return out;
      };

      if (turn.kind === 'recap') {
        const answer = memory.covered().sentence;
        const record = memory.observe(query, { query });
        const out: ConversationTurn = {
          text: answer,
          steps: [],
          surfaces: [],
          turn: record,
          kind: turn.kind,
          followUp: null,
        };
        if (answer) viaSink({ type: 'text.delta', text: answer });
        return finish(out);
      }

      const follow = memory.followUpTool(query);
      const effective = follow?.query ?? query;
      const call = direct(effective, turn);
      let textOut = '';
      let steps: TurnStep[] = [];
      if (call) {
        viaSink({ type: 'tool.use', id: call.id, args: call.args });
        const result = await runtime.runCapability(call.id, call.args);
        textOut = typeof result.result === 'object' && result.result
          ? String((result.result as { answer?: unknown; text?: unknown }).answer
            ?? (result.result as { text?: unknown }).text
            ?? result.text
            ?? '')
          : result.text;
        steps = result.steps;
        viaSink({
          type: 'tool.result',
          id: call.id,
          ok: result.ok,
          text: textOut,
          result: result.result,
          steps: result.steps,
        });
        if (!result.ok) throw new Error(result.text || `The ${call.id} tool did not answer.`);
        if (!sawDelta && textOut) viaSink({ type: 'text.delta', text: textOut });
      } else {
        const result = await runtime.send(effective);
        textOut = result.text;
        steps = result.steps;
        if (!sawDelta && textOut) viaSink({ type: 'text.delta', text: textOut });
      }

      const answerEntities = entitiesIn(textOut, memory.subjects);
      const record = memory.observe(query, {
        capabilityId: call?.id ?? stepCapability(steps),
        query: effective,
        args: call?.args,
        entities: answerEntities,
      });
      const surfaces = steps
        .filter((step): step is Extract<TurnStep, { type: 'surface' }> => step.type === 'surface')
        .flatMap((step) => step.messages);
      return finish({
        text: textOut,
        steps,
        surfaces,
        turn: record,
        kind: turn.kind,
        followUp: follow,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      viaSink({ type: 'error', message });
      throw error;
    } finally {
      activeSink = null;
    }
  }

  async function* stream(text: string): AsyncIterable<ConversationEvent> {
    const queue = new AsyncQueue<ConversationEvent>();
    const task = run(text, (event) => queue.push(event)).then(
      () => queue.close(),
      (error) => queue.fail(error),
    );
    for await (const event of queue) yield event;
    await task;
  }

  async function ask(text: string): Promise<ConversationTurn> {
    let completed: ConversationTurn | null = null;
    for await (const event of stream(text)) {
      if (event.type === 'turn.completed') completed = event.turn;
    }
    if (!completed) throw new Error('The conversation ended without a completed turn.');
    return completed;
  }

  function suggestions(limit = 5): string[] {
    return manifest.slice(0, limit).map((capability) => capability.title);
  }

  return {
    memory,
    runtime,
    capabilities: manifest,
    ask,
    stream,
    query: stream,
    classify,
    suggestions,
    reset() {
      runtime.reset();
      memory.reset();
    },
  };
}

/** A tiny async queue: events may arrive before the consumer asks for them. */
class AsyncQueue<T> {
  private values: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;
  private failure: unknown = null;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    this.failure = error;
    this.close();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift() as T;
        continue;
      }
      if (this.closed) {
        if (this.failure) throw this.failure;
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next.done) {
        if (this.failure) throw this.failure;
        return;
      }
      yield next.value;
    }
  }
}
