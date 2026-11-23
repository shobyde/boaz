import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/core/loop.js';
import { CapabilityRegistry } from '../src/core/registry.js';
import { defineCapability } from '../src/core/define.js';
import type { AgentEngine, EngineRequest, ManifestCapability } from '../src/core/types.js';

function scriptedEngine(outputs: string[], onRequest?: (request: EngineRequest) => void): AgentEngine {
  let index = 0;
  return {
    id: 'scripted',
    async complete(request) {
      onRequest?.(request);
      const output = outputs[Math.min(index, outputs.length - 1)] ?? '';
      index += 1;
      return { text: output };
    },
  };
}

function tool(id: string, args: Record<string, unknown> = {}): string {
  return ['```json', JSON.stringify({ tool: id, arguments: args }), '```'].join('\n');
}

const billingRoute: ManifestCapability = {
  id: 'billing.navigate',
  kind: 'route',
  title: 'Billing',
  description: 'Takes the visitor to the billing page where cards, plans and invoices live.',
  keywords: ['invoice', 'payment'],
  route: '/settings/billing',
};

const filterInvoices: ManifestCapability = {
  id: 'billing.filter_invoices',
  kind: 'action',
  title: 'Filter invoices by status',
  description: 'Filters the invoice table to show paid, open or overdue invoices.',
  route: '/settings/billing',
  paramsSchema: {
    type: 'object',
    properties: { status: { type: 'string', enum: ['paid', 'open', 'overdue'] } },
    required: ['status'],
    additionalProperties: false,
  },
};

const deleteAccount: ManifestCapability = {
  id: 'account.delete',
  kind: 'action',
  title: 'Delete account',
  description: 'Permanently deletes the account and every stored document.',
  requiresConfirmation: true,
  paramsSchema: { type: 'object', properties: {}, additionalProperties: false },
};

function setup(options: {
  capabilities: ManifestCapability[];
  outputs: string[];
  route?: string;
  confirm?: (request: { capabilityId: string }) => Promise<boolean>;
  registry?: CapabilityRegistry;
  maxToolCalls?: number;
  onRequest?: (request: EngineRequest) => void;
}) {
  const registry = options.registry ?? new CapabilityRegistry();
  let route = options.route ?? '/';
  const navigated: string[] = [];
  const runtime = new AgentRuntime({
    engine: scriptedEngine(options.outputs, options.onRequest),
    capabilities: options.capabilities,
    registry,
    getSnapshot: () => ({ currentRoute: route, state: { plan: 'pro' } }),
    navigate: (to) => {
      navigated.push(to);
      route = to;
    },
    dispatch: () => undefined,
    ...(options.confirm ? { confirm: options.confirm } : {}),
    ...(options.maxToolCalls ? { maxToolCalls: options.maxToolCalls } : {}),
  });
  return { runtime, registry, navigated, routeNow: () => route };
}

describe('AgentRuntime', () => {
  it('hands tool results to the engine as structured observations', async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const handler = vi.fn(async () => ({ posts: 58, newest: 'A post' }));
    const registry = new CapabilityRegistry();
    registry.register(
      defineCapability({
        id: 'blog.stats',
        kind: 'query',
        title: 'Log statistics',
        description: 'Reads how many posts are published and which is newest.',
        paramsSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler,
      }),
    );
    const runtime = new AgentRuntime({
      engine: {
        id: 'observing',
        async complete(request) {
          seen.push(request.observations);
          if (!request.observations?.['blog.stats']) return { text: tool('blog.stats') };
          return { text: `saw ${JSON.stringify(request.observations['blog.stats'])}` };
        },
      },
      capabilities: [
        {
          id: 'blog.stats',
          kind: 'query',
          title: 'Log statistics',
          description: 'Reads how many posts are published and which is newest.',
        },
      ],
      registry,
      getSnapshot: () => ({ currentRoute: '/' }),
      dispatch: () => undefined,
    });
    const result = await runtime.send('how many posts?');
    expect(result.text).toContain('"posts":58');
    expect(seen.at(-1)?.['blog.stats']).toEqual({ posts: 58, newest: 'A post' });
  });

  it('navigates to a route capability and reports the destination', async () => {
    const { runtime, navigated } = setup({
      capabilities: [billingRoute],
      outputs: [tool('billing.navigate'), "You're on the billing page. I can filter invoices if you like."],
    });
    const result = await runtime.send('take me to billing');

    expect(navigated).toEqual(['/settings/billing']);
    expect(result.steps[0]).toMatchObject({ type: 'navigate', route: '/settings/billing' });
    expect(result.text).toContain('filter invoices');
    expect(result.stoppedBy).toBe('final');
  });

  it('replays the exact schema error and runs the corrected call', async () => {
    const handler = vi.fn(async ({ status }: { status: string }) => ({ appliedFilter: status }));
    const registry = new CapabilityRegistry();
    registry.register(defineCapability({ ...filterInvoices, handler }));

    const { runtime } = setup({
      capabilities: [filterInvoices],
      registry,
      route: '/settings/billing',
      outputs: [tool('billing.filter_invoices', { status: 'unpaid' }), tool('billing.filter_invoices', { status: 'open' }), 'Filtered to open invoices.'],
    });

    const result = await runtime.send('show only open invoices');

    const validation = result.steps.find((step) => step.type === 'validation-error');
    expect(validation).toMatchObject({ type: 'validation-error', capabilityId: 'billing.filter_invoices' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toEqual({ status: 'open' });
    expect(result.text).toBe('Filtered to open invoices.');
  });

  it('does not run a side effect the user rejects', async () => {
    const handler = vi.fn(async () => ({ deleted: true }));
    const registry = new CapabilityRegistry();
    registry.register(defineCapability({ ...deleteAccount, handler }));
    const confirm = vi.fn(async () => false);

    const { runtime } = setup({
      capabilities: [deleteAccount],
      registry,
      confirm,
      outputs: [tool('account.delete')],
    });

    const result = await runtime.send('delete my account');

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    expect(result.text).toContain('Cancelled');
    expect(result.steps.some((step) => step.type === 'confirmation' && step.approved === false)).toBe(true);
  });

  it('navigates, waits for the handler to register, then runs it', async () => {
    const handler = vi.fn(async ({ status }: { status: string }) => ({ appliedFilter: status }));
    const registry = new CapabilityRegistry();

    const { runtime } = setup({
      capabilities: [filterInvoices],
      registry,
      outputs: [tool('billing.filter_invoices', { status: 'overdue' }), 'Filtered to overdue.'],
    });

    // Simulate the route module mounting 20ms after navigation.
    setTimeout(() => registry.register(defineCapability({ ...filterInvoices, handler })), 20);

    const result = await runtime.send('show overdue invoices');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.steps.some((step) => step.type === 'action')).toBe(true);
  });

  it('hands a declarative surface to the host instead of executing it', async () => {
    const registry = new CapabilityRegistry();
    const surface = [
      {
        version: '1.0',
        createSurface: {
          surfaceId: 'project',
          catalogId: 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json',
          components: [{ id: 'root', component: 'Column', children: ['t'] }, { id: 't', component: 'Text', text: 'Hobnob' }],
        },
      },
    ];
    registry.register(
      defineCapability({
        id: 'projects.card',
        kind: 'action',
        title: 'Show a project card',
        description: 'Shows a card for one project with its summary and links.',
        handler: async () => ({ surface }),
      }),
    );

    const { runtime } = setup({
      capabilities: [
        {
          id: 'projects.card',
          kind: 'action',
          title: 'Show a project card',
          description: 'Shows a card for one project with its summary and links.',
        },
      ],
      registry,
      route: '#projects',
      outputs: [tool('projects.card'), 'Here is the card.'],
    });

    const result = await runtime.send('tell me about hobnob');
    const step = result.steps.find((entry) => entry.type === 'surface');
    expect(step).toMatchObject({ type: 'surface', capabilityId: 'projects.card' });
    if (step?.type === 'surface') expect(step.messages).toEqual(surface);
    expect(result.text).toBe('Here is the card.');
  });

  it('caps sequential tool calls instead of looping', async () => {
    const registry = new CapabilityRegistry();
    registry.register(
      defineCapability({
        id: 'cart.count',
        kind: 'query',
        title: 'Cart item count',
        description: 'Reads how many items are in the cart right now.',
        handler: async () => ({ count: 2 }),
      }),
    );

    const { runtime } = setup({
      capabilities: [
        {
          id: 'cart.count',
          kind: 'query',
          title: 'Cart item count',
          description: 'Reads how many items are in the cart right now.',
        },
      ],
      registry,
      outputs: [tool('cart.count')],
      maxToolCalls: 3,
    });

    const result = await runtime.send('how many items are in my cart?');

    expect(result.stoppedBy).toBe('max-tool-calls');
    expect(result.steps.filter((step) => step.type === 'query')).toHaveLength(3);
  });

  it('rejects an invented capability id and lets the model recover', async () => {
    const seen: string[] = [];
    const { runtime } = setup({
      capabilities: [billingRoute],
      outputs: [tool('billing.teleport'), 'I can only open the billing page.'],
      onRequest: (request) => {
        for (const message of request.messages) seen.push(message.content);
      },
    });

    const result = await runtime.send('teleport me to billing');

    // The invented id is fed back to the model rather than surfaced as an
    // error: it is recoverable, and the visitor should not see the mistake.
    expect(seen.some((content) => content.includes('is not a capability id'))).toBe(true);
    expect(result.text).toBe('I can only open the billing page.');
    expect(result.steps.some((step) => step.type === 'navigate')).toBe(false);
  });

  it('asks for a corrected reply when the JSON is malformed', async () => {
    const { runtime } = setup({
      capabilities: [billingRoute],
      outputs: ['```json\n{"tool": "billing.navigate"\n```', 'I need to retry that.'],
      route: '/',
    });

    const result = await runtime.send('billing');

    expect(result.steps.some((step) => step.type === 'validation-error' || step.type === 'error')).toBe(false);
    expect(result.text).toBe('I need to retry that.');
  });

  it('includes the current route and retrieved capabilities in the system prompt', async () => {
    let system = '';
    const { runtime } = setup({
      capabilities: [billingRoute, filterInvoices, deleteAccount],
      outputs: ['Nothing to do.'],
      route: '/settings/billing',
      onRequest: (request) => {
        system = request.messages.find((message) => message.role === 'system')?.content ?? '';
      },
    });

    await runtime.send('show only overdue invoices');

    expect(system).toContain('Current route: /settings/billing');
    expect(system).toContain('billing.navigate');
    expect(system).toContain('billing.filter_invoices');
    expect(system).not.toContain('account.delete');
  });

  it('keeps conversation turns across sends', async () => {
    const requests: number[] = [];
    const { runtime } = setup({
      capabilities: [billingRoute],
      outputs: ['Hello.'],
      onRequest: (request) => requests.push(request.messages.length),
    });

    await runtime.send('hi');
    await runtime.send('again');

    expect(requests[0]).toBe(2); // system + user
    expect(requests[1]).toBe(4); // system + user + assistant + user
  });
});
