// Xray Cloud: a campaign's results sent to Xray (lib/campaigns.js) — a Test Execution holding
// each test's result. Each IziTest test is a Generic test of Xray, created the first time and
// found again after by its definition ("izitest:<name>"), linked to the Jira stories it covers
// (its requirements imported from Jira): Xray shows their coverage. Sent again, a campaign
// updates its Test Execution. Nothing is sent without being asked, and a dry run comes first.
//
// An API key of Xray (Jira → Apps → Xray → API Keys: a client id and a secret) is set in the
// dashboard (Settings → Xray), else read from XRAY_CLIENT_ID and XRAY_CLIENT_SECRET; XRAY_BASE_URL
// names a regional Xray (e.g. https://eu.xray.cloud.getxray.app).

import { db, parseJson } from './db.js';
import { log } from './logger.js';
import { getCampaign } from './campaigns.js';
import { jiraConfig, mask } from './jira.js';

const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;
const xrayUrl = () => (process.env.XRAY_BASE_URL || 'https://xray.cloud.getxray.app').replace(/\/+$/, '');

// ─── Connection ──────────────────────────────────────────────────────

/** The Xray API key: set in the dashboard, else in the environment; null when neither is. */
export function xrayConfig() {
  const saved = parseJson(db.prepare("SELECT value FROM settings WHERE key = 'xray'").get()?.value);
  if (saved?.clientId && saved?.clientSecret) return { ...saved, from: 'settings' };
  const { XRAY_CLIENT_ID: clientId, XRAY_CLIENT_SECRET: clientSecret } = process.env;
  return clientId && clientSecret ? { clientId, clientSecret, from: 'env' } : null;
}

/** The API key as the dashboard shows it: the secret masked. */
export function maskedXrayConfig() {
  const config = xrayConfig();
  return config ? { ...config, clientSecret: mask(config.clientSecret) } : null;
}

/** Keep the API key the dashboard sets. A secret given masked keeps the one saved; no client id removes the key. */
export function saveXrayConfig({ clientId, clientSecret }) {
  if (!clientId?.trim()) {
    db.prepare("DELETE FROM settings WHERE key = 'xray'").run();
    return null;
  }
  const saved = parseJson(db.prepare("SELECT value FROM settings WHERE key = 'xray'").get()?.value);
  const secret = clientSecret?.includes('•') ? saved?.clientSecret : clientSecret?.trim();
  if (!secret) throw new Error('Xray needs the client secret of the API key, with its client id');
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('xray', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
              ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(JSON.stringify({ clientId: clientId.trim(), clientSecret: secret }));
  log('Xray API key set');
  return maskedXrayConfig();
}

/** Why Xray refused a call, in a sentence. */
function refusal(status, body, path) {
  const said = typeof body === 'string' ? body.trim() : body?.error ?? body?.message ?? '';
  if (status === 401 && path.endsWith('/authenticate')) {
    return 'Xray refused the API key: check its client id and secret (Jira → Apps → Xray → API Keys), and that Xray is licensed on the site';
  }
  if (status === 401) return 'Xray refused the token, or its license is not valid on the site';
  return said ? `Xray: ${said}` : `Xray answered ${status} to ${path}`;
}

/** A client of Xray Cloud's REST API v2, authenticated by the API key once. `fetch` can be given (tests). */
export function xrayClient(config = xrayConfig(), { fetch = globalThis.fetch, baseUrl = xrayUrl() } = {}) {
  if (!config) throw new Error('No Xray API key set: Settings → Xray in the dashboard (or XRAY_CLIENT_ID, XRAY_CLIENT_SECRET)');
  const call = async (path, body, token) => {
    let res;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
    } catch (err) {
      throw new Error(`Xray could not be reached at ${baseUrl}: ${err.cause?.message ?? err.message}`);
    }
    const text = await res.text();
    const data = parseJson(text);
    if (!res.ok) {
      const error = new Error(refusal(res.status, data, path));
      error.status = res.status;
      throw error;
    }
    return data;
  };
  let token = null;
  // The token comes as a JSON string.
  const authenticate = async () => (token ??= await call('/api/v2/authenticate', { client_id: config.clientId, client_secret: config.clientSecret }));
  return { baseUrl, authenticate, post: async (path, body) => call(path, body, await authenticate()) };
}

/** Whether the API key works: Xray gives a token for it. */
export async function testXray(client) {
  await client.authenticate();
  return { url: client.baseUrl };
}

// ─── A campaign, as a Test Execution ─────────────────────────────────

// A result as Xray's statuses say it: a test not run (stopped, could not start) is still to do.
const XRAY_STATUS = { passed: 'PASSED', failed: 'FAILED' };

/** A date as Xray reads it: no milliseconds. */
const xrayDate = (iso) => (iso ? new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z') : undefined);

/** The Jira stories a test covers: its requirements imported from Jira. */
function storiesOf(testName) {
  return db.prepare(
    `SELECT DISTINCT r.key FROM requirement_cases c JOIN tests t ON t.id = c.test_id JOIN requirements r ON r.id = c.requirement_id
     WHERE t.name = ? AND r.source = 'jira' ORDER BY r.key`
  ).all(testName).map((r) => r.key).filter((key) => KEY.test(key));
}

/** What Xray is told of a test's result: how it did, where it failed and why. */
function commentOf(t) {
  const seconds = t.duration_ms != null ? ` in ${Math.round(t.duration_ms / 1000)}s` : '';
  if (t.status === 'passed') return `Passed${seconds}.`;
  if (t.status === 'failed') {
    const where = t.failed_step ? ` at step ${t.failed_step}/${t.total_steps}` : '';
    const triage = t.triage ? `\n\nTriage: ${t.triage.cause} (${t.triage.confidence}) — ${t.triage.summary}` : '';
    return `Failed${where}${seconds}: ${String(t.error ?? '').trim()}${triage}`;
  }
  if (t.status === 'error') return `Could not run: ${String(t.error ?? '').trim()}`;
  return 'Not run: the campaign was stopped before it.';
}

/**
 * The Jira project the Test Execution goes in: the one asked for, else the one of the stories
 * the campaign's tests cover, when they are all of one.
 */
function projectOf(projectKey, tests) {
  if (projectKey) {
    const key = String(projectKey).trim().toUpperCase();
    if (!PROJECT_KEY.test(key)) throw new Error(`Not a Jira project key: "${projectKey}" (e.g. SHOP)`);
    return key;
  }
  const projects = [...new Set(tests.flatMap((t) => t.requirementKeys.map((k) => k.replace(/-\d+$/, ''))))];
  if (projects.length === 1) return projects[0];
  throw new Error(projects.length
    ? `The campaign's stories are in several Jira projects (${projects.join(', ')}): say which one the Test Execution goes in (project_key)`
    : 'None of the campaign\'s tests covers a story imported from Jira: say which Jira project the Test Execution goes in (project_key)');
}

/**
 * The Xray JSON of a campaign: a new Test Execution and each test's result, the test a Generic
 * test linked to the stories it covers.
 */
export function xrayExecutionOf(campaign, { projectKey = null, testPlanKey = null } = {}) {
  const runs = new Map(db.prepare(`SELECT id, started_at, finished_at FROM test_executions WHERE campaign_id = ?`).all(campaign.id).map((r) => [r.id, r]));
  const descriptions = new Map(db.prepare(
    `SELECT name, description FROM tests WHERE name IN (${campaign.runs.map(() => '?').join(',') || "''"})`
  ).all(...campaign.runs.map((t) => t.name)).map((t) => [t.name, t.description]));
  const tests = campaign.runs.map((t) => ({ ...t, requirementKeys: storiesOf(t.name) }));
  const project = projectOf(projectKey, tests);
  if (testPlanKey && !KEY.test(String(testPlanKey).trim().toUpperCase())) throw new Error(`Not a Jira key: "${testPlanKey}" (e.g. SHOP-40)`);
  const summary = `IziTest — ${campaign.name}${campaign.version ? ` (${campaign.version})` : ''}`;
  const description = [
    `IziTest campaign #${campaign.id}: ${campaign.totals.passed}/${campaign.total} passed, ${campaign.totals.failed} failed`
      + `${campaign.totals.error ? `, ${campaign.totals.error} could not run` : ''}${campaign.totals.skipped ? `, ${campaign.totals.skipped} not run` : ''}.`,
    ...(campaign.changes?.regressed.length ? [`Regressed since campaign #${campaign.changes.since.id}: ${campaign.changes.regressed.join(', ')}.`] : []),
    ...(campaign.non_conformities.length ? [`Non-conformities: ${campaign.non_conformities.join(', ')}.`] : []),
  ].join('\n');
  return {
    info: {
      project, summary, description,
      ...(xrayDate(campaign.created_at) ? { startDate: xrayDate(campaign.created_at) } : {}),
      ...(xrayDate(campaign.finished_at) ? { finishDate: xrayDate(campaign.finished_at) } : {}),
      ...(testPlanKey ? { testPlanKey: String(testPlanKey).trim().toUpperCase() } : {}),
    },
    tests: tests.map((t) => {
      const run = runs.get(t.execution_id);
      return {
        testInfo: {
          projectKey: project, type: 'Generic', summary: descriptions.get(t.name)?.trim() || t.name, definition: `izitest:${t.name}`,
          labels: ['izitest'], ...(t.requirementKeys.length ? { requirementKeys: t.requirementKeys } : {}),
        },
        status: XRAY_STATUS[t.status] ?? 'TODO',
        comment: commentOf(t),
        ...(run?.started_at ? { start: xrayDate(run.started_at) } : {}),
        ...(run?.finished_at ? { finish: xrayDate(run.finished_at) } : {}),
      };
    }),
  };
}

/** A Test Execution Xray says is not there (deleted since it was sent). */
const isGone = (err) => err.status === 400 && /not (?:be )?found|does not exist|doesn't exist|no issue/i.test(err.message);

/**
 * Send a campaign's results to Xray: a Test Execution in `projectKey` (default: the project of
 * the stories its tests cover), in a Test Plan when given one — or, sent before, the same Test
 * Execution updated. A dry run unless `dryRun` is false: what would be sent.
 */
export async function exportToXray(campaignId, { projectKey = null, testPlanKey = null, dryRun = true } = {}, { client = null } = {}) {
  const campaign = getCampaign(campaignId);
  if (!campaign) throw new Error(`No campaign #${campaignId}`);
  if (campaign.running) throw new Error(`Campaign #${campaign.id} is still running: send it once it is done`);
  const executionKey = campaign.xray_execution_key ?? null;
  const created = xrayExecutionOf(campaign, { projectKey, testPlanKey });
  // Sent before: its Test Execution is given the results again, not its fields — Xray may not be
  // let set them once it exists (its dates, on a team-managed project), and they do not change.
  const payload = executionKey
    ? { testExecutionKey: executionKey, ...(created.info.testPlanKey ? { info: { testPlanKey: created.info.testPlanKey } } : {}), tests: created.tests }
    : created;
  const site = jiraConfig()?.baseUrl ?? null;
  const summary = {
    project: created.info.project, execution: executionKey, updates: !!executionKey,
    tests: payload.tests.map((t) => ({ name: t.testInfo.definition.replace(/^izitest:/, ''), status: t.status, stories: t.testInfo.requirementKeys ?? [] })),
  };
  if (dryRun) return { sent: false, ...summary, payload };

  client ??= xrayClient();
  let answer;
  try {
    answer = await client.post('/api/v2/import/execution', payload);
  } catch (err) {
    if (!executionKey || !isGone(err)) throw err;
    // Its Test Execution deleted in Jira since: a new one.
    answer = await client.post('/api/v2/import/execution', created);
  }
  const key = answer?.key ?? null;
  if (key) db.prepare('UPDATE campaigns SET xray_execution_key = ? WHERE id = ?').run(key, campaign.id);
  log(`Xray: campaign #${campaign.id} sent to ${key ?? 'a Test Execution'} (${payload.tests.length} test(s))`);
  return { sent: true, ...summary, execution: key, url: key && site ? `${site}/browse/${key}` : null };
}

/** What was (or would be) sent to Xray, for the agent. */
export function formatXrayExport(result) {
  const counts = Object.entries(result.tests.reduce((acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }), {}))
    .map(([status, n]) => `${n} ${status}`).join(', ');
  const head = result.sent
    ? `Sent to Xray: ${result.execution ?? 'a Test Execution'}${result.url ? ` (${result.url})` : ''}, in ${result.project} — ${counts}.`
    : `Dry run — would ${result.updates ? `update the Test Execution ${result.execution}` : 'create a Test Execution'} in ${result.project}: ${counts}. Nothing sent; dry_run: false sends it.`;
  return [
    head,
    ...result.tests.map((t) => `- ${t.name}: ${t.status}${t.stories.length ? ` — covers ${t.stories.join(', ')}` : ''}`),
    ...(result.sent ? [] : ['Each test is a Generic test of Xray (found again by its definition "izitest:<name>"), linked to the stories it covers.']),
  ].join('\n');
}
