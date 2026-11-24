import type { ManifestCapability } from './types.js';
import { analyzeQuestion } from './question.js';
import { planRequest, routeRequest, type PlanOptions, type PlannedStep } from './plan.js';

/**
 * An MCP-shaped bridge: the same capabilities an in-page assistant uses,
 * exposed as JSON-RPC tools, so a client that speaks the protocol can drive
 * them without knowing this library exists.
 *
 * The point is not to imitate a model. It is to show that the tool surface a
 * hosted model gets is a data structure, and that a deterministic planner can
 * call it just as well: `planToolCall` routes a request to a tool name and its
 * arguments, and the server answers with the protocol's result shape
 * (`content` for a reader, `structuredContent` for a program).
 *
 * Validation happens on this side of the wire on purpose. A model client will
 * happily send an argument the schema never declared, and a server that runs it
 * anyway teaches the caller that the schema is decorative.
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface ToolServerOptions {
  name: string;
  version: string;
  capabilities: ManifestCapability[];
  /** Runs one capability. The host's own path, not a second one. */
  run: (capabilityId: string, args: Record<string, unknown>) => unknown | Promise<unknown>;
  /** Echoed back on `initialize`. Defaults to the 2025-06-18 revision. */
  protocolVersion?: string;
}

export interface ToolServer {
  /** Tool definitions, in manifest order. */
  tools: ToolDefinition[];
  /** The capability id behind a tool name. */
  capabilityFor: (toolName: string) => string | undefined;
  callTool: (toolName: string, args?: Record<string, unknown>) => Promise<ToolCallResult>;
  /** One JSON-RPC message in, one response out. `null` means "no response" (notification). */
  handle: (message: JsonRpcRequest) => Promise<JsonRpcResponse | null>;
}

/**
 * The protocol's tool-name pattern is `[a-zA-Z0-9_-]`, and every capability id
 * here carries a dot (`projects.list`). Sanitising rather than renaming keeps
 * the id as the record and the name as the wire format.
 */
export function toolName(capabilityId: string): string {
  return capabilityId.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 64);
}

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;

export function toolsFromCapabilities(capabilities: ManifestCapability[]): ToolDefinition[] {
  return capabilities.map((capability) => {
    const description = [capability.title, capability.description].filter(Boolean).join(': ');
    const schema = capability.paramsSchema as Record<string, unknown> | undefined;
    return {
      name: toolName(capability.id),
      description: description || capability.id,
      inputSchema: schema ?? { ...EMPTY_SCHEMA },
    };
  });
}

/** "3 items: Hobnob, Readback, Boaz" — an array is described, never stringified. */
function describeValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return 'nothing';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const names = value.map((entry) => {
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const label = record.title ?? record.name ?? record.id ?? record.label;
        if (label !== undefined) return String(label);
      }
      return describeValue(entry, depth + 1);
    });
    const shown = names.slice(0, 3).join(', ');
    return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
  }
  if (depth > 0) return Object.keys(value as Record<string, unknown>).join(', ');
  const record = value as Record<string, unknown>;
  return Object.entries(record)
    .slice(0, 6)
    .map(([key, entry]) => `${key}: ${describeValue(entry, depth + 1)}`)
    .join('; ');
}

/**
 * A tool result a reader can use and a program can parse. The text is a
 * sentence, because the first consumer of an MCP result is often a model that
 * will quote it; the structure rides alongside for the deterministic caller.
 */
export function describeToolResult(title: string, value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return `${title}: ${describeValue(value)}`;
  return `${title}: ${describeValue(value)}`;
}

function validateArgs(
  capability: ManifestCapability,
  args: Record<string, unknown>,
): string | null {
  const schema = capability.paramsSchema;
  const required = schema?.required ?? [];
  const properties = schema?.properties ?? {};
  for (const name of required) {
    if (!(name in args) || args[name] === undefined) {
      const property = properties[name];
      const allowed = property?.enum ? ` (one of: ${property.enum.join(', ')})` : '';
      return `Tool ${toolName(capability.id)} needs the argument "${name}"${allowed}.`;
    }
  }
  for (const key of Object.keys(args)) {
    if (!(key in properties)) {
      return `Tool ${toolName(capability.id)} has no argument "${key}".`;
    }
    const property = properties[key];
    if (property?.enum && !property.enum.includes(args[key] as never)) {
      return `"${String(args[key])}" is not one of ${property.enum.join(', ')} for "${key}".`;
    }
  }
  return null;
}

export function createToolServer(options: ToolServerOptions): ToolServer {
  const tools = toolsFromCapabilities(options.capabilities);
  const byName = new Map(tools.map((tool) => [tool.name, tool.name]));
  const byCapability = new Map(options.capabilities.map((capability) => [toolName(capability.id), capability]));
  const byTool = new Map(tools.map((tool) => [tool.name, tool]));

  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    const capability = byCapability.get(name);
    const tool = byTool.get(name);
    if (!capability || !tool) {
      throw Object.assign(new Error(`Unknown tool: ${name}`), {
        code: -32602,
        data: { tools: tools.map((entry) => entry.name) },
      });
    }
    const problem = validateArgs(capability, args);
    if (problem) {
      return { content: [{ type: 'text', text: problem }], isError: true, _meta: { capabilityId: capability.id } };
    }
    try {
      const result = await options.run(capability.id, args);
      return {
        content: [{ type: 'text', text: describeToolResult(capability.title || capability.id, result) }],
        structuredContent: result,
        _meta: { capabilityId: capability.id },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `${capability.title || capability.id} failed: ${message}` }],
        isError: true,
        _meta: { capabilityId: capability.id },
      };
    }
  }

  async function handle(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = message?.id ?? null;
    const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
    const fail = (code: number, text: string, data?: unknown): JsonRpcResponse => ({
      jsonrpc: '2.0',
      id,
      error: { code, message: text, ...(data === undefined ? {} : { data }) },
    });
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return fail(-32600, 'Invalid Request');
    }
    // A notification has no id and gets no reply, but it still runs: the client
    // sends `notifications/initialized` and expects the conversation to continue.
    const notification = message.id === undefined;
    switch (message.method) {
      case 'initialize':
        return reply({
          protocolVersion: options.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: options.name, version: options.version },
          instructions: `${tools.length} deterministic tools. No model runs behind them; every result is computed from the data this server was given.`,
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'ping':
        return notification ? null : reply({});
      case 'tools/list':
        return reply({ tools });
      case 'tools/call': {
        const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
        const name = typeof params.name === 'string' ? params.name : '';
        // `arguments` is an object in the protocol. A caller that sends the
        // string "{}" is not making a call with no arguments, it is sending a
        // payload this server does not read, and silently treating it as empty
        // is how a malformed call looks like a valid one.
        if (params.arguments !== undefined && (params.arguments === null || typeof params.arguments !== 'object' || Array.isArray(params.arguments))) {
          return fail(-32602, 'params.arguments must be an object');
        }
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        try {
          return reply(await callTool(name, args));
        } catch (error) {
          const typed = error as { code?: number; message?: string; data?: unknown };
          return fail(typed.code ?? -32603, typed.message ?? 'Tool call failed', typed.data);
        }
      }
      default:
        return fail(-32601, `Method not found: ${message.method}`);
    }
  }

  return {
    tools,
    capabilityFor: (name) => (byName.has(name) ? byCapability.get(name)!.id : undefined),
    callTool,
    handle,
  };
}

export interface ToolClient {
  initialize: () => Promise<Record<string, unknown>>;
  listTools: () => Promise<ToolDefinition[]>;
  callTool: (name: string, args?: Record<string, unknown>) => Promise<ToolCallResult>;
}

/**
 * A client over any transport: a `send` that takes one JSON-RPC message and
 * resolves the matching response. In-process it is the server's `handle`; over
 * stdio it is one line in, one line out. Neither path knows about the other.
 */
export function createToolClient(
  send: (message: JsonRpcRequest) => Promise<JsonRpcResponse | null>,
): ToolClient {
  let nextId = 1;
  async function request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = nextId++;
    const response = await send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    if (!response) throw new Error(`${method}: no response`);
    // A client that accepts someone else's reply is how a bridge mixes up two
    // calls in flight, so the id check is part of the contract.
    if (response.id !== id) throw new Error(`${method}: response id ${String(response.id)} is not ${id}`);
    if (response.error) {
      throw Object.assign(new Error(response.error.message), {
        code: response.error.code,
        data: response.error.data,
      });
    }
    return response.result;
  }
  return {
    initialize: async () => (await request('initialize', { protocolVersion: '2025-06-18', capabilities: {} })) as Record<string, unknown>,
    listTools: async () => {
      const result = (await request('tools/list')) as { tools?: ToolDefinition[] };
      return result.tools ?? [];
    },
    callTool: async (name, args = {}) => (await request('tools/call', { name, arguments: args })) as ToolCallResult,
  };
}

export interface PlannedToolCall {
  name: string;
  capabilityId: string;
  args: Record<string, unknown>;
  /** True when the call can run now; false when it needs an argument or a page. */
  runnable: boolean;
  reason?: 'args' | 'route';
}

export interface ToolPlan {
  calls: PlannedToolCall[];
  declined?: string;
  failed?: string;
  /** One sentence a host can print before making the calls. */
  summary: string;
}

export interface PlanToolOptions extends PlanOptions {}

/**
 * The deterministic planner behind a tool client. One sentence becomes one
 * call, a sentence with two requests becomes two calls in order, and a request
 * no capability serves is declined rather than mapped onto the nearest tool.
 *
 * It keeps `needs` instead of ignoring it: a tool call with a missing argument
 * is the MCP version of asking a page for a card it was never told to open.
 */
export function planToolCall(query: string, options: PlanToolOptions): ToolPlan {
  const plan = planRequest(query, options);
  if (plan.steps.length > 0) {
    const calls = plan.steps.map((step: PlannedStep) => ({
      name: toolName(step.capabilityId),
      capabilityId: step.capabilityId,
      args: (step.args ?? {}) as Record<string, unknown>,
      runnable: step.needs === 'none' && step.args !== null,
      ...(step.args === null ? { reason: 'args' as const } : step.needs === 'route' ? { reason: 'route' as const } : {}),
    }));
    return { calls, summary: plan.summary };
  }
  const routed = routeRequest(query, {
    ...options,
    prefer: analyzeQuestion(query).questionShaped ? 'question' : 'request',
  });
  if (routed.declined) {
    return { calls: [], declined: routed.declined, failed: query, summary: '' };
  }
  const args = (routed.args ?? {}) as Record<string, unknown>;
  return {
    calls: [
      {
        name: toolName(routed.capabilityId),
        capabilityId: routed.capabilityId,
        args,
        runnable: routed.args !== null,
        ...(routed.args === null ? { reason: 'args' as const } : {}),
      },
    ],
    summary: routed.title,
  };
}
