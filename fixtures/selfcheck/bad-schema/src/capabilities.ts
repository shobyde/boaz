import { defineCapability } from 'client-agent/core';

export const filter = defineCapability({
  id: 'orders.filter',
  kind: 'action',
  title: 'Filter orders',
  description: 'Filters the orders table by status so the visitor can focus on what shipped.',
  route: '/orders',
  paramsSchema: { type: 'object', properties: { status: 'string' }, required: 'status' },
  handler: async () => null,
});
