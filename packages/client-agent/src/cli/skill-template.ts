export const CLIENT_LLM_SKILL_MD = `---
name: client-llm-capabilities
description: Use when adding or changing a route, modal, filter, or user-facing control in this app. Keeps the in-browser assistant's capability manifest in sync.
---

# Client LLM capabilities

This repository ships an in-browser assistant (\`client-agent\`). It does not read
your source code and it cannot see the DOM. It only knows what the build-time
manifest tells it, and it can only do what a registered handler does. A feature
without a capability declaration is invisible to it.

## When this skill applies

Any time you:

- add a route, page, tab, or deep-linked view;
- add or change a modal, wizard, or multi-step workflow;
- add a filter, sort, bulk action, or form pre-fill;
- rename a user-visible control or change what it does;
- delete a screen or action.

## The rule

Every user-reachable destination gets a \`route\` capability. Every mutating or
stateful control the user might ask for gets an \`action\` capability. Live state
the assistant should be able to read before acting gets a \`query\` capability.

Declare it in a \`capabilities.ts\` next to the feature that owns the behaviour,
not in a central file. Central files rot; co-located ones get updated with the
feature.

\`\`\`ts
import { defineCapability } from 'client-agent/core';

export const openInvoices = defineCapability({
  id: 'billing.open_invoices',
  kind: 'route',
  title: 'Billing & invoices',
  description:
    'Takes the visitor to the billing page where they can change plan, update the payment card, or download past invoices as PDF.',
  keywords: ['invoice', 'receipt', 'payment', 'card', 'subscription', 'plan'],
  route: '/settings/billing',
});

export const filterInvoices = defineCapability({
  id: 'billing.filter_invoices',
  kind: 'action',
  title: 'Filter invoices by status',
  description:
    'Filters the invoice table to show only paid, open, or overdue invoices, so the visitor can find what still needs paying.',
  keywords: ['filter', 'overdue', 'unpaid', 'paid'],
  route: '/settings/billing',
  paramsSchema: {
    type: 'object',
    properties: { status: { type: 'string', enum: ['paid', 'open', 'overdue'] } },
    required: ['status'],
    additionalProperties: false,
  },
  handler: async ({ status }, ctx) => {
    if (ctx.currentRoute !== '/settings/billing') await ctx.navigate('/settings/billing');
    ctx.dispatch('billing:setInvoiceFilter', { status });
    return { appliedFilter: status };
  },
});
\`\`\`

## Writing the metadata

- **id**: \`<area>.<verb_or_noun>\`, lowercase, stable. Never reuse an id for a
  different thing; the assistant's conversation refers to ids.
- **title**: what the visitor would call it, not the component name.
  "Download invoices", not \`InvoiceTableToolbar\`.
- **description**: one sentence that starts from the visitor's goal —
  "Use when the visitor wants to…". This string is the retrieval text: if it
  does not contain the words a visitor would type, the capability is unfindable.
  No component names, no internal jargon, no marketing.
- **keywords**: synonyms and plural forms a visitor might say. Cheap; add them.
- **route**: the path the capability's UI lives on, even for actions. The runtime
  navigates there before running the handler if the handler is not mounted.
- **paramsSchema**: strict JSON Schema, \`additionalProperties: false\`, enums over
  free strings. The runtime validates against it and replays the exact error to
  the model once. Unenforced keywords (\`$ref\`, \`format\`) are reported as CAP005.

## Safety classification

Set \`requiresConfirmation: true\` when the action:

- deletes or archives anything, or clears user data;
- spends money, changes a plan, or starts a subscription;
- sends something to someone else (email, invite, transfer, share);
- is expensive or hard to undo.

Do not set it for navigation, filtering, sorting, opening a dialog, or reading
state. A confirmation on a harmless action trains the visitor to click through
the ones that matter.

## Verification

\`\`\`bash
npx client-agent verify
\`\`\`

Exit code 0 means every declaration parses, ids are unique, schemas are valid,
and every static route found in the router has a matching route capability.
Warnings are quality issues (usually a missing confirmation or a vague
description); errors block the build. \`npx client-agent codes\` explains each one.

Finish a task only when \`verify\` passes. If a new route is intentionally not
reachable by the assistant, say so in the pull request instead of leaving an
unexplained CAP008.
`;
