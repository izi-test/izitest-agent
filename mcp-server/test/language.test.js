// Unit tests for the language a project's tests are written in (lib/gherkin/language.js): its
// built-in phrases, its Gherkin keywords, its Cucumber export, and what the agents writing for
// it are told. A project switched to French keeps its English phrases, so its tests still
// read and parse; it reads in French. On a database of their own, thrown away after.
// Run with: node --test test/language.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'language-')), 'test.db');
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { DEFAULT_STEP_DEFINITIONS, defaultStepDefinitions } = await import('../lib/gherkin/default-step-definitions.js');
const { seedProjectStepDefinitions, listStepDefinitions, writingDefinitions } = await import('../lib/gherkin/step-definition-store.js');
const { serializeTestToFeatureWith } = await import('../lib/gherkin/serialize.js');
const { parseFeatureToStepsWith } = await import('../lib/gherkin/parse.js');
const { stepsForEditedFeature } = await import('../lib/gherkin/reconcile.js');
const { generatePlaywrightCucumber } = await import('../lib/codegen/playwright-cucumber.js');
const { saveTest, loadTest } = await import('../lib/test-store.js');
const { scenarioFeature } = await import('../lib/requirements.js');
const { designBrief, projectBrief, resolveScenario } = await import('../lib/requirement-design.js');
const { proposalBrief } = await import('../lib/business-steps.js');

const FRENCH = defaultStepDefinitions('fr').map((d, i) => ({ id: 100 + i, ...d, steps_template: null, is_default: 1 }));
const ENGLISH = defaultStepDefinitions('en').map((d, i) => ({ id: 200 + i, ...d, steps_template: null, is_default: 1 }));

/** A step every argument of `definition` is given a value to, as recording would. */
function stepOf(definition) {
  const values = ['#a', 'b', 'c'];
  const fill = (tpl) => {
    if (typeof tpl === 'string') {
      return tpl.replace(/\{(\d+)\}/g, (_, i) => (definition.pattern.includes('{int}') ? '3' : definition.pattern.includes('{word}') && i === '1' ? 'top' : values[i]));
    }
    return Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, typeof v === 'string' ? fill(v) : v]));
  };
  const params = fill(definition.params_template);
  return definition.command === 'assert' ? { command: 'assert', params: {}, assertion: params } : { command: definition.command, params };
}

test('every built-in phrase reads back in French as the step it was written from', () => {
  for (const definition of FRENCH) {
    const step = stepOf(definition);
    const feature = serializeTestToFeatureWith({ name: 't', language: 'fr', steps: [step] }, FRENCH);
    const [parsed] = parseFeatureToStepsWith(feature, FRENCH);
    // Two phrases may say the same step (je vais sur, je suis sur): the step is what reads back.
    assert.equal(parsed.command, step.command, definition.pattern);
    assert.deepEqual(step.command === 'assert' ? parsed.assertion : parsed.params, step.command === 'assert' ? step.assertion : step.params,
      `${definition.pattern}: ${feature.split('\n').at(-2)}`);
  }
  assert.equal(FRENCH.length, DEFAULT_STEP_DEFINITIONS.length);
});

test('a feature in French says so, with its keywords; it is saved as it was', () => {
  const t = {
    name: 'connexion', description: 'Un utilisateur se connecte', language: 'fr', steps: [
      { command: 'navigate', params: { url: 'https://shop.test/login' } },
      { command: 'fill', params: { selector: '#email', value: 'bob@corp' } },
      { command: 'click', params: { selector: '#go' } },
      { command: 'assert', params: {}, assertion: { type: 'text_contains', expected: 'Bienvenue' } },
      { command: 'assert', params: {}, assertion: { type: 'url_contains', expected: '/home' } },
    ],
  };
  const feature = serializeTestToFeatureWith(t, [...ENGLISH, ...FRENCH]);
  assert.equal(feature, [
    '# language: fr',
    'Fonctionnalité: connexion',
    '  Un utilisateur se connecte',
    '',
    '  Scénario: connexion',
    '    Soit je suis sur "https://shop.test/login"',
    '    Quand je remplis "#email" avec "bob@corp"',
    '    Et je clique sur "#go"',
    '    Alors je vois "Bienvenue"',
    "    Et l'URL contient \"/home\"",
    '',
  ].join('\n'), 'its own phrases first, where the catalogue has both');
  assert.deepEqual(stepsForEditedFeature(feature, [...ENGLISH, ...FRENCH], t).map((s) => s.params), t.steps.map((s) => s.params));

  const english = serializeTestToFeatureWith({ ...t, language: 'en' }, [...ENGLISH, ...FRENCH]);
  assert.match(english, /^Feature: connexion\n[\s\S]*Scenario: connexion\n    Given I am on/);
  assert.equal(parseFeatureToStepsWith(english, [...ENGLISH, ...FRENCH]).length, 5, 'an English feature still parses in a project with both');
});

test('a project in French is seeded with French phrases; switched to French, it keeps its English ones', () => {
  const french = db.prepare("INSERT INTO projects (name, language) VALUES ('Boutique', 'fr') RETURNING id").get().id;
  seedProjectStepDefinitions(french);
  assert.ok(listStepDefinitions(french).every((d) => d.language === 'fr'));
  assert.ok(listStepDefinitions(french).some((d) => d.pattern === 'je clique sur {string}'));

  const switched = db.prepare("INSERT INTO projects (name) VALUES ('Shop') RETURNING id").get().id;
  seedProjectStepDefinitions(switched);
  db.prepare("UPDATE projects SET language = 'fr' WHERE id = ?").run(switched);
  seedProjectStepDefinitions(switched);
  const all = listStepDefinitions(switched);
  assert.equal(all.filter((d) => d.language === 'en').length, DEFAULT_STEP_DEFINITIONS.length);
  assert.equal(all.filter((d) => d.language === 'fr').length, DEFAULT_STEP_DEFINITIONS.length);
  assert.ok(writingDefinitions(switched).every((d) => d.language === 'fr'), 'an agent writes with the French ones only');

  saveTest({ name: 'old one', variables: {}, steps: [{ command: 'click', params: { selector: '#go' } }] });
  db.prepare("UPDATE tests SET project_id = ? WHERE name = 'old one'").run(switched);
  assert.equal(loadTest('old one').language, 'fr');
  assert.match(serializeTestToFeatureWith(loadTest('old one'), all), /Quand je clique sur "#go"/, 'it reads in French now');
});

test('a scenario designed for a requirement is wrapped, and resolves, in the language of its project', () => {
  const wrapped = scenarioFeature('Scénario: Connexion refusée\n  Soit je suis sur "https://shop.test"\n  Alors je vois "Erreur"', 'REQ-1 Connexion', 'x', 'fr');
  assert.match(wrapped, /^# language: fr\nFonctionnalité: REQ-1 Connexion\n\n  Scénario: Connexion refusée\n    Soit je suis sur/);
  assert.deepEqual(resolveScenario(wrapped, FRENCH), { phrases: 2, unresolved: [], ready: true });
  assert.deepEqual(resolveScenario(wrapped.replace('je vois', 'je lis'), FRENCH).unresolved, ['Alors je lis "Erreur"'], 'told as written');
  assert.match(scenarioFeature('Given I am on "x"', 'F', 'S'), /^Feature: F\n\n  Scenario: S\n/);
});

test('the Cucumber export of a French test: its feature, tags after the language, its step code in French', () => {
  const { files } = generatePlaywrightCucumber({
    name: 'profil', language: 'fr', variables: { nom: { defaultValue: 'alice' } }, requirements: [{ key: 'REQ-1' }],
    steps: [{ command: 'navigate', params: { url: 'https://shop.test' } }, { command: 'fill', params: { selector: '#nom', value: '{{nom}}' } }],
  }, FRENCH);
  assert.match(files[0].content, /^# language: fr\n@REQ-1\nFonctionnalité: profil\n\n  Plan du scénario: profil\n    Soit je suis sur "https:\/\/shop\.test"\n    Quand je remplis "#nom" avec "<nom>"\n\n    Exemples:\n      \| nom \|\n      \| alice \|\n$/);
  const steps = files.find((f) => f.path === 'features/steps/default.steps.js').content;
  assert.match(steps, /^When\('je remplis \{string\} avec \{string\}', async function \(selector, value\) \{/m);
  assert.match(steps, /^When\('j\\'appuie sur \{string\}', async function \(key\) \{/m, 'an apostrophe escaped');
  assert.doesNotMatch(steps, /^When\('I click on/m);
});

test('the agents writing for a French project are told to write in French', () => {
  const project = db.prepare("INSERT INTO projects (name, language) VALUES ('Magasin', 'fr') RETURNING id").get().id;
  seedProjectStepDefinitions(project);
  const brief = designBrief({ key: 'REQ-9', title: 'Connexion', description: '', criteria: [], cases: [], project_id: project });
  assert.match(brief, /in French, the language of the project's tests, with its keywords: Scénario \/ Soit \/ Quand \/ Alors \/ Et/);
  assert.match(brief, /"gherkin": "Scénario: …\\n {2}Soit …/);
  assert.match(brief, /^- Soit je suis sur \{string\}/m);
  assert.doesNotMatch(brief, /^- Given I am on/m);

  assert.match(projectBrief({ name: 'Magasin', language: 'fr' }), /write the intent of each step in French/);
  saveTest({ name: 'panier', variables: {}, steps: [{ command: 'click', params: { selector: '#a' } }, { command: 'click', params: { selector: '#b' } }] });
  db.prepare("UPDATE tests SET project_id = ? WHERE name = 'panier'").run(project);
  assert.match(proposalBrief(loadTest('panier'), listStepDefinitions(project)), /Write the phrase in French: the tests of this project are written in it\./);
});
