import type {
  AgentEvent,
  AgentRuntimeOptions,
  CapabilityDeclaration,
  ExecutionContext,
  ManifestCapability,
  TurnResult,
  TurnStep,
} from './types.js';
import { CapabilityIndex } from './retriever.js';
import { buildSystemPrompt, buildToolSpecs } from './prompt.js';
import { parseModelOutput } from './tools.js';
import { formatSchemaErrors, validateParams } from './schema.js';

const MAX_CORRECTIONS = 2;

function clip(value: unknown, max = 600): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? 'null';
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Runs the tool-call loop for one user turn.
 *
 * The model is not trusted: every call is matched against the manifest, every
 * argument is validated, side effects pass a confirmation gate, and the number
 * of sequential calls is capped. A failure is retried once with the exact
 * validator error, which is what actually makes small local models usable.
 */
export class AgentRuntime {
  private history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private index: CapabilityIndex;
  private byId = new Map<string, ManifestCapability>();
  private readonly maxToolCalls: number;
  private readonly topK: number;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.index = new CapabilityIndex(options.capabilities);
    for (const capability of options.capabilities) {
      this.byId.set(capability.id, capability);
    }
    this.maxToolCalls = options.maxToolCalls ?? 3;
    this.topK = options.topK ?? 8;
  }

  get conversation(): ReadonlyArray<{ role: 'user' | 'assistant'; content: string }> {
    return this.history;
  }

  get capabilities(): ManifestCapability[] {
    return [...this.byId.values()];
  }

  reset(): void {
    this.history = [];
  }

  private emit(event: AgentEvent): void {
    this.options.onEvent?.(event);
  }

  private makeContext(): ExecutionContext {
    const snapshot = this.options.getSnapshot();
    return {
      currentRoute: snapshot.currentRoute,
      navigate: (to: string) => {
        if (!this.options.navigate) {
          throw new Error(`no navigate function configured; cannot go to ${to}`);
        }
        return this.options.navigate(to);
      },
      dispatch: (name: string, payload?: unknown) => {
        if (!this.options.dispatch) {
          throw new Error(`no dispatch function configured; cannot emit ${name}`);
        }
        this.options.dispatch(name, payload);
      },
      read: <T,>(key: string) => this.options.getSnapshot().state?.[key] as T | undefined,
    };
  }

  async send(userText: string): Promise<TurnResult> {
    const steps: TurnStep[] = [];
    const push = (step: TurnStep) => {
      steps.push(step);
      this.emit({ type: 'step', step });
    };

    const firstSnapshot = this.options.getSnapshot();
    const retrieved = this.index.search(userText, {
      currentRoute: firstSnapshot.currentRoute,
      limit: this.topK,
    });
    const selected = retrieved.map((entry) => entry.capability);
    // Always keep route capabilities for the current page: they are the most
    // likely follow-up and cost one line each.
    for (const capability of this.byId.values()) {
      if (
        capability.kind === 'route' &&
        capability.route === firstSnapshot.currentRoute &&
        !selected.some((c) => c.id === capability.id)
      ) {
        selected.push(capability);
      }
    }
    this.emit({ type: 'retrieval', ids: selected.map((c) => c.id) });

    const systemPrompt = buildSystemPrompt({
      capabilities: selected,
      snapshot: firstSnapshot,
      budgetTokens: this.options.promptBudgetTokens,
      instructions: this.options.instructions,
    });

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...this.history,
      { role: 'user', content: userText },
    ];

    let toolCalls = 0;
    let corrections = 0;
    let finalText: string | undefined;
    let stoppedBy: TurnResult['stoppedBy'] = 'final';

    const correct = (message: string) => {
      corrections += 1;
      messages.push({ role: 'user', content: `[client-agent] ${message}` });
    };

    while (toolCalls < this.maxToolCalls) {
      const completion = await this.options.engine.complete({
        messages,
        tools: buildToolSpecs(selected),
      });
      const parsed = parseModelOutput(completion.text);

      if (parsed.kind === 'text') {
        finalText = parsed.text || undefined;
        if (finalText) push({ type: 'text', text: finalText });
        break;
      }

      if (parsed.kind === 'malformed') {
        if (corrections < MAX_CORRECTIONS) {
          correct(
            `That reply was not usable: ${parsed.error}. Reply with either plain prose or one fenced JSON block of the form {"tool":"<id>","arguments":{}}.`,
          );
          continue;
        }
        push({ type: 'error', message: parsed.error });
        break;
      }

      const capability = this.byId.get(parsed.capabilityId);
      if (!capability) {
        if (corrections < MAX_CORRECTIONS) {
          const available = selected.map((c) => c.id).join(', ') || '(none)';
          correct(
            `"${parsed.capabilityId}" is not a capability id. Use one of: ${available}. If none fits, reply in prose saying you cannot do it.`,
          );
          continue;
        }
        push({ type: 'error', message: `unknown capability "${parsed.capabilityId}"` });
        break;
      }

      const validation = validateParams(parsed.args, capability.paramsSchema);
      if (!validation.valid) {
        const errors = formatSchemaErrors(validation.errors);
        push({ type: 'validation-error', capabilityId: capability.id, errors, retried: corrections < MAX_CORRECTIONS });
        if (corrections < MAX_CORRECTIONS) {
          correct(
            `The call to "${capability.id}" was rejected by schema validation: ${errors.join('; ')}. Reply with the corrected JSON object only.`,
          );
          continue;
        }
        finalText = `I couldn't call ${capability.title} with those details.`;
        break;
      }
      const args = validation.value;

      if (capability.requiresConfirmation) {
        if (!this.options.confirm) {
          push({
            type: 'error',
            message: `${capability.id} requires confirmation but no confirmation UI is configured`,
            capabilityId: capability.id,
          });
          finalText = `${capability.title} needs confirmation, which is not available here.`;
          break;
        }
        const approved = await this.options.confirm({
          capabilityId: capability.id,
          title: capability.title,
          description: capability.description,
          args,
        });
        push({ type: 'confirmation', capabilityId: capability.id, approved });
        if (!approved) {
          finalText = 'Cancelled. Nothing was changed.';
          break;
        }
      }

      toolCalls += 1;

      if (capability.kind === 'route') {
        const route = capability.route ?? '/';
        const snapshot = this.options.getSnapshot();
        if (snapshot.currentRoute === route) {
          push({ type: 'navigate', capabilityId: capability.id, route });
          this.emit({ type: 'already-there', route });
        } else {
          if (!this.options.navigate) {
            push({ type: 'error', message: 'no navigate function configured', capabilityId: capability.id });
            finalText = 'I cannot navigate in this environment.';
            break;
          }
          await this.options.navigate(route);
          push({ type: 'navigate', capabilityId: capability.id, route });
        }
        messages.push(
          { role: 'assistant', content: completion.text },
          {
            role: 'user',
            content: `[client-agent] Navigation succeeded. The visitor is now on ${route}.`,
          },
        );
        continue;
      }

      // action | query: the handler lives in the module the route mounts.
      let live: CapabilityDeclaration | undefined = this.options.registry.get(capability.id);
      if (!live || typeof live.handler !== 'function') {
        const snapshot = this.options.getSnapshot();
        if (
          capability.route &&
          capability.route !== snapshot.currentRoute &&
          this.options.navigate
        ) {
          await this.options.navigate(capability.route);
          push({ type: 'navigate', capabilityId: capability.id, route: capability.route });
        }
        live = await this.options.registry.awaitRegistration(capability.id, 2000);
      }
      if (!live || typeof live.handler !== 'function') {
        push({
          type: 'error',
          message: `no handler registered for "${capability.id}" (the module owning it may not be mounted)`,
          capabilityId: capability.id,
        });
        finalText = `I couldn't reach the ${capability.title} control on this screen.`;
        break;
      }

      const ctx = this.makeContext();
      try {
        const result = await live.handler(args, ctx);
        if (capability.kind === 'query') {
          push({ type: 'query', capabilityId: capability.id, args, result });
          messages.push(
            { role: 'assistant', content: completion.text },
            { role: 'user', content: `[client-agent] Query "${capability.id}" returned ${clip(result)}.` },
          );
        } else {
          push({ type: 'action', capabilityId: capability.id, args, result });
          messages.push(
            { role: 'assistant', content: completion.text },
            {
              role: 'user',
              content: `[client-agent] "${capability.id}" ran successfully and returned ${clip(result)}.`,
            },
          );
        }
        continue;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        push({ type: 'error', message, capabilityId: capability.id });
        if (corrections < MAX_CORRECTIONS) {
          correct(`Running "${capability.id}" threw: ${message}. Try a different call or reply in prose.`);
          continue;
        }
        finalText = `${capability.title} failed: ${message}`;
        break;
      }
    }

    if (!finalText && toolCalls >= this.maxToolCalls) stoppedBy = 'max-tool-calls';
    if (!finalText) {
      finalText = this.summarize(steps, stoppedBy);
    }
    if (finalText) push({ type: 'text', text: finalText });

    this.history.push({ role: 'user', content: userText });
    this.history.push({ role: 'assistant', content: finalText });
    this.emit({ type: 'turn', text: finalText, steps });

    return { text: finalText, steps, stoppedBy };
  }

  private summarize(steps: TurnStep[], stoppedBy: TurnResult['stoppedBy']): string {
    const lastAction = [...steps].reverse().find((s) => s.type === 'action' || s.type === 'navigate');
    if (stoppedBy === 'max-tool-calls') {
      return lastAction
        ? `I stopped after ${this.maxToolCalls} steps. The last one completed; tell me if you want to continue.`
        : `I stopped after ${this.maxToolCalls} steps without finishing.`;
    }
    if (lastAction?.type === 'navigate') return `You're on ${lastAction.route} now.`;
    if (lastAction?.type === 'action') {
      const title = this.byId.get(lastAction.capabilityId)?.title ?? lastAction.capabilityId;
      return `${title}: done.`;
    }
    return "I couldn't complete that. Nothing was changed.";
  }
}
