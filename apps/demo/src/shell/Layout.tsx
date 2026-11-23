import { NavLink, Outlet, useLocation } from 'react-router-dom';

const nav = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/settings/billing', label: 'Billing' },
  { to: '/team', label: 'Team' },
  { to: '/reports', label: 'Reports' },
  { to: '/settings/account', label: 'Account' },
];

export function Layout({ onAsk, assistantOpen }: { onAsk: () => void; assistantOpen: boolean }) {
  const location = useLocation();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">L</span>
          <span>
            Ledger<em>demo</em>
          </span>
        </div>
        <nav className="nav">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="avatar">MO</span>
          <span>
            Mara Okafor
            <em>Scale plan</em>
          </span>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <span className="muted mono">ledger.dev / {location.pathname === '/' ? 'dashboard' : location.pathname.replace('/settings/', '')}</span>
          <button type="button" className={assistantOpen ? 'button small active' : 'button small'} onClick={onAsk}>
            {assistantOpen ? 'Close assistant' : 'Ask the assistant'}
          </button>
        </div>
        <div className="page">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
