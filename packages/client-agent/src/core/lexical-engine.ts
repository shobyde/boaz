import type { AgentEngine, EngineRequest, JSONSchemaObject, ManifestCapability } from './types.js';
import { CapabilityIndex, tokenize } from './retriever.js';

export interface LexicalEngineOptions {
  capabilities: ManifestCapability[];
  /** Minimum BM25 score before a capability is called. Default 0.9. */
  threshold?: number;
  /** How far ahead of the runner-up the top match must be. Default 1.25. */
  margin?: number;
}

const EMAIL = /[^\s@<>()"']+@[^\s@<>()"']+\.[^\s@<>()"']+/;

function realUserMessages(request: EngineRequest): number[] {
  const indexes: number[] = [];
  request.messages.forEach((message, index) => {
    if (message.role === 'user' && !message.content.startsWith('[client-agent]')) indexes.push(index);
  });
  return indexes;
}

function lastUserMessage(request: EngineRequest): string {
  const indexes = realUserMessages(request);
  const index = indexes[indexes.length - 1];
  return index === undefined ? '' : (request.messages[index]?.content ?? '');
}

function currentRoute(request: EngineRequest): string {
  const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
  return /Current route: (\S+)/.exec(system)?.[1] ?? '/';
}

/**
 * Infers the required arguments from the visitor's own words when the schema
 * makes it unambiguous: an enum value that appears in the query, or an email
 * address in the query. Anything else is a question for the visitor, not a
 * guess.
 */
function inferArguments(
  capability: ManifestCapability,
  query: string,
): Record<string, unknown> | null {
  const schema: JSONSchemaObject | undefined = capability.paramsSchema;
  const required = schema?.required ?? [];
  if (required.length === 0) return {};
  const tokens = new Set(tokenize(query));
  const args: Record<string, unknown> = {};

  for (const name of required) {
    const property = schema?.properties?.[name];
    if (!property) return null;
    if (property.enum) {
      const match = property.enum.find((value) => {
        const words = tokenize(String(value));
        return words.some((word) => tokens.has(word));
      });
      if (match === undefined) return null;
      args[name] = match;
      continue;
    }
    if (property.type === 'string' && (name === 'email' || property.pattern?.includes('@'))) {
      const found = EMAIL.exec(query)?.[0];
      if (!found) return null;
      args[name] = found;
      continue;
    }
    if (property.type === 'boolean') {
      args[name] = /\b(yes|do it|confirm|please)\b/i.test(query);
      continue;
    }
    return null;
  }
  return args;
}

/**
 * Turns a query result into a sentence. A capability that returns `answer` (or
 * `text`) gets to phrase its own reply; anything else is summarised key by key,
 * which is readable for counts and ambiguous for prose.
 */
function readAnswer(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.answer === 'string') return parsed.answer;
    if (typeof parsed.text === 'string') return parsed.text;
    const summary = Object.entries(parsed)
      .map(([key, value]) => `${key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()} ${String(value)}`)
      .join(', ');
    if (!summary) return '';
    return /[.!?]$/.test(summary) ? summary : `Right now: ${summary}.`;
  } catch {
    const text = raw.trim();
    return /[.!?]$/.test(text) ? text : `${text}.`;
  }
}

function callTool(id: string, args: Record<string, unknown>): string {
  return ['```json', JSON.stringify({ tool: id, arguments: args }), '```'].join('\n');
}

/**
 * Deterministic engine that answers from the capability index.
 *
 * It is the no-WebGPU fallback and the reference implementation of the tool
 * protocol: same messages in, same JSON out, no download and no GPU. When the
 * request is unambiguous it navigates or calls the action; when it is not, it
 * asks instead of guessing.
 */
export function createLexicalEngine(options: LexicalEngineOptions): AgentEngine {
  const index = new CapabilityIndex(options.capabilities);
  const byId = new Map(options.capabilities.map((capability) => [capability.id, capability]));
  const threshold = options.threshold ?? 0.9;
  const margin = options.margin ?? 1.25;

  return {
    id: 'lexical',
    async complete(request: EngineRequest): Promise<{ text: string }> {
      const query = lastUserMessage(request);
      const route = currentRoute(request);
      if (!query) {
        return { text: 'Ask me to take you somewhere or change something on this screen.' };
      }

      // A tool already ran for this message: report the outcome instead of
      // calling it again forever.
      const indexes = realUserMessages(request);
      const lastUserIndex = indexes[indexes.length - 1] ?? -1;
      const after = request.messages.slice(lastUserIndex + 1);
      if (after.some((message) => message.content.startsWith('[client-agent]'))) {
        const trace = after.map((message) => message.content).join(' ');
        if (trace.includes('Navigation succeeded')) return { text: "You're there now. Anything else?" };
        // Parse the tool result from its own message: the payload is JSON that
        // can contain full stops, so the period ending the sentence must be the
        // last character, not the first one followed by a space.
        const queryMessage = after.find((message) =>
          message.content.startsWith('[client-agent] Query "'),
        );
        if (queryMessage) {
          const payload = /returned ([\s\S]*)\.$/.exec(queryMessage.content)?.[1] ?? '';
          const answer = readAnswer(payload);
          return { text: answer || 'I read that value.' };
        }
        if (trace.includes('ran successfully')) {
          // Name what ran, so the reply is not the same sentence every time.
          const ranId = /\[client-agent\] "([^"]+)" ran successfully/.exec(trace)?.[1];
          const title = ranId ? byId.get(ranId)?.title : undefined;
          return { text: title ? `Done: ${title}.` : 'Done.' };
        }
        return { text: "I couldn't finish that one." };
      }

      // Rank without the route boost: the boost is right for choosing prompt
      // context, but it would make "take me to billing" look ambiguous while
      // the visitor is already on a billing screen.
      const ranked = index.search(query, { limit: 3, boost: false });
      const top = ranked[0];
      const second = ranked[1];
      const confident =
        top !== undefined && top.score >= threshold && (!second || top.score >= second.score * margin);
      if (!top || !confident) {
        const suggestions = index
          .search(query, { currentRoute: route, limit: 3 })
          .map((entry) => entry.capability.title);
        return {
          text: suggestions.length
            ? `I'm not sure about that. I can help with: ${suggestions.join('; ')}.`
            : 'I can only help with the screens and controls built into this app.',
        };
      }

      const capability = byId.get(top.capability.id);
      if (!capability) return { text: "I couldn't match that to anything here." };
      if (capability.kind === 'route') return { text: callTool(capability.id, {}) };

      const args = inferArguments(capability, query);
      if (!args) {
        const required = capability.paramsSchema?.required ?? [];
        return { text: `I can do that — ${capability.title} needs ${required.join(' and ')}.` };
      }
      return { text: callTool(capability.id, args) };
    },
  };
}
