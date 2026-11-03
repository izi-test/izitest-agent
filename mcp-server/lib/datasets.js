// The datasets of a project: tables of values — a CSV, a JSON or an Excel sheet dropped in —
// that a test bound to one runs once per row of (each column a variable of the run: {{email}}),
// and any test reads a value of ({{utilisateurs[2].email}}, rows numbered from 1). A campaign
// runs a bound test once per row.

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

/** A short label for a row: its number and its first values ("row 2 — bob@x.dev, Bob"). */
export function rowLabel(row, number) {
  const values = Object.values(row ?? {}).filter((v) => v !== '').slice(0, 2).map((v) => (v.length > 30 ? `${v.slice(0, 29)}…` : v));
  return `row ${number}${values.length ? ` — ${values.join(', ')}` : ''}`;
}
