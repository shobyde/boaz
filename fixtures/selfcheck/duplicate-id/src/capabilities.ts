import { defineCapability } from '@shobyde/boaz/core';

export const a = defineCapability({
  id: 'billing.navigate',
  kind: 'route',
  title: 'Billing',
  description: 'Takes the visitor to the billing page where plans and cards are managed.',
  route: '/settings/billing',
});

export const b = defineCapability({
  id: 'billing.navigate',
  kind: 'route',
  title: 'Billing again',
  description: 'A second declaration with the same identifier, which cannot both register.',
  route: '/settings/billing',
});
