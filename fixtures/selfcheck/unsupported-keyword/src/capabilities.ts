import { defineCapability } from 'client-agent/core';

export const invite = defineCapability({
  id: 'team.invite',
  kind: 'action',
  title: 'Invite a teammate',
  description: 'Sends an invitation email so a teammate can join the workspace.',
  route: '/team',
  paramsSchema: {
    type: 'object',
    properties: {
      email: { type: 'string', format: 'email' },
      role: { $ref: '#/$defs/role' },
    },
    required: ['email'],
    additionalProperties: false,
  },
  handler: async () => null,
});
