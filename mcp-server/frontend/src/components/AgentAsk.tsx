import { useEffect, useState } from 'react';
import { KeyRound, MessageCircleQuestion } from 'lucide-react';
import { Button } from './Button';
import type { AgentAsk } from '../types';
import { runWindows, shownInPlace } from '../agent-asks';

// A question an agent asks while it works (mcp-server/lib/asks.js): values a test needs and
// nobody gave. Answered here, never in the agent's conversation: a secret field is kept in the
// project's secrets and the agent only gets its reference ({{secret.NAME}}).

async function post(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}


/** The form of one question: its reason, its fields, Send or Don't give. */
export function AgentAskForm({ ask, onSettled, docked = false }: { ask: AgentAsk; onSettled?: (answered: boolean) => void; docked?: boolean }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setValues({}); setError(null); }, [ask.id]);
  useEffect(() => {
    if (docked) return undefined;
    shownInPlace.add(ask.id);
    return () => { shownInPlace.delete(ask.id); };
  }, [ask.id, docked]);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await post(`/api/asks/${ask.id}/answer`, { values });
      onSettled?.(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const decline = async () => {
    setBusy(true);
    try {
      await post(`/api/asks/${ask.id}/cancel`);
      onSettled?.(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const secrets = ask.fields.filter((f) => f.secret).length;

  return (
    <form className="agent-ask" onSubmit={send}>
      <div className="agent-ask__head">
        <MessageCircleQuestion size={18} />
        <div>
          <strong>The agent needs{ask.project_name ? ` (${ask.project_name})` : ''}</strong>
          <p>{ask.why}</p>
        </div>
      </div>
      {ask.fields.map((field, index) => (
        <label key={field.name} className="field">
          <span className="field__label">
            {field.secret && <KeyRound size={12} />} {field.label}
            {field.secret && <span className="field__optional">secret {`{{secret.${field.name}}}`}</span>}
          </span>
          <input
            type={field.secret ? 'password' : 'text'} autoComplete={field.secret ? 'new-password' : 'off'} spellCheck={false}
            autoFocus={index === 0} value={values[field.name] ?? ''}
            onChange={(e) => { setValues({ ...values, [field.name]: e.target.value }); setError(null); }}
          />
        </label>
      ))}
      {secrets > 0 && (
        <p className="field__hint">
          {secrets === 1 ? 'The secret is' : 'The secrets are'} kept in the project, encrypted: the agent gets {secrets === 1 ? 'its name' : 'their names'}, IziTest types the value.
        </p>
      )}
      {error && <div className="alert alert--error">{error}</div>}
      <div className="form__actions">
        <Button variant="ghost" size="sm" onClick={decline} disabled={busy}>Don't give</Button>
        <Button variant="primary" size="sm" type="submit" disabled={busy}>Send to the agent</Button>
      </div>
    </form>
  );
}

/**
 * The questions no page shows in place: those of an agent the dashboard did not start (Claude
 * Code, say), and those of a dashboard run whose window is not on this page (another tab, or
 * the page reloaded while the agent still works) — unless a run window is open here. On every
 * page, asked again every 3 s.
 */
export function PendingAgentAsks() {
  const [asks, setAsks] = useState<AgentAsk[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  useEffect(() => {
    let stopped = false;
    const read = async () => {
      try {
        const response = await fetch('/api/asks');
        if (!response.ok) return;
        const data = await response.json();
        if (!stopped) setAsks((data.asks as AgentAsk[]).filter((a) => !shownInPlace.has(a.id) && (!a.run_id || runWindows.size === 0)));
      } catch {
        // the server is away: asked again
      }
    };
    read();
    const timer = setInterval(read, 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);

  const ask = asks.find((a) => !hidden.includes(a.id));
  if (!ask) return null;
  return (
    <div className="agent-ask-dock" role="dialog" aria-label="A question from an agent">
      <AgentAskForm ask={ask} docked onSettled={() => setHidden([...hidden, ask.id])} />
    </div>
  );
}
