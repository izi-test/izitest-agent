// Jev (TypeSafe AI) client — typed decisions via OpenRouter's alpha Decisions API.
// Jev never generates text: it answers noul / choice / score questions about a
// state with calibrated probabilities, typically in 70–500ms. All questions in
// one request are evaluated in parallel, so batch them instead of looping.
//
// API reference: https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request
// NOTE: this is NOT the chat/completions endpoint — chat SDKs do not work with Jev.

import { log } from './logger.js';

const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const JEV_MODEL = process.env.JEV_MODEL || 'typesafe/jev-1.13';
const DEFAULT_TIMEOUT_MS = 5000;

// Resolve the OpenRouter key: env first, then the agent settings row.
// db.js is imported lazily because it opens the SQLite file at import time.
export async function getOpenRouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const { db, parseJson } = await import('./db.js');
    const row = db.prepare("SELECT value FROM settings WHERE key = 'agent'").get();
    return (row && parseJson(row.value)?.api?.apiKey) || null;
  } catch {
    return null;
  }
}

// state:     string | object | array (max ~32k tokens)
// questions: { [key]: { type: 'noul'|'choice'|'score', instructions, criteria } }
// Returns:   { answers, usage, latencyMs }
//   noul   → { type, noul: 0..1 }                        (P(true), NOT a boolean)
//   choice → { type, choice, confidence, probabilities }  (max 255 options)
//   score  → { type, score, confidence, legend, probabilities }
export async function evaluate(apiKey, state, questions, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!apiKey) throw new Error('Jev: no OpenRouter API key');

  const startedAt = Date.now();
  const resp = await fetch(DECISIONS_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: JEV_MODEL, state, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const body = await resp.json().catch(() => null);
  if (!resp.ok || !body?.answers) {
    const msg = body?.error?.message || `HTTP ${resp.status}`;
    throw new Error(`Jev: ${msg}`);
  }

  const latencyMs = Date.now() - startedAt;
  log(`[Jev] ${Object.keys(questions).length} question(s) in ${latencyMs}ms (${body.usage?.input_tokens ?? '?'} tokens)`);
  return { answers: body.answers, usage: body.usage || {}, latencyMs };
}
