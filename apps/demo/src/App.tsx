import { useCallback, useEffect, useMemo, useState } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import manifest from 'boaz:manifest';
import { type ManifestCapability } from 'boaz/core';
import { KnowledgeBase, createRulesEngine, fact } from 'boaz/rules';
import { AgentProvider } from 'boaz/react';
import { Layout } from './shell/Layout.js';
import { Assistant } from './shell/Assistant.js';
import { Dashboard } from './pages/Dashboard.js';
import { Billing } from './pages/Billing.js';
import { Team } from './pages/Team.js';
import { Reports } from './pages/Reports.js';
import { Account } from './pages/Account.js';
import { useDemo, invoiceCsv } from './store.js';
import { invoices, team } from './data.js';

const capabilities = manifest.capabilities as ManifestCapability[];

// The demo's knowledge base: invoice rows plus one rule, so a question about a
// status is answered from data instead of a paragraph of prose.
const knowledge = new KnowledgeBase({
  facts: invoices.map((invoice) =>
    fact('invoice', invoice.id, invoice.customer, invoice.status, String(invoice.amount)),
  ),
  rules: ['invoices_with(?I, ?C, ?S, ?A) :- invoice(?I, ?C, ?S, ?A), asked(?S).'],
});

const answers = [
  {
    id: 'invoices.by_status',
    title: 'Which invoices have a status',
    keywords: ['overdue invoices', 'unpaid', 'paid invoices', 'open invoices', 'which invoices'],
    goal: 'invoices_with(?I, ?C, ?S, ?A)',
    compose: ({ solutions }: { solutions: { bindings: Record<string, string> }[] }) => {
      if (solutions.length === 0) return '';
      const rows = solutions.map(
        (solution) =>
          `${solution.bindings['?I']} (${solution.bindings['?C']}, $${Number(solution.bindings['?A']).toLocaleString('en-US')})`,
      );
      return `${rows.length} invoice${rows.length === 1 ? '' : 's'}: ${rows.join(', ')}.`;
    },
  },
];

export function App() {
  const store = useDemo();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const engine = useMemo(() => createRulesEngine({ knowledge, answers, capabilities }), []);

  const getSnapshot = useCallback(
    () => ({
      currentRoute: location.pathname,
      state: {
        invoiceFilter: store.filter,
        visibleInvoices: store.visibleInvoices.length,
        openInvoices: invoices.filter((invoice) => invoice.status === 'open').length,
        overdueInvoices: invoices.filter((invoice) => invoice.status === 'overdue').length,
        memberCount: team.length,
        invitedTeammates: store.invited.length,
        workspaceDeleted: store.deleted,
      },
    }),
    [location.pathname, store],
  );

  const dispatch = useCallback(
    (event: string, payload?: unknown) => {
      const data = (payload ?? {}) as Record<string, string>;
      switch (event) {
        case 'invoices:filter':
          store.setFilter(data.status as 'paid' | 'open' | 'overdue');
          break;
        case 'invoices:export_csv':
          store.download('invoices.csv', invoiceCsv(store.visibleInvoices));
          break;
        case 'team:invite':
          store.invite(data.email ?? '', data.role ?? 'Member');
          break;
        case 'reports:export':
          store.exportReport(data.month ?? '2026-11');
          break;
        case 'account:delete':
          store.deleteAccount();
          break;
        default:
          console.warn('[demo] unhandled assistant dispatch', event, payload);
      }
    },
    [store],
  );

  const goTo = useCallback((route: string) => navigate(route), [navigate]);

  // Dock the assistant on wide screens instead of covering the page.
  useEffect(() => {
    document.body.dataset.assistant = open ? 'open' : '';
    return () => {
      document.body.dataset.assistant = '';
    };
  }, [open]);

  return (
    <AgentProvider
      engine={engine}
      capabilities={capabilities}
      getSnapshot={getSnapshot}
      navigate={goTo}
      dispatch={dispatch}
      topK={8}
      maxToolCalls={3}
    >
      <Routes>
        <Route element={<Layout onAsk={() => setOpen((value) => !value)} assistantOpen={open} />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/settings/billing" element={<Billing />} />
          <Route path="/team" element={<Team />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/settings/account" element={<Account />} />
        </Route>
      </Routes>
      <Assistant
        open={open}
        onClose={() => setOpen((value) => !value)}
        engineLabel="Rules + keyword search · no download"
        capabilityCount={capabilities.length}
        capabilities={capabilities}
      />
    </AgentProvider>
  );
}
