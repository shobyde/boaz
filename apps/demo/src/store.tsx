import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { invoices, invoiceCsv, type Invoice, type InvoiceStatus } from './data.js';

export type Filter = 'all' | InvoiceStatus;

interface DemoState {
  filter: Filter;
  invited: Array<{ email: string; role: string }>;
  deleted: boolean;
  exports: string[];
}

interface DemoStore extends DemoState {
  invoices: Invoice[];
  visibleInvoices: Invoice[];
  setFilter: (filter: Filter) => void;
  invite: (email: string, role: string) => void;
  deleteAccount: () => void;
  exportReport: (month: string) => string;
  download: (filename: string, contents: string) => void;
}

const DemoContext = createContext<DemoStore | null>(null);

export function useDemo(): DemoStore {
  const store = useContext(DemoContext);
  if (!store) throw new Error('useDemo must be used inside <DemoProvider>');
  return store;
}

function triggerDownload(filename: string, contents: string) {
  const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * The same state the UI renders and the same functions the capabilities call.
 * The assistant never reaches into React; it emits the same events a button does.
 */
export function DemoProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DemoState>({
    filter: 'all',
    invited: [],
    deleted: false,
    exports: [],
  });

  const setFilter = useCallback((filter: Filter) => {
    setState((previous) => ({ ...previous, filter }));
  }, []);

  const invite = useCallback((email: string, role: string) => {
    setState((previous) => ({
      ...previous,
      invited: [
        ...previous.invited.filter((entry) => entry.email !== email),
        { email, role },
      ],
    }));
  }, []);

  const deleteAccount = useCallback(() => {
    setState((previous) => ({ ...previous, deleted: true }));
  }, []);

  const exportReport = useCallback((month: string) => {
    const contents = `month,revenue\n${month},${reportRevenue(month)}`;
    const filename = `ledger-${month}.csv`;
    triggerDownload(filename, contents);
    setState((previous) => ({ ...previous, exports: [...previous.exports, filename] }));
    return filename;
  }, []);

  const download = useCallback((filename: string, contents: string) => {
    triggerDownload(filename, contents);
  }, []);

  const value = useMemo<DemoStore>(() => {
    const visibleInvoices =
      state.filter === 'all' ? invoices : invoices.filter((invoice) => invoice.status === state.filter);
    return {
      ...state,
      invoices,
      visibleInvoices,
      setFilter,
      invite,
      deleteAccount,
      exportReport,
      download,
    };
  }, [state, setFilter, invite, deleteAccount, exportReport, download]);

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

function reportRevenue(month: string): number {
  if (month.startsWith('2026-11')) return 48210;
  if (month.startsWith('2026-10')) return 43980;
  return 41260;
}

export { invoices, invoiceCsv };
