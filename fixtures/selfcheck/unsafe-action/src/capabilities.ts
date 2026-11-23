import { defineCapability } from 'client-agent/core';

export const deleteAll = defineCapability({
  id: 'documents.delete_all',
  kind: 'action',
  title: 'Delete every document',
  description: 'Deletes all documents in the workspace and cannot be undone, with no confirmation gate.',
  route: '/documents',
  handler: async () => ({ deleted: 12 }),
});
