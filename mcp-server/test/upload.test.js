// Unit tests for upload steps: the files read for the page, the variable a recorded upload
// becomes, and the code generated from it. izitest-test.html's avatar drop zone.
// Run with: node --test test/upload.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUploadFiles, mimeTypeOf, uploadPathsOf, recordedPathNote } from '../lib/upload-files.js';
import { variabilizeInput } from '../lib/variable-detection.js';
import { generatePlaywrightPlain } from '../lib/codegen/playwright-plain.js';
import { generatePlaywrightCucumber, toScenarioOutline } from '../lib/codegen/playwright-cucumber.js';
import { serializeTestToFeatureWith } from '../lib/gherkin/serialize.js';
import { parseFeatureToStepsWith } from '../lib/gherkin/parse.js';
import { DEFAULT_STEP_DEFINITIONS } from '../lib/gherkin/default-step-definitions.js';

const DEFAULTS = DEFAULT_STEP_DEFINITIONS.map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));
const dir = await mkdtemp(join(tmpdir(), 'upload-'));
const AVATAR = join(dir, 'avatar.png');
await writeFile(AVATAR, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

test('the files are read for the page: name, type, content', async () => {
  assert.deepEqual(await readUploadFiles([AVATAR]), [{ name: 'avatar.png', type: 'image/png', base64: 'iVBORw==' }]);
  assert.equal(mimeTypeOf('cv.PDF'), 'application/pdf');
  assert.equal(mimeTypeOf('data.bin'), 'application/octet-stream');
  await assert.rejects(readUploadFiles([join(dir, 'missing.png')]), /No file to upload at .*missing\.png/);
  await assert.rejects(readUploadFiles([dir]), /No file to upload at/, 'a folder is no file');
});

test('one file is `file`, several are `files`', () => {
  assert.deepEqual(uploadPathsOf({ file: AVATAR }), [AVATAR]);
  assert.deepEqual(uploadPathsOf({ files: ['a.txt', 'b.txt'] }), ['a.txt', 'b.txt']);
  assert.deepEqual(uploadPathsOf({}), []);
});

test('a recorded upload becomes a file variable, named after the input', () => {
  const step = { command: 'upload', params: { selector: '#avatar-input', file: AVATAR }, locators: [{ type: 'attribute', value: 'input[name="avatar"]' }] };
  assert.equal(variabilizeInput(step, 1, new Set()), true);
  assert.deepEqual([step.params.file, step.variable], ['{{avatar}}', { name: 'avatar', type: 'file', defaultValue: AVATAR }]);
  const several = { command: 'upload', params: { selector: '#docs', files: ['a.txt', 'b.txt'] } };
  assert.equal(variabilizeInput(several, 2, new Set()), false, 'several files stay as they are');
});

const RECORDED = {
  name: 'avatar', project_id: 1,
  variables: { avatar: { type: 'file', defaultValue: AVATAR } },
  steps: [{ command: 'upload', params: { selector: '#avatar-input', file: '{{avatar}}' }, variable: { name: 'avatar', type: 'file', defaultValue: AVATAR } }],
};

test('plain Playwright sets the files on the input, and says when the path is this machine\'s', () => {
  const out = generatePlaywrightPlain(RECORDED);
  assert.match(out, /await page\.setInputFiles\('#avatar-input', `\$\{VARS\.avatar\}`\);/);
  assert.match(out, /\/\/ FIXME: a file of the machine that recorded this test/);
  const relative = generatePlaywrightPlain({ name: 't', steps: [{ command: 'upload', params: { selector: '#docs', files: ['fixtures/a.txt', 'fixtures/b.txt'] } }] });
  assert.match(relative, /await page\.setInputFiles\('#docs', \['fixtures\/a\.txt', 'fixtures\/b\.txt'\]\);/);
  assert.doesNotMatch(relative, /FIXME/);
  assert.equal(recordedPathNote({ params: { file: 'fixtures/a.txt' } }), '');
});

test('Gherkin: "I upload … to …", read back the same, and a column of the Outline', () => {
  const step = { command: 'upload', params: { selector: '#avatar-input', file: 'fixtures/avatar.png' } };
  const feature = serializeTestToFeatureWith({ name: 't', steps: [step] }, DEFAULTS);
  assert.match(feature, /When I upload "fixtures\/avatar\.png" to "#avatar-input"/);
  assert.deepEqual(parseFeatureToStepsWith(feature, DEFAULTS)[0].params, step.params);

  const outline = toScenarioOutline(serializeTestToFeatureWith(RECORDED, DEFAULTS), RECORDED.variables);
  assert.match(outline, /When I upload "<avatar>" to "#avatar-input"/);
  const stepsJs = generatePlaywrightCucumber(RECORDED, DEFAULTS).files.find(f => f.path === 'features/steps/default.steps.js').content;
  assert.match(stepsJs, /When\('I upload \{string\} to \{string\}', async function \(file, selector\) \{\n {2}await this\.page\.setInputFiles\(selector, file\);/);
});

test('a business step uploads too', () => {
  const business = {
    id: 99, keyword: 'When', pattern: 'je change mon avatar', command: 'composite', is_default: 0,
    steps_template: [{ command: 'upload', params: { selector: '#avatar-input', file: 'fixtures/avatar.png' } }],
  };
  const composite = generatePlaywrightCucumber({ name: 't', project_id: 1, steps: [] }, [...DEFAULTS, business]).files
    .find(f => f.path === 'features/steps/composite.steps.js').content;
  assert.match(composite, /await this\.page\.setInputFiles\('#avatar-input', 'fixtures\/avatar\.png'\);/);
});
