import { describe, expect, it, vi } from 'vitest';
import {
  createToolClient,
  createToolServer,
  planToolCall,
  toolName,
  type JsonRpcResponse,
  type ToolServer,
} from '../src/core/mcp.js';
import type { ManifestCapability } from '../src/core/types.js';

/** Three capabilities shaped like a real app's: a route, an action with an enum, a query. */
function capabilities(): ManifestCapability[] {
  return [
    {
      id: 'blog.open_archive',
      title: 'Open the full archive',
      description: 'Every post, by date',
      kind: 'route',
      route: '/archive/',
      keywords: ['archive', 'all posts', 'every post'],
    },
    {
      id: 'projects.card',
      title: 'Show a project card',
      description: 'One card per project',
      kind: 'action',
      keywords: ['project card', 'show project'],
      paramsSchema: {
        type: 'object',
        required: ['project'],
        properties: {
          project: { type: 'string', enum: ['Hobnob', 'Readback', 'Boaz'] },
        },
      },
    },
    {
      id: 'blog.stats',
      title: 'Log statistics',
      description: 'How many posts, newest title',
      kind: 'query',
      keywords: ['how many posts', 'post count', 'newest post'],
    },
  ] as unknown as ManifestCapability[];
}

function server(run = vi.fn(async (id: string) => ({ id, ok: true }))): { server: ToolServer; run: typeof run } {
  const instance = createToolServer({
    name: 'boaz-test',
    version: '0.0.0',
    capabilities: capabilities(),
    run,
  });
  return { server: instance, run };
}

const ask = (server: ToolServer, message: Parameters<ToolServer['handle']>[0]) => server.handle(message);

describe('tool surface', () => {
  it('exposes one tool per capability with a protocol-safe name and a schema', () => {
    const { server } = serverWith();
    expect(server.tools).toHaveLength(3);
    for (const tool of server.tools) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
    }
    expect(server.tools.map((tool) => tool.name)).toEqual(['blog_open_archive', 'projects_card', 'blog_stats']);
    expect(server.capabilityFor('projects_card')).toBe('projects.card');
    expect(server.capabilityFor('nope')).toBeUndefined();
  });

  it('keeps the capability id recoverable from the wire name', () => {
    expect(toolName('projects.open')).toBe('projects_open');
    expect(toolName('a'.repeat(80))).toHaveLength(64);
  });

  it('answers initialize with the protocol version and its own name', async () => {
    const { server } = serverWith();
    const reply = (await ask(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })) as JsonRpcResponse;
    expect(reply.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'boaz-test', version: '0.0.0' },
    });
  });

  it('does not reply to a notification', async () => {
    const { server } = serverWith();
    expect(await ask(server, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('echoes a string id exactly', async () => {
    const { server } = serverWith();
    const reply = (await ask(server, { jsonrpc: '2.0', id: 'abc-1', method: 'tools/list' })) as JsonRpcResponse;
    expect(reply.id).toBe('abc-1');
  });
});

describe('tools/call', () => {
  it('runs a tool and returns text for a reader plus the structure for a program', async () => {
    const { server, run } = serverWith();
    const reply = (await ask(server, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'projects_card', arguments: { project: 'Hobnob' } },
    })) as JsonRpcResponse;
    expect(run).toHaveBeenCalledWith('projects.card', { project: 'Hobnob' });
    const result = reply.result as { content: Array<{ text: string }>; structuredContent: unknown; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Show a project card');
    expect(result.structuredContent).toEqual({ id: 'projects.card', ok: true });
  });

  it('refuses a missing required argument without running the handler', async () => {
    const { server, run } = serverWith();
    const reply = (await ask(server, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'projects_card', arguments: {} },
    })) as JsonRpcResponse;
    const result = reply.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('needs the argument "project"');
    expect(result.content[0].text).toContain('Hobnob, Readback, Boaz');
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses an argument the schema never declared', async () => {
    const { server, run } = serverWith();
    const reply = (await ask(server, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'blog_stats', arguments: { verbose: true } },
    })) as JsonRpcResponse;
    expect((reply.result as { isError?: boolean }).isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a value outside the enum', async () => {
    const { server } = serverWith();
    const reply = (await ask(server, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'projects_card', arguments: { project: 'Hobbnot' } },
    })) as JsonRpcResponse;
    expect((reply.result as { content: Array<{ text: string }> }).content[0].text).toContain('is not one of Hobnob');
  });

  it('turns a throwing handler into an error result, not a lost call', async () => {
    const { server } = serverWith(async () => {
      throw new Error('registry offline');
    });
    const reply = (await ask(server, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'blog_stats', arguments: {} },
    })) as JsonRpcResponse;
    const result = reply.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('registry offline');
  });

  it('answers an unknown tool with a JSON-RPC error that lists the real ones', async () => {
    const { server } = serverWith();
    const reply = (await ask(server, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'projects_expand', arguments: {} },
    })) as JsonRpcResponse;
    expect(reply.error?.code).toBe(-32602);
    expect(reply.error?.message).toContain('Unknown tool');
    expect((reply.error?.data as { tools: string[] }).tools).toContain('projects_card');
  });

  it('answers an unknown method with -32601', async () => {
    const { server } = serverWith();
    const reply = (await ask(server, { jsonrpc: '2.0', id: 13, method: 'resources/list' })) as JsonRpcResponse;
    expect(reply.error?.code).toBe(-32601);
  });

  it('rejects a message that is not JSON-RPC 2.0', async () => {
    const { server } = serverWith();
    const reply = (await ask(server, { id: 14, method: 'tools/list' })) as JsonRpcResponse;
    expect(reply.error?.code).toBe(-32600);
  });
});

describe('client', () => {
  it('drives the server over a transport function', async () => {
    const { server } = serverWith();
    const client = createToolClient((message) => server.handle(message));
    const info = await client.initialize();
    expect(info.serverInfo).toMatchObject({ name: 'boaz-test' });
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('blog_open_archive');
    const result = await client.callTool('blog_open_archive', {});
    expect(result.structuredContent).toEqual({ id: 'blog.open_archive', ok: true });
  });

  it('fails loudly when a response carries another call\u2019s id', async () => {
    const client = createToolClient(async () => ({ jsonrpc: '2.0', id: 99, result: {} }));
    await expect(client.listTools()).rejects.toThrow('response id 99 is not 1');
  });

  it('surfaces a JSON-RPC error as a thrown error with its code', async () => {
    const { server } = serverWith();
    const client = createToolClient((message) => server.handle(message));
    await expect(client.callTool('missing_tool', {})).rejects.toMatchObject({ code: -32602 });
  });
});

describe('planToolCall', () => {
  const options = { capabilities: capabilities(), controllerVerbs: ['open'] };

  it('routes one request to one tool with its argument', () => {
    const plan = planToolCall('show the hobnob project card', options);
    expect(plan.calls.map((call) => call.name)).toEqual(['projects_card']);
    expect(plan.calls[0].args).toEqual({ project: 'Hobnob' });
    expect(plan.calls[0].runnable).toBe(true);
  });

  it('turns a two-request sentence into two calls in order', () => {
    const plan = planToolCall('open the archive and show the hobnob project card', options);
    expect(plan.calls.map((call) => call.name)).toEqual(['blog_open_archive', 'projects_card']);
  });

  it('marks a call whose argument was never stated as not runnable', () => {
    const plan = planToolCall('show me a project card', options);
    expect(plan.calls[0]?.runnable).toBe(false);
    expect(plan.calls[0]?.reason).toBe('args');
  });

  it('declines a request no capability serves', () => {
    const plan = planToolCall('zzz qqq', options);
    expect(plan.calls).toHaveLength(0);
    expect(plan.declined).toBe('unmapped-clause');
    expect(plan.failed).toBe('zzz qqq');
  });
});

function serverWith(run?: (id: string, args: Record<string, unknown>) => Promise<unknown>) {
  const spy = vi.fn(run ?? (async (id: string) => ({ id, ok: true })));
  const instance = createToolServer({
    name: 'boaz-test',
    version: '0.0.0',
    capabilities: capabilities(),
    run: spy,
  });
  return { server: instance, run: spy };
}
