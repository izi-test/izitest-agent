import { useState } from 'react';
import { Upload, Loader2, RefreshCw, Search, FileUp, X, Sparkles } from 'lucide-react';
import { useImportRequirementsMutation, useImportFromConnectorMutation, useGetConnectorScopesQuery } from '../store/services/requirementsApi';
import { useGetConnectorsQuery } from '../store/services/settingsApi';
import { useGetProjectsQuery } from '../store/services/projectsApi';
import { Button } from './Button';
import { ProjectField } from './ProjectSelector';
import { Pill } from './ui';
import type { Connector, RequirementImport } from '../types';

// Requirements from a file (mcp-server/lib/requirement-import.js) — a test plan in a spreadsheet
// (CSV, Excel), a Jira CSV export, JSON, a Markdown spec, a Word document, an API (a Postman
// collection, an OpenAPI document: a request per requirement), chosen or pasted — or
// any document read by the agent set in Settings (mcp-server/lib/requirement-reading.js: a Word
// spec, an email, free text; each requirement shown with the passage it comes from), or from a
// tool set in Settings → Connectors (mcp-server/lib/connectors: Jira, GitHub Issues…), by a query,
// their keys or again to see what changed: previewed (what is new, changed, unchanged; for a
// table, which column is which), then imported — what the agent read, as the preview showed it.

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

/**
 * What is read: a file (its bytes, or pasted text) — `agent`: read by the agent —, or a tool's
 * requirements (a query, their keys, or those imported already).
 */
type Source =
  | { kind: 'file'; filename: string; content_base64?: string; content?: string; agent?: boolean }
  | { kind: 'connector'; connector: string; query?: string; keys?: string[]; sync?: boolean };

export function RequirementImportPanel({ defaultProjectId, onDone, onCancel }: {
  defaultProjectId: number | null; onDone: () => void; onCancel: () => void;
}) {
  // Into the project in scope; with all of them in scope, chosen — "No project" too, on purpose.
  const [projectId, setProjectId] = useState<number | null | undefined>(defaultProjectId ?? undefined);
  const { data: projects = [] } = useGetProjectsQuery();
  const projectName = projectId == null ? null : projects.find((p) => p.id === projectId)?.name ?? null;
  // A file, or a connector's id.
  const [tab, setTab] = useState('file');
  const { data: connectors = [] } = useGetConnectorsQuery();
  const sources = connectors.filter((c) => c.requirements);
  const [dragging, setDragging] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [pasted, setPasted] = useState('');
  // Files and pasted text read by the agent, rather than as a table, JSON or Markdown.
  const [withAgent, setWithAgent] = useState(false);
  const [columns, setColumns] = useState<Record<string, string | null>>({});
  const [sheet, setSheet] = useState('');
  const [preview, setPreview] = useState<RequirementImport | null>(null);
  const [done, setDone] = useState<RequirementImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readFile, { isLoading: readingFile }] = useImportRequirementsMutation();
  const [readTool, { isLoading: readingTool }] = useImportFromConnectorMutation();
  const isLoading = readingFile || readingTool;

  // Whether the agent is reading (minutes), rather than its reading being imported (an instant).
  const [agentReading, setAgentReading] = useState(false);
  const ask = async (from: Source, options: { columns?: Record<string, string | null>; sheet?: string; dryRun: boolean }) => {
    setError(null);
    setAgentReading(from.kind === 'file' && !!from.agent && options.dryRun);
    try {
      const { import: result } = from.kind === 'connector'
        ? await readTool({ connector: from.connector, query: from.query, keys: from.keys, sync: from.sync, project_id: projectId, dry_run: options.dryRun }).unwrap()
        // Read by the agent: what the preview showed is imported, not read again (its next reading could differ).
        : from.agent && !options.dryRun && preview
          ? await readFile({ requirements: preview.items, format: preview.format, project_id: projectId, dry_run: false }).unwrap()
          : await readFile({
            filename: from.filename, content: from.content, content_base64: from.content_base64,
            columns: options.columns ?? columns, sheet: (options.sheet ?? sheet) || undefined, project_id: projectId, dry_run: options.dryRun,
            agent: from.agent || undefined,
          }).unwrap();
      if (options.dryRun) setPreview(result);
      else { setDone(result); setPreview(null); }
    } catch (err) {
      setError(errorOf(err));
      if (options.dryRun) setPreview(null);
    }
  };
  const start = (from: Source) => {
    setSource(from);
    setPreview(null);
    setColumns({});
    setSheet('');
    return ask(from, { columns: {}, sheet: '', dryRun: true });
  };
  const choose = async (file: File | undefined) => {
    if (file) await start({ kind: 'file', filename: file.name, content_base64: base64Of(await file.arrayBuffer()), agent: withAgent });
  };
  // The agent on or off: the file chosen, or the text pasted, read again that way.
  const readWith = (agent: boolean) => {
    setWithAgent(agent);
    if (source?.kind === 'file') start({ ...source, agent });
  };
  const remap = (field: string, header: string) => {
    const next = { ...columns, [field]: header || null };
    setColumns(next);
    if (source) ask(source, { columns: next, dryRun: true });
  };
  const switchTo = (next: string) => { setTab(next); setPreview(null); setSource(null); setError(null); };
  const tool = sources.find((c) => c.id === tab);

  if (done) {
    return (
      <div className="import-panel">
        <div className="alert alert--success">
          Imported {done.items.length} requirement{done.items.length === 1 ? '' : 's'} into {projectName ?? 'no project'}: {done.new} new, {done.changed} changed, {done.unchanged} unchanged.
        </div>
        <div className="form__actions"><Button onClick={onDone}>Close</Button></div>
      </div>
    );
  }

  return (
    <div className="import-panel">
      <nav className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'file'} className={`tab ${tab === 'file' ? 'active' : ''}`} onClick={() => switchTo('file')}><FileUp size={15} /> From a file</button>
        {sources.map((c) => (
          <button key={c.id} type="button" role="tab" aria-selected={tab === c.id} className={`tab ${tab === c.id ? 'active' : ''}`} onClick={() => switchTo(c.id)}>
            <RefreshCw size={15} /> From {c.name}
          </button>
        ))}
      </nav>
      <ProjectField
        label="Import into project" value={projectId}
        onChange={(id) => { setProjectId(id); setPreview(null); setSource(null); }}
        hint="Imported again, a requirement is updated under its key (or title): its unchanged criteria keep their tests."
      />
      {projectId !== undefined && (!tool ? (
        <>
          <label className="field field--check">
            <span className="checkbox-row">
              <input type="checkbox" checked={withAgent} disabled={isLoading} onChange={(e) => readWith(e.target.checked)} />
              <span className="field__label">Have the agent read it</span>
            </span>
            <span className="field__hint">
              Any document — a Word spec, an email, notes — read by the agent set in Settings. It keeps the document's keys, titles
              and words, writes only the criteria it states, and lists what is unclear. You check each requirement against the
              passage it comes from before anything is imported. It takes up to a few minutes.
            </span>
          </label>
          {!withAgent && (
            <p className="help">
              A test plan in a spreadsheet (CSV, Excel), a Jira CSV export, JSON, a Markdown spec, a Word document with a heading per
              requirement, or an API: a Postman collection or an OpenAPI document (JSON), a request per requirement, its example
              responses and tests as criteria. Columns are found by their names — Key, Title, Description, Acceptance criteria,
              Priority, Link, in English or French —; one criterion per line in a cell, or per row under it.
            </p>
          )}
          <label
            className={`dropzone ${dragging ? 'dropzone--over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files?.[0]); }}
          >
            <Upload size={22} />
            <span><strong>Drop a file here</strong> or choose one</span>
            <span className="field__hint">{withAgent ? 'Word (.docx), a text file, or any file below' : 'CSV, Excel, a Jira CSV export, JSON, Markdown, Word (.docx), Postman, OpenAPI'}</span>
            <input type="file" accept=".csv,.tsv,.txt,.xlsx,.xlsm,.json,.md,.markdown,.docx" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {source?.kind === 'file' && source.filename && (
            <div className="chip chip--plain" style={{ alignSelf: 'flex-start' }}>
              <FileUp size={14} /> {source.filename}
              <button type="button" className="icon-button" style={{ width: 22, height: 22 }} aria-label="Remove the file" onClick={() => { setSource(null); setPreview(null); }}><X size={12} /></button>
            </div>
          )}
          <details className="import-paste">
            <summary>{withAgent ? '…or paste a text: a spec, an email, the text of a PDF' : '…or paste CSV, JSON or Markdown'}</summary>
            <textarea rows={5} value={pasted} onChange={(e) => setPasted(e.target.value)} />
            {pasted.trim() && <div><Button size="sm" variant="secondary" disabled={isLoading} onClick={() => start({ kind: 'file', filename: '', content: pasted, agent: withAgent })}>Preview the pasted text</Button></div>}
          </details>
        </>
      ) : (
        <ConnectorSource key={tool.id} connector={tool} projectName={projectName} busy={isLoading} onRead={start} />
      ))}
      {isLoading && (
        <p className="help">
          <Loader2 size={12} className="spin" /> {agentReading ? 'The agent is reading the document. It takes up to a few minutes.' : 'Reading…'}
        </p>
      )}
      {error && <div className="alert alert--error">{error}</div>}
      {/* Read as a table, JSON or Markdown, and not as it should be: the agent reads any document. */}
      {source?.kind === 'file' && !source.agent && !isLoading && (error || (preview && (!preview.items.length || preview.warnings.length > 0 || ['docx', 'markdown'].includes(preview.format)))) && (
        <div className="import-agent">
          <span>Not what the document says?</span>
          <Button size="sm" variant="secondary" icon={Sparkles} onClick={() => readWith(true)}>Have the agent read it</Button>
        </div>
      )}
      {preview && <ImportPreview preview={preview} columns={columns} onRemap={remap} sheet={sheet}
        onSheet={(name) => { setSheet(name); if (source) ask(source, { sheet: name, dryRun: true }); }} />}
      <div className="form__actions">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button icon={Upload} disabled={!preview?.items.length || isLoading || !source || projectId === undefined} onClick={() => source && ask(source, { dryRun: false })}>
          Import {preview?.items.length ?? 0} requirement{preview?.items.length === 1 ? '' : 's'}{projectId !== undefined && ` into ${projectName ?? 'no project'}`}
        </Button>
      </div>
    </div>
  );
}

/**
 * A tool's requirements (a connector set in Settings): those a query finds — a project's to start
 * from, when the tool has projects —, those of their keys, or the ones imported already, read again.
 */
function ConnectorSource({ connector: c, projectName, busy, onRead }: {
  connector: Connector; projectName: string | null; busy: boolean; onRead: (from: Source) => void;
}) {
  const role = c.requirements!;
  const { data: scopes = [], error } = useGetConnectorScopesQuery(c.id, { skip: !c.config || !role.scopes });
  const [query, setQuery] = useState('');
  const [keys, setKeys] = useState('');
  if (!c.config) return <div className="alert alert--info">{c.name} is not set yet: Settings → {c.name}.</div>;
  const listed = keys.split(/[\s,;]+/).filter(Boolean);
  const site = c.config.baseUrl;
  return (
    <>
      <div className="alert alert--info">
        {role.items.replace(/^./, (l) => l.toUpperCase())} read as requirements{site && <> from <strong>{site}</strong></>}: {role.reads}.
        Nothing is written to {c.name}. Into: <strong>{projectName ?? 'no project'}</strong>.
      </div>
      {error && <div className="alert alert--error">{errorOf(error)}</div>}
      {scopes.length > 0 && (
        <label className="field">
          <span className="field__label">Where to start</span>
          <select value="" onChange={(e) => e.target.value && setQuery(e.target.value)}>
            <option value="">Choose…</option>
            {scopes.map((scope) => <option key={scope.label} value={scope.query}>{scope.label}</option>)}
          </select>
        </label>
      )}
      <label className="field">
        <span className="field__label">{role.query.label.replace(/^./, (l) => l.toUpperCase())}</span>
        <textarea className="mono" rows={2} placeholder={`e.g. ${role.query.placeholder}`} value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
      </label>
      <label className="field">
        <span className="field__label">Or their keys</span>
        <input type="text" className="mono" placeholder={`e.g. ${role.keys}`} value={keys} onChange={(e) => setKeys(e.target.value)} spellCheck={false} />
      </label>
      <div className="repair-actions">
        <Button size="sm" variant="secondary" icon={Search} disabled={(!query.trim() && !listed.length) || busy}
          onClick={() => onRead(listed.length ? { kind: 'connector', connector: c.id, keys: listed } : { kind: 'connector', connector: c.id, query })}>
          Preview
        </Button>
        <Button size="sm" variant="ghost" icon={RefreshCw} disabled={busy} title={`Read again the requirements imported from ${c.name}: which changed?`}
          onClick={() => onRead({ kind: 'connector', connector: c.id, sync: true })}>
          Check the imported ones for changes
        </Button>
      </div>
    </>
  );
}

/** What would be imported: the column of each field (to change), each requirement and what becomes of it. */
function ImportPreview({ preview, columns, onRemap, sheet, onSheet }: {
  preview: RequirementImport; columns: Record<string, string | null>; onRemap: (field: string, header: string) => void;
  sheet: string; onSheet: (name: string) => void;
}) {
  return (
    <div className="import-preview">
      <div className="import-summary">
        <span className="tag">{preview.format.toUpperCase()}</span>
        {preview.agent && <span className="tag tag--blue"><Sparkles size={11} /> read by {preview.agent}</span>}
        {preview.items.length} requirement{preview.items.length === 1 ? '' : 's'}:
        <Pill tone="blue" dot={false}>{preview.new} new</Pill>
        <Pill tone="amber" dot={false}>{preview.changed} changed</Pill>
        <Pill tone="slate" dot={false}>{preview.unchanged} unchanged</Pill>
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
      {preview.agent && (
        <p className="help">
          Check each requirement against the passage of the document it comes from: a requirement says what the document says.
          Nothing is imported until you do. To change one, edit the document and read it again, or edit it once imported.
        </p>
      )}
      {preview.warnings.length > 0 && (
        <ul className="import-warnings">{preview.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
      )}
      <div className="import-items">
        {preview.items.map((item, i) => (
          <details key={`${item.key ?? ''}-${item.title}-${i}`} className="import-item" open={!!preview.agent}>
            <summary>
              <Pill tone={item.status === 'new' ? 'blue' : item.status === 'changed' ? 'amber' : 'slate'} dot={false}>{STATUS_LABELS[item.status]}</Pill>
              <span className="key-chip">{item.key ?? 'new key'}</span>
              <span className="import-item__title">{item.title}</span>
              {item.status === 'changed' && item.linked_tests > 0 && (
                <span className="tag tag--amber">{item.linked_tests} test{item.linked_tests === 1 ? '' : 's'} linked: check {item.linked_tests === 1 ? 'it' : 'them'}</span>
              )}
              {preview.agent && (item.quote_found === false || (item.unsupported_criteria?.length ?? 0) > 0) && (
                <span className="tag tag--amber">check it</span>
              )}
              {(item.dropped_criteria?.length ?? 0) > 0 && (
                <span className="tag tag--red">drops {item.dropped_criteria!.length} criteri{item.dropped_criteria!.length === 1 ? 'on' : 'a'}</span>
              )}
              <span className="cell-muted">{item.criteria.length} criteri{item.criteria.length === 1 ? 'on' : 'a'} · {item.priority}</span>
            </summary>
            {preview.agent && (
              <blockquote className="import-quote">
                <span className="import-quote__label">
                  From the document{item.source_quote && item.quote_found === false && <span className="tag tag--amber">not found there word for word</span>}
                </span>
                {item.source_quote ?? 'The agent did not say which passage.'}
              </blockquote>
            )}
            {item.title_before && <p className="import-description">Was titled: {item.title_before}</p>}
            {item.description && <p className="import-description">{item.description}</p>}
            <ol>
              {item.criteria.map((c, j) => (
                <li key={j}>
                  {c}
                  {item.unsupported_criteria?.includes(c) && <span className="tag tag--amber import-flag">not in the document as written</span>}
                </li>
              ))}
            </ol>
            {(item.dropped_criteria?.length ?? 0) > 0 && (
              <div className="import-dropped">
                Imported, it replaces {item.key}: these criteria of it go, with the tests planned or linked to them.
                <ul>{item.dropped_criteria!.map((c) => <li key={c}><s>{c}</s></li>)}</ul>
              </div>
            )}
          </details>
        ))}
      </div>
    </div>
  );
}
