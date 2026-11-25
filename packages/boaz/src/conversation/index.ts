import { AgentRuntime } from '../core/loop.js';
import { CapabilityRegistry, type RegistryLookup } from '../core/registry.js';
import { isCoverageQuery, createWorkingMemory, type MemoryTurn, type WorkingMemory } from '../core/memory.js';
import { analyzeQuestion } from '../core/question.js';
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

export interface ConversationDescription {
  /** A phrase that points at a subject, such as /reading|books|kid/i. */
  match: RegExp;
  subject: string;
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
  /** Pointing phrases the host knows, e.g. "the reading one" -> Readback. */
  descriptions?: ConversationDescription[];
  /** Which subjects can be pointed at with an ordinal or exclusion. */
  pointable?: (subject: string) => boolean;
  /** A size for a subject, used to resolve "which one is bigger?". */
  sizeOf?: (subject: string) => number | null;
  /** The sentence a size comparison becomes. Defaults to "compare A and B by size". */
  compareQuery?: (a: string, b: string) => string;
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

/** Every subject named anywhere in the answer, for list and comparison items. */
function allEntitiesIn(text: string, subjects: string[]): string[] {
  const body = String(text ?? '').toLowerCase();
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

  const slugOf = (value: string) =>
    String(value).split(':')[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const nameBySlug = new Map(memory.subjects.map((name) => [slugOf(name), name]));
  const joinNames = (names: string[]) => {
    const list = [...new Set(names.filter(Boolean))];
    if (list.length <= 1) return list[0] ?? '';
    return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  };
  let setNote: { groups: Array<{ term: string; names: string[] }>; turn: number } | null = null;

  function rememberSet(steps: TurnStep[], turn: number): void {
    const inference = steps.find((step) => step.type === 'inference' && step.solutions?.length);
    if (!inference || inference.type !== 'inference') return;
    const groups = new Map<string, { term: string; names: string[] }>();
    for (const solution of inference.solutions) {
      const bindings = solution as Record<string, string>;
      const term = bindings['?1_T'];
      const slug = bindings['?P'];
      if (!term || !slug) continue;
      const name = nameBySlug.get(String(slug)) ?? String(slug);
      const group = groups.get(String(term)) ?? { term: String(term), names: [] };
      if (!group.names.includes(name)) group.names.push(name);
      groups.set(String(term), group);
    }
    setNote = groups.size >= 2 ? { groups: [...groups.values()], turn } : null;
  }

  function setExclusion(query: string): { text: string; line: string } | null {
    if (!setNote || setNote.turn !== memory.turns.length) return null;
    if (!/^\s*why\s+(not|isn'?t|aren'?t|didn'?t|doesn'?t)\b/i.test(query)) return null;
    const groups = setNote.groups;
    const terms = groups.map((group) => group.term);
    const shared = groups[0]?.names.filter((name) => groups.every((group) => group.names.includes(name))) ?? [];
    const claim = shared.length
      ? `${joinNames(shared)} ${shared.length === 1 ? 'is' : 'are'} the only ${shared.length === 1 ? 'one' : 'ones'} with both ${joinNames(terms)}.`
      : `No project lists both ${joinNames(terms)}.`;
    const sides = groups
      .map((group) => {
        const only = group.names.filter((name) => !shared.includes(name));
        if (!only.length) return '';
        const missing = terms.filter((term) => term !== group.term);
        return `${joinNames(only)} ${only.length === 1 ? 'lists' : 'list'} ${group.term} and ${only.length === 1 ? 'not' : 'neither lists'} ${joinNames(missing)}`;
      })
      .filter(Boolean);
    return {
      text: `${claim}${sides.length ? ` ${sides.join('; ')}.` : ''}`,
      line: 'Read the two conditions of the last answer',
    };
  }

  function resolveContext(query: string): { query?: string; text?: string } | null {
    const analysis = analyzeQuestion(query, {
      subjects: memory.subjects,
      ...(options.attributes ? { attributes: options.attributes } : {}),
      context: memory.context(),
    });
    const items = (memory.context().items ?? []).filter(
      (name) => !options.pointable || options.pointable(name),
    );
    const subject = memory.context().subject;
    const attribute = analysis.slots.attribute;
    const rewrite = (name: string) =>
      attribute ? `what is ${name}'s ${attribute}?` : `tell me about ${name}`;

    const described = options.descriptions?.find((entry) => entry.match.test(query))?.subject;
    const pointsAtAThing = /\b(the one|the\s+.+?\s+one|that one|the .+ project)\b/i.test(query);
    if (described && pointsAtAThing) return { query: rewrite(described) };

    const ordinal = query.toLowerCase().match(/\b(first|second|third|fourth|fifth|last)\b/)?.[1];
    const ORDINALS: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4 };
    if (ordinal && items.length > 1) {
      const index = ordinal === 'last' ? items.length - 1 : ORDINALS[ordinal];
      if (index !== undefined && items[index]) return { query: rewrite(items[index]) };
    }

    const lowerQuery = query.toLowerCase();
    const excluded = [
      ...new Set([
        ...(analysis.slots.exclude ?? []),
        ...memory.subjects.filter((name) => lowerQuery.includes(`not ${name.toLowerCase()}`)),
      ]),
    ];
    if (excluded.length && items.length > 1) {
      const remaining = items.filter((name) => !excluded.some((entry) => entry.toLowerCase() === name.toLowerCase()));
      if (remaining.length === 1) return { query: rewrite(remaining[0]) };
    }

    if (subject && /\b(privacy|cloud|server|send|upload|leave)\b/i.test(query)) {
      return { query: `does ${subject} send data to a server?` };
    }

    if (subject && (analysis.slots.reference || /\b(its|their|that one|the same)\b/i.test(query)) && attribute) {
      return { query: `what is ${subject}'s ${attribute}?` };
    }

    const asksSize = /\bwhich (one|of them|project)?\s*(is )?(bigger|larger|smaller)\b/i.test(query);
    if (asksSize && items.length === 2 && options.sizeOf) {
      const [a, b] = items;
      const left = options.sizeOf(a);
      const right = options.sizeOf(b);
      if (left !== null && right !== null) {
        const bigger = /smaller/i.test(query) ? (left < right ? a : b) : (left > right ? a : b);
        const smaller = bigger === a ? b : a;
        return {
          query: options.compareQuery
            ? options.compareQuery(bigger, smaller)
            : `compare ${bigger} and ${smaller} by size`,
        };
      }
    }
    return null;
  }

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

      const exclusion = setExclusion(query);
      if (exclusion) {
        const record = memory.observe(query, { query, items: [] });
        const out: ConversationTurn = {
          text: exclusion.text,
          steps: [],
          surfaces: [],
          turn: record,
          kind: turn.kind,
          followUp: null,
        };
        viaSink({ type: 'text.delta', text: exclusion.text });
        return finish(out);
      }

      const contextual = resolveContext(query);
      const follow = memory.followUpTool(query);
      const effective = follow?.query ?? contextual?.query ?? query;
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
      const questionEntities = analyzeQuestion(query, {
        subjects: memory.subjects,
        ...(options.attributes ? { attributes: options.attributes } : {}),
        context: memory.context(),
      }).slots.entities;
      // A comparison names its own two items; a list answer supplies them from
      // the first sentence. Using every subject in the whole answer turns
      // "shobyde.com takes the other route" into a third project.
      const itemEntities = questionEntities.length >= 2
        ? questionEntities
        : allEntitiesIn(sentence(textOut), memory.subjects);
      const record = memory.observe(query, {
        capabilityId: call?.id ?? stepCapability(steps),
        query: effective,
        args: call?.args,
        entities: answerEntities,
        items: itemEntities,
      });
      rememberSet(steps, record.turn);
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
