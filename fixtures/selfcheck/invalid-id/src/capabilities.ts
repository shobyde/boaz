import { defineCapability } from 'boaz/core';

export const weird = defineCapability({
  id: 'Reports.Open!',
  kind: 'link',
  title: 'Reports',
  description: 'Takes the visitor to the reports screen where saved reports can be opened.',
  route: '/reports',
});
