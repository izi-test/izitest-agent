import { useState } from 'react';
import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useAppDispatch } from '../store/hooks';
import { showToast } from '../store/slices/uiSlice';
import { useDeleteSecretMutation, useGetSecretsQuery, useSaveSecretMutation } from '../store/services/projectsApi';
import { Button } from './Button';
import { Pill } from './ui';
import { relativeTime } from '../format';

// The secrets of a project (mcp-server/lib/secrets.js): a password, an API key a test types.
// Written {{secret.NAME}} in a step; IziTest types the value, which nobody reads back — not the
// AI agent, not this page: once saved, a value can be replaced, never shown.

const errorOf = (err: unknown) => (err as { data?: { error?: string } })?.data?.error ?? 'The request failed';
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Editing = { name: string; isNew: boolean; description: string };

export function ProjectSecrets({ projectId }: { projectId: number }) {
  const dispatch = useAppDispatch();
  const { data: secrets = [], isLoading } = useGetSecretsQuery(projectId);
  const [saveSecret, { isLoading: saving }] = useSaveSecretMutation();
  const [deleteSecret] = useDeleteSecretMutation();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const open = (next: Editing | null) => { setEditing(next); setValue(''); setError(null); };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const name = editing.name.trim();
    if (!NAME.test(name)) return setError('A name is letters, digits and _, not starting with a digit: SHOP_PASSWORD');
    if (editing.isNew && !value) return setError('A new secret needs its value');
    try {
      await saveSecret({ projectId, name, description: editing.description, ...(value ? { value } : {}) }).unwrap();
      dispatch(showToast({ message: `Secret ${name} saved` }));
      open(null);
    } catch (err) {
      setError(errorOf(err));
    }
  };

  const remove = async (name: string) => {
    try {
      await deleteSecret({ projectId, name }).unwrap();
      dispatch(showToast({ message: `Secret ${name} deleted` }));
    } catch (err) {
      dispatch(showToast({ message: errorOf(err), type: 'error' }));
    }
    setDeleting(null);
  };

  return (
    <section className="secrets">
      <div className="secrets__head">
        <span className="field__label"><KeyRound size={14} /> Secrets</span>
        {!editing && <Button size="sm" variant="ghost" icon={Plus} onClick={() => open({ name: '', isNew: true, description: '' })}>Add a secret</Button>}
      </div>
      <p className="field__hint">
        Passwords, API keys, tokens a test types. Written <code>{'{{secret.NAME}}'}</code> in a step: IziTest types the value, the AI agent
        only knows the name. Kept encrypted on this machine; once saved, a value is never shown again. Saved as you go, apart from the project.
      </p>

      {isLoading ? <p className="muted">Loading…</p> : secrets.length === 0 ? (
        !editing && <p className="secrets__empty">No secret yet. An agent recording a test asks for the ones it needs.</p>
      ) : (
        <ul className="secrets__list">
          {secrets.map((secret) => (
            <li key={secret.name} className="secrets__item">
              <div className="secrets__main">
                <code className="secrets__name">{secret.name}</code>
                {secret.from_environment && <Pill tone="blue" title={`IZITEST_SECRET_${secret.name} in the server's environment is used instead`}>from the environment</Pill>}
                <span className="secrets__desc">{secret.description || <span className="muted">No description</span>}</span>
                <span className="muted secrets__when">{relativeTime(secret.updated_at)}</span>
              </div>
              {deleting === secret.name ? (
                <span className="secrets__confirm">
                  Tests typing it will fail.
                  <Button size="sm" variant="danger" onClick={() => remove(secret.name)}>Delete</Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(null)}>Keep</Button>
                </span>
              ) : (
                <span className="secrets__actions">
                  <button type="button" className="icon-btn" title={`Replace ${secret.name}`} onClick={() => open({ name: secret.name, isNew: false, description: secret.description })}><Pencil size={14} /></button>
                  <button type="button" className="icon-btn" title={`Delete ${secret.name}`} onClick={() => setDeleting(secret.name)}><Trash2 size={14} /></button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <form className="secrets__form" onSubmit={save}>
          <div className="form__row">
            <label className="field" style={{ width: 190 }}>
              <span className="field__label">Name</span>
              <input value={editing.name} disabled={!editing.isNew} autoFocus={editing.isNew} spellCheck={false} placeholder="SHOP_PASSWORD"
                onChange={(e) => { setEditing({ ...editing, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') }); setError(null); }} />
            </label>
            <label className="field form__grow">
              <span className="field__label">{editing.isNew ? 'Value' : 'New value'}{!editing.isNew && <span className="field__optional">empty keeps the current one</span>}</span>
              <input type="password" autoComplete="new-password" value={value} autoFocus={!editing.isNew} spellCheck={false}
                onChange={(e) => { setValue(e.target.value); setError(null); }} />
            </label>
          </div>
          <label className="field">
            <span className="field__label">What it is for <span className="field__optional">the agent reads it</span></span>
            <input value={editing.description} placeholder="Password of the test account qa@shop.test"
              onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
          </label>
          {error && <div className="alert alert--error">{error}</div>}
          <div className="form__actions">
            <Button variant="secondary" size="sm" onClick={() => open(null)}>Cancel</Button>
            <Button variant="primary" size="sm" type="submit" disabled={saving}>Save the secret</Button>
          </div>
        </form>
      )}
    </section>
  );
}
