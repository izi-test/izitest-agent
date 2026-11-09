#!/usr/bin/env node

// Run a campaign from a CI job or a terminal, and give its result as an exit code.
//
// It asks a running IziTest Agent server (the one whose Chrome has the extension) to replay a
// project's tests, a requirement's or a list, waits for the end, writes the JUnit XML a CI
// reads and the HTML report, and prints a line per failure.
//
//   node bin/campaign.js --project 3 --version 1.4.0 --junit reports/junit.xml
//   node bin/campaign.js --requirement REQ-12 --html reports/campaign.html
//   node bin/campaign.js --tests login,checkout --concurrency 2
//   node bin/campaign.js --project 3 --headless      (in the server's Chrome without windows)
//   node bin/campaign.js --stages stages.json        (the tests in stages: [{ "mode": "sequential",
//                                                     "tests": ["create_order"] }, { "tests": […],
//                                                     "needs_previous": true }])
//
// The token is read from IZITEST_TOKEN, the server from IZITEST_URL (default
// http://127.0.0.1:3467). Exit code 0: every test passed; 1: a test failed or did not run;
// 2: the campaign could not be run.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const BASE = (process.env.IZITEST_URL || 'http://127.0.0.1:3467').replace(/\/$/, '');
const headers = { 'Content-Type': 'application/json', ...(process.env.IZITEST_TOKEN ? { Authorization: `Bearer ${process.env.IZITEST_TOKEN}` } : {}) };

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const isJson = res.headers.get('content-type')?.includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new Error(isJson ? data.error ?? `HTTP ${res.status}` : `HTTP ${res.status}`);
  return data;
}

function save(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.log(`Written: ${file}`);
}

try {
  const project = option('project');
  const stagesFile = option('stages');
  const { campaign: started } = await api('POST', '/api/campaigns', {
    stages: stagesFile ? JSON.parse(readFileSync(stagesFile, 'utf8')) : undefined,
    project_id: project ? Number(project) : undefined,
    requirement: option('requirement'),
    tests: option('tests')?.split(',').map((t) => t.trim()).filter(Boolean),
    version: option('version'),
    name: option('name'),
    concurrency: option('concurrency') ? Number(option('concurrency')) : undefined,
    headless: args.includes('--headless'),
  });
  console.log(`Campaign #${started.id} "${started.name}": ${started.total} test(s)`);

  let campaign = started;
  while (campaign.running) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    ({ campaign } = await api('GET', `/api/campaigns/${started.id}`));
  }

  const { totals } = campaign;
  console.log(`${totals.passed} passed, ${totals.failed} failed${totals.error ? `, ${totals.error} could not run` : ''}${totals.skipped ? `, ${totals.skipped} not run` : ''}`);
  for (const t of campaign.runs.filter((r) => r.status === 'failed' || r.status === 'error')) {
    console.log(`  ✗ ${t.name}${t.failed_step ? ` (step ${t.failed_step})` : ''}${t.triage ? ` — ${t.triage.cause}: ${t.triage.summary}` : ''}`);
  }
  if (campaign.changes?.regressed.length) console.log(`Regressed since campaign #${campaign.changes.since.id}: ${campaign.changes.regressed.join(', ')}`);

  if (option('junit')) save(option('junit'), await api('GET', `/api/campaigns/${started.id}/junit.xml`));
  if (option('html')) save(option('html'), await api('GET', `/api/campaigns/${started.id}/report.html`));
  process.exit(totals.passed === campaign.total ? 0 : 1);
} catch (err) {
  console.error(`Campaign not run: ${err.message}`);
  process.exit(2);
}
