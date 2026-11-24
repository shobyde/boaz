import { defineCapability } from 'boaz/core';

export const openReports = defineCapability({
  id: 'reports.navigate',
  kind: 'route',
  title: 'Monthly reports',
  description:
    'Takes the visitor to the reports page with monthly revenue and growth, and a CSV export for accounting.',
  keywords: ['reports', 'revenue', 'monthly', 'growth', 'accounting', 'finance'],
  route: '/reports',
});

export const exportReport = defineCapability({
  id: 'reports.export_csv',
  kind: 'action',
  title: 'Export a monthly report as CSV',
  description:
    'Downloads one month of revenue as a CSV file. Ask which month if the visitor did not name one.',
  keywords: ['export', 'download', 'csv', 'month', 'accounting'],
  route: '/reports',
  paramsSchema: {
    type: 'object',
    properties: {
      month: { type: 'string', enum: ['2026-11', '2026-10', '2026-09'] },
    },
    required: ['month'],
    additionalProperties: false,
  },
  handler: async ({ month }, ctx) => {
    if (ctx.currentRoute !== '/reports') await ctx.navigate('/reports');
    ctx.dispatch('reports:export', { month });
    return { exported: `ledger-${month}.csv` };
  },
});
