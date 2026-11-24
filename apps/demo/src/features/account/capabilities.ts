import { defineCapability } from '@shobyde/boaz/core';

export const openAccount = defineCapability({
  id: 'account.navigate',
  kind: 'route',
  title: 'Account settings',
  description:
    'Takes the visitor to account settings where the workspace name, its plan, and the members who can reach it are managed.',
  keywords: ['account', 'workspace', 'settings', 'rename', 'plan details'],
  route: '/settings/account',
});

export const deleteAccount = defineCapability({
  id: 'account.delete',
  kind: 'action',
  title: 'Delete the workspace',
  description:
    'Permanently deletes the workspace and every invoice in it. This cannot be undone, so it always asks the visitor to confirm first.',
  keywords: ['delete', 'destroy', 'remove workspace', 'close account', 'cancel subscription'],
  route: '/settings/account',
  requiresConfirmation: true,
  paramsSchema: {
    type: 'object',
    properties: {
      reason: { type: 'string', maxLength: 120 },
    },
    additionalProperties: false,
  },
  handler: async (_params, ctx) => {
    if (ctx.currentRoute !== '/settings/account') await ctx.navigate('/settings/account');
    ctx.dispatch('account:delete');
    return { deleted: true };
  },
});
