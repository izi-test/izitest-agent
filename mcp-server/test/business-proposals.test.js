// Unit tests for the business steps the agent proposes for a test (lib/business-steps.js): what
// it is asked — the test step by step, what is already a business step, the project's phrases —,
// its proposals checked before they are shown, then accepted as the user left them, or
// dismissed. The agent is a stand-in that answers what the test gives it. On a database of
// their own, thrown away after.
// Run with: node --test test/business-proposals.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'business-')), 'test.db');
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { saveTest, loadTest } = await import('../lib/test-store.js');
const { seedProjectStepDefinitions, listStepDefinitions } = await import('../lib/gherkin/step-definition-store.js');
const { withElementNames } = await import('../lib/element-store.js');
const { serializeTestToFeatureWith } = await import('../lib/gherkin/serialize.js');
const { proposalBrief, parseProposals, startProposals, proposalsOf, acceptProposal, dismissProposal, addBusinessStep } = await import('../lib/business-steps.js');

const PAGE = 'shop.test/profile';
const project = db.prepare("INSERT INTO projects (name) VALUES ('Shop') RETURNING id").get().id;
seedProjectStepDefinitions(project);

const field = (label, selector, value) => ({
  command: 'fill', params: { selector, value }, intent: `Enter ${label.toLowerCase()}`, page: PAGE,
  locators: [{ type: 'css', value: selector }, { type: 'aria', value: label }],
});
const button = (name, selector) => ({
  command: 'click', params: { selector }, intent: name, page: PAGE,
  locators: [{ type: 'css', value: selector }, { type: 'role', value: 'button', name }],
});
const contains = (expected) => ({
  command: 'assert', params: {}, intent: `Shows ${expected}`, page: PAGE, assertion: { type: 'text_contains', selector: '#result', expected },
});

/** The profile test: open, fill in the name and the bio, save, check the result. */
function profileTest(name) {
  saveTest({
    name, description: 'A user edits their profile',
    variables: { display_name: { type: 'text', defaultValue: 'alice' }, bio: { type: 'text', defaultValue: 'Hi' } },
    steps: [
      { command: 'navigate', params: { url: 'https://shop.test/profile' }, intent: 'Open the profile' },
      field('Display name', '#name', '{{display_name}}'),
      field('Bio', '#bio', '{{bio}}'),
      button('Save profile', '#save'),
      contains('Saved'),
      contains('{{display_name}}'),
    ],
  });
  db.prepare('UPDATE tests SET project_id = ? WHERE name = ?').run(project, name);
  return loadTest(name);
}

const FILL_IN = {
  from_step: 2, to_step: 4, keyword: 'When', pattern: 'je renseigne mon profil avec le nom {string} et la bio {string}',
  args: [{ variable: 'display_name' }, { variable: '{{bio}}' }], reason: 'Filling the profile in and saving it is one thing',
};
const SAVED = { from_step: 5, to_step: 6, keyword: 'Then', pattern: 'le profil de {string} est enregistré', args: [{ variable: 'display_name' }] };
const answer = (...proposals) => JSON.stringify({ proposals });

test('the agent reads the test step by step, its variables, and the business steps the project has', () => {
  const t = profileTest('brief');
  addBusinessStep(project, t, { from_step: 5, to_step: 6, keyword: 'Then', pattern: 'the profile shows {string}', args: [{ variable: 'display_name' }] });
  const brief = proposalBrief(withElementNames(t), listStepDefinitions(project));
  assert.match(brief, /^1\. Given I am on "https:\/\/shop\.test\/profile"/m);
  assert.match(brief, /^2\. When I fill "Display name" with "\{\{display_name\}\}"   \(Enter display name — on shop\.test\/profile\)/m,
    'by the name of its element, with what it is for and where');
  assert.match(brief, /^5–6\. Then the profile shows "\{\{display_name\}\}"   \[already a business step of the project\]/m);
  assert.match(brief, /^- \{\{bio\}\} \(default "Hi"\)/m);
  assert.match(brief, /## The business steps the project already has[^\n]*\n- Then the profile shows \{string\}/);
  db.prepare("DELETE FROM step_definitions WHERE pattern = 'the profile shows {string}'").run();
});

test('only proposals that group what can be grouped are shown, with how they read and the other tests they read in', () => {
  const t = withElementNames(profileTest('checked'));
  profileTest('checked again');
  const definitions = listStepDefinitions(project);
  const proposals = parseProposals(answer(
    { ...FILL_IN, from_step: 1, to_step: 1 },
    { ...FILL_IN, pattern: 'je renseigne (vite) mon profil' },
    { ...FILL_IN, pattern: 'I click on {string}' },
    { ...FILL_IN, args: [{ variable: 'display_name' }] },
    FILL_IN,
    { ...SAVED, from_step: 4, to_step: 5 },
    SAVED,
  ), t, definitions, [loadTest('checked again')]);

  assert.deepEqual(proposals.map((p) => [p.id, p.from_step, p.to_step]), [['p1', 2, 4], ['p2', 5, 6]],
    'one step alone, ( ) in the phrase, a phrase the project has, a variable left unmapped, an overlap: dropped');
  assert.equal(proposals[0].reads, 'When je renseigne mon profil avec le nom "{{display_name}}" et la bio "{{bio}}"');
  assert.deepEqual(proposals[0].replaces, ['When I fill "Display name" with "{{display_name}}"', 'When I fill "Bio" with "{{bio}}"', 'When I click on "Save profile"']);
  assert.deepEqual(proposals[0].args, [{ variable: 'display_name' }, { variable: 'bio' }], 'a variable given in braces is its name');
  assert.deepEqual(proposals[0].also_in, ['checked again'], 'the same steps, on the same elements');
  assert.equal(proposals[0].reason, 'Filling the profile in and saving it is one thing');

  assert.throws(() => parseProposals('I would group 2 to 4.', t, definitions), /did not answer with business steps/);
});

test('asked in the background, accepted as the user left them, or dismissed', async () => {
  profileTest('accepted');
  let asked = null;
  const complete = async ({ prompt }) => { asked = prompt; return answer(FILL_IN, SAVED); };
  assert.equal(startProposals('accepted', { complete, agent: 'stand-in' }).status, 'running');
  assert.equal(startProposals('accepted', { complete: async () => { throw new Error('asked twice'); } }).status, 'running', 'one at a time');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(asked, /# Business steps for the test "accepted"/);
  const ready = proposalsOf('accepted');
  assert.deepEqual([ready.status, ready.agent, ready.proposals.length], ['ready', 'stand-in', 2]);

  assert.equal(acceptProposal('accepted', 'p1', { pattern: 'je renseigne mon profil avec le nom {string}' }).status, 422,
    'a phrase edited with a parameter less: the bio has none');
  const accepted = acceptProposal('accepted', 'p1', { pattern: 'je mets à jour mon profil : nom {string}, bio {string}' });
  assert.match(accepted.feature, /When je mets à jour mon profil : nom "\{\{display_name\}\}", bio "\{\{bio\}\}"\n/);
  assert.match(serializeTestToFeatureWith(withElementNames(loadTest('checked again')), listStepDefinitions(project)), /When je mets à jour mon profil/,
    'every test acting on the same elements reads with it');
  assert.deepEqual(proposalsOf('accepted').proposals.map((p) => p.id), ['p2']);

  assert.deepEqual(dismissProposal('accepted', 'p2').proposals, []);
  assert.equal(dismissProposal('accepted').status, 'none');
  assert.equal(proposalsOf('accepted').status, 'none');
});

test('the agent failing is told; a test with no project is not asked about', async () => {
  profileTest('failing');
  startProposals('failing', { complete: async () => { throw new Error('No API key configured'); } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual([proposalsOf('failing').status, proposalsOf('failing').error], ['failed', 'No API key configured']);

  saveTest({ name: 'loose', variables: {}, steps: [{ command: 'navigate', params: { url: 'https://shop.test' } }] });
  assert.equal(startProposals('loose', { complete: async () => '{}' }).status, 400);
  assert.equal(startProposals('nope', { complete: async () => '{}' }).status, 404);
});
