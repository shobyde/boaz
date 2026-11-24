import { defineCapability } from '@shobyde/boaz/core';

export const openTeam = defineCapability({
  id: 'team.navigate',
  kind: 'route',
  title: 'Team & permissions',
  description:
    'Takes the visitor to the team page where they can see every member, their role, and invite new people to the workspace.',
  keywords: ['team', 'members', 'people', 'colleagues', 'permissions', 'seats'],
  route: '/team',
});

export const inviteTeammate = defineCapability({
  id: 'team.invite',
  kind: 'action',
  title: 'Invite a teammate',
  description:
    'Sends an invitation email so a new person can join the workspace with the chosen role. Ask for the email address and role first if the visitor did not say them.',
  keywords: ['invite', 'add person', 'send email', 'new member', 'recruit'],
  route: '/team',
  requiresConfirmation: true,
  paramsSchema: {
    type: 'object',
    properties: {
      email: { type: 'string', pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
      role: { type: 'string', enum: ['Admin', 'Member', 'Viewer'] },
    },
    required: ['email', 'role'],
    additionalProperties: false,
  },
  handler: async ({ email, role }, ctx) => {
    if (ctx.currentRoute !== '/team') await ctx.navigate('/team');
    ctx.dispatch('team:invite', { email, role });
    return { invited: email, role };
  },
});

export const countMembers = defineCapability({
  id: 'team.count_members',
  kind: 'query',
  title: 'Count team members',
  description:
    'Reads how many people are in the workspace and how many invitations are still pending.',
  keywords: ['how many people', 'headcount', 'seats used', 'members count'],
  route: '/team',
  paramsSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_params, ctx) => ({
    members: ctx.read<number>('memberCount') ?? 0,
    pendingInvites: ctx.read<number>('invitedTeammates') ?? 0,
  }),
});
