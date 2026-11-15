// The datasets of a project: tables of values — a CSV, a JSON or an Excel sheet dropped in —
// that a test bound to one runs once per row of (each column a variable of the run: {{email}}),
// and any test reads a value of ({{utilisateurs[2].email}}, rows numbered from 1). A run of a
// bound test plays every row, a campaign too. A test may also keep rows of its own (testRows),
// played the same way.

import { db, parseJson } from './db.js';
import { textOf, parseCsv, parseXlsx } from './requirement-import.js';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 2000;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A file's name made the name of a dataset: utilisateurs.csv → utilisateurs. */
export function nameOf(filename) {
  const base = String(filename ?? 'data').replace(/\.[^.]+$/, '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const name = base.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'data';
  return /^\d/.test(name) ? `data_${name}` : name;
}

/** A column header made a variable name: "E-mail" → e_mail, "Mot de passe" → mot_de_passe. */
function columnName(header, index, taken) {
  let name = nameOf(`${String(header ?? '').trim()}.x`).toLowerCase();
  if (!String(header ?? '').trim()) name = `column_${index + 1}`;
  let unique = name;
  for (let n = 2; taken.has(unique); n += 1) unique = `${name}_${n}`;
  taken.add(unique);
  return unique;
}

/** Rows as arrays, the first one the headers: { columns, rows } with every value a string. */
function fromTable(table) {
  const [headers = [], ...lines] = table.filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''));
  if (!headers.length) throw new Error('No header row: the first row names the columns');
  const taken = new Set();
  const columns = headers.map((header, i) => columnName(header, i, taken));
  const rows = lines.map((line) => Object.fromEntries(columns.map((column, i) => [column, String(line[i] ?? '').trim()])));
  return { columns, rows };
}

/** A list of objects: { columns, rows }, a value that is no text written as JSON. */
function fromObjects(list) {
  if (!Array.isArray(list) || !list.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
    throw new Error('A JSON dataset is a list of objects, one per row ([{ "email": "…" }, …]), or an object holding one');
  }
  const columns = [...new Set(list.flatMap((item) => Object.keys(item)))];
  const text = (value) => (value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));
  return { columns, rows: list.map((item) => Object.fromEntries(columns.map((column) => [column, text(item[column])]))) };
}

/**
 * The table a file holds: `{ columns, rows }`, rows as objects of strings. A CSV or TSV (header
 * row first), an Excel workbook (its first sheet), or JSON (a list of objects, or an object
 * whose first list it is). `content` a string or a Buffer (an .xlsx must be one).
 */
export function parseDataset({ filename = '', content }) {
  if (content == null || content.length === 0) throw new Error('The file is empty');
  if (content.length > MAX_BYTES) throw new Error(`The file is over ${MAX_BYTES / 1024 / 1024} MB`);
  const extension = String(filename).toLowerCase().split('.').pop();
  let table;
  if (['xlsx', 'xlsm'].includes(extension) || (typeof content !== 'string' && content[0] === 0x50 && content[1] === 0x4b)) {
    table = fromTable(parseXlsx(Buffer.from(content)));
  } else {
    const text = textOf(content);
    if (extension === 'json' || /^\s*[[{]/.test(text)) {
      let data;
      try { data = JSON.parse(text); } catch (err) { throw new Error(`Not valid JSON: ${err.message}`); }
      table = fromObjects(Array.isArray(data) ? data : Object.values(data ?? {}).find(Array.isArray));
    } else {
      table = fromTable(parseCsv(text));
    }
  }
  if (!table.rows.length) throw new Error('No row of values under the headers');
  if (table.rows.length > MAX_ROWS) throw new Error(`${table.rows.length} rows: at most ${MAX_ROWS}`);
  return table;
}

const asDataset = (row, { withRows = false } = {}) => row && {
  id: row.id,
  project_id: row.project_id,
  name: row.name,
  source: row.source,
  columns: parseJson(row.columns) ?? [],
  row_count: (parseJson(row.rows) ?? []).length,
  ...(withRows && { rows: parseJson(row.rows) ?? [] }),
  created_at: row.created_at,
  updated_at: row.updated_at,
  used_by: db.prepare('SELECT name FROM tests WHERE dataset_id = ? ORDER BY name').all(row.id).map((t) => t.name),
};

/**
 * Saves a dataset of a project from a file, or from rows given (`rows`: a list of objects): a
 * new one, or the one of that name replaced — the tests bound to it then run its new rows.
 */
export function saveDataset(projectId, { name, filename, content, rows }) {
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) return { error: 'Project not found', status: 404 };
  let table;
  try {
    table = rows ? fromObjects(rows) : parseDataset({ filename, content });
  } catch (err) {
    return { error: err.message, status: 400 };
  }
  if (!table.rows.length) return { error: 'No row of values', status: 400 };
  const datasetName = String(name ?? '').trim() || nameOf(filename);
  if (!NAME.test(datasetName)) return { error: `"${datasetName}" is not a usable name: letters, digits and _, not starting with a digit`, status: 400 };
  const saved = db.prepare(
    `INSERT INTO datasets (project_id, name, source, columns, rows) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (project_id, name) DO UPDATE SET source = excluded.source, columns = excluded.columns, rows = excluded.rows,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     RETURNING *`
  ).get(projectId, datasetName, filename ?? null, JSON.stringify(table.columns), JSON.stringify(table.rows));
  return { dataset: asDataset(saved, { withRows: true }) };
}

export function listDatasets(projectId) {
  return db.prepare('SELECT * FROM datasets WHERE project_id = ? ORDER BY name').all(projectId).map((row) => asDataset(row));
}

export function getDataset(id) {
  return asDataset(db.prepare('SELECT * FROM datasets WHERE id = ?').get(id), { withRows: true });
}

export function deleteDataset(id) {
  return db.prepare('DELETE FROM datasets WHERE id = ?').run(id).changes > 0;
}

/** The datasets of a project by name, their rows: what an expression reads ({{utilisateurs[2].email}}). */
export function datasetRows(projectId) {
  if (!projectId) return {};
  return Object.fromEntries(db.prepare('SELECT name, rows FROM datasets WHERE project_id = ?').all(projectId).map((row) => [row.name, parseJson(row.rows) ?? []]));
}

/** The dataset a test is bound to, with its rows; null when it is bound to none. */
export function datasetOfTest(testName) {
  const row = db.prepare('SELECT d.* FROM datasets d JOIN tests t ON t.dataset_id = d.id WHERE t.name = ?').get(testName);
  return row ? asDataset(row, { withRows: true }) : null;
}

// ─── The rows a test keeps of its own ─────────────────────────────────────
// Typed in its Data tab's table, or read from the Examples of its Gherkin: one row, one run of
// the test, a value per variable of it by its name — a variable a row has no value for plays
// its default; a value may be computed ({{today + 3 days}}) or a secret ({{secret.NAME}}).
// Kept with the test (tests.data_rows), not as a dataset of the project: its columns are the
// test's variables, the rows go with the test (renamed, deleted), take no name among the
// project's datasets ({{users[2].email}}) and change no other test's runs. They are played as
// a dataset's are (rowsOfTest): a run per row (data_row), a campaign entry per row. A test
// bound to a dataset plays the dataset's rows; its own are kept for when it is unbound.

/** The rows a test keeps of its own: a list of objects, [] when it has none. */
export function testRows(testName) {
  const rows = parseJson(db.prepare('SELECT data_rows FROM tests WHERE name = ?').get(testName)?.data_rows);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Saves the rows a test keeps of its own (`rows`: a list of objects, a value per variable by its
 * name; [] for none): `{ rows, added }` or `{ error, status }`. A column that is no variable of
 * the test is refused — or, with `addVariables` (rows read from the Examples of its Gherkin),
 * made one (`added`), its default the value of row 1.
 */
export function saveTestRows(testName, rows, { addVariables = false } = {}) {
  const test = db.prepare('SELECT id, variables FROM tests WHERE name = ?').get(testName);
  if (!test) return { error: 'Test not found', status: 404 };
  if (!Array.isArray(rows) || !rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
    return { error: 'rows: a list of objects, a value per variable of the test ([{ "email": "bob@x.dev" }, …])', status: 400 };
  }
  if (rows.length > MAX_ROWS) return { error: `${rows.length} rows: at most ${MAX_ROWS}`, status: 400 };
  const variables = parseJson(test.variables) ?? {};
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const badName = columns.find((column) => !NAME.test(column));
  if (badName !== undefined) return { error: `"${badName}" is no variable name: letters, digits and _, not starting with a digit`, status: 400 };
  const unknown = columns.filter((column) => !variables[column]);
  if (unknown.length && !addVariables) {
    const known = Object.keys(variables);
    return {
      error: `${unknown.map((c) => `{{${c}}}`).join(', ')}: no variable of the test — each column is one of its variables (${known.length ? known.map((c) => `{{${c}}}`).join(', ') : 'it has none'})`,
      status: 400,
    };
  }
  const text = (value) => (value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));
  const clean = rows.map((row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, text(value)])));
  for (const column of unknown) {
    variables[column] = { type: 'text', defaultValue: clean.find((row) => column in row)?.[column] ?? '', description: 'A column of its rows' };
  }
  db.prepare(`UPDATE tests SET data_rows = ?, variables = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(clean.length ? JSON.stringify(clean) : null, JSON.stringify(variables), test.id);
  return { rows: clean, added: unknown };
}

/** A variable of a test renamed: the column of its rows goes with it. */
export function renameRowColumn(testName, from, to) {
  const rows = testRows(testName);
  if (!from || from === to || !rows.some((row) => from in row)) return;
  const renamed = rows.map((row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [column === from ? to : column, value])));
  db.prepare('UPDATE tests SET data_rows = ? WHERE name = ?').run(JSON.stringify(renamed), testName);
}

/**
 * The rows a test plays, a run each: those of the dataset it is bound to, else its own (`own`,
 * its variables the columns) — in the shape datasetOfTest gives; null when it has none.
 */
export function rowsOfTest(testName) {
  const dataset = datasetOfTest(testName);
  if (dataset) return dataset;
  const rows = testRows(testName);
  if (!rows.length) return null;
  const variables = parseJson(db.prepare('SELECT variables FROM tests WHERE name = ?').get(testName)?.variables) ?? {};
  const columns = [...new Set([...Object.keys(variables), ...rows.flatMap((row) => Object.keys(row))])];
  return { id: null, name: null, own: true, columns, rows, row_count: rows.length };
}

/** The rows a run of a test plays, numbered from 1: the one asked, else every row it has; [null] when it has none. */
export function rowsToPlay(testName, row) {
  if (row != null && row !== '' && row !== 'all') return [Number(row)];
  const played = rowsOfTest(testName);
  return played ? played.rows.map((_, i) => i + 1) : [null];
}

/** What a run says of the rows it plays: "row 2 — bob@x.dev, Bob" of its rows or of the dataset "users". */
export function rowsSource(played) {
  return played?.own ? 'its rows' : `the dataset "${played?.name}"`;
}

/**
 * What the code of a test carries of its data (codegen): the datasets of its project, and the
 * name of the rows it plays among them — its own rows go as one more.
 */
export function codeData(test) {
  const datasets = datasetRows(test.project_id);
  const played = rowsOfTest(test.name);
  if (!played) return { datasets, dataset: null };
  if (!played.own) return { datasets, dataset: played.name };
  let name = 'rows';
  for (let n = 2; datasets[name]; n += 1) name = `rows_${n}`;
  return { datasets: { ...datasets, [name]: played.rows }, dataset: name };
}

/** Binds a test to a dataset of its project (by id or name), or to none (null). */
export function bindDataset(testName, dataset) {
  const test = db.prepare('SELECT id, project_id FROM tests WHERE name = ?').get(testName);
  if (!test) return { error: 'Test not found', status: 404 };
  if (dataset == null || dataset === '') {
    db.prepare('UPDATE tests SET dataset_id = NULL WHERE id = ?').run(test.id);
    return { dataset: null };
  }
  const found = typeof dataset === 'number' || /^\d+$/.test(String(dataset))
    ? db.prepare('SELECT * FROM datasets WHERE id = ?').get(Number(dataset))
    : db.prepare('SELECT * FROM datasets WHERE project_id = ? AND name = ?').get(test.project_id, String(dataset));
  if (!found) return { error: `No dataset "${dataset}" in the test's project`, status: 404 };
  if (found.project_id !== test.project_id) return { error: 'The dataset belongs to another project than the test', status: 400 };
  db.prepare('UPDATE tests SET dataset_id = ? WHERE id = ?').run(found.id, test.id);
  return { dataset: asDataset(found) };
}

/**
 * The datasets of a project as an agent is told them, one line each: its columns, its number of
 * rows and its first row — what it has to test with ({{users[1].email}}).
 */
// A column that holds a password, a key, a code: its values are not shown to an agent. Typed
// as {{password}} they still are, by the server; a secret of the project is better
// ({{secret.NAME}}, lib/secrets.js).
const SENSITIVE_COLUMN = /pass|pwd|mot.?de.?passe|secret|token|api.?key|cl[eé].?api|otp|pin.?code|code.?pin/i;

/** A value of a dataset as an agent is shown it: one of a sensitive column hidden, unless it is a reference. */
export function shownValue(column, value) {
  const text = String(value ?? '');
  if (!SENSITIVE_COLUMN.test(column) || !text || /^\{\{\s*secret\.[A-Za-z_]\w*\s*\}\}$/.test(text)) return text;
  return '(hidden)';
}

/** A row of a dataset as an agent is shown it (shownValue). */
export function shownRow(row) {
  if (!row) return row;
  return Object.fromEntries(Object.entries(row).map(([column, value]) => [column, shownValue(column, value)]));
}

export function datasetLines(projectId) {
  if (!projectId) return [];
  const short = (value) => JSON.stringify(value.length > 40 ? `${value.slice(0, 39)}…` : value);
  return db.prepare('SELECT * FROM datasets WHERE project_id = ? ORDER BY name').all(projectId).map((row) => {
    const { name, columns, rows } = asDataset(row, { withRows: true });
    const first = columns.map((column) => `${column} ${short(shownValue(column, rows[0]?.[column]))}`).join(', ');
    return `- ${name}: ${columns.join(', ')} — ${rows.length} row(s); row 1: ${first}`;
  });
}

/**
 * The project a recording is for and the dataset it plays (start_recording's project_id and
 * dataset), checked as it starts: `{ dataset }` — its name and its first row, which {{column}}
 * is while recording; null when it plays none — or `{ error }`, naming the datasets there are.
 */
export function recordingDataset(projectId, name) {
  if (projectId != null && !db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) return { error: `No project ${projectId}` };
  if (!name) return { dataset: null };
  if (projectId == null) return { error: `A dataset belongs to a project: pass its project_id with dataset "${name}"` };
  const found = db.prepare('SELECT * FROM datasets WHERE project_id = ? AND name = ?').get(projectId, String(name));
  if (!found) {
    const names = listDatasets(projectId).map((d) => d.name);
    return { error: `No dataset "${name}" in project ${projectId}: ${names.length ? `its datasets are ${names.join(', ')}` : 'it has none'}` };
  }
  const { rows } = asDataset(found, { withRows: true });
  return { dataset: { name: found.name, row: rows[0], rowCount: rows.length } };
}

/** What start_recording says of the datasets: the one it plays, or those it may take a value from. */
export function recordingDatasetText(projectId, dataset) {
  if (dataset) {
    return `\nIt plays the dataset "${dataset.name}" (${dataset.rowCount} rows): type {{${Object.keys(dataset.row).join('}}, {{')}}}`
      + ' — the values of its row 1 now, those of each row at run.';
  }
  const lines = datasetLines(projectId);
  return lines.length ? `\nThe datasets of the project — take a value from one rather than make one up, as {{users[1].email}}:\n${lines.join('\n')}` : '';
}

/**
 * A recorded test, saved, put in the project it was recorded for and bound to the dataset it
 * played (start_recording's project_id and dataset): what stop_recording says of it.
 */
export function placeRecorded(recording) {
  if (!recording.projectId) return '';
  db.prepare("UPDATE tests SET project_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?").run(recording.projectId, recording.name);
  if (!recording.dataset) return '';
  const result = bindDataset(recording.name, recording.dataset.name);
  return result.error
    ? `\nNot bound to the dataset "${recording.dataset.name}": ${result.error}`
    : `\nBound to the dataset "${recording.dataset.name}": it runs once per row of it (${recording.dataset.rowCount} rows), each column a variable of the run.`;
}

/**
 * The columns of the dataset a test is bound to, as variables of it whose value is that of row 1:
 * what an assertion added to it may be linked to — the name a row shows, not only what was typed.
 */
export function datasetVariables(testName) {
  const row = datasetOfTest(testName)?.rows[0] ?? {};
  return Object.fromEntries(Object.entries(row).map(([column, value]) => [column, { type: 'text', defaultValue: value }]));
}

/**
 * A test's variables with the columns of its dataset an expected value names ({{name}}, linked
 * or written so): its own, row 1's value by default — unbound, the test still checks that row.
 */
export function withColumnsOf(variables, fromDataset, expected) {
  const named = [...String(expected ?? '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
  const added = [...new Set(named)].filter((name) => fromDataset[name] && !variables?.[name]);
  return added.length ? { ...variables, ...Object.fromEntries(added.map((name) => [name, fromDataset[name]])) } : variables;
}

/** A short label for a row: its number and its first values ("row 2 — bob@x.dev, Bob"). */
export function rowLabel(row, number) {
  const values = Object.values(row ?? {}).filter((v) => v !== '').slice(0, 2).map((v) => (v.length > 30 ? `${v.slice(0, 29)}…` : v));
  return `row ${number}${values.length ? ` — ${values.join(', ')}` : ''}`;
}
