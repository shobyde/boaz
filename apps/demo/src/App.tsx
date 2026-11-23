import { useCallback, useEffect, useMemo, useState } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import manifest from 'client-agent:manifest';
import { createLexicalEngine, type ManifestCapability } from 'client-agent/core';
import { createWebLLMEngine, isWebGPUAvailable } from 'client-agent/webllm';
import { AgentProvider } from 'client-agent/react';
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

export function App() {
  const store = useDemo();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'lexical' | 'local'>('lexical');
  const [progress, setProgress] = useState<{ progress: number; text: string } | null>(null);
  const [engineNote, setEngineNote] = useState<string | null>(null);
  const [canUseLocalModel] = useState(() => isWebGPUAvailable());

  const engine = useMemo(() => {
    if (mode === 'lexical') {
      return createLexicalEngine({ capabilities });
    }
    // The bundler recognises this exact shape and compiles a worker chunk.
    const worker = new Worker(new URL('./agent.worker.ts', import.meta.url), { type: 'module' });
    return createWebLLMEngine({
      tier: 'compact',
      worker,
      onProgress: setProgress,
      onStateChange: (state) => {
        if (state === 'error') {
          setEngineNote('The on-device model failed to load, so keyword search is still answering.');
          setMode('lexical');
        }
      },
    });
  }, [mode]);

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
        engineLabel={mode === 'local' ? 'On-device · WebGPU' : 'Keyword search · no download'}
        usingLocalModel={mode === 'local'}
        canUseLocalModel={canUseLocalModel}
        onToggleEngine={() => {
          if (mode === 'local') {
            setMode('lexical');
            setEngineNote(null);
            return;
          }
          if (!canUseLocalModel) {
            setEngineNote('This browser does not expose WebGPU, so keyword search is the only engine here.');
            return;
          }
          setEngineNote('Downloading a ~1.2 GB quantized model. It is cached after the first load.');
          setMode('local');
        }}
        progress={progress}
        engineNote={engineNote}
        capabilityCount={capabilities.length}
        capabilities={capabilities}
      />
    </AgentProvider>
  );
}
