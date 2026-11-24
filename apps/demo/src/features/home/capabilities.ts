import { defineCapability } from 'boaz/core';

export const openDashboard = defineCapability({
  id: 'home.navigate',
  kind: 'route',
  title: 'Dashboard',
  description:
    'Takes the visitor back to the dashboard with this month revenue, open invoices, and recent activity.',
  keywords: ['home', 'dashboard', 'overview', 'start', 'main page'],
  route: '/',
});
