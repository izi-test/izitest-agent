// Requirements imported from a file: a spreadsheet (CSV, TSV, Excel .xlsx — a test plan, a
// Jira export), a JSON export, a Markdown spec. Each is read into the records save_requirement
// keeps — key, title, description, acceptance criteria, priority, link — and shown before
// anything is saved: what is new, what changed, what is the same. Saved, a requirement
// imported again is updated under its key (or, without one, its title), and its criteria
// whose text did not change keep their tests.

import { inflateRawSync } from 'node:zlib';
import { db } from './db.js';
import { saveRequirement, getRequirement, contentHash, PRIORITIES } from './requirements.js';

export const FORMATS = ['csv', 'xlsx', 'json', 'markdown'];
export const FIELDS = ['key', 'title', 'description', 'criteria', 'priority', 'url'];
const MAX_BYTES = 5 * 1024 * 1024;

// ─── Text ────────────────────────────────────────────────────────────

/** A file's text: UTF-8 (its BOM dropped), else Windows-1252 — what older Excel saves CSV in. */
export function textOf(content) {
  if (typeof content === 'string') return content.replace(/^\uFEFF/, '');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(content);
  }
}

const plain = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
/** A name as it is compared: no accents, no case, words between single spaces. */
export const fold = (s) => plain(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// A list item's marker: "- ", "* ", "• ", "1.", "1)", "# " (Jira's numbered list), a task box, "AC1:".
const BULLET = /^\s*(?:[-*+•▪◦#]\s+|\d+[.)]\s+|\[[ xX]\]\s+|(?:AC|CA)\s*\d+\s*[:.)-]\s*)/;

/** A cell or a block of text as criteria: one per line, its list marker dropped — a Gherkin scenario's steps one. */
export function splitCriteria(text) {
  return scenarios(String(text ?? '').split(/\r?\n/)
    .map((line) => line.replace(BULLET, '').replace(/^\[[ xX]\]\s+/, '').trim())
    .filter(Boolean));
}

// A Gherkin step, in English or French: its context ("Given", "Étant donné", "Soit"), its action
// ("When", "Quand", "Lorsque"), its outcome ("Then", "Alors"), or one going on ("And", "Et",
// "But", "Mais"); a scenario's name ("Scenario:", "Scénario :").
const STEPS = [
  ['given', /^(?:given|etant donnee?s?|soit|sachant que?)\b/i],
  ['when', /^(?:when|quand|lorsque?)\b/i],
  ['then', /^(?:then|alors)\b/i],
  ['and', /^(?:and|but|et|mais)\b/i],
];
const SCENARIO = /^(?:scenario(?: outline| template)?|plan du scenario|example|exemple)\s*:/i;
const stepOf = (line) => {
  const text = plain(line).trim();
  return SCENARIO.test(text) ? 'name' : STEPS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
};

/**
 * Criteria with Gherkin scenarios among them, one criterion a scenario: "Étant donné …, quand
 * …, alors …", its name before it. A context or an action after an outcome starts the next one;
 * steps that make no whole scenario (no outcome) stay criteria of their own.
 */
function scenarios(lines) {
  const criteria = [];
  let run = { name: null, steps: [], phase: null };
  const flush = () => {
    if (run.steps.length > 1 && run.steps.some((s) => s.kind === 'then')) {
      const text = run.steps.map((s, i) => (i ? s.text[0].toLowerCase() + s.text.slice(1) : s.text).replace(/[\s.,;]+$/, '')).join(', ');
      criteria.push(run.name ? `${run.name} — ${text}` : text);
    } else criteria.push(...(run.name ? [run.name] : []), ...run.steps.map((s) => s.text));
    run = { name: null, steps: [], phase: null };
  };
  for (const line of lines) {
    const kind = stepOf(line);
    if (kind === 'name') {
      flush();
      run.name = line.slice(line.indexOf(':') + 1).trim() || null;
    } else if (!kind || (kind === 'and' && !run.steps.length)) {
      flush();
      criteria.push(line);
    } else {
      if (run.phase === 'then' ? kind !== 'then' && kind !== 'and' : run.phase === 'when' && kind === 'given') flush();
      run.steps.push({ kind, text: line });
      if (kind !== 'and') run.phase = kind;
    }
  }
  flush();
  return criteria;
}

// The line that opens a list of criteria: "Acceptance criteria:", "## Critères d'acceptation",
// Jira's "h3. Acceptance Criteria" or "*AC:*".
const CRITERIA_HEADING = /^\s*(?:h\d\.\s*|#+\s*)?[*_]*\s*(?:acceptance criteria|criteres? d['’ ]?\s*acceptation|conditions? of acceptance|ac)\s*[*_]*\s*:?\s*[*_]*\s*$/i;
const isCriteriaHeading = (line) => CRITERIA_HEADING.test(plain(line));

/**
 * Criteria written inside a description, as a Jira story often has them: the list, or the
 * Gherkin steps, under an "Acceptance criteria" line. The criteria, and the description without them.
 */
export function criteriaFromText(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const at = lines.findIndex(isCriteriaHeading);
  if (at < 0) return { criteria: [], description: String(text ?? '').trim() };
  // A list item, a step ("And" only after one), a scenario's name.
  const listed = (i) => BULLET.test(lines[i]) || ['given', 'when', 'then', 'name'].includes(stepOf(lines[i]))
    || (stepOf(lines[i]) === 'and' && i > at + 1 && !!stepOf(lines[i - 1]));
  let end = at + 1;
  while (end < lines.length && (listed(end) || (!lines[end].trim() && end + 1 < lines.length && listed(end + 1)))) end++;
  const criteria = splitCriteria(lines.slice(at + 1, end).join('\n'));
  return { criteria, description: [...lines.slice(0, at), ...lines.slice(end)].join('\n').trim() };
}

const PRIORITY_WORDS = {
  high: ['high', 'highest', 'haute', 'haut', 'elevee', 'eleve', 'critical', 'critique', 'blocker', 'bloquant', 'bloquante', 'majeure', 'majeur', 'urgent', 'urgente', 'must', 'p0', 'p1', '1'],
  medium: ['medium', 'moyenne', 'moyen', 'normal', 'normale', 'should', 'p2', '2'],
  low: ['low', 'lowest', 'basse', 'bas', 'faible', 'mineure', 'mineur', 'minor', 'trivial', 'could', 'p3', 'p4', '3', '4'],
};

/** A priority as written ("Haute", "Highest", "P1"…) as one IziTest knows; unknown: null. */
export function priorityOf(value) {
  const word = fold(value);
  if (!word) return null;
  return PRIORITIES.find((p) => PRIORITY_WORDS[p].includes(word)) ?? null;
}

// ─── Tables: CSV, TSV, Excel ─────────────────────────────────────────

/** The delimiter of a CSV: the one of ; , tab found most in its first line (outside quotes). */
function delimiterOf(text) {
  const firstLine = text.split(/\r?\n/, 1)[0].replace(/"[^"]*"/g, '');
  const [best, count] = [';', ',', '\t'].map((d) => [d, firstLine.split(d).length - 1]).sort((a, b) => b[1] - a[1])[0];
  return count > 0 ? best : ',';
}

/** CSV rows (RFC 4180: quoted fields, "" for a quote, line breaks inside quotes). */
export function parseCsv(text, delimiter = delimiterOf(text)) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** The files of a ZIP archive (an .xlsx is one): name → content. Stored or deflated entries. */
function unzip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('Not an Excel file (.xlsx): no ZIP directory in it');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(data) : data);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const unescapeXml = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e) => (
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e]));

/** The text of an XML element holding <t> runs (a shared string, an inline string): all its runs, phonetic ones aside. */
const runsOf = (xml) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)]
  .map((m) => unescapeXml(m[1] ?? '')).join('');

const columnIndex = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** The rows of a sheet of an Excel workbook: the one named `sheetName`, or the first. */
export function parseXlsx(buffer, sheetName = null) {
  const files = unzip(buffer);
  const read = (name) => files.get(name)?.toString('utf8') ?? null;
  const workbook = read('xl/workbook.xml');
  if (!workbook) throw new Error('Not an Excel workbook (.xlsx): no xl/workbook.xml in it');
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({
    name: unescapeXml(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? ''), rel: /\br:id="([^"]*)"/.exec(m[1])?.[1] ?? /\bid="([^"]*)"/.exec(m[1])?.[1],
  }));
  const sheet = sheetName ? sheets.find((s) => s.name === sheetName) : sheets[0];
  if (!sheet) throw new Error(`No sheet "${sheetName}" in the workbook (it has ${sheets.map((s) => `"${s.name}"`).join(', ')})`);
  const rels = read('xl/_rels/workbook.xml.rels') ?? '';
  const target = new RegExp(`<Relationship\\b[^>]*\\bId="${sheet.rel}"[^>]*\\bTarget="([^"]*)"`).exec(rels)?.[1]
    ?? new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]*)"[^>]*\\bId="${sheet.rel}"`).exec(rels)?.[1];
  const path = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target}`) : 'xl/worksheets/sheet1.xml';
  const xml = read(path);
  if (!xml) throw new Error(`The sheet "${sheet.name}" is not in the file`);
  const shared = [...(read('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runsOf(m[1]));
  const rows = [];
  for (const [, attributes, body = ''] of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const index = Number(/\br="(\d+)"/.exec(attributes)?.[1] ?? rows.length + 1) - 1;
    const cells = [];
    for (const [, cellAttributes, inner = ''] of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([A-Z]+\d+)"/.exec(cellAttributes)?.[1];
      const type = /\bt="([^"]*)"/.exec(cellAttributes)?.[1];
      const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      const text = type === 's' ? shared[Number(value)] ?? ''
        : type === 'inlineStr' ? runsOf(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '')
          : type === 'b' ? (value === '1' ? 'TRUE' : 'FALSE')
            : unescapeXml(value ?? '');
      cells[ref ? columnIndex(ref) : cells.length] = text;
    }
    rows[index] = Array.from(cells, (c) => c ?? '');
  }
  return Array.from(rows, (r) => r ?? []);
}

// What each field's column is called, in English and French; a Jira CSV export's names too.
const HEADERS = {
  key: ['key', 'id', 'ref', 'reference', 'cle', 'issue key', 'ticket', 'requirement id', 'req id', 'exigence id', 'id exigence', 'identifiant', 'numero', 'n', 'no', 'code'],
  title: ['title', 'summary', 'titre', 'resume', 'intitule', 'name', 'nom', 'exigence', 'requirement', 'user story', 'story', 'libelle', 'sujet', 'subject'],
  description: ['description', 'desc', 'details', 'detail', 'contexte', 'context', 'enonce'],
  criteria: ['acceptance criteria', 'criteria', 'criterion', 'criteres d acceptation', 'critere d acceptation', 'criteres', 'critere', 'ac', 'conditions of acceptance', 'regles de gestion', 'regle de gestion', 'resultat attendu', 'resultats attendus', 'expected result', 'expected results'],
  priority: ['priority', 'priorite', 'criticite', 'importance', 'severity', 'severite'],
  url: ['url', 'link', 'lien', 'issue link'],
};

/**
 * Which column holds each field: the header that is one of its names, else one that contains
 * one ("Custom field (Acceptance Criteria)"). Each column serves one field at most.
 */
export function detectColumns(headers) {
  const folded = headers.map(fold);
  const used = new Set();
  const columns = {};
  for (const exact of [true, false]) {
    for (const field of FIELDS) {
      if (columns[field] != null) continue;
      const at = folded.findIndex((h, i) => !used.has(i) && h && HEADERS[field].some((name) => (exact ? h === name : name.length > 2 && ` ${h} `.includes(` ${name} `))));
      if (at >= 0) { columns[field] = at; used.add(at); }
    }
  }
  return columns;
}

/**
 * Requirements from the rows of a table: the first non-empty row names the columns. A row
 * with no key nor title, but criteria, adds them to the requirement above it (one criterion
 * per row); rows with the same key are one requirement. `columns` names, field by field,
 * the header to take it from, over what is detected.
 */
export function requirementsFromRows(rows, columnsGiven = {}) {
  const start = rows.findIndex((r) => r.some((c) => String(c).trim()));
  if (start < 0) return { requirements: [], headers: [], columns: {}, warnings: ['The file is empty'] };
  const headers = rows[start].map((h) => String(h).trim());
  const columns = detectColumns(headers);
  for (const [field, header] of Object.entries(columnsGiven ?? {})) {
    if (!FIELDS.includes(field)) continue;
    if (header == null || header === '') { delete columns[field]; continue; }
    const at = headers.indexOf(header);
    if (at < 0) throw new Error(`No column "${header}" for ${field} (the columns: ${headers.map((h) => `"${h}"`).join(', ')})`);
    columns[field] = at;
  }
  if (columns.title == null) {
    throw new Error(`No column for the title: name it Title (or Summary, Titre, Intitulé…), or say which it is. The columns: ${headers.map((h) => `"${h}"`).join(', ')}`);
  }
  const jira = headers.some((h) => fold(h) === 'issue key');
  const cell = (row, field) => (columns[field] != null ? String(row[columns[field]] ?? '').trim() : '');
  const warnings = [];
  // A column of plain numbers (1, 2, 3…) numbers the rows: as keys, "12" would name requirement #12.
  const numbered = columns.key != null && rows.slice(start + 1).every((row) => /^\d*$/.test(cell(row, 'key')));
  if (numbered) warnings.push(`The column "${headers[columns.key]}" holds plain numbers: taken as row numbers, not keys`);
  const byKey = new Map();
  const requirements = [];
  let last = null;
  rows.slice(start + 1).forEach((row, i) => {
    const line = start + i + 2;
    if (!row.some((c) => String(c).trim())) return;
    const key = numbered ? '' : cell(row, 'key');
    const title = cell(row, 'title');
    // Nothing in the key and title cells: the rest of the requirement above (its next criterion).
    if (!cell(row, 'key') && !title) {
      if (last && cell(row, 'criteria')) last.criteria.push(...splitCriteria(cell(row, 'criteria')));
      else warnings.push(`Row ${line}: no title — skipped`);
      return;
    }
    if (!key && !title) {
      warnings.push(`Row ${line}: no title — skipped`);
      return;
    }
    // Rows of one requirement: the same key, or — with none — the same title (a criterion per row).
    const known = byKey.get(key || `title:${title}`);
    if (known) {
      known.criteria.push(...splitCriteria(cell(row, 'criteria')));
      last = known;
      return;
    }
    if (!title) {
      warnings.push(`Row ${line}: ${key} has no title — skipped`);
      return;
    }
    const written = priorityOf(cell(row, 'priority'));
    if (cell(row, 'priority') && !written) warnings.push(`Row ${line}: priority "${cell(row, 'priority')}" not known — medium`);
    const requirement = {
      key: key || null, title, description: cell(row, 'description'), criteria: splitCriteria(cell(row, 'criteria')),
      priority: written ?? 'medium', url: cell(row, 'url') || null, source: jira ? 'jira' : 'import', line,
    };
    byKey.set(key || `title:${title}`, requirement);
    requirements.push(requirement);
    last = requirement;
  });
  return { requirements, headers, columns: Object.fromEntries(Object.entries(columns).map(([f, i]) => [f, headers[i]])), warnings };
}

// ─── JSON ────────────────────────────────────────────────────────────

const first = (object, names) => names.map((n) => object?.[n]).find((v) => v != null && v !== '');

/** Requirements from JSON: a list of them, { requirements: [...] }, or one; field names as written by most tools. */
export function requirementsFromJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Not valid JSON: ${err.message}`);
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.requirements) ? data.requirements : Array.isArray(data?.issues) ? data.issues : [data];
  const warnings = [];
  const requirements = list.flatMap((item, i) => {
    const fields = item?.fields && typeof item.fields === 'object' ? { ...item.fields, key: item.key } : item;
    const title = String(first(fields, ['title', 'summary', 'name', 'titre']) ?? '').trim();
    if (!title) {
      warnings.push(`Item ${i + 1}: no title — skipped`);
      return [];
    }
    const given = first(fields, ['criteria', 'acceptance_criteria', 'acceptanceCriteria', 'acceptance criteria', 'criteres']);
    const description = typeof fields.description === 'string' ? fields.description : '';
    const listed = Array.isArray(given) ? given.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).map((c) => c.trim()).filter(Boolean)
      : typeof given === 'string' ? splitCriteria(given) : [];
    const fromText = listed.length ? null : criteriaFromText(description);
    const priority = fields.priority?.name ?? fields.priority;
    return [{
      key: first(fields, ['key', 'id', 'ref']) != null ? String(first(fields, ['key', 'id', 'ref'])) : null,
      title, description: fromText ? fromText.description : description.trim(), criteria: fromText ? fromText.criteria : listed,
      priority: priorityOf(priority) ?? 'medium', url: first(fields, ['url', 'link']) ?? null,
      source: ['prompt', 'manual', 'jira', 'import'].includes(fields.source) ? fields.source : item?.fields ? 'jira' : 'import',
    }];
  });
  return { requirements, warnings };
}

// ─── Markdown ────────────────────────────────────────────────────────

const KEY_IN_TITLE = /^([A-Z][A-Z0-9]+-\d+)\s*[—–:\-|]?\s*(.*)$/;
const FIELD_LINE = /^\s*(?:\*\*)?\s*(priority|priorite|priorité|link|lien|url|key|cle|clé|id)\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+?)\s*$/i;

/**
 * Requirements from Markdown: each heading with something under it is one — its key when the
 * heading starts with one ("## SHOP-12 — Title"), the items of its lists as criteria (and the
 * Gherkin steps under an "Acceptance criteria" line, a scenario one), a
 * "Priority:" or "Link:" line, the rest as its description. A heading with only headings
 * under it (the document's title, a chapter) is not one.
 */
export function requirementsFromMarkdown(text) {
  const blocks = [];
  let current = null;
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = !fenced && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading && !isCriteriaHeading(line)) {
      current = { level: heading[1].length, heading: heading[2].trim(), lines: [] };
      blocks.push(current);
    } else if (current) current.lines.push(line);
  }
  const warnings = [];
  // The document's title, a chapter: a heading above others, with no key nor list of its own.
  const deepest = Math.max(...blocks.map((b) => b.level));
  const isChapter = (block) => block.level < deepest && !KEY_IN_TITLE.test(block.heading) && !block.lines.some((l) => BULLET.test(l));
  const requirements = blocks.flatMap((block) => {
    if (!block.lines.some((l) => l.trim()) || isChapter(block)) return [];
    const [, key = null, rest = block.heading] = KEY_IN_TITLE.exec(block.heading) ?? [];
    const requirement = { key, title: (rest || block.heading).trim(), description: '', criteria: [], priority: 'medium', url: null, source: 'import' };
    const description = [];
    let code = false;
    let underCriteria = false;
    for (const line of block.lines) {
      // A code block is description, whatever it holds; "#" is no list marker in Markdown.
      if (/^\s*(```|~~~)/.test(line)) code = !code;
      if (code || /^\s*(```|~~~)/.test(line)) {
        description.push(line);
        continue;
      }
      const item = BULLET.test(line) && !/^\s*#/.test(line);
      const field = FIELD_LINE.exec(line.replace(BULLET, ''));
      if (field) {
        const name = fold(field[1]);
        if (name === 'priority' || name === 'priorite') requirement.priority = priorityOf(field[2]) ?? 'medium';
        else if (name === 'key' || name === 'cle' || name === 'id') requirement.key = field[2];
        else requirement.url = field[2];
      } else if (item) requirement.criteria.push(...splitCriteria(line));
      else if (isCriteriaHeading(line)) underCriteria = true;
      else if (underCriteria && stepOf(line)) requirement.criteria.push(line.trim());
      else description.push(line);
    }
    // Steps a line each, as list items or not: a scenario one criterion.
    requirement.criteria = scenarios(requirement.criteria);
    requirement.description = description.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!requirement.title) {
      warnings.push(`Heading "${block.heading}": no title — skipped`);
      return [];
    }
    return [requirement];
  });
  return { requirements, warnings };
}

// ─── Any file ────────────────────────────────────────────────────────

/** A file's format, from its name, else from what it holds. */
export function detectFormat({ filename = '', content }) {
  const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  if (extension === 'xlsx' || extension === 'xlsm') return 'xlsx';
  if (extension === 'json') return 'json';
  if (['md', 'markdown'].includes(extension)) return 'markdown';
  if (['csv', 'tsv', 'tab'].includes(extension)) return 'csv';
  if (typeof content !== 'string' && content?.[0] === 0x50 && content?.[1] === 0x4b) return 'xlsx';
  const text = textOf(content).trimStart();
  if (text.startsWith('{') || text.startsWith('[')) return 'json';
  if (/^#{1,6}\s/m.test(text) && !/^[^\n]*[;,\t][^\n]*\n/.test(text)) return 'markdown';
  return 'csv';
}

/**
 * The requirements a file holds, read: `content` a string or a Buffer (an .xlsx must be one);
 * `format` when known; `columns` for a table, the header of each field; `sheet` for Excel.
 */
export function parseRequirements({ content, filename = '', format = null, columns = {}, sheet = null }) {
  if (content == null || (content.length ?? 0) === 0) throw new Error('The file is empty');
  if (content.length > MAX_BYTES) throw new Error(`The file is too big (${Math.round(content.length / 1024)} KB, 5 MB at most)`);
  const kind = format ?? detectFormat({ filename, content });
  if (!FORMATS.includes(kind)) throw new Error(`No such format: ${kind} (${FORMATS.join(', ')})`);
  if (kind === 'xlsx') {
    if (typeof content === 'string') throw new Error('An Excel file has to be given as its bytes, not as text');
    return { format: kind, ...requirementsFromRows(parseXlsx(content, sheet), columns) };
  }
  const text = textOf(content);
  if (kind === 'json') return { format: kind, ...requirementsFromJson(text) };
  if (kind === 'markdown') return { format: kind, ...requirementsFromMarkdown(text) };
  return { format: kind, ...requirementsFromRows(parseCsv(text, /\.tsv$/i.test(filename) ? '\t' : undefined), columns) };
}

/** The requirement already saved that an imported one is: by its key, else its title (in the project). */
function existingOf(requirement, projectId) {
  if (requirement.key) return getRequirement(requirement.key);
  const row = db.prepare('SELECT id FROM requirements WHERE title = ? AND (project_id IS ? OR ? IS NULL) ORDER BY id LIMIT 1')
    .get(requirement.title, projectId, projectId);
  return row ? getRequirement(row.id) : null;
}

/**
 * Import the requirements of a file: each new one, changed or unchanged against what is
 * saved — and, unless `dryRun`, saved (in `projectId`).
 */
export function importRequirements({ content, filename = '', format = null, columns = {}, sheet = null, projectId = null, dryRun = false }) {
  const parsed = parseRequirements({ content, filename, format, columns, sheet });
  return applyImport(parsed.requirements, { ...parsed, projectId, dryRun });
}

/**
 * Requirements read from anywhere (a file, Jira) against what is saved: each new, changed or
 * unchanged — and, unless `dryRun`, saved. Criteria found in a description ("Acceptance
 * criteria" and its list) are taken out of it when nothing else gave any.
 */
export function applyImport(requirements, { format, headers = null, columns = null, warnings = [], projectId = null, dryRun = false }) {
  const items = requirements.map((r) => {
    const extracted = r.criteria.length ? null : criteriaFromText(r.description);
    const requirement = extracted?.criteria.length ? { ...r, criteria: extracted.criteria, description: extracted.description } : r;
    const existing = existingOf(requirement, projectId);
    const hash = contentHash({ title: requirement.title.trim(), description: requirement.description, criteria: requirement.criteria.map((c) => c.trim()) });
    const status = !existing ? 'new' : existing.content_hash === hash ? 'unchanged' : 'changed';
    return { ...requirement, key: requirement.key ?? existing?.key ?? null, status, linked_tests: existing?.coverage.tests ?? 0 };
  });
  if (!dryRun) {
    db.transaction(() => {
      for (const item of items) {
        const { requirement } = saveRequirement({
          key: item.key ?? undefined, title: item.title, description: item.description, criteria: item.criteria,
          source: item.source, url: item.url, projectId, priority: item.priority,
        });
        item.key = requirement.key;
      }
    })();
  }
  const count = (status) => items.filter((i) => i.status === status).length;
  return {
    format, headers, columns, warnings,
    saved: !dryRun, items, new: count('new'), changed: count('changed'), unchanged: count('unchanged'),
  };
}

/** An import as the agent reads it. */
export function formatImport(result) {
  const lines = [
    `${result.saved ? 'Imported' : 'Would import'} ${result.items.length} requirement(s) from ${result.format}: ${result.new} new, ${result.changed} changed, ${result.unchanged} unchanged.`,
  ];
  if (result.columns) lines.push(`Columns: ${Object.entries(result.columns).map(([field, header]) => `${field} ← "${header}"`).join(', ')}`);
  for (const item of result.items) {
    lines.push(`  ${item.status.toUpperCase().padEnd(9)} ${item.key ?? '(new key)'} — ${item.title} [${item.priority}, ${item.criteria.length} criteria]`
      + (item.status === 'changed' && item.linked_tests ? ` — ${item.linked_tests} test(s) linked: check they still match it` : ''));
  }
  for (const warning of result.warnings) lines.push(`  ! ${warning}`);
  if (!result.saved) lines.push('Nothing saved yet: show this to the user, then import again with dry_run: false.');
  else if (result.new + result.changed) lines.push('Next: design_tests on each new or changed one, to review its criteria and design its tests.');
  return lines.join('\n');
}
