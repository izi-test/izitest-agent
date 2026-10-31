// Serialize a izitest-agent test into a Gherkin .feature document.
// The Gherkin is computed on the fly from test_steps — nothing is stored.

import { db, parseJson } from '../db.js';

export function serializeTestToFeature(test, projectId) {
  const definitions = db.prepare(
    'SELECT * FROM step_definitions WHERE project_id = ?'
  ).all(projectId).map(r => ({
    ...r,
    params_template: parseJson(r.params_template) || {},
    steps_template: parseJson(r.steps_template) || null,
  }));
  return serializeTestToFeatureWith(test, definitions);
}

// Pure version — takes pre-loaded definitions. Used by tests and by the
// API layer when definitions are already in memory.
export function serializeTestToFeatureWith(test, definitions) {
  // Split into composite and single definitions.
  const composites = definitions.filter(d => d.steps_template);
  const singles = definitions.filter(d => !d.steps_template);

  // Most specific templates first: definitions with more leaves in their
  // params_template win over generic fallbacks when both can match a step. On a tie,
  // the one with more fixed text wins, then the project's own over a built-in default:
  // "I search a house in {string}" on url "https://…/{0}/maison" beats "I am on {string}".
  const sortedSingles = [...singles].sort(
    (a, b) => templateComplexity(b.params_template) - templateComplexity(a.params_template)
      || literalLength(b.params_template) - literalLength(a.params_template)
      || Number(!!a.is_default) - Number(!!b.is_default)
  );
  // Longer composites first — greedier match wins.
  const sortedComposites = [...composites].sort(
    (a, b) => b.steps_template.length - a.steps_template.length
  );

  const lines = [];
  lines.push(`Feature: ${test.name}`);
  if (test.description) {
    for (const l of String(test.description).split('\n')) lines.push(`  ${l}`);
  }
  lines.push('');
  lines.push(`  Scenario: ${test.name}`);

  const steps = test.steps || [];
  let lastKeyword = null;
  let i = 0;

  while (i < steps.length) {
    // Try composite match first — check if next N steps match a composite definition.
    const composite = tryMatchComposite(steps, i, sortedComposites);
    if (composite) {
      const keyword = (composite.keyword === lastKeyword) ? 'And' : composite.keyword;
      lines.push(`    ${keyword} ${composite.phrase}`);
      lastKeyword = composite.keyword;
      i += composite.consumed;
      continue;
    }

    // Fall back to single-step matching.
    const rendered = renderStepPhrase(steps[i], sortedSingles);
    const keyword = (rendered.keyword === lastKeyword) ? 'And' : rendered.keyword;
    lines.push(`    ${keyword} ${rendered.phrase}`);
    lastKeyword = rendered.keyword;
    i++;
  }

  return lines.join('\n') + '\n';
}

function tryMatchComposite(steps, startIndex, composites) {
  for (const def of composites) {
    const tpls = def.steps_template;
    if (startIndex + tpls.length > steps.length) continue;

    // Try explicit link first: if the first step points at this composite definition
    if (steps[startIndex].step_definition_id && steps[startIndex].step_definition_id === def.id) {
      const args = extractCompositeArgs(steps, startIndex, tpls);
      if (args) {
        return {
          keyword: def.keyword,
          phrase: renderPattern(def.pattern, args),
          consumed: tpls.length,
        };
      }
    }

    // Implicit match: every sub-step command and params must match the template
    let matched = true;
    const args = [];
    for (let j = 0; j < tpls.length; j++) {
      const step = steps[startIndex + j];
      const tpl = tpls[j];
      if (step.command !== tpl.command) { matched = false; break; }
      if (!walk(tpl.params, normalizeParams(step), args)) { matched = false; break; }
    }
    if (!matched) continue;

    // Verify all arg slots are filled
    if (args.some(a => a === undefined)) continue;

    return {
      keyword: def.keyword,
      phrase: renderPattern(def.pattern, args),
      consumed: tpls.length,
    };
  }
  return null;
}

function extractCompositeArgs(steps, startIndex, tpls) {
  const args = [];
  for (let j = 0; j < tpls.length; j++) {
    const step = steps[startIndex + j];
    const tpl = tpls[j];
    if (step.command !== tpl.command) return null;
    if (!walk(tpl.params, normalizeParams(step), args)) return null;
  }
  if (args.some(a => a === undefined)) return null;
  return args;
}

function renderStepPhrase(step, definitions) {
  // Case 1 — explicit link via step_definition_id
  if (step.step_definition_id) {
    const def = definitions.find(d => d.id === step.step_definition_id);
    if (def) {
      const args = extractArgs(def.params_template, normalizeParams(step));
      if (args) return { keyword: def.keyword, phrase: renderPattern(def.pattern, args) };
    }
  }

  // Case 2 — implicit match by command + template shape
  for (const def of definitions) {
    if (def.command !== step.command) continue;
    const args = extractArgs(def.params_template, normalizeParams(step));
    if (args) return { keyword: def.keyword, phrase: renderPattern(def.pattern, args) };
  }

  // Case 3 — fallback: use intent or raw command
  const keyword = fallbackKeyword(step.command);
  const phrase = step.intent
    ? `"${String(step.intent).replace(/"/g, '\\"')}"`
    : `${step.command} ${JSON.stringify(step.params || {})}`;
  return { keyword, phrase };
}

function normalizeParams(step) {
  // For assert steps the data lives in `step.assertion`, not `step.params`.
  if (step.command === 'assert') {
    return step.assertion || step.params || {};
  }
  return step.params || {};
}

function fallbackKeyword(command) {
  if (command === 'navigate') return 'Given';
  if (command === 'assert') return 'Then';
  return 'When';
}

// ─── Template matching ──────────────────────────────────────────────

function extractArgs(template, actual) {
  const args = [];
  if (!walk(template, actual, args)) return null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === undefined) return null;
  }
  return args;
}

function walk(tpl, actual, args) {
  if (typeof tpl === 'string') {
    return matchTemplateString(tpl, actual, args);
  }
  if (Array.isArray(tpl)) {
    if (!Array.isArray(actual) || actual.length !== tpl.length) return false;
    return tpl.every((v, i) => walk(v, actual[i], args));
  }
  if (tpl && typeof tpl === 'object') {
    if (!actual || typeof actual !== 'object') return false;
    for (const key of Object.keys(tpl)) {
      if (!walk(tpl[key], actual[key], args)) return false;
    }
    return true;
  }
  return tpl === actual;
}

function matchTemplateString(tpl, actual, args) {
  // Pure placeholder "{N}" — capture the value, but only if actually present
  const pure = tpl.match(/^\{(\d+)\}$/);
  if (pure) {
    if (actual == null) return false;
    args[Number(pure[1])] = String(actual);
    return true;
  }

  // No placeholder — literal match
  if (!tpl.includes('{')) {
    return tpl === (actual == null ? '' : String(actual));
  }

  // Mixed template "{0}000" → compile to regex with capture groups
  if (actual == null) return false;
  const parts = tpl.split(/(\{\d+\})/);
  const indices = [];
  let regexSrc = '^';
  for (const part of parts) {
    const m = part.match(/^\{(\d+)\}$/);
    if (m) {
      indices.push(Number(m[1]));
      regexSrc += '(.+)';
    } else {
      regexSrc += escapeRegex(part);
    }
  }
  regexSrc += '$';

  const match = new RegExp(regexSrc).exec(String(actual));
  if (!match) return false;
  for (let i = 0; i < indices.length; i++) {
    args[indices[i]] = match[i + 1];
  }
  return true;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Characters of a template that are not placeholders.
function literalLength(tpl) {
  if (tpl == null) return 0;
  if (typeof tpl !== 'object') return String(tpl).replace(/\{\d+\}/g, '').length;
  return Object.values(tpl).reduce((a, v) => a + literalLength(v), 0);
}

function templateComplexity(tpl) {
  if (tpl == null) return 0;
  if (typeof tpl !== 'object') return 1;
  if (Array.isArray(tpl)) return tpl.reduce((a, v) => a + templateComplexity(v), 0);
  return Object.values(tpl).reduce((a, v) => a + templateComplexity(v), 0);
}

// ─── Pattern rendering ──────────────────────────────────────────────

function renderPattern(pattern, args) {
  let i = 0;
  return pattern.replace(/\{(string|int|float|word)\}/g, (_, type) => {
    const val = args[i++] ?? '';
    if (type === 'string') return `"${String(val).replace(/"/g, '\\"')}"`;
    return String(val);
  });
}
