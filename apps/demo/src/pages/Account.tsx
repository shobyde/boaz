import { useRegisterCapability } from '@shobyde/boaz/react';
import { useDemo } from '../store.js';
import { deleteAccount } from '../features/account/capabilities.js';

export function Account() {
  useRegisterCapability(deleteAccount);
  const store = useDemo();

  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Settings</p>
        <h1>Account</h1>
        <p className="lede">Workspace-wide settings. Deleting the workspace removes every invoice immediately.</p>
      </header>

      {store.deleted && (
        <div className="banner danger" role="status">
          Workspace scheduled for deletion. Nothing else in this demo will change — reload to reset.
        </div>
      )}

      <section className="panel">
        <h2>Workspace</h2>
        <div className="form">
          <label>
            Name
            <input type="text" defaultValue="Ledger Studio" disabled />
          </label>
          <label>
            Billing plan
            <input type="text" defaultValue="Scale — annual, renews Sep 2027" disabled />
          </label>
        </div>
      </section>

      <section className="panel danger-zone">
        <div>
          <h2>Delete this workspace</h2>
          <p>
            Permanently removes the workspace, its invoices, and its members. This cannot be undone.
            The assistant will ask you to confirm before doing this.
          </p>
        </div>
        <button
          type="button"
          className="button danger"
          onClick={() => {
            if (window.confirm('Delete the workspace and every invoice?')) store.deleteAccount();
          }}
        >
          Delete workspace
        </button>
      </section>
    </>
  );
}
