// Unit tests for requirements imported from an API description (lib/requirement-import.js): a
// Postman collection (test/fixtures/postman-collection.json, and one with folders, ids, tests and
// big response bodies) and an OpenAPI or Swagger document — a request per requirement, its
// examples, documented responses and tests as criteria, the bodies never read; what the agent is
// sent of them (lib/requirement-reading.js). On a database of their own, thrown away after.
// Run with: node --test test/requirement-api.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IZITEST_DB_PATH = join(await mkdtemp(join(tmpdir(), 'requirement-api-')), 'test.db');
const { db, initDatabase } = await import('../lib/db.js');
initDatabase();
const { parseRequirements, importRequirements, formatImport, checkFile, MAX_JSON_BYTES } = await import('../lib/requirement-import.js');
const { documentText, readWithAgent } = await import('../lib/requirement-reading.js');
const { getRequirement } = await import('../lib/requirements.js');

const SAMPLE = await readFile(new URL('./fixtures/postman-collection.json', import.meta.url));

test('a Postman collection: a request per requirement, its folders in its title, its examples and tests as criteria', () => {
  const { format, requirements, warnings } = parseRequirements({ content: SAMPLE, filename: 'collection.json' });
  assert.equal(format, 'postman');
  assert.deepEqual(requirements, [
    {
      key: null, title: 'Auth / Login',
      description: 'Logs a user in. A wrong password answers 401.\n\nPOST {{base}}/api/login',
      criteria: ['Returns a token valid 1 hour', 'Locks the account after 5 failures', 'Answers 200 (OK)', 'Answers 401 (Wrong password)'],
      priority: 'medium', url: null, source: 'import',
    },
    {
      key: null, title: 'Create expense',
      description: 'Creates an expense. The amount must be positive.\n\nPOST {{base}}/api/expenses',
      criteria: ['status is 201'],
      priority: 'medium', url: null, source: 'import',
    },
  ], 'the folder "Auth" is no requirement; its description\'s list items are criteria, its prose stays the description');
  assert.deepEqual(warnings, []);
});

// Exported by Postman: ids, folders in folders, a description as { content }, scripts, and the
// whole body of each example response.
const BODY = `{"data":"${'x'.repeat(6 * 1024 * 1024)}"}`;
const COLLECTION = {
  info: { _postman_id: 'c-1', name: 'Shop API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  event: [{ listen: 'test', script: { exec: ['pm.test("collection-wide check", () => {});'] } }],
  item: [
    {
      name: 'Orders', description: 'Everything about orders.',
      item: [
        {
          name: 'Admin', item: [
            {
              id: 'b7f0c3e2-0001', name: 'Refund an order',
              request: {
                method: 'post', url: { raw: '{{base}}/orders/:id/refund', host: ['{{base}}'] },
                description: { content: 'Refunds a paid order.\n\n## Acceptance criteria\n- A refund of an unpaid order is refused\n- The customer gets an email\n\n## Example\n```\n- not a criterion\n```', type: 'text/markdown' },
              },
              response: [
                { name: 'Refunded', code: 200, status: 'OK', body: BODY },
                { code: 409, status: 'Conflict', body: BODY },
                { name: 'Refunded', code: 200, body: '{}' },
              ],
              event: [
                { listen: 'prerequest', script: { exec: ['pm.test("not a test of the answer", () => {});'] } },
                { listen: 'test', script: { exec: ['pm.test("status is 200", function () {', '  pm.response.to.have.status(200);', '});', "tests['the \\'refunded\\' flag is set'] = true;"] } },
                { listen: 'test', disabled: true, script: { exec: 'pm.test("switched off", () => {});' } },
              ],
            },
          ],
        },
        {
          _postman_id: 'p-2', name: 'List orders', request: 'https://shop.test/orders',
          response: [{ name: 'Empty', code: 200, body: '[]' }],
        },
        { name: '', request: { method: 'GET', url: '{{base}}/x' } },
        { name: 'Ping', request: { method: 'GET', url: '{{base}}/ping', description: '# Health\n\n- Answers fast' } },
        { name: 'Ping', request: { method: 'HEAD', url: '{{base}}/ping' } },
      ],
    },
    { name: 'Empty folder', item: [] },
  ],
};

test('a collection exported by Postman: ids as keys, nested folders, scripts, its response bodies never read', () => {
  const content = Buffer.from(JSON.stringify(COLLECTION));
  assert.ok(content.length > 5 * 1024 * 1024, 'over the 5 MB of other files, under the 30 MB of a JSON one');
  const result = parseRequirements({ content, filename: 'shop.postman_collection.json' });
  assert.equal(result.format, 'postman');
  assert.deepEqual(result.requirements.map((r) => [r.key, r.title, r.criteria]), [
    ['b7f0c3e2-0001', 'Orders / Admin / Refund an order', [
      'A refund of an unpaid order is refused', 'The customer gets an email', 'Answers 200 (Refunded)', 'Answers 409 (Conflict)', 'status is 200', 'the \'refunded\' flag is set',
    ]],
    ['p-2', 'Orders / List orders', ['Answers 200 (Empty)']],
    [null, 'Orders / Ping', ['Answers fast']],
    [null, 'Orders / Ping', []],
  ], 'criteria under "Acceptance criteria" first; an example saved twice, once; a test of the request\'s, not one switched off, before it, or of the collection');
  assert.equal(result.requirements[0].description, 'Refunds a paid order.\n\n## Example\n```\n- not a criterion\n```\n\nPOST {{base}}/orders/:id/refund');
  assert.equal(result.requirements[1].description, 'GET https://shop.test/orders', 'a request given as its URL');
  assert.equal(result.requirements[2].description, '# Health\n\nGET {{base}}/ping', 'a "#" line is a heading, not an item');
  assert.deepEqual(result.warnings, [
    'A request in "Orders" has no name — skipped',
    'Two requests are named "Orders / Ping" and have no id: name them apart, or imported again they are taken for one',
  ]);
  assert.ok(!JSON.stringify(result).includes('xxxxxxxx'), 'no response body in what is read');
  assert.throws(() => checkFile({ content: Buffer.alloc(MAX_JSON_BYTES + 1, 0x20), filename: 'big.json' }), /too big \(\d+ KB, 30 MB at most\)/);
  assert.throws(() => checkFile({ content: Buffer.alloc(6 * 1024 * 1024, 0x41), filename: 'big.csv' }), /too big \(\d+ KB, 5 MB at most\)/);
});

test('a collection imported, then again: found by its ids, else its titles; the report says an API is checked by its status only', () => {
  const dry = importRequirements({ content: SAMPLE, filename: 'collection.json', dryRun: true });
  assert.equal(dry.saved, false);
  assert.match(formatImport(dry), /^Would import 2 requirement\(s\) from postman: 2 new[\s\S]*call_api checks a request's status, not yet what its response holds/);
  importRequirements({ content: SAMPLE, filename: 'collection.json', dryRun: false });
  assert.deepEqual(getRequirement('REQ-1').criteria.map((c) => c.text), ['Returns a token valid 1 hour', 'Locks the account after 5 failures', 'Answers 200 (OK)', 'Answers 401 (Wrong password)']);
  const again = importRequirements({ content: SAMPLE, filename: 'collection.json', dryRun: true });
  assert.deepEqual(again.items.map((i) => [i.key, i.status]), [['REQ-1', 'unchanged'], ['REQ-2', 'unchanged']]);

  const keyed = importRequirements({ content: JSON.stringify(COLLECTION), filename: 'shop.json', dryRun: false });
  assert.deepEqual(keyed.items.map((i) => i.key).slice(0, 2), ['b7f0c3e2-0001', 'p-2']);
  const renamed = JSON.parse(JSON.stringify(COLLECTION));
  renamed.item[0].item[0].item[0].name = 'Refund a paid order';
  const changed = importRequirements({ content: JSON.stringify(renamed), filename: 'shop.json', dryRun: true });
  assert.deepEqual([changed.items[0].status, changed.items[0].title_before], ['changed', 'Orders / Admin / Refund an order'], 'renamed, it is the same request: its id says so');
});

const OPENAPI = {
  openapi: '3.0.3',
  info: { title: 'Expense API', version: '1.2' },
  paths: {
    '/expenses': {
      post: {
        operationId: 'createExpense', summary: 'Create an expense', tags: ['Expenses'],
        description: 'Creates an expense for the user logged in.\n\n- The amount must be positive\n- A meal over 35 € needs a justification',
        responses: {
          201: { description: 'Created' },
          400: { $ref: '#/components/responses/Invalid' },
          default: { description: 'Unexpected error' },
        },
      },
      get: { operationId: 'listExpenses', responses: { 200: { description: 'The expenses of the user' } } },
      parameters: [],
    },
    '/expenses/{id}': {
      delete: { summary: 'Delete an expense', responses: { 204: { description: '' }, 404: { $ref: '#/components/responses/Missing~1Gone' } } },
    },
  },
  components: { responses: { Invalid: { description: 'The expense is invalid' }, 'Missing/Gone': { description: 'No such expense' } } },
};

test('an OpenAPI document: an operation per requirement, its documented responses as criteria', () => {
  const { format, requirements, warnings } = parseRequirements({ content: JSON.stringify(OPENAPI), filename: 'openapi.json' });
  assert.equal(format, 'openapi');
  assert.deepEqual(requirements.map((r) => [r.key, r.title, r.description, r.criteria]), [
    ['listExpenses', 'listExpenses', 'GET /expenses', ['Answers 200 (The expenses of the user)']],
    ['createExpense', 'Expenses / Create an expense', 'Creates an expense for the user logged in.\n\nPOST /expenses', [
      'The amount must be positive', 'A meal over 35 € needs a justification', 'Answers 201 (Created)', 'Answers 400 (The expense is invalid)', 'Answers any other status (Unexpected error)',
    ]],
    [null, 'Delete an expense', 'DELETE /expenses/{id}', ['Answers 204', 'Answers 404 (No such expense)']],
  ], 'its operationId as key (and title, with no summary); a response by reference read where it points');
  assert.deepEqual(warnings, []);

  const swagger = { swagger: '2.0', info: { title: 'Old' }, paths: { '/login': { post: { operationId: 'login', summary: 'Log in', responses: { 401: { $ref: '#/responses/Denied' } } } } }, responses: { Denied: { description: 'Wrong password' } } };
  assert.deepEqual(parseRequirements({ content: JSON.stringify(swagger), filename: 'swagger.json' }).requirements.map((r) => [r.key, r.criteria]), [['login', ['Answers 401 (Wrong password)']]]);
  assert.deepEqual(parseRequirements({ content: JSON.stringify({ openapi: '3.1.0', info: {}, paths: {} }), filename: 'x.json' }).warnings, ['The API document has no operation']);
  assert.equal(parseRequirements({ content: '{ "info": { "name": "x" }, "title": "A requirement" }', filename: 'x.json' }).format, 'json', 'info alone is no collection');
});

test('read by the agent, an API is sent as what each request is — never its response bodies', async () => {
  const content = Buffer.from(JSON.stringify(COLLECTION));
  const { text, kind } = documentText({ content, filename: 'shop.json' });
  assert.equal(kind, 'postman');
  assert.ok(text.length < 2000, 'a few lines a request, not the 12 MB of bodies');
  assert.ok(text.startsWith('# Shop API\n\n## Orders / Admin / Refund an order\nKey: b7f0c3e2-0001\n\nRefunds a paid order.'));
  assert.match(text, /- Answers 409 \(Conflict\)\n- status is 200/);
  assert.ok(!text.includes('xxxxxxxx'));

  let prompt = null;
  const result = await readWithAgent({
    content: SAMPLE, filename: 'collection.json',
    complete: async (asked) => { prompt = asked.prompt; return JSON.stringify({ requirements: [{ key: null, title: 'Auth / Login', criteria: ['A wrong password answers 401'], source_quote: 'Logs a user in. A wrong password answers 401.' }] }); },
  });
  assert.ok(prompt.includes('<<<\n# Expense API\n\nAPI of the expense notes app\n\n## Auth / Login\n\nLogs a user in.'));
  assert.equal(result.format, 'postman');
  assert.deepEqual(result.items.map((i) => [i.title, i.quote_found, i.unsupported_criteria]), [['Auth / Login', true, []]]);
  assert.equal(documentText({ content: '{"title": "x"}', filename: 'r.json' }).kind, 'json', 'other JSON: as it is');
});
