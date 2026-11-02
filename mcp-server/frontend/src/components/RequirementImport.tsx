import { useState } from 'react';
import { Upload, Loader2 } from 'lucide-react';
import { useImportRequirementsMutation } from '../store/services/requirementsApi';
import { Button } from './Button';
import type { RequirementImport } from '../types';

// Requirements from a file (mcp-server/lib/requirement-import.js): a test plan in a spreadsheet
// (CSV, Excel), a Jira CSV export, JSON, a Markdown spec — chosen or pasted, previewed (what is
// new, changed, unchanged; which column is which), then imported.

const FIELDS = ['key', 'title', 'description', 'criteria', 'priority', 'url'] as const;
const FIELD_LABELS: Record<(typeof FIELDS)[number], string> = {
  key: 'Key', title: 'Title', description: 'Description', criteria: 'Acceptance criteria', priority: 'Priority', url: 'Link',
};
const STATUS_LABELS = { new: 'New', changed: 'Changed', unchanged: 'Unchanged' } as const;

const errorOf = (err: unknown) => (err as { data?: { error?: string } })?.data?.error ?? 'The request failed';

/** A file's bytes as base64: the server reads its text (UTF-8, or Windows-1252) or its workbook. */
function base64Of(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

type Source = { filename: string; content_base64: string } | { filename: ''; content: string };

export function RequirementImportPanel({ projectId, projectName, onDone, onCancel }: {
  projectId: number | null; projectName: string | null; onDone: () => void; onCancel: () => void;
}) {
  const [source, setSource] = useState<Source | null>(null);
  const [pasted, setPasted] = useState('');
  const [columns, setColumns] = useState<Record<string, string | null>>({});
  const [sheet, setSheet] = useState('');
  const [preview, setPreview] = useState<RequirementImport | null>(null);
  const [done, setDone] = useState<RequirementImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, { isLoading }] = useImportRequirementsMutation();

  const ask = async (from: Source, options: { columns?: Record<string, string | null>; sheet?: string; dryRun: boolean }) => {
    setError(null);
    try {
      const { import: result } = await run({
        ...from, columns: options.columns ?? columns, sheet: (options.sheet ?? sheet) || undefined, project_id: projectId, dry_run: options.dryRun,
      }).unwrap();
      if (options.dryRun) setPreview(result);
      else { setDone(result); setPreview(null); }
    } catch (err) {
      setError(errorOf(err));
      if (options.dryRun) setPreview(null);
    }
  };

  const choose = async (file: File | undefined) => {
    if (!file) return;
    const from = { filename: file.name, content_base64: base64Of(await file.arrayBuffer()) };
    setSource(from);
    setColumns({});
    setSheet('');
    await ask(from, { columns: {}, sheet: '', dryRun: true });
  };
  const readPasted = async () => {
    const from = { filename: '' as const, content: pasted };
    setSource(from);
    setColumns({});
    await ask(from, { columns: {}, dryRun: true });
  };
  const remap = (field: string, header: string) => {
    const next = { ...columns, [field]: header || null };
    setColumns(next);
    if (source) ask(source, { columns: next, dryRun: true });
  };

  if (done) {
    return (
      <div className="requirement-form import-panel">
        <p className="import-done">
          Imported {done.items.length} requirement{done.items.length === 1 ? '' : 's'}: {done.new} new, {done.changed} changed, {done.unchanged} unchanged.
        </p>
        <div className="repair-actions"><Button size="sm" variant="action" onClick={onDone}>Close</Button></div>
      </div>
    );
  }

  return (
    <div className="requirement-form import-panel">
      <p className="explore-help">
        A test plan in a spreadsheet (CSV, Excel), a Jira CSV export, JSON, or a Markdown spec. Columns are found by their names —
        Key, Title, Description, Acceptance criteria, Priority, Link, in English or French —; one criterion per line in a cell, or
        per row under it. Imported again, a requirement is updated under its key (or title): its unchanged criteria keep their tests.
        Into: <strong>{projectName ?? 'no project'}</strong>.
      </p>
      <label className="import-file">
        <Upload size={14} /> Choose a file
        <input type="file" accept=".csv,.tsv,.txt,.xlsx,.xlsm,.json,.md,.markdown" onChange={(e) => choose(e.target.files?.[0])} />
        {source && 'filename' in source && source.filename && <span className="dash-table__muted">{source.filename}</span>}
      </label>
      <textarea rows={4} placeholder="…or paste CSV, JSON or Markdown here" value={pasted} onChange={(e) => setPasted(e.target.value)} />
      {pasted.trim() && <div><Button size="sm" variant="action" disabled={isLoading} onClick={readPasted}>Preview the pasted text</Button></div>}
      {isLoading && <p className="explore-help"><Loader2 size={12} className="spin" /> Reading…</p>}
      {error && <div className="repair-error">{error}</div>}
      {preview && <ImportPreview preview={preview} columns={columns} onRemap={remap} sheet={sheet}
        onSheet={(name) => { setSheet(name); if (source) ask(source, { sheet: name, dryRun: true }); }} />}
      <div className="repair-actions">
        <Button size="sm" variant="save" icon={Upload} disabled={!preview?.items.length || isLoading || !source} onClick={() => source && ask(source, { dryRun: false })}>
          Import {preview?.items.length ?? 0} requirement{preview?.items.length === 1 ? '' : 's'}
        </Button>
        <Button size="sm" variant="cancel" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

/** What would be imported: the column of each field (to change), each requirement and what becomes of it. */
function ImportPreview({ preview, columns, onRemap, sheet, onSheet }: {
  preview: RequirementImport; columns: Record<string, string | null>; onRemap: (field: string, header: string) => void;
  sheet: string; onSheet: (name: string) => void;
}) {
  return (
    <div className="import-preview">
      <div className="explore-help">
        {preview.format.toUpperCase()} — {preview.items.length} requirement{preview.items.length === 1 ? '' : 's'}: {preview.new} new, {preview.changed} changed, {preview.unchanged} unchanged.
      </div>
      {preview.format === 'xlsx' && (
        <input className="import-sheet" placeholder="Sheet (default: the first)" defaultValue={sheet} onBlur={(e) => e.target.value !== sheet && onSheet(e.target.value)} />
      )}
      {preview.headers && (
        <div className="import-columns">
          {FIELDS.map((field) => (
            <label key={field}>
              {FIELD_LABELS[field]}
              <select value={columns[field] === null ? '' : columns[field] ?? preview.columns?.[field] ?? ''} onChange={(e) => onRemap(field, e.target.value)}>
                <option value="">—</option>
                {preview.headers!.filter(Boolean).map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}
      {preview.warnings.length > 0 && (
        <ul className="import-warnings">{preview.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
      )}
      <div className="bug-list">
        {preview.items.map((item, i) => (
          <details key={`${item.key ?? ''}-${item.title}-${i}`} className="import-item">
            <summary>
              <span className={`import-status import-status--${item.status}`}>{STATUS_LABELS[item.status]}</span>
              <span className="requirement-key">{item.key ?? 'new key'}</span>
              <span className="requirement-title">{item.title}</span>
              <span className="dash-table__muted">{item.criteria.length} criteri{item.criteria.length === 1 ? 'on' : 'a'} · {item.priority}</span>
              {item.status === 'changed' && item.linked_tests > 0 && (
                <span className="import-linked">{item.linked_tests} test{item.linked_tests === 1 ? '' : 's'} linked: check them</span>
              )}
            </summary>
            {item.description && <p className="import-description">{item.description}</p>}
            <ol>{item.criteria.map((c, j) => <li key={j}>{c}</li>)}</ol>
          </details>
        ))}
      </div>
    </div>
  );
}
