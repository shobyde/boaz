// Runs an app's own engine, the way its UI would.
//
// The module the app points at exports `createEngine()` (and optionally the
// capabilities and answer rules it was built from). That keeps the harness out
// of the app's business: no imports are guessed, no config is reimplemented.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseModelOutput } from '../core/index.js';
import type { AgentEngine, EngineRequest } from '../core/types.js';
import type { AnswerRule } from '../rules/engine.js';
import type { ManifestCapability } from '../core/types.js';

export type CapabilityRunner = (
  id: string,
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

export interface AgentModule {
  createEngine: () => AgentEngine;
  /** Runs a capability the way the UI would, so rules that use tools can answer. */
  runCapability?: CapabilityRunner;
  answers?: AnswerRule[];
  capabilities?: ManifestCapability[];
}

export interface TurnResult {
  /** The reply the visitor would read: prose, or the last tool call text. */
  text: string;
  /** First capability the engine called in this turn, when it called one. */
  toolId?: string;
  args?: Record<string, unknown>;
  /** True when the engine called a capability at all. */
  isCall: boolean;
  /** Every call in order, so a harness can report the decision, not the ending. */
  calls: Array<{ id: string; args: Record<string, unknown> }>;
  /** The rule that planned the first call, when a rule planned it. */
  plannedBy?: string;
  /** The answer rule that composed the prose, from its inference step. */
  composedBy?: string;
}

export async function loadAgentModule(file: string): Promise<AgentModule> {
  const url = pathToFileURL(path.resolve(file)).href;
  const loaded = (await import(url)) as Partial<AgentModule>;
  if (typeof loaded.createEngine !== 'function') {
    throw new Error(
      `${file}: export a createEngine() that returns the engine your UI uses ` +
        '(see "Proving it works" in the docs)',
    );
  }
  return {
    createEngine: loaded.createEngine,
    ...(loaded.runCapability ? { runCapability: loaded.runCapability } : {}),
    ...(loaded.answers ? { answers: loaded.answers } : {}),
    ...(loaded.capabilities ? { capabilities: loaded.capabilities } : {}),
  };
}

export async function ask(
  engine: AgentEngine,
  question: string,
  run?: CapabilityRunner,
): Promise<TurnResult> {
  const messages = [{ role: 'user' as const, content: question }];
  let observations: Record<string, unknown> | undefined;
  let text = '';
  const calls: Array<{ id: string; args: Record<string, unknown> }> = [];
  let plannedBy: string | undefined;
  let composedBy: string | undefined;

  for (let turn = 0; turn < 2; turn += 1) {
    const request: EngineRequest = {
      messages,
      tools: [],
      ...(observations ? { observations } : {}),
    };
    const completion = await engine.complete(request);
    text = typeof completion.text === 'string' ? completion.text : String(completion.text ?? '');
    const parsed = parseModelOutput(text);
    const planned = (engine as { memory?: { planned?: { ruleId?: string } | null } }).memory?.planned;
    if (planned?.ruleId && !plannedBy) plannedBy = planned.ruleId;
    const inference = (completion.steps ?? []).find(
      (step) => (step as { type?: string }).type === 'inference',
    ) as { capabilityId?: string } | undefined;
    if (inference?.capabilityId) composedBy = inference.capabilityId;
    if (parsed.kind !== 'tool') break;
    calls.push({ id: parsed.capabilityId ?? '', args: parsed.args ?? {} });
    if (!run) break;

    // The UI would run this capability and hand the result back; do the same so
    // a rule that reasons over a tool produces the sentence, not the call.
    const result = await run(parsed.capabilityId ?? '', parsed.args ?? {});
    observations = { ...(observations ?? {}), [parsed.capabilityId ?? '']: result };
  }
  const [first] = calls;
  return {
    text,
    ...(first ? { toolId: first.id, args: first.args } : {}),
    isCall: calls.length > 0,
    calls,
    ...(plannedBy ? { plannedBy } : {}),
    ...(composedBy ? { composedBy } : {}),
  };
}

/**
 * A rule that runs a capability before answering shows up as a tool call. When
 * the app exports its rules, an expectation written as the rule id is satisfied
 * by the call its step declares.
 */
export function ruleForCall(
  answers: AnswerRule[] | undefined,
  toolId: string,
  expect: string | undefined,
): string | undefined {
  if (!answers?.length) return undefined;
  return answers.find(
    (rule) => rule.id === expect && (rule.steps ?? []).some((step) => step.capabilityId === toolId),
  )?.id;
}

/** Runs the capability an expectation names, if the app exposed it. */
export function findCapability(
  capabilities: ManifestCapability[] | undefined,
  id: string,
): ManifestCapability | undefined {
  return capabilities?.find((capability) => capability.id === id);
}

/**
 * A knowledge capability is answered by quoting its text, so the reply names it:
 * first line of the declared paragraph, compared on a fixed prefix.
 */
export function knowledgeSource(
  capabilities: ManifestCapability[] | undefined,
  text: string,
): string | undefined {
  const seen = text.trim().toLowerCase();
  return capabilities?.find((capability) => {
    const knowledge = capability.knowledge?.trim().toLowerCase();
    return knowledge && knowledge.length > 20 && seen.startsWith(knowledge.slice(0, 40));
  })?.id;
}
