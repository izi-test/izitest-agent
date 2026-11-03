// Xray Cloud, a connector (lib/connectors): a campaign's results sent to Xray — a Test Execution
// holding each test's result. Each IziTest test is a Generic test of Xray, created the first time
// and found again after by its definition ("izitest:<name>"), linked to the Jira stories it covers
// (its requirements imported from Jira): Xray shows their coverage. Sent again, a campaign
// updates its Test Execution. Nothing is sent without being asked, and a dry run comes first.
//
// An API key of Xray (Jira → Apps → Xray → API Keys: a client id and a secret) is set in the
// dashboard (Settings → Connectors → Xray), else read from XRAY_CLIENT_ID and XRAY_CLIENT_SECRET;
// XRAY_BASE_URL names a regional Xray (e.g. https://eu.xray.cloud.getxray.app).

import { parseJson } from '../db.js';

const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;
const xrayUrl = () => (process.env.XRAY_BASE_URL || 'https://xray.cloud.getxray.app').replace(/\/+$/, '');

// ─── Connection ──────────────────────────────────────────────────────

/** Why Xray refused a call, in a sentence. */
function refusal(status, body, path) {
  const said = typeof body === 'string' ? body.trim() : body?.error ?? body?.message ?? '';
  if (status === 401 && path.endsWith('/authenticate')) {
    return 'Xray refused the API key: check its client id and secret (Jira → Apps → Xray → API Keys), and that Xray is licensed on the site';
  }
  if (status === 401) return 'Xray refused the token, or its license is not valid on the site';
  return said ? `Xray: ${said}` : `Xray answered ${status} to ${path}`;
}

/** A client of Xray Cloud's REST API v2, authenticated by the API key once. */
export function xrayClient(config, { fetch = globalThis.fetch, baseUrl = xrayUrl() } = {}) {
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

// ─── A campaign, as a Test Execution ─────────────────────────────────

// A result as Xray's statuses say it: a test not run (stopped, could not start) is still to do.
const XRAY_STATUS = { passed: 'PASSED', failed: 'FAILED' };

/** A date as Xray reads it: no milliseconds. */
const xrayDate = (iso) => (iso ? new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z') : undefined);

/** The Jira stories a test covers: its requirements imported from Jira. */
const storiesOf = (test) => test.requirements.filter((r) => r.source === 'jira' && KEY.test(r.key)).map((r) => r.key);

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
  const tests = campaign.runs.map((t) => ({ ...t, requirementKeys: storiesOf(t) }));
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
    tests: tests.map((t) => ({
      testInfo: {
        projectKey: project, type: 'Generic', summary: t.description?.trim() || t.name, definition: `izitest:${t.name}`,
        labels: ['izitest'], ...(t.requirementKeys.length ? { requirementKeys: t.requirementKeys } : {}),
      },
      status: XRAY_STATUS[t.status] ?? 'TODO',
      comment: commentOf(t),
      ...(t.started_at ? { start: xrayDate(t.started_at) } : {}),
      ...(t.finished_at ? { finish: xrayDate(t.finished_at) } : {}),
    })),
  };
}

/** A Test Execution Xray says is not there (deleted since it was sent). */
const isGone = (err) => err.status === 400 && /not (?:be )?found|does not exist|doesn't exist|no issue/i.test(err.message);

// ─── The connector ───────────────────────────────────────────────────

export const xray = {
  id: 'xray',
  name: 'Xray',
  description: 'Xray Cloud, the test management of Jira: each test of IziTest is one of its tests, linked to the Jira stories it covers.',
  settings: {
    fields: [
      { name: 'clientId', label: 'Client ID', type: 'text', env: 'XRAY_CLIENT_ID' },
      { name: 'clientSecret', label: 'Client secret', type: 'secret', placeholder: 'The secret of that API key', env: 'XRAY_CLIENT_SECRET' },
    ],
    hint: 'An API key is made in Jira → Apps → Xray → API Keys (a Jira administrator\'s). XRAY_BASE_URL names a regional Xray.',
  },
  async test({ config, fetch }) {
    const client = xrayClient(config, { fetch });
    await client.authenticate();
    return `Xray takes this API key (${client.baseUrl}).`;
  },
  results: {
    what: 'Test Execution',
    options: [
      { name: 'project_key', label: 'Project', placeholder: 'default: the stories\'' },
      { name: 'test_plan_key', label: 'Test Plan', placeholder: 'optional, e.g. SHOP-40' },
    ],
    note: 'Each test is a Generic test of Xray (found again by its definition "izitest:<name>"), linked to the stories it covers.',
    /**
     * A Test Execution in `project_key` (default: the project of the stories its tests cover), in a
     * Test Plan when given one — or, sent before (`ref`), its results again, not its fields: Xray
     * may not be let set them once it exists (its dates, on a team-managed project), and they do not change.
     */
    prepare(campaign, { project_key: projectKey = null, test_plan_key: testPlanKey = null }, { ref }) {
      const created = xrayExecutionOf(campaign, { projectKey: projectKey || null, testPlanKey: testPlanKey || null });
      const payload = ref
        ? { testExecutionKey: ref, ...(created.info.testPlanKey ? { info: { testPlanKey: created.info.testPlanKey } } : {}), tests: created.tests }
        : created;
      return {
        target: created.info.project, payload, created,
        items: payload.tests.map((t) => ({ test: t.testInfo.definition.replace(/^izitest:/, ''), status: t.status, links: t.testInfo.requirementKeys ?? [] })),
      };
    },
    async send(ctx, { payload, created }, { ref }) {
      const client = xrayClient(ctx.config, { fetch: ctx.fetch });
      let answer;
      try {
        answer = await client.post('/api/v2/import/execution', payload);
      } catch (err) {
        if (!ref || !isGone(err)) throw err;
        // Its Test Execution deleted in Jira since: a new one.
        answer = await client.post('/api/v2/import/execution', created);
      }
      const key = answer?.key ?? null;
      return { ref: key, url: xray.results.urlOf(ctx, key) };
    },
    // A Test Execution is an issue of the Jira site.
    urlOf: (ctx, key) => {
      const site = ctx.configOf('jira')?.baseUrl;
      return key && site ? `${site}/browse/${key}` : null;
    },
  },
};
