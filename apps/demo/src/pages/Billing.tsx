import { useRegisterCapability } from 'boaz/react';
import { useDemo, type Filter } from '../store.js';
import { money } from '../data.js';
import { countInvoices, exportInvoices, filterInvoices } from '../features/billing/capabilities.js';

const filters: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'paid', label: 'Paid' },
];

export function Billing() {
  useRegisterCapability([filterInvoices, countInvoices, exportInvoices]);
  const store = useDemo();

  const total = store.visibleInvoices.reduce((sum, invoice) => sum + invoice.amount, 0);

  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Settings</p>
        <h1>Billing &amp; invoices</h1>
        <p className="lede">
          Every invoice this workspace has issued. Filter the table, or download the rows you see.
        </p>
      </header>

      <section className="panel">
        <header className="toolbar">
          <div className="chips" role="group" aria-label="Filter invoices by status">
            {filters.map((filter) => (
              <button
                key={filter.value}
                type="button"
                className={store.filter === filter.value ? 'chip active' : 'chip'}
                aria-pressed={store.filter === filter.value}
                onClick={() => store.setFilter(filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="button"
            onClick={() => {
              store.download('invoices.csv', invoiceCsvFor(store.visibleInvoices));
            }}
          >
            Download CSV
          </button>
        </header>

        <table className="table">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Customer</th>
              <th className="num">Amount</th>
              <th>Status</th>
              <th>Issued</th>
            </tr>
          </thead>
          <tbody>
            {store.visibleInvoices.map((invoice) => (
              <tr key={invoice.id}>
                <td className="mono">{invoice.id}</td>
                <td>{invoice.customer}</td>
                <td className="num">{money(invoice.amount)}</td>
                <td>
                  <span className={`badge ${invoice.status}`}>{invoice.status}</span>
                </td>
                <td className="muted">{invoice.issued}</td>
              </tr>
            ))}
            {store.visibleInvoices.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  No {store.filter} invoices.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <footer className="table-foot">
          <span className="muted">
            {store.visibleInvoices.length} invoice{store.visibleInvoices.length === 1 ? '' : 's'}
          </span>
          <strong>{money(total)}</strong>
        </footer>
      </section>
    </>
  );
}

function invoiceCsvFor(list: Array<{ id: string; customer: string; amount: number; status: string; issued: string }>): string {
  const header = 'id,customer,amount,status,issued';
  return [header, ...list.map((invoice) => [invoice.id, invoice.customer, invoice.amount, invoice.status, invoice.issued].join(','))].join('\n');
}
