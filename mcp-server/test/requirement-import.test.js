// Unit tests for importing requirements (lib/requirement-import.js): a test plan saved as CSV
// by Excel, a Jira CSV export, an Excel workbook (test/fixtures/requirements.xlsx, written by
// openpyxl), JSON, a Markdown spec — read, previewed, saved, imported again. On a database of
// their own, thrown away after.
// Run with: node --test test/requirement-import.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'requirement-import-')), 'test.db');
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const {
  parseCsv, parseRequirements, importRequirements, detectFormat, splitCriteria, criteriaFromText, priorityOf, formatImport,
} = await import('../lib/requirement-import.js');
const { getRequirement, linkTest } = await import('../lib/requirements.js');

const xlsx = await readFile(new URL('./fixtures/requirements.xlsx', import.meta.url));

// A test plan as Excel saves it in French: ";" between cells, a BOM, CRLF, quoted cells over several lines.
const PLAN = '﻿N°;Intitulé;Critères d\'acceptation;Priorité\r\n'
  + '1;Connexion;"1. Un mauvais mot de passe affiche ""Identifiants invalides""\r\n2. Le champ email garde sa valeur";Haute\r\n'
  + ';;- Après 3 échecs le compte est bloqué;\r\n'
  + '2;Inscription;Un email déjà pris est refusé;Urgentissime\r\n'
  + '3;Inscription;Un mot de passe de moins de 8 caractères est refusé;\r\n'
  + '4;;sans titre;\r\n';

test('CSV: quotes, line breaks in a cell, the delimiter Excel picked', () => {
  assert.deepEqual(parseCsv('a,"b ""c""",d\n"e\nf",g,'), [['a', 'b "c"', 'd'], ['e\nf', 'g', '']]);
  const { requirements, columns, warnings } = parseRequirements({ content: PLAN, filename: 'plan.csv' });
  assert.deepEqual(columns, { key: 'N°', title: 'Intitulé', criteria: 'Critères d\'acceptation', priority: 'Priorité' });
  assert.deepEqual(requirements.map((r) => [r.key, r.title, r.priority, r.criteria]), [
    [null, 'Connexion', 'high', ['Un mauvais mot de passe affiche "Identifiants invalides"', 'Le champ email garde sa valeur', 'Après 3 échecs le compte est bloqué']],
    [null, 'Inscription', 'medium', ['Un email déjà pris est refusé', 'Un mot de passe de moins de 8 caractères est refusé']],
  ], 'a row with no key nor title adds to the one above; rows of one title are one requirement');
  assert.deepEqual(warnings, [
    'The column "N°" holds plain numbers: taken as row numbers, not keys',
    'Row 4: priority "Urgentissime" not known — medium',
    'Row 6: no title — skipped',
  ], 'rows as the spreadsheet numbers them: a cell over two lines is one row');
});

test('a CSV saved in Windows-1252 by an older Excel is read', () => {
  const latin1 = Buffer.from('Titre;Critères\nPaiement;Le reçu est envoyé\n', 'latin1');
  assert.deepEqual(parseRequirements({ content: latin1, filename: 'x.csv' }).requirements[0].criteria, ['Le reçu est envoyé']);
});

test('the columns said over what is detected; no title column: an error naming the columns', () => {
  const csv = 'Ref,Story,Notes\nPAY-1,Refund,Within 14 days\n';
  assert.throws(() => parseRequirements({ content: csv, filename: 'x.csv', columns: { title: null } }), /No column for the title[\s\S]*"Ref", "Story", "Notes"/);
  const { requirements } = parseRequirements({ content: csv, filename: 'x.csv', columns: { criteria: 'Notes' } });
  assert.deepEqual(requirements.map((r) => [r.key, r.title, r.criteria]), [['PAY-1', 'Refund', ['Within 14 days']]]);
  assert.throws(() => parseRequirements({ content: csv, filename: 'x.csv', columns: { criteria: 'Nope' } }), /No column "Nope" for criteria/);
});

test('a Jira CSV export: its columns, its priorities, criteria in a custom field or in the description', () => {
  const jira = 'Summary,Issue key,Issue id,Issue Type,Priority,Description,Custom field (Acceptance Criteria)\n'
    + 'Refund an order,PAY-7,10007,Story,Highest,As a buyer I want my money back,"* Refused after 14 days\n* The refund shows in the history"\n'
    + 'Pay by card,PAY-8,10008,Story,Lowest,"Card payments.\nh3. Acceptance Criteria\n# A declined card shows an error\n# The order stays unpaid\n\nOut of scope: wallets",\n';
  const result = importRequirements({ content: jira, filename: 'jira.csv', dryRun: true });
  assert.deepEqual(result.items.map((r) => [r.key, r.source, r.priority, r.criteria, r.description]), [
    ['PAY-7', 'jira', 'high', ['Refused after 14 days', 'The refund shows in the history'], 'As a buyer I want my money back'],
    ['PAY-8', 'jira', 'low', ['A declined card shows an error', 'The order stays unpaid'], 'Card payments.\n\nOut of scope: wallets'],
  ]);
});

test('an Excel workbook: the sheet asked for, French headers, a cell over several lines, a row adding to the one above', () => {
  const { format, requirements } = parseRequirements({ content: xlsx, sheet: 'Exigences' });
  assert.equal(format, 'xlsx', 'told from its bytes, with no name');
  assert.deepEqual(requirements.map((r) => [r.key, r.title, r.priority, r.criteria.length, r.url]), [
    ['SHOP-10', 'Connexion', 'high', 3, 'https://jira.example/browse/SHOP-10'],
    ['SHOP-11', 'Panier', 'medium', 1, null],
    ['SHOP-12', 'Paiement <3D Secure>', 'high', 1, null],
  ]);
  assert.equal(requirements[0].description, 'L\'utilisateur se connecte avec son email & son mot de passe');
  assert.equal(requirements[2].criteria[0], 'Un refus 3D Secure affiche un message');
  assert.throws(() => parseRequirements({ content: xlsx, filename: 'plan.xlsx' }), /No column for the title[\s\S]*"Cahier de recette — v2"/, 'the first sheet is a cover page');
  assert.throws(() => parseRequirements({ content: xlsx, filename: 'plan.xlsx', sheet: 'Nope' }), /No sheet "Nope" in the workbook \(it has "Notes", "Exigences"\)/);
  assert.throws(() => parseRequirements({ content: Buffer.from('PK nope'), filename: 'x.xlsx' }), /Not an Excel file/);
});

test('JSON: a list, { requirements }, a Jira search result; criteria as text or objects', () => {
  const list = JSON.stringify([{ key: 'A-1', title: 'One', criteria: ['x', { text: 'y' }], priority: 'low' }, { summary: 'Two', acceptance_criteria: '- a\n- b' }, { description: 'no title' }]);
  const { requirements, warnings } = parseRequirements({ content: list, filename: 'r.json' });
  assert.deepEqual(requirements.map((r) => [r.key, r.title, r.criteria, r.priority]), [['A-1', 'One', ['x', 'y'], 'low'], [null, 'Two', ['a', 'b'], 'medium']]);
  assert.deepEqual(warnings, ['Item 3: no title — skipped']);
  const search = JSON.stringify({ issues: [{ key: 'PAY-9', fields: { summary: 'Invoice', description: 'Acceptance criteria:\n- Sent by email', priority: { name: 'High' } } }] });
  assert.deepEqual(parseRequirements({ content: search, filename: 's.json' }).requirements.map((r) => [r.key, r.source, r.priority, r.criteria]), [['PAY-9', 'jira', 'high', ['Sent by email']]]);
  assert.throws(() => parseRequirements({ content: '{ nope', filename: 'r.json' }), /Not valid JSON/);
});

test('Markdown: a heading per requirement, its key, its list as criteria; the document\'s title and chapters are not ones', () => {
  const md = [
    '# Spécifications du paiement', 'Ce document décrit le paiement.', '',
    '## Carte bancaire',
    '### PAY-20 — Paiement refusé', 'Le client paie par carte.', '**Priorité :** haute', '',
    '#### Critères d\'acceptation', '- [ ] Une carte refusée affiche « Paiement refusé »', '1. La commande reste à payer', '',
    '```', '# not a heading', '```',
    '### Remboursement', 'Lien : https://wiki.example/refund', '* Sous 14 jours', '',
  ].join('\n');
  const { requirements } = parseRequirements({ content: md, filename: 'spec.md' });
  assert.deepEqual(requirements.map((r) => [r.key, r.title, r.priority, r.url, r.criteria]), [
    ['PAY-20', 'Paiement refusé', 'high', null, ['Une carte refusée affiche « Paiement refusé »', 'La commande reste à payer']],
    [null, 'Remboursement', 'medium', 'https://wiki.example/refund', ['Sous 14 jours']],
  ]);
  assert.equal(requirements[0].description, 'Le client paie par carte.\n\n```\n# not a heading\n```');
});

test('the format from the name, else from what the file holds', () => {
  assert.equal(detectFormat({ filename: 'a.TSV', content: '' }), 'csv');
  assert.equal(detectFormat({ content: '[{"title":"x"}]' }), 'json');
  assert.equal(detectFormat({ content: '# Spec\n\n## A\n- x' }), 'markdown');
  assert.equal(detectFormat({ content: 'Title;Criteria\nA;x' }), 'csv');
  assert.equal(detectFormat({ content: xlsx }), 'xlsx');
  assert.equal(priorityOf('Élevée'), 'high');
  assert.equal(priorityOf('?'), null);
  assert.deepEqual(splitCriteria('AC1: one\nCA2 - two\n\n• three'), ['one', 'two', 'three']);
  assert.deepEqual(criteriaFromText('Intro\n*Acceptance criteria:*\n- a\n- b').criteria, ['a', 'b']);
});

test('Gherkin criteria: a scenario one criterion — in a cell, under a heading in a description, in Markdown', () => {
  assert.deepEqual(splitCriteria([
    'Given I am on the login page', 'When I sign in with a wrong password', 'Then "Invalid credentials" shows.', 'And I stay on the page',
    'When I sign in with the right one', 'Then I am signed in', 'Shown in under a second',
  ].join('\n')), [
    'Given I am on the login page, when I sign in with a wrong password, then "Invalid credentials" shows, and I stay on the page',
    'When I sign in with the right one, then I am signed in',
    'Shown in under a second',
  ], 'an action after an outcome: the next scenario');
  assert.deepEqual(splitCriteria("Quand je clique sur A, B s'affiche\nQuand je clique sur C, D s'affiche"),
    ["Quand je clique sur A, B s'affiche", "Quand je clique sur C, D s'affiche"], 'no outcome of their own: no scenario');

  const story = criteriaFromText([
    "En tant qu'utilisateur, je veux que mes préférences restent enregistrées.", "Critères d'acceptation",
    'Scénario : Profil public', 'Étant donné que je suis sur mon profil', "Quand je coche « Profil public » et que j'enregistre",
    'Alors « Profil public » est toujours coché après rechargement', '',
    'Soit un profil privé', 'Lorsque je le consulte déconnecté', 'Alors il ne s\'affiche pas', '',
    'Et voilà la suite de la description.',
  ].join('\n'));
  assert.deepEqual(story.criteria, [
    "Profil public — Étant donné que je suis sur mon profil, quand je coche « Profil public » et que j'enregistre, alors « Profil public » est toujours coché après rechargement",
    "Soit un profil privé, lorsque je le consulte déconnecté, alors il ne s'affiche pas",
  ]);
  assert.equal(story.description, "En tant qu'utilisateur, je veux que mes préférences restent enregistrées.\n\nEt voilà la suite de la description.");

  const { requirements } = parseRequirements({ filename: 'spec.md', content: [
    '## Connexion', 'Se connecter.', '### Critères d\'acceptation', '- Given a wrong password', '- When I sign in', '- Then "Invalid credentials" shows',
    '## Profil', 'Ses préférences.', "Critères d'acceptation :", 'Étant donné mon profil', 'Quand je l\'enregistre', 'Alors il est enregistré',
  ].join('\n') });
  assert.deepEqual(requirements.map((r) => [r.title, r.description, r.criteria]), [
    ['Connexion', 'Se connecter.', ['Given a wrong password, when I sign in, then "Invalid credentials" shows']],
    ['Profil', 'Ses préférences.', ["Étant donné mon profil, quand je l'enregistre, alors il est enregistré"]],
  ]);
});

test('a dry run saves nothing; saved, imported again: unchanged, or changed with the tests to check', () => {
  const project = db.prepare("INSERT INTO projects (name) VALUES ('Shop') RETURNING id").get().id;
  const dry = importRequirements({ content: PLAN, filename: 'plan.csv', projectId: project, dryRun: true });
  assert.deepEqual([dry.saved, dry.new, dry.items.map((i) => i.key)], [false, 2, [null, null]]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM requirements').get().n, 0);
  assert.match(formatImport(dry), /^Would import 2 requirement\(s\) from csv: 2 new, 0 changed, 0 unchanged\.\nColumns: key ← "N°", title ← "Intitulé"[\s\S]*Nothing saved yet/);

  const saved = importRequirements({ content: PLAN, filename: 'plan.csv', projectId: project });
  assert.deepEqual(saved.items.map((i) => [i.status, i.key]), [['new', 'REQ-1'], ['new', 'REQ-2']]);
  const login = getRequirement('REQ-1');
  assert.deepEqual([login.source, login.project_id, login.priority, login.criteria.length], ['import', project, 'high', 3]);

  db.prepare("INSERT INTO tests (name) VALUES ('login_wrong_password')").run();
  linkTest('REQ-1', 'login_wrong_password', { criterion: 1 });
  const again = importRequirements({ content: PLAN, filename: 'plan.csv', projectId: project });
  assert.deepEqual(again.items.map((i) => [i.status, i.key]), [['unchanged', 'REQ-1'], ['unchanged', 'REQ-2']], 'found again by title: no key in the file');

  const edited = PLAN.replace('Le champ email garde sa valeur', 'Le champ email garde sa valeur saisie');
  const changed = importRequirements({ content: edited, filename: 'plan.csv', projectId: project });
  assert.deepEqual(changed.items.map((i) => i.status), ['changed', 'unchanged']);
  assert.match(formatImport(changed), /CHANGED {3}REQ-1 — Connexion \[high, 3 criteria\] — 1 test\(s\) linked: check they still match it/);
  const after = getRequirement('REQ-1');
  assert.equal(after.cases.find((c) => c.test === 'login_wrong_password').criterion_id, after.criteria[0].id, 'the criterion left as it was keeps its test');

  const keyed = importRequirements({ content: xlsx, sheet: 'Exigences', projectId: project });
  assert.deepEqual(keyed.items.map((i) => [i.status, i.key]), [['new', 'SHOP-10'], ['new', 'SHOP-11'], ['new', 'SHOP-12']]);
  assert.equal(importRequirements({ content: xlsx, sheet: 'Exigences', projectId: project, dryRun: true }).unchanged, 3);
});
