import { useEffect, useMemo, useState } from 'react';
import { Copy, Plus, Rows3, Save, Trash2, Undo2 } from 'lucide-react';
import { useAppDispatch } from '../store/hooks';
import { showToast } from '../store/slices/uiSlice';
import { useSaveTestRowsMutation } from '../store/services/testsApi';
import type { Test } from '../types';
import { Button } from './Button';
import { Card, EmptyState } from './ui';

type Row = Record<string, string>;

// The rows typed and not saved yet, by test: kept while another tab of the test is looked at.
const drafts = new Map<string, Row[]>();

// A column holding a password, a key, a code: its cells are masked (mcp-server/lib/datasets.js
// hides them the same way in what a run keeps, its reports and its Gherkin).
const SENSITIVE_COLUMN = /pass|pwd|mot.?de.?passe|secret|token|api.?key|cl[eé].?api|otp|pin.?code|code.?pin/i;
const SECRET_REFERENCE = /^\{\{\s*secret\.[A-Za-z_]\w*\s*\}\}$/;

/**
 * The rows a test plays, typed in a table (its Data tab): a column per variable of the test, a
 * row per run. Run plays every row, one after the other, each run saying which row it played;
 * with two rows or more its Gherkin is a Scenario Outline whose Examples these rows are. Saved
 * with the test (PUT /api/tests/:name/rows). Bound to a dataset of the project, the test plays
 * that one's rows: its own are kept for when it is unbound.
 */
export function TestRows({ test, onDirtyChange }: { test: Test; onDirtyChange?: (dirty: boolean) => void }) {
  const dispatch = useAppDispatch();
  const [saveRows, { isLoading: saving }] = useSaveTestRowsMutation();
  const saved = useMemo(() => test.rows ?? [], [test.rows]);
  const [rows, setRowsHere] = useState<Row[]>(() => drafts.get(test.name) ?? saved);
  const setRows = (next: Row[]) => {
    setRowsHere(next);
    if (JSON.stringify(next) === JSON.stringify(saved)) drafts.delete(test.name);
    else drafts.set(test.name, next);
  };
  const variables = useMemo(() => (test.variables ?? {}) as Record<string, { defaultValue?: string; description?: string }>, [test.variables]);
  // A column per variable of the test; a column of a row no variable has any more, kept to be seen.
  const columns = useMemo(() => {
    const names = Object.keys(variables);
    for (const row of rows) for (const name of Object.keys(row)) if (!names.includes(name)) names.push(name);
    return names;
  }, [variables, rows]);
  const savedJson = JSON.stringify(saved);
  const dirty = JSON.stringify(rows) !== savedJson;
  // Saved again (here, by the Gherkin, by an agent): the table shows it — unless it holds edits.
  const [base, setBase] = useState(savedJson);
  if (savedJson !== base) {
    setBase(savedJson);
    const here = JSON.stringify(rows);
    if (here === base) setRowsHere(saved);
    if (here === base || here === savedJson) drafts.delete(test.name);
  }
  // Told to the page, which asks before it is left; another tab looked at, the draft stays.
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const defaults = (): Row => Object.fromEntries(Object.entries(variables).map(([name, info]) => [name, String(info?.defaultValue ?? '')]));
  const setCell = (index: number, name: string, value: string) => setRows(rows.map((row, i) => (i === index ? { ...row, [name]: value } : row)));
  const save = async () => {
    try {
      const result = await saveRows({ testName: test.name, rows }).unwrap();
      dispatch(showToast({ message: result.rows.length ? `${result.rows.length} row${result.rows.length === 1 ? '' : 's'} saved: a run each` : 'Rows removed: one run, with the defaults' }));
    } catch (err) {
      dispatch(showToast({ message: (err as { data?: { error?: string } })?.data?.error ?? 'The rows were not saved', type: 'error' }));
    }
  };

  const bound = test.dataset;
  const hasVariables = Object.keys(variables).length > 0;
  return (
    <Card title="Test data" icon={Rows3} className="test-rows"
      subtitle="One row, one run of the test: each column is one of its variables. Run plays every row, one after the other, and each run says which row it played."
      actions={hasVariables && !bound && (
        <>
          {dirty && <Button variant="ghost" size="sm" icon={Undo2} onClick={() => setRows(saved)}>Discard</Button>}
          <Button variant="secondary" size="sm" icon={Plus} onClick={() => setRows([...rows, defaults()])}>Add a row</Button>
          <Button size="sm" icon={Save} disabled={!dirty || saving} onClick={save}>Save rows</Button>
        </>
      )}>
      {bound ? (
        <p className="field__hint">
          It plays the {bound.row_count} row{bound.row_count === 1 ? '' : 's'} of the dataset <strong>{bound.name}</strong> (above).
          {saved.length > 0 && ` Its own ${saved.length} row${saved.length === 1 ? ' is' : 's are'} kept for when it is unbound.`}
          {' '}Choose “None” above to type rows of its own here.
        </p>
      ) : !hasVariables ? (
        <EmptyState icon={Rows3} title="No variable yet">A row gives a value to each variable of the test: they are created when a value is typed while recording, or with “Add a variable” on a step.</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState icon={Rows3} title="No row: one run, with the values below"
          action={<Button variant="secondary" size="sm" icon={Plus} onClick={() => setRows([defaults(), defaults()])}>Add rows</Button>}>
          Add a row per case to play — a user, a product, a date: the test runs once per row.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table table--compact test-rows__table">
            <thead>
              <tr>
                <th className="col-num">#</th>
                {columns.map((name) => (
                  <th key={name} title={variables[name]?.description ?? (variables[name] ? undefined : 'No variable of the test has this name any more: removed when saved empty')}>
                    <span className={`step-var-badge ${variables[name] ? '' : 'step-var-badge--stale'}`}>{`{{${name}}}`}</span>
                  </th>
                ))}
                <th aria-label="Row actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  <td className="col-num cell-muted">{index + 1}</td>
                  {columns.map((name) => {
                    const value = row[name];
                    const masked = SENSITIVE_COLUMN.test(name) && !SECRET_REFERENCE.test(value ?? '');
                    return (
                      <td key={name}>
                        <input
                          className="test-rows__cell"
                          type={masked ? 'password' : 'text'}
                          autoComplete={masked ? 'new-password' : 'off'}
                          spellCheck={false}
                          aria-label={`Row ${index + 1}, {{${name}}}`}
                          value={value ?? ''}
                          // Not given, the variable's default plays: shown greyed.
                          placeholder={value === undefined ? String(variables[name]?.defaultValue ?? '') || '(empty)' : undefined}
                          title={value === undefined ? 'Not given: the variable\'s default plays' : undefined}
                          onChange={(e) => setCell(index, name, e.target.value)}
                        />
                      </td>
                    );
                  })}
                  <td className="test-rows__actions">
                    <button type="button" className="icon-btn" title="Duplicate this row" aria-label={`Duplicate row ${index + 1}`}
                      onClick={() => setRows([...rows.slice(0, index + 1), { ...row }, ...rows.slice(index + 1)])}><Copy size={14} /></button>
                    <button type="button" className="icon-btn icon-btn--danger" title="Delete this row" aria-label={`Delete row ${index + 1}`}
                      onClick={() => setRows(rows.filter((_, i) => i !== index))}><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!bound && hasVariables && (
        <p className="field__hint data-help">
          {rows.length > 1 ? 'With two rows or more its Gherkin is a Scenario Outline: these rows are its Examples. ' : 'With two rows or more, its Gherkin becomes a Scenario Outline whose Examples are the rows. '}
          A cell left greyed plays the variable's default; one emptied is typed empty. A cell may compute its value ({'{{today + 3 days | dd/MM/yyyy}}'}, {'{{price * 3}}'}) or type a secret of the project ({'{{secret.NAME}}'}).
        </p>
      )}
    </Card>
  );
}
