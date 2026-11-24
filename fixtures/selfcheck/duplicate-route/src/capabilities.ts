import { defineCapability } from 'boaz/core';

export const billing = defineCapability({
  id: 'billing.navigate',
  kind: 'route',
  title: 'Billing',
  description: 'Takes the visitor to the billing page where plans and cards are managed.',
  route: '/settings/billing',
});

export const invoices = defineCapability({
  id: 'invoices.navigate',
  kind: 'route',
  title: 'Invoices',
  description: 'Takes the visitor to the invoice list so they can download past receipts.',
  route: '/settings/billing/',
});
