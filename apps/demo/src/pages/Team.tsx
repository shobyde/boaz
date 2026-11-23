import { useState } from 'react';
import { useRegisterCapability } from 'client-agent/react';
import { team } from '../data.js';
import { useDemo } from '../store.js';
import { countMembers, inviteTeammate } from '../features/team/capabilities.js';

export function Team() {
  useRegisterCapability([inviteTeammate, countMembers]);
  const store = useDemo();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('Member');

  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Workspace</p>
        <h1>Team &amp; permissions</h1>
        <p className="lede">Four seats in use. Invitations send a one-time link that expires in 72 hours.</p>
      </header>

      <div className="split wide-left">
        <section className="panel">
          <header className="panel-head">
            <h2>Members</h2>
            <span className="muted">{team.length} active</span>
          </header>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Since</th>
              </tr>
            </thead>
            <tbody>
              {team.map((member) => (
                <tr key={member.email}>
                  <td>{member.name}</td>
                  <td className="mono muted">{member.email}</td>
                  <td>{member.role}</td>
                  <td className="muted">{member.since}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {store.invited.length > 0 && (
            <div className="invited">
              <h3>Pending invitations</h3>
              <ul>
                {store.invited.map((invite) => (
                  <li key={invite.email}>
                    <span className="mono">{invite.email}</span>
                    <span className="badge open">{invite.role}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="panel">
          <h2>Invite someone</h2>
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!email.includes('@')) return;
              store.invite(email, role);
              setEmail('');
            }}
          >
            <label>
              Email
              <input
                type="email"
                value={email}
                placeholder="name@company.com"
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label>
              Role
              <select value={role} onChange={(event) => setRole(event.target.value)}>
                <option>Admin</option>
                <option>Member</option>
                <option>Viewer</option>
              </select>
            </label>
            <button type="submit" className="button">
              Send invitation
            </button>
          </form>
          <p className="hint">
            Or ask: <em>“invite priya@ledger.dev as a viewer”</em> — the assistant asks you to
            confirm before sending.
          </p>
        </section>
      </div>
    </>
  );
}
