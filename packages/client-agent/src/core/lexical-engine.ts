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

/** Verbs that ask for a place, not an explanation. */
const NAVIGATE = /^(take me|go to|jump to|scroll to|scroll down to|bring me|navigate to|show me)\b/i;

/**
 * ...unless the same sentence asks for a specific thing at that place. "Show me
 * the blog" is navigation; "show me the newest article card" is a card.
 */
const NAMED_THING = /\b(card|expand|print|download|copy|link|source|repo|site|archive|resume)\b/i;

/**
 * The visitor's verb should decide between capabilities that share a topic.
 * "Expand the Hobnob card" must beat "Show a project card", and both read the
 * same nouns.
 */
const ACTION_VERBS = new Set([
  'show', 'open', 'expand', 'read', 'copy', 'download', 'print', 'visit', 'go', 'take',
  'list', 'browse', 'find', 'scroll', 'jump', 'email',
]);

function verbBoost(capabilityId: string, title: string, queryVerb: string | undefined): number {
  if (!queryVerb) return 1;
  const [first] = tokenize(title);
  if (first === queryVerb) return 1.35;
  return tokenize(capabilityId).includes(queryVerb) ? 1.2 : 1;
}

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
const LOOKS_LIKE_DATA = /^\s*[\[{]/;

/**
 * Turns one value into words. Arrays of records are named by their title/name,
 * because "projects [object Object]" is what happens when they are not.
 */
function summarizeValue(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return 'nothing';
    const names = value
      .map((item) =>
        item && typeof item === 'object'
          ? ((item as Record<string, unknown>).title ??
            (item as Record<string, unknown>).name ??
            (item as Record<string, unknown>).id ??
            null)
          : item,
      )
      .filter((name): name is string | number => typeof name === 'string' || typeof name === 'number');
    if (names.length === 0) return `${value.length} items`;
    const short = names.slice(0, 3).map(String).join(', ');
    return value.length > 3 ? `${value.length} items (${short}…)` : short;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return 'nothing';
    if (entries.length > 3) return `${entries.length} fields`;
    return entries.map(([key, item]) => `${key}: ${String(item)}`).join(', ');
  }
  return String(value);
}

function readAnswer(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Truncated or otherwise unreadable: say that, never echo the payload. A
    // visitor asked a question, not for the wire format.
    return LOOKS_LIKE_DATA.test(raw)
      ? 'I read that data, but it came back too large to summarise. Try a narrower question.'
      : '';
  }
  if (parsed === null || typeof parsed !== 'object') return String(parsed);
  const record = parsed as Record<string, unknown>;
  if (typeof record.answer === 'string') return record.answer;
  if (typeof record.text === 'string') return record.text;
  if (Array.isArray(parsed)) {
    return parsed.length === 0 ? 'Nothing came back for that.' : `That returned ${parsed.length} items.`;
  }
  const summary = Object.entries(record)
    .map(([key, value]) => `${key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()} ${summarizeValue(value)}`)
    .join(', ');
  if (!summary) return '';
  return /[.!?]$/.test(summary) ? summary : `Right now: ${summary}.`;
}

function callTool(id: string, args: Record<string, unknown>): string {
  return ['```json', JSON.stringify({ tool: id, arguments: args }), '```'].join('\n');
}

/**
 * Deterministic engine that answers from the capability index.
 *
 * It is the no-model fallback and the reference implementation of the tool
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
      let query = lastUserMessage(request);
      // Conversational follow-ups: "more", "tell me more", "and?" reuse the
      // previous user question so retrieval has something to work with.
      const FOLLOWUPS = new Set(['more', 'again', 'also', 'and', 'continue', 'details', 'elaborate']);
      const tokens = tokenize(query);
      if (tokens.length <= 1 && FOLLOWUPS.has(tokens[0] ?? '')) {
        const indexes = realUserMessages(request);
        const prev = indexes.length >= 2 ? request.messages[indexes[indexes.length - 2]]?.content ?? '' : '';
        if (prev) query = `${prev} ${query}`;
      }
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
          // The transcript copy is clipped for prompt budgets, so a large result
          // arrives as truncated JSON. Prefer the structured observation the
          // runtime passes alongside it, and never show raw JSON to a visitor.
          const id = /^\[client-agent\] Query "([^"]+)"/.exec(queryMessage.content)?.[1];
          const observed = id ? request.observations?.[id] : undefined;
          const payload =
            observed !== undefined
              ? JSON.stringify(observed)
              : /returned ([\s\S]*)\.$/.exec(queryMessage.content)?.[1] ?? '';
          const answer = readAnswer(payload);
          return { text: answer || 'I read that value.' };
        }
        if (trace.includes('rendered a surface')) {
          // The surface is the reply; the host renders it.
          return { text: '' };
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
      const [queryVerb] = tokenize(query);
      if (queryVerb && ACTION_VERBS.has(queryVerb)) {
        ranked.sort(
          (a, b) =>
            b.score * verbBoost(b.capability.id, b.capability.title, queryVerb) -
            a.score * verbBoost(a.capability.id, a.capability.title, queryVerb),
        );
      }
      const top = ranked[0];
      const second = ranked[1];
      const confident =
        top !== undefined && top.score >= threshold && (!second || top.score >= second.score * margin);
      // "Take me to X" is a different question from "what is X": when the visitor
      // asks for a place, the best route is the answer even if an action or query
      // about the same thing scores just as high.
      if (!confident && NAVIGATE.test(query) && !NAMED_THING.test(query)) {
        const route = ranked.find(
          (entry) => byId.get(entry.capability.id)?.kind === 'route' && entry.score >= threshold,
        );
        if (route) return { text: callTool(route.capability.id, {}) };
      }

      // "Who is Sho" is a question, so a knowledge answer within reach of a route
      // should be the answer; the route can still be offered afterwards.
      const asked = /^(who|what|when|where|why|how|which|does|do|is|are|can|has|have|tell me)\b/i.test(
        query,
      );
      if (!confident && asked) {
        const knowledgeHit = ranked.find(
          (entry) => byId.get(entry.capability.id)?.kind === 'knowledge' && entry.score >= threshold * 0.75,
        );
        const topScore = top?.score ?? 0;
        if (knowledgeHit && knowledgeHit.score >= topScore * 0.85) {
          const capability = byId.get(knowledgeHit.capability.id);
          if (capability?.knowledge) return { text: capability.knowledge };
        }
      }

      if (!top || !confident) {
        // Conversational fallback: if several knowledge entries matched, stitch
        // them together instead of giving up.
        const rankedKnowledge = ranked.filter((entry) => entry.capability.kind === 'knowledge' && entry.capability.knowledge);
        if (rankedKnowledge.length >= 2) {
          return { text: rankedKnowledge.map((entry) => entry.capability.knowledge).join(' ') };
        }
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
      // Knowledge capabilities answer in prose from declared facts, no browser action.
      if (capability.kind === 'knowledge' && capability.knowledge) {
        return { text: capability.knowledge };
      }
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
