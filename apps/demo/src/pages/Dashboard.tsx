import { Link } from 'react-router-dom';
import { useRegisterCapability } from 'client-agent/react';
import { money, reportMonths, activity, invoices } from '../data.js';
import { openDashboard } from '../features/home/capabilities.js';

export function Dashboard() {
  useRegisterCapability(openDashboard);
  const month = reportMonths[0]!;
  const open = invoices.filter((invoice) => invoice.status === 'open');
  const overdue = invoices.filter((invoice) => invoice.status === 'overdue');

  return (
    <>
      <header className="page-head">
        <p className="eyebrow">November 2026</p>
        <h1>The money, at a glance.</h1>
        <p className="lede">
          Revenue is up 12% on October. Three invoices have slipped past their due date — the
          assistant can pull them up for you.
        </p>
      </header>

      <section className="stats">
        <article className="stat">
          <span className="stat-label">Revenue</span>
          <strong className="stat-value">{money(month.revenue)}</strong>
          <span className="delta up">+12% vs October</span>
        </article>
        <article className="stat">
          <span className="stat-label">Open invoices</span>
          <strong className="stat-value">{open.length}</strong>
          <span className="stat-note">{money(open.reduce((sum, invoice) => sum + invoice.amount, 0))} outstanding</span>
        </article>
        <article className="stat">
          <span className="stat-label">Overdue</span>
          <strong className="stat-value">{overdue.length}</strong>
          <span className="stat-note">{money(overdue.reduce((sum, invoice) => sum + invoice.amount, 0))} past due</span>
        </article>
        <article className="stat">
          <span className="stat-label">Seats</span>
          <strong className="stat-value">4 / 10</strong>
          <span className="stat-note">Scale plan, annual</span>
        </article>
      </section>

      <div className="split">
        <section className="panel">
          <header className="panel-head">
            <h2>Recent activity</h2>
            <span className="muted">Last 7 days</span>
          </header>
          <ul className="activity">
            {activity.map((entry) => (
              <li key={entry.what}>
                <span className="activity-dot" />
                <div>
                  <p>{entry.what}</p>
                  <span className="muted">
                    {entry.who} · {entry.when}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel ask">
          <h2>Ask instead of clicking</h2>
          <p>
            This demo ships an assistant that runs entirely in the tab. It knows the routes and
            actions of this app because they are declared next to the code, not because it read the
            source.
          </p>
          <ul className="ask-list">
            <li>“Show only overdue invoices”</li>
            <li>“How many invoices are still open?”</li>
            <li>“Invite priya@ledger.dev as a member”</li>
          </ul>
          <Link to="/settings/billing" className="button ghost">
            Open billing
          </Link>
        </section>
      </div>
    </>
  );
}
