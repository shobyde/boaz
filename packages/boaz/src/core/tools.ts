export type ParsedModelOutput =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; capabilityId: string; args: Record<string, unknown> }
  | { kind: 'malformed'; error: string; raw: string };

const ID_KEYS = ['tool', 'name', 'action', 'capability', 'capabilityId'];
const ARG_KEYS = ['arguments', 'args', 'parameters', 'input', 'params'];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalize(value: unknown): ParsedModelOutput | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const idKey = ID_KEYS.find((key) => typeof record[key] === 'string');
  if (!idKey) return undefined;
  const capabilityId = String(record[idKey]).trim();
  const argKey = ARG_KEYS.find((key) => key in record);
  let args: Record<string, unknown> = {};
  if (argKey) {
    const rawArgs = record[argKey];
    if (typeof rawArgs === 'string') {
      try {
        args = asRecord(JSON.parse(rawArgs)) ?? {};
      } catch {
        return { kind: 'malformed', error: 'arguments were a string but not valid JSON', raw: rawArgs };
      }
    } else if (rawArgs === null || rawArgs === undefined) {
      args = {};
    } else {
      const parsed = asRecord(rawArgs);
      if (!parsed) {
        return { kind: 'malformed', error: 'arguments must be a JSON object', raw: JSON.stringify(rawArgs) };
      }
      args = parsed;
    }
  }
  if (capabilityId === 'route' && typeof record.route === 'string') {
    return { kind: 'tool', capabilityId: 'navigate', args: { route: record.route } };
  }
  return { kind: 'tool', capabilityId, args };
}

/**
 * Extracts one tool call from whatever a small local model actually emitted:
 * a bare JSON object, a fenced block, a fenced block wrapped in prose, or a
 * JSON string nested inside `arguments`.
 */
export function parseModelOutput(text: string): ParsedModelOutput {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'text', text: '' };

  const fences = [...trimmed.matchAll(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/g)];
  if (fences.length > 0) {
    for (const fence of fences) {
      const body = (fence[1] ?? '').trim();
      if (!body.startsWith('{') && !body.startsWith('[')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        return {
          kind: 'malformed',
          error: `the JSON block did not parse: ${(error as Error).message}`,
          raw: body,
        };
      }
      const normalized = normalize(parsed);
      if (normalized) return normalized;
      return { kind: 'malformed', error: 'the JSON block had no "tool" field', raw: body };
    }
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      return {
        kind: 'malformed',
        error: `a JSON object was returned but did not parse: ${(error as Error).message}`,
        raw: trimmed,
      };
    }
    const normalized = normalize(parsed);
    if (normalized) return normalized;
    return { kind: 'malformed', error: 'the JSON object had no "tool" field', raw: trimmed };
  }

  return { kind: 'text', text: trimmed };
}

/** Parses the `model_output` of a native function-calling response body. */
export function parseNativeToolCall(payload: unknown): ParsedModelOutput {
  const record = asRecord(payload);
  if (!record) return { kind: 'malformed', error: 'payload was not an object', raw: String(payload) };
  const call = asRecord(record.function) ?? asRecord(record.tool_call) ?? record;
  const name = call.name ?? record.name;
  if (typeof name !== 'string') {
    return { kind: 'malformed', error: 'native tool call had no name', raw: JSON.stringify(payload) };
  }
  const rawArgs = call.arguments ?? record.arguments ?? {};
  let args: Record<string, unknown> = {};
  if (typeof rawArgs === 'string') {
    try {
      args = asRecord(JSON.parse(rawArgs)) ?? {};
    } catch {
      return { kind: 'malformed', error: 'native tool arguments were not valid JSON', raw: rawArgs };
    }
  } else {
    args = asRecord(rawArgs) ?? {};
  }
  return { kind: 'tool', capabilityId: name, args };
}
