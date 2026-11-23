import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAgentChat } from 'client-agent/react';
import type { ManifestCapability, TurnStep } from 'client-agent/core';

export interface AssistantProps {
  open: boolean;
  onClose: () => void;
  engineLabel: string;
  capabilityCount: number;
  capabilities: ManifestCapability[];
}

const suggestions: Record<string, string[]> = {
  '/': ['Show me the overdue invoices', 'How many invoices are open?', 'Invite priya@ledger.dev as a member'],
  '/settings/billing': ['Show only overdue invoices', 'How many invoices are open?', 'Download the invoice list as CSV'],
  '/team': ['Invite priya@ledger.dev as a viewer', 'How many seats are in use?'],
  '/reports': ['Export October 2026 as CSV', 'Take me to billing'],
  '/settings/account': ['Delete this workspace', 'Take me to the reports page'],
};

function trace(step: TurnStep): string | null {
  switch (step.type) {
    case 'navigate':
      return `→ ${step.route}`;
    case 'action':
      return `✓ ${step.capabilityId} ${JSON.stringify(step.args)}`;
    case 'query':
      return `◦ ${step.capabilityId} → ${JSON.stringify(step.result)}`;
    case 'inference':
      return `∴ ${step.rule ?? step.goal}`;
    case 'confirmation':
      return step.approved ? '✓ you confirmed' : '✕ you cancelled';
    case 'validation-error':
      return `↻ schema rejected: ${step.errors[0] ?? 'invalid arguments'}`;
    case 'error':
      return `✕ ${step.message}`;
    default:
      return null;
  }
}

export function Assistant(props: AssistantProps) {
  const { messages, send, status, pendingConfirmation, approve, reject } = useAgentChat();
  const [draft, setDraft] = useState('');
  const location = useLocation();
  const scroller = useRef<HTMLDivElement | null>(null);

  const chips = useMemo(() => suggestions[location.pathname] ?? suggestions['/']!, [location.pathname]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages, status, pendingConfirmation]);

  if (!props.open) {
    return (
      <button type="button" className="launcher" onClick={props.onClose} aria-label="Open the assistant">
        <span aria-hidden>✦</span> Ask
      </button>
    );
  }

  const submit = () => {
    const text = draft.trim();
    if (!text || status === 'thinking') return;
    setDraft('');
    void send(text);
  };

  return (
    <aside className="assistant" aria-label="Assistant">
      <header className="assistant-head">
        <div>
          <h2>Ledger assistant</h2>
          <p className="muted">
            {props.engineLabel} · {props.capabilityCount} capabilities
          </p>
        </div>
        <button type="button" className="icon-button" onClick={props.onClose} aria-label="Close the assistant">
          ✕
        </button>
      </header>

      <div className="messages" ref={scroller}>
        {messages.length === 0 && (
          <div className="empty-state">
            <p>
              I can explain a screen, take you to one, or change what is on it. Everything I know
              comes from the capability manifest:
            </p>
            <ul className="declared">
              {props.capabilities
                .filter((capability) => capability.kind === 'route')
                .map((capability) => (
                  <li key={capability.id}>
                    <span className="mono">{capability.route}</span>
                    <span>{capability.title}</span>
                  </li>
                ))}
            </ul>
            <p className="declared-note">
              Plus{' '}
              {props.capabilities.filter((capability) => capability.kind === 'action').length} actions
              and{' '}
              {props.capabilities.filter((capability) => capability.kind === 'query').length} read-only
              queries.
            </p>
          </div>
        )}
        {messages.map((message) => {
          const steps = (message.steps ?? []).map(trace).filter((line): line is string => Boolean(line));
          return (
            <div key={message.id} className={`bubble from-${message.role}`}>
              <p>{message.content}</p>
              {steps.length > 0 && (
                <ul className="trace">
                  {steps.map((line, index) => (
                    <li key={`${message.id}-${index}`}>{line}</li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        {status === 'thinking' && !pendingConfirmation && (
          <div className="bubble from-assistant pending">
            <span className="dots">
              <i />
              <i />
              <i />
            </span>
          </div>
        )}
      </div>

      {pendingConfirmation && (
        <div className="confirm" role="alertdialog" aria-label="Confirm action">
          <h3>{pendingConfirmation.title}</h3>
          <p>{pendingConfirmation.description}</p>
          {Object.keys(pendingConfirmation.args).length > 0 ? (
            <pre>{JSON.stringify(pendingConfirmation.args, null, 2)}</pre>
          ) : (
            <p className="no-args">No arguments — this is the whole action.</p>
          )}
          <div className="confirm-actions">
            <button type="button" className="button danger" onClick={approve}>
              Confirm
            </button>
            <button type="button" className="button ghost" onClick={reject}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="composer">
        {messages.length === 0 && (
          <div className="chips wrap">
            {chips.map((chip) => (
              <button
                key={chip}
                type="button"
                className="chip"
                onClick={() => {
                  setDraft('');
                  void send(chip);
                }}
              >
                {chip}
              </button>
            ))}
          </div>
        )}
        <div className="composer-row">
          <textarea
            value={draft}
            rows={1}
            placeholder="Ask for a screen or an action…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <button type="button" className="button" onClick={submit} disabled={status === 'thinking'}>
            Send
          </button>
        </div>
        <p className="fineprint">
          Nothing leaves this tab: capabilities come from <span className="mono">agent-manifest.json</span>,
          and the lexical mode needs no download at all.
        </p>
      </div>
    </aside>
  );
}
