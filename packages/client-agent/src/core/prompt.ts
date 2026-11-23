import type { ManifestCapability, RuntimeSnapshot, ToolSpec } from './types.js';

/** Rough token estimate: ~4 characters per token is close enough for budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function describeArgs(capability: ManifestCapability): string {
  const schema = capability.paramsSchema;
  if (!schema || !schema.properties || Object.keys(schema.properties).length === 0) {
    return '';
  }
  const required = new Set(schema.required ?? []);
  const parts = Object.entries(schema.properties).map(([name, prop]) => {
    let type = prop.type ? String(prop.type) : 'value';
    if (prop.enum) type = prop.enum.map((v) => JSON.stringify(v)).join('|');
    const optional = required.has(name) ? '' : '?';
    return `${name}${optional}:${type}`;
  });
  return parts.join(', ');
}

export interface PromptInput {
  capabilities: ManifestCapability[];
  snapshot: RuntimeSnapshot;
  /** Token budget for the capability list itself. Default 1500. */
  budgetTokens?: number;
  instructions?: string;
  /** Grounding text for this turn: page content, docs, a transcript. */
  context?: string;
  /** Token budget for that text. Default 700. */
  contextBudgetTokens?: number;
}

/**
 * Builds the system prompt for one turn. Everything in here is authored by the
 * host app, never by the model, and the capability list is the only source of
 * callable ids — the loop rejects anything else.
 */
export function buildSystemPrompt(input: PromptInput): string {
  const { capabilities, snapshot } = input;
  const budget = input.budgetTokens ?? 1500;

  const header = [
    'You are the assistant built into this web application. You help the visitor find screens and perform actions.',
    '',
    `Current route: ${snapshot.currentRoute}`,
  ];
  if (snapshot.state && Object.keys(snapshot.state).length > 0) {
    header.push(`Client state: ${JSON.stringify(snapshot.state)}`);
  }
  header.push(
    '',
    'Reply in one of exactly two shapes:',
    '1. Plain prose for an answer that needs no action.',
    '2. A single fenced ```json block calling one capability:',
    '```json',
    '{"tool":"<capability id>","arguments":{}}',
    '```',
    '',
    'Rules:',
    '- Only call ids from the Capabilities list. Never invent an id, an argument, a URL or a selector.',
    '- Use argument names and values exactly as the schema allows. Omit optional arguments you do not need.',
    '- route capabilities take no arguments.',
    '- Call one capability per reply. You may be asked again after the result.',
    '- If nothing listed does what was asked, say so plainly and name the closest capability.',
    '- Answer in at most two sentences. Never claim an action happened unless a tool result says it did.',
  );
  if (input.instructions) header.push('', input.instructions);

  if (input.context && input.context.trim()) {
    const limit = (input.contextBudgetTokens ?? 700) * 4;
    const raw = input.context.trim();
    const body = raw.length > limit ? `${raw.slice(0, limit).trimEnd()}\n[content truncated]` : raw;
    header.push(
      '',
      'Page content, for answering questions about this site:',
      body,
      '',
      'Use the page content to explain things. When the visitor would be better off seeing a section, say so and offer to take them there.',
    );
  }

  const lines = capabilities.map((capability) => {
    const route = capability.route ? ` [${capability.route}]` : '';
    const args = describeArgs(capability);
    const confirm = capability.requiresConfirmation ? ' (asks the user to confirm)' : '';
    const argLine = args ? ` args{${args}}` : '';
    return `- ${capability.id} (${capability.kind}${route})${confirm} ${capability.title}: ${capability.description}${argLine}`;
  });

  const fixed = `${header.join('\n')}\n\nCapabilities:\n`;
  const room = budget * 4 - fixed.length - 40;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > room && kept.length > 0) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (kept.length < lines.length) {
    kept.push(`- (${lines.length - kept.length} more capabilities are not listed; ask the user to narrow the request)`);
  }
  return `${fixed}${kept.join('\n')}`;
}

/** Native tool specs for engines that support OpenAI-style function calling. */
export function buildToolSpecs(capabilities: ManifestCapability[]): ToolSpec[] {
  return capabilities.map((capability) => ({
    name: capability.id,
    description: `${capability.title}. ${capability.description}`,
    parameters:
      capability.paramsSchema ??
      ({ type: 'object', properties: {}, additionalProperties: false } as const),
  }));
}
