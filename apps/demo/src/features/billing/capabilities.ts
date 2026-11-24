import { defineCapability } from '@shobyde/boaz/core';

export const openBilling = defineCapability({
  id: 'billing.navigate',
  kind: 'route',
  title: 'Billing & invoices',
  description:
    'Takes the visitor to the billing page where they can read every invoice, filter the table by payment status, and download the list as a CSV file.',
  keywords: ['invoice', 'receipt', 'payment', 'bill', 'statement', 'amount', 'overdue', 'unpaid'],
  route: '/settings/billing',
});

export const filterInvoices = defineCapability({
  id: 'billing.filter_invoices',
  kind: 'action',
  title: 'Filter invoices by status',
  description:
    'Filters the invoice table down to paid, open, or overdue invoices, so the visitor can see just the ones that still need paying.',
  keywords: ['filter', 'show only', 'unpaid', 'overdue', 'paid', 'narrow'],
  route: '/settings/billing',
  paramsSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['paid', 'open', 'overdue'] },
    },
    required: ['status'],
    additionalProperties: false,
  },
  handler: async ({ status }, ctx) => {
    if (ctx.currentRoute !== '/settings/billing') {
      await ctx.navigate('/settings/billing');
    }
    ctx.dispatch('invoices:filter', { status });
    return { appliedFilter: status };
  },
});

export const countInvoices = defineCapability({
  id: 'billing.count_invoices',
  kind: 'query',
  title: 'Count invoices by status',
  description:
    'Reads how many invoices are open or overdue right now, for when the visitor asks how much is unpaid.',
  keywords: ['how many', 'count', 'outstanding', 'owed', 'unpaid total'],
  route: '/settings/billing',
  paramsSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler: async (_params, ctx) => ({
    open: ctx.read<number>('openInvoices') ?? 0,
    overdue: ctx.read<number>('overdueInvoices') ?? 0,
    visible: ctx.read<number>('visibleInvoices') ?? 0,
  }),
});

export const exportInvoices = defineCapability({
  id: 'billing.export_csv',
  kind: 'action',
  title: 'Download invoices as CSV',
  description:
    'Downloads the invoices currently shown in the table as a CSV file the visitor can open in a spreadsheet.',
  keywords: ['download', 'export', 'csv', 'spreadsheet', 'save list'],
  route: '/settings/billing',
  handler: async (_params, ctx) => {
    ctx.dispatch('invoices:export_csv');
    return { exported: ctx.read<number>('visibleInvoices') ?? 0 };
  },
});
