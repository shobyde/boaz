import { defineCapability } from '@shobyde/boaz/core';

export const openHome = defineCapability({
  id: 'home.navigate',
  kind: 'route',
  title: 'Home dashboard',
  description: 'Takes the visitor back to the dashboard with recent activity and shortcuts.',
  keywords: ['home', 'start', 'dashboard'],
  route: '/',
});
