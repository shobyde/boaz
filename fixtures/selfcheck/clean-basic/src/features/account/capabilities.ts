import { defineCapability } from 'client-agent/core';

export const openAccount = defineCapability({
  id: 'account.navigate',
  kind: 'route',
  title: 'Account settings',
  description: 'Takes the visitor to account settings where they can change their name, email, and password.',
  keywords: ['profile', 'email', 'password', 'login'],
  route: '/settings/account',
});

export const deleteAccount = defineCapability({
  id: 'account.delete',
  kind: 'action',
  title: 'Delete the account',
  description: 'Permanently deletes the account and every stored document after the visitor confirms.',
  route: '/settings/account',
  requiresConfirmation: true,
  paramsSchema: { type: 'object', properties: { reason: { type: 'string', maxLength: 200 } }, additionalProperties: false },
  handler: async () => ({ deleted: true }),
});
