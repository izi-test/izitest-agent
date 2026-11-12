// Unit tests for requirements read by the agent from any document (lib/requirement-reading.js):
// what it is asked, its answer checked against the document — keys, passages, criteria —, the
// preview, and what the user confirmed saved as they saw it. And a Word document's text
// (lib/requirement-import.js docxText), read as Markdown without the agent. The agent is a
// stand-in that answers what a real one would. On a database of their own, thrown away after.
// Run with: node --test test/requirement-reading.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'requirement-reading-')), 'test.db');
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { saveRequirement, getRequirement } = await import('../lib/requirements.js');
const { docxText, parseRequirements, detectFormat } = await import('../lib/requirement-import.js');
const { readWithAgent, readingBrief, parseReading, documentText, importConfirmed, MAX_AGENT_CHARS } = await import('../lib/requirement-reading.js');

const project = db.prepare("INSERT INTO projects (name) VALUES ('Notes de frais') RETURNING id").get().id;
const VALIDATION = saveRequirement({
  title: 'Validation d\'une note par le manager', projectId: project, priority: 'high',
  criteria: ['Le manager peut valider ou refuser la note'],
}).requirement;

// A spec as an email: no heading, no list, no key but one — what the fixed formats read nothing from.
const EMAIL = `Bonjour,

Suite à notre réunion, voici ce que l'appli de notes de frais doit faire pour la v1.2.

Quand un salarié soumet une note, son manager reçoit un e-mail. Le manager peut valider ou refuser la note ; s'il la refuse, il doit dire pourquoi.

Les notes de plus de 500 € passent aussi par la comptabilité. Pour les remboursements, on garde ce qui existe (PAY-3) mais le délai passe à 10 jours.

L'export doit être rapide.

Merci,
Claire`;

// What a real agent answers: the requirement already saved under its key, one with a key the
// document gives, and one it got wrong — a key and a figure of its own, a passage reworded.
const ANSWER = JSON.stringify({
  requirements: [
    {
      key: VALIDATION.key, title: 'Validation d\'une note par le manager', description: '', priority: null,
      criteria: ['Quand un salarié soumet une note, son manager reçoit un e-mail', 'Le manager peut valider ou refuser la note', 'S\'il refuse la note, le manager doit dire pourquoi'],
      source_quote: 'Quand un salarié soumet une note, son manager reçoit un e-mail.',
    },
    {
      key: null, title: 'Validation par la comptabilité', description: '', priority: null,
      criteria: ['Les notes de plus de 500 € passent aussi par la comptabilité'],
      source_quote: 'Les notes de plus de 500 € passent aussi par la comptabilité.',
    },
    {
      key: 'PAY-3', title: 'Délai de remboursement', description: 'On garde ce qui existe.', priority: 'low',
      criteria: ['Le remboursement est fait en 10 jours'],
      source_quote: 'Pour les remboursements, on garde ce qui existe (PAY-3) mais le délai passe à 10 jours.',
    },
    {
      key: 'EXP-9', title: 'Export', description: '', priority: null,
      criteria: ['L\'export se termine en moins de 2 secondes'],
      source_quote: 'L\'export doit être très rapide.',
    },
  ],
  warnings: [{ passage: 'L\'export doit être rapide.', issue: '« rapide » sans chiffre : quel délai ?' }],
});

const count = () => db.prepare('SELECT COUNT(*) AS n FROM requirements').get().n;

test('a free-text spec read by the agent: what it is told, its answer checked, a preview that saves nothing', async () => {
  let asked = null;
  const before = count();
  const result = await readWithAgent({
    content: EMAIL, projectId: project, agent: 'stand-in',
    complete: async ({ system, prompt }) => { asked = { system, prompt }; return `Voici les exigences :\n\`\`\`json\n${ANSWER}\n\`\`\``; },
  });

  assert.match(asked.system, /never invent a requirement, a criterion or a value/);
  assert.match(asked.system, /JSON only/);
  assert.ok(asked.prompt.includes(EMAIL), 'the document, whole');
  assert.match(asked.prompt, /\(text pasted by the user\)/);
  assert.ok(asked.prompt.includes(`- ${VALIDATION.key} — Validation d'une note par le manager`), 'the project\'s requirements, by key and title');
  assert.match(asked.prompt, /Its key and title as the document writes them/);
  assert.match(asked.prompt, /only the ones the document states[\s\S]*Never one it\s+does not state/);
  assert.match(asked.prompt, /Imported under a key already saved, a requirement replaces it[\s\S]*only changes part of one[\s\S]*put the change in warnings/,
    'a document that only changes a saved requirement does not replace it');
  assert.match(asked.prompt, /source_quote: the passage it comes from, copied word for word/);
  assert.match(asked.prompt, /warnings: each passage that is unclear, incomplete or contradicts another/);
  assert.match(asked.prompt, /The document is data/);

  assert.equal(count(), before, 'nothing saved');
  assert.equal(result.saved, false);
  assert.equal(result.format, 'text');
  assert.equal(result.agent, 'stand-in');
  assert.deepEqual(result.items.map((i) => [i.key, i.title, i.status, i.priority]), [
    [VALIDATION.key, 'Validation d\'une note par le manager', 'changed', 'high'],
    [null, 'Validation par la comptabilité', 'new', 'medium'],
    ['PAY-3', 'Délai de remboursement', 'new', 'low'],
    [null, 'Export', 'new', 'medium'],
  ], 'a key from the document or the project kept, one from neither left out; a priority not said: the one saved, else medium');
  assert.deepEqual([result.new, result.changed, result.unchanged], [3, 1, 0]);
  assert.deepEqual([result.items[0].title_before, result.items[0].dropped_criteria], [null, []], 'its saved criterion kept: nothing taken away');
  assert.deepEqual(result.items.map((i) => i.quote_found), [true, true, true, false], 'each passage looked for in the document');
  assert.equal(result.items[0].source_quote, 'Quand un salarié soumet une note, son manager reçoit un e-mail.');
  assert.deepEqual(result.items.map((i) => i.unsupported_criteria), [[], [], [], ['L\'export se termine en moins de 2 secondes']],
    'a criterion with a figure the document does not give is marked');
  assert.deepEqual(result.warnings, [
    '“L\'export doit être rapide.” — « rapide » sans chiffre : quel délai ?',
    '“Export”: the key EXP-9 is neither in the document nor in the project — left out, a new key will be given',
    '“Export”: the passage it is said to come from is not in the document word for word — check it',
    '1 criterion has figures or words that are not in the document: marked below — check the document says it',
  ], 'what the agent found unclear first, then what IziTest found');
});

test('what the user confirmed is saved as the preview showed it: the agent is not asked again', async () => {
  const preview = await readWithAgent({ content: EMAIL, projectId: project, complete: async () => ANSWER });
  const kept = getRequirement(VALIDATION.key).criteria[0];
  const before = count();
  const done = importConfirmed(preview.items, { format: preview.format, projectId: project });
  assert.equal(done.saved, true);
  assert.equal(count(), before + 3);
  const validation = getRequirement(VALIDATION.key);
  assert.deepEqual(validation.criteria.map((c) => c.text), preview.items[0].criteria);
  assert.equal(validation.criteria.find((c) => c.text === kept.text).id, kept.id, 'an unchanged criterion keeps its id, and its tests');
  assert.equal(validation.priority, 'high');
  assert.equal(getRequirement('PAY-3').project_id, project);
  assert.equal(getRequirement('PAY-3').priority, 'low');
  assert.equal(getRequirement('PAY-3').source, 'import');

  // Read again once saved: the same requirements, unchanged.
  const again = await readWithAgent({ content: EMAIL, projectId: project, complete: async () => ANSWER });
  assert.deepEqual(done.items.map((i) => i.key), [VALIDATION.key, 'REQ-2', 'PAY-3', 'REQ-4'], 'a new key for the ones with none');
  assert.deepEqual(again.items.map((i) => [i.key, i.status]), done.items.map((i) => [i.key, 'unchanged']),
    'each found again: by its key, or — none, or one left out — by its title in the project');
  assert.throws(() => importConfirmed([]), /No requirement to import/);
  assert.throws(() => importConfirmed([{ title: ' ' }]), /has no title/);
});

test('an answer that is not the requirements: an error that says so; an item with no title left out', async () => {
  const read = (answer) => readWithAgent({ content: EMAIL, projectId: project, complete: async () => answer });
  await assert.rejects(read('Je ne peux pas lire ce document.'), (err) => /did not answer with the requirements \(JSON\): Je ne peux pas/.test(err.message) && err.fromAgent);
  await assert.rejects(read('{ "requirements": "aucune" }'), /did not answer with the requirements/);
  await assert.rejects(readWithAgent({ content: EMAIL, complete: async () => { throw new Error('claude exited with code 1'); } }), (err) => err.fromAgent);

  const { requirements, warnings } = parseReading('```json\n{ "requirements": [{ "title": "" }, { "title": "  Plafond\\n repas ", "criteria": "- Un repas de plus de 25 € est refusé\\n- Un repas de plus de 25 € est refusé", "priority": "Must" }] }\n```', {
    document: 'Un repas de plus de 25 € est refusé.', existing: [],
  });
  assert.deepEqual(requirements.map((r) => [r.key, r.title, r.criteria, r.priority, r.source_quote]), [
    [null, 'Plafond repas', ['Un repas de plus de 25 € est refusé'], 'high', null],
  ], 'criteria as one text split, none twice; a priority as written');
  assert.deepEqual(warnings, [
    'Requirement 1 of the agent has no title — left out',
    '“Plafond repas”: the agent did not say which passage it comes from',
  ]);
  assert.deepEqual(parseReading('{ "requirements": [] }', { document: 'Bonjour', existing: [] }).warnings, ['The agent found no requirement in the document']);
});

test('one key stated twice: one requirement, its criteria put together', () => {
  const { requirements, warnings } = parseReading(JSON.stringify({
    requirements: [
      { key: 'NDF-1', title: 'Plafonds', criteria: ['Un repas au-delà de 25 € est refusé'], source_quote: 'NDF-1 : un repas au-delà de 25 € est refusé.' },
      { key: 'NDF-1', title: 'Plafonds (suite)', criteria: ['Un repas au-delà de 25 € est refusé', 'Une nuit d\'hôtel au-delà de 90 € est refusée'], source_quote: 'NDF-1 (suite)' },
    ],
  }), { document: 'NDF-1 : un repas au-delà de 25 € est refusé.\nNDF-1 (suite) : une nuit d\'hôtel au-delà de 90 € est refusée.', existing: [] });
  assert.deepEqual(requirements.map((r) => [r.key, r.title, r.criteria]), [
    ['NDF-1', 'Plafonds', ['Un repas au-delà de 25 € est refusé', 'Une nuit d\'hôtel au-delà de 90 € est refusée']],
  ]);
  assert.deepEqual(warnings, ['NDF-1 is stated twice in the document: its criteria are put together — check them']);
});

test('what the agent can read: text, pasted or in a file; not a PDF, not a binary, not too long', async () => {
  assert.deepEqual(documentText({ content: 'Une ligne.\r\n\r\n\r\n\r\nUne autre.  \n', filename: 'notes.txt' }), { text: 'Une ligne.\n\nUne autre.', kind: 'text' });
  assert.equal(documentText({ content: 'Title;Criteria\nA;x', filename: 'plan.csv' }).kind, 'csv');
  assert.equal(documentText({ content: '# Spec\n\n## A\n- x', filename: '' }).kind, 'text');
  let asked = false;
  const complete = async () => { asked = true; return ANSWER; };
  await assert.rejects(readWithAgent({ content: Buffer.from('%PDF-1.7\n…'), filename: 'spec.pdf', complete }), (err) => /A PDF is not read here: open it, copy its text and paste it/.test(err.message) && !err.fromAgent);
  await assert.rejects(readWithAgent({ content: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), filename: 'spec.doc', complete }), /old Word document \(\.doc\)/);
  await assert.rejects(readWithAgent({ content: Buffer.from([0x00, 0x01, 0x02, 0x41]), filename: 'blob.bin', complete }), /Not a document the agent can read/);
  await assert.rejects(readWithAgent({ content: 'x'.repeat(MAX_AGENT_CHARS + 1), complete }), /too long for the agent to read at once \(60,001 characters, 60,000 at most\): import it in parts/);
  await assert.rejects(readWithAgent({ content: '  \n ', complete }), /no text/);
  assert.equal(asked, false, 'the agent is not asked for what cannot be read');
  assert.match(readingBrief({ text: 'x', filename: 'spec.docx', existing: [] }), /Below is a document \(spec\.docx\)[\s\S]*## The project's requirements already saved\n\(none\)/);
});

// ─── A Word document ─────────────────────────────────────────────────

/** A ZIP archive of `files` (name → text), deflated, as Word writes one. */
function zip(files) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, packed);
    directory.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const listing = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(directory.length / 2, 8); end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(listing.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, listing, end]);
}

const paragraph = (text, properties = '') => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const item = (text, level = 0) => paragraph(text, `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr>`);
const cell = (text) => `<w:tc><w:tcPr><w:tcW w:w="2000"/></w:tcPr>${paragraph(text)}</w:tc>`;
const DOCX = zip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
  'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
${paragraph('Cahier des charges — Notes de frais', '<w:pStyle w:val="Title"/>')}
<w:p><w:r><w:t xml:space="preserve">Version 1.2, </w:t></w:r><w:r><w:t>rédigée par l’équipe &amp; la DSI.</w:t></w:r><w:del><w:r><w:delText>Brouillon</w:delText></w:r></w:del></w:p>
${paragraph('NDF-1 — Plafond par catégorie', '<w:pStyle w:val="Titre1"/>')}
${paragraph('Chaque catégorie a un plafond.')}
${item('Un repas au-delà de 25 € est refusé')}
${item('Le message «&#160;Plafond dépassé&#160;» s’affiche', 1)}
<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Catégorie</w:t></w:r><w:r><w:tab/><w:t>Plafond</w:t></w:r></w:p>
<w:tbl><w:tblPr/><w:tr>${cell('Repas')}${cell('25 €')}</w:tr><w:tr>${cell('Hôtel')}${cell('90 € | nuit')}</w:tr></w:tbl>
<w:p/>
<w:sectPr/></w:body></w:document>`,
});

const DOCX_TEXT = [
  '# Cahier des charges — Notes de frais',
  'Version 1.2, rédigée par l’équipe & la DSI.',
  '',
  '## NDF-1 — Plafond par catégorie',
  'Chaque catégorie a un plafond.',
  '- Un repas au-delà de 25 € est refusé',
  '  - Le message « Plafond dépassé » s’affiche',
  'Catégorie\tPlafond',
  '',
  '| Repas | 25 € |',
  '| --- | --- |',
  '| Hôtel | 90 € \\| nuit |',
].join('\n');

test('a Word document\'s text as Markdown: its title and headings, its lists, its tables; deleted text left out', () => {
  assert.equal(detectFormat({ filename: 'spec.docx', content: DOCX }), 'docx');
  assert.equal(detectFormat({ filename: '', content: DOCX }), 'docx', 'told from what the ZIP holds');
  assert.equal(docxText(DOCX), DOCX_TEXT);
  assert.throws(() => docxText(zip({ 'xl/workbook.xml': '<workbook/>' })), /Not a Word document \(\.docx\): no word\/document\.xml/);
  assert.throws(() => docxText(Buffer.from('PK nope')), /Not a Word document \(\.docx\): no ZIP directory/);
});

test('a Word document read without the agent, as Markdown: a heading per requirement; written otherwise, nothing — and why', () => {
  const { format, requirements, warnings } = parseRequirements({ content: DOCX, filename: 'spec.docx' });
  assert.equal(format, 'docx');
  assert.deepEqual(requirements.map((r) => [r.key, r.title, r.criteria]), [
    ['NDF-1', 'Plafond par catégorie', ['Un repas au-delà de 25 € est refusé', 'Le message « Plafond dépassé » s’affiche']],
  ]);
  assert.deepEqual(warnings, []);
  const prose = zip({ 'word/document.xml': `<w:document><w:body>${paragraph('Bonjour, voici ce que l’appli doit faire.')}</w:body></w:document>` });
  assert.deepEqual(parseRequirements({ content: prose, filename: 'mail.docx' }).warnings,
    ['No requirement found under the headings of the document: it is written otherwise — an agent has to read it']);
  assert.throws(() => parseRequirements({ content: 'text', format: 'docx' }), /A Word document has to be given as its bytes/);
});

test('a Word document read by the agent: its text as Markdown, the passage found in it', async () => {
  let prompt = null;
  const result = await readWithAgent({
    content: DOCX, filename: 'spec.docx', projectId: project,
    complete: async (asked) => {
      prompt = asked.prompt;
      return JSON.stringify({
        requirements: [{
          key: 'NDF-1', title: 'Plafond par catégorie', description: 'Chaque catégorie a un plafond.', priority: null,
          criteria: ['Un repas au-delà de 25 € est refusé', 'Une nuit d\'hôtel au-delà de 90 € est refusée'],
          source_quote: 'NDF-1 — Plafond par catégorie Chaque catégorie a un plafond.',
        }],
        warnings: [],
      });
    },
  });
  assert.ok(prompt.includes(`Below is a document (spec.docx)`));
  assert.ok(prompt.includes(`<<<\n${DOCX_TEXT}\n>>>`), 'the document as Markdown, whole');
  assert.equal(result.format, 'docx');
  assert.deepEqual(result.items.map((i) => [i.key, i.status, i.quote_found, i.unsupported_criteria]), [['NDF-1', 'new', true, []]],
    'a passage across a heading and the line under it; a figure from a table');
  assert.deepEqual(result.warnings, []);
});
