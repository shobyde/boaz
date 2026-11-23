import { defineCapability } from 'client-agent/core';
import { ROUTES } from './routes';

export const open = defineCapability({
  id: 'reports.open',
  kind: 'route',
  title: 'Reports',
  description: 'Takes the visitor to the reports screen where saved reports can be opened.',
  route: ROUTES.reports,
});
