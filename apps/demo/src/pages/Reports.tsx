import { useRegisterCapability } from '@shobyde/boaz/react';
import { reportMonths, money } from '../data.js';
import { useDemo, invoices } from '../store.js';
import { exportReport } from '../features/reports/capabilities.js';

export function Reports() {
  useRegisterCapability(exportReport);
  const store = useDemo();

  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Finance</p>
        <h1>Monthly reports</h1>
        <p className="lede">Revenue is counted on issue date, not payment date. Exports include the month total only.</p>
      </header>

      <section className="report-grid">
        {reportMonths.map((month) => (
          <article className="panel report" key={month.id}>
            <header>
              <h2>{month.label}</h2>
              <span className={month.growth >= 0 ? 'delta up' : 'delta down'}>
                {month.growth >= 0 ? '+' : ''}
                {Math.round(month.growth * 100)}%
              </span>
            </header>
            <strong className="report-total">{money(month.revenue)}</strong>
            <span className="muted">
              {invoices.filter((invoice) => invoice.issued.startsWith(month.id)).length} invoices issued
            </span>
            <button type="button" className="button ghost" onClick={() => store.exportReport(month.id)}>
              Export CSV
            </button>
          </article>
        ))}
      </section>

      {store.exports.length > 0 && (
        <p className="hint">Downloaded this session: {store.exports.join(', ')}</p>
      )}
    </>
  );
}
