import { useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FolderKanban, RefreshCw, Table, Trash2, Upload } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { showToast } from '../store/slices/uiSlice';
import {
  useDeleteDatasetMutation, useGetDatasetQuery, useGetDatasetsQuery, useGetProjectsQuery, useSaveDatasetMutation,
} from '../store/services/projectsApi';
import { useGo } from '../navigation';
import { shortDate } from '../format';
import { Button } from './Button';
import { Card, EmptyState, KeyChip, PageHeader } from './ui';
import type { Dataset } from '../types';

// The datasets of the project in scope (mcp-server/lib/datasets.js): tables of values — a CSV,
// a JSON or an Excel sheet dropped in. A test bound to one (its Data tab) runs once per row,
// each column a variable of the run; any test reads a value of one as {{users[2].email}}.

const errorOf = (err: unknown) => (err as { data?: { error?: string } })?.data?.error ?? 'The request failed';
const ROWS_SHOWN = 50;

/** A file as the API takes it: text, or an Excel workbook in base64. */
async function contentOf(file: File): Promise<{ content?: string; content_base64?: string }> {
  if (/\.(xlsx|xlsm)$/i.test(file.name)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { content_base64: btoa(binary) };
  }
  return { content: await file.text() };
}

export function DatasetsPage() {
  const scope = useAppSelector((state) => state.ui.selectedProjectId);
  const { data: projects = [] } = useGetProjectsQuery();
  const project = projects.find((p) => p.id === scope);
  const go = useGo();
  const { data: datasets = [], isLoading } = useGetDatasetsQuery(scope ?? 0, { skip: scope == null });
  const upload = useUpload(scope);

  if (scope == null) {
    return (
      <>
        <PageHeader title="Datasets" subtitle="Tables of values the tests of a project run with." />
        <Card>
          <EmptyState icon={FolderKanban} title="Choose a project" action={<Button variant="secondary" onClick={() => go('/projects')}>Projects</Button>}>
            Datasets belong to a project: choose one in the sidebar.
          </EmptyState>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Datasets"
        subtitle={`Tables of values of ${project?.name ?? 'this project'}: a test bound to one runs once per row of it, each column a variable of the run ({{email}}); any test reads a value of one as {{users[2].email}}, rows numbered from 1.`}
        actions={<Button icon={Upload} disabled={upload.busy} onClick={() => upload.pick()}>Add a dataset</Button>}
      />
      {upload.input}
      {isLoading ? (
        <Card><p className="empty-state">Loading…</p></Card>
      ) : datasets.length === 0 ? (
        <Card>
          <EmptyState icon={Table} title="No dataset yet" action={<Button icon={Upload} onClick={() => upload.pick()}>Add a dataset</Button>}>
            A CSV, a JSON list or an Excel sheet, its first row naming the columns: the users to log in with, the products to order.
            Its name is the file's (users.csv → users); a file of the same name replaces it.
          </EmptyState>
        </Card>
      ) : (
        <Card flush>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th className="col-chevron" /><th>Dataset</th><th>Columns</th><th className="col-num">Rows</th><th>Run by</th><th>Updated</th><th className="col-actions" /></tr>
              </thead>
              <tbody>
                {datasets.map((dataset) => <DatasetRow key={dataset.id} dataset={dataset} onReplace={() => upload.pick(dataset.name)} />)}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

/** Picks a file and saves it as a dataset of the project — under `name`, to replace that one. */
function useUpload(projectId: number | null) {
  const dispatch = useAppDispatch();
  const ref = useRef<HTMLInputElement>(null);
  const [name, setName] = useState<string | undefined>();
  const [save, { isLoading }] = useSaveDatasetMutation();
  const pick = (replacing?: string) => {
    setName(replacing);
    ref.current?.click();
  };
  const input = (
    <input ref={ref} type="file" hidden accept=".csv,.tsv,.txt,.json,.xlsx,.xlsm" onChange={async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file || projectId == null) return;
      try {
        const { dataset } = await save({ projectId, filename: file.name, ...(name ? { name } : {}), ...(await contentOf(file)) }).unwrap();
        dispatch(showToast({ message: `${dataset.name}: ${dataset.row_count} row${dataset.row_count === 1 ? '' : 's'}, ${dataset.columns.length} column${dataset.columns.length === 1 ? '' : 's'}` }));
      } catch (err) {
        dispatch(showToast({ message: errorOf(err), type: 'error' }));
      }
    }} />
  );
  return { input, pick, busy: isLoading };
}

function DatasetRow({ dataset, onReplace }: { dataset: Dataset; onReplace: () => void }) {
  const dispatch = useAppDispatch();
  const go = useGo();
  const [open, setOpen] = useState(false);
  const [remove, { isLoading: removing }] = useDeleteDatasetMutation();
  const { data: full } = useGetDatasetQuery(dataset.id, { skip: !open });

  return (
    <>
      <tr className="clickable" onClick={() => setOpen(!open)}>
        <td className="col-chevron">{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
        <td>
          <div className="test-name-cell">
            <span className="cell-title mono">{dataset.name}</span>
            {dataset.source && <span className="cell-sub">{dataset.source}</span>}
          </div>
        </td>
        <td><div className="cell-chips">{dataset.columns.map((c) => <span key={c} className="step-var-badge">{`{{${c}}}`}</span>)}</div></td>
        <td className="col-num">{dataset.row_count}</td>
        <td onClick={(e) => e.stopPropagation()}>
          <div className="cell-chips">
            {dataset.used_by.length
              ? dataset.used_by.map((test) => <KeyChip key={test} onClick={() => go(`/tests/${encodeURIComponent(test)}`, { from: 'Datasets' })}>{test}</KeyChip>)
              : <span className="cell-muted">No test</span>}
          </div>
        </td>
        <td className="cell-muted">{shortDate(dataset.updated_at)}</td>
        <td className="col-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-button" title="Replace with another file" aria-label={`Replace ${dataset.name}`} onClick={onReplace}><RefreshCw size={15} /></button>
          <button className="icon-button icon-button--danger" title="Delete" aria-label={`Delete ${dataset.name}`} disabled={removing} onClick={async () => {
            if (!window.confirm(`Delete the dataset ${dataset.name}?${dataset.used_by.length ? ` ${dataset.used_by.length} test(s) then run once, with their own values.` : ''}`)) return;
            await remove(dataset.id).unwrap().catch((err) => dispatch(showToast({ message: errorOf(err), type: 'error' })));
          }}><Trash2 size={15} /></button>
        </td>
      </tr>
      {open && (
        <tr className="dataset-rows">
          <td />
          <td colSpan={6}>
            {!full?.rows ? <p className="muted">Loading…</p> : (
              <div className="table-wrap">
                <table className="table table--compact">
                  <thead><tr><th className="col-num">#</th>{full.columns.map((c) => <th key={c} className="mono">{c}</th>)}</tr></thead>
                  <tbody>
                    {full.rows.slice(0, ROWS_SHOWN).map((row, i) => (
                      <tr key={i}><td className="col-num cell-muted">{i + 1}</td>{full.columns.map((c) => <td key={c}>{row[c]}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
                {full.rows.length > ROWS_SHOWN && <p className="muted">The first {ROWS_SHOWN} of {full.rows.length} rows.</p>}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
