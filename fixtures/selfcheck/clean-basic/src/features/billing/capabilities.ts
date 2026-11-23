import { defineCapability } from 'client-agent/core';

export const openBilling = defineCapability({
  id: 'billing.navigate',
  kind: 'route',
  title: 'Billing & subscription',
  description: 'Takes the visitor to the billing page where they can change plan, update the payment card, or download invoices as PDF.',
  keywords: ['invoice', 'receipt', 'payment', 'plan'],
  route: '/settings/billing',
});

export const filterInvoices = defineCapability({
  id: 'billing.filter_invoices',
  kind: 'action',
  title: 'Filter invoices by status',
  description: 'Filters the invoice table to show only paid, open, or overdue invoices so the visitor can find what still needs paying.',
  keywords: ['filter', 'overdue', 'unpaid'],
  route: '/settings/billing',
  paramsSchema: {
    type: 'object',
    properties: { status: { type: 'string', enum: ['paid', 'open', 'overdue'] } },
    required: ['status'],
    additionalProperties: false,
  },
  handler: async ({ status }, ctx) => {
    ctx.dispatch('billing:setInvoiceFilter', { status });
    return { appliedFilter: status };
  },
});

export const openArchive = defineCapability({
  id: 'blog.open_archive',
  kind: 'action',
  title: 'Open the archive',
  description: 'Opens the archive page with every post, the topic filters, and the publication calendar.',
  keywords: ['archive', 'all posts'],
  route: '/archive',
  handler: async () => ({ opened: '/archive/' }),
});
