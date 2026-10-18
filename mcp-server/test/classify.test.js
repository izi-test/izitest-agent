// Unit tests for Jev-backed variable classification (fetch is stubbed — no network, no DB).
// Run with: node --test test/classify.test.js

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENROUTER_API_KEY = 'sk-or-test';
const { classifyWithLLM } = await import('../lib/classify.js');
const { evaluate } = await import('../lib/jev.js');

const LIST_CONTEXT = {
  type: 'list',
  totalItems: 12,
  selectedText: 'Chaussures de running',
  itemTexts: ['Chaussures de running', 'Sandales', 'Bottes'],
};

const realFetch = globalThis.fetch;
let lastRequest;

function stubFetch(status, body) {
  globalThis.fetch = async (url, init) => {
    lastRequest = { url, init, body: JSON.parse(init.body) };
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

function jevAnswers({ isList, mode, name }) {
  return {
    answers: {
      is_list: { type: 'noul', noul: isList },
      selection_mode: { type: 'choice', choice: mode, confidence: 0.9, probabilities: {} },
      variable_name: { type: 'choice', choice: name, confidence: 0.8, probabilities: {} },
    },
    usage: { input_tokens: 200, output_tokens: 0 },
  };
}

beforeEach(() => { lastRequest = null; });
afterEach(() => { globalThis.fetch = realFetch; });

test('maps Jev answers to the classification result', async () => {
  stubFetch(200, jevAnswers({ isList: 0.97, mode: 'by_text', name: 'category' }));
  const result = await classifyWithLLM(LIST_CONTEXT, 'Choisir une catégorie');
  assert.deepEqual(result, { isList: true, variableName: 'category', selectionMode: 'by_text' });
});

test('treats the noul answer as a probability, not a boolean', async () => {
  stubFetch(200, jevAnswers({ isList: 0.12, mode: 'by_index', name: 'item' }));
  const result = await classifyWithLLM(LIST_CONTEXT);
  assert.equal(result.isList, false);
});

test('falls back to "item" when Jev returns a name outside the closed list', async () => {
  stubFetch(200, jevAnswers({ isList: 0.9, mode: 'by_index', name: 'constructor' }));
  const result = await classifyWithLLM(LIST_CONTEXT);
  assert.equal(result.variableName, 'item');
});

test('sends one batched request to the Decisions endpoint', async () => {
  stubFetch(200, jevAnswers({ isList: 0.9, mode: 'by_index', name: 'product' }));
  await classifyWithLLM(LIST_CONTEXT, 'Pick a product');

  assert.equal(lastRequest.url, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(lastRequest.init.headers.Authorization, 'Bearer sk-or-test');
  assert.equal(lastRequest.body.model, 'typesafe/jev-1.13');
  assert.deepEqual(Object.keys(lastRequest.body.questions), ['is_list', 'selection_mode', 'variable_name']);
  assert.equal(lastRequest.body.questions.is_list.type, 'noul');
  assert.equal(lastRequest.body.state.step_intent, 'Pick a product');
  assert.equal(lastRequest.body.state.sample_items.length, 3);
});

test('evaluate throws the API error message on failure', async () => {
  stubFetch(402, { error: { code: 402, message: 'Insufficient credits' } });
  await assert.rejects(
    () => evaluate('sk-or-test', 'state', { q: { type: 'noul', instructions: '?' } }),
    /Jev: Insufficient credits/
  );
});

test('evaluate refuses to call without a key', async () => {
  await assert.rejects(() => evaluate('', 'state', {}), /no OpenRouter API key/);
});
