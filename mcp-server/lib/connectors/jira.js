// Jira Cloud, a connector (lib/connectors): its stories read as requirements — summary,
// description, acceptance criteria (a field of their own, or the list under "Acceptance criteria"
// in the description), priority, link — by a JQL query, their keys, or again to see which
// changed; and each story told where it stands in IziTest, as a comment of IziTest's (one a
// story, updated after) — only when asked, after a dry run. A bug of IziTest's is sent as an
// issue of a project (a Bug, unless said otherwise), updated when sent again.
//
// The site, the account's email and an API token of that account are set in the dashboard
// (Settings → Connectors → Jira), else read from JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN.

import { splitCriteria, priorityOf, fold } from '../requirement-import.js';

const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const MAX_ISSUES = 500;

// ─── Connection ──────────────────────────────────────────────────────

/** A site's address as Jira gives it: https, no path. */
export function siteOf(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? '').trim());
  } catch {
    throw new Error(`Not a Jira site address: "${url}" (e.g. https://your-team.atlassian.net)`);
  }
  if (parsed.protocol !== 'https:') throw new Error('The Jira site has to be reached over https');
  return parsed.origin;
}

/** Why Jira refused a call, in a sentence. */
function refusal(status, body, path) {
  const messages = [...(body?.errorMessages ?? []), ...Object.values(body?.errors ?? {})].join(' ');
  if (status === 401) return 'Jira refused the email and API token: check them (an API token, not the account password)';
  if (status === 403) return `This account may not do that in Jira${messages ? `: ${messages}` : ''}`;
  if (status === 404 && !messages) return `Not found on the Jira site: ${path}`;
  return messages || `Jira answered ${status} to ${path}`;
}

/** A client of a Jira site's REST API, as its account. */
export function jiraClient(config, { fetch = globalThis.fetch } = {}) {
  const auth = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`;
  const call = async (method, path, body) => {
    let res;
    try {
      res = await fetch(`${config.baseUrl}${path}`, {
        method, headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new Error(`Jira could not be reached at ${config.baseUrl}: ${err.cause?.message ?? err.message}`);
    }
    const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : null;
    if (!res.ok) {
      const error = new Error(refusal(res.status, data, path));
      error.status = res.status;
      error.messages = data?.errorMessages ?? [];
      error.fields = Object.keys(data?.errors ?? {});
      throw error;
    }
    return data;
  };
  return {
    baseUrl: config.baseUrl, get: (path) => call('GET', path), post: (path, body) => call('POST', path, body), put: (path, body) => call('PUT', path, body),
  };
}

/**
 * A query for a project's requirements: its stories, when it has a Story type; else its issues
 * but sub-tasks (standardIssueTypes(), whatever the site's language names them).
 */
function storiesQuery(project) {
  const story = project.issueTypes?.find((t) => !t.subtask && /^story$/i.test(t.name));
  const type = story ? `issuetype = ${story.name}` : 'issuetype in standardIssueTypes()';
  return `project = ${project.key} AND ${type} ORDER BY key`;
}

// ─── Reading stories ─────────────────────────────────────────────────

/**
 * The text of an Atlassian Document (a description, a rich text field): paragraphs and headings
 * a line each, list items as "- …" (nested ones indented), a task as "- [ ] …", a table's rows
 * as cells between "|".
 */
export function adfToText(node, indent = '') {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  const inline = (n) => (n.content ?? []).map((c) => adfToText(c, indent)).join('');
  const blocks = (n, at = indent) => (n.content ?? []).map((c) => adfToText(c, at)).filter((t) => t !== '').join('\n');
  switch (node.type) {
    case 'doc': return blocks(node).replace(/\n{3,}/g, '\n\n').trim();
    case 'text': return node.text ?? '';
    case 'hardBreak': return '\n';
    case 'mention': return node.attrs?.text ?? '';
    case 'emoji': return node.attrs?.text ?? node.attrs?.shortName ?? '';
    case 'inlineCard': case 'blockCard': case 'embedCard': return node.attrs?.url ?? '';
    case 'status': return node.attrs?.text ?? '';
    case 'date': return node.attrs?.timestamp ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10) : '';
    case 'paragraph': case 'heading': return inline(node);
    case 'bulletList': case 'orderedList': case 'taskList':
      return (node.content ?? []).map((item) => adfToText(item, indent)).join('\n');
    case 'listItem': case 'taskItem': {
      const box = node.type === 'taskItem' ? (node.attrs?.state === 'DONE' ? '[x] ' : '[ ] ') : '';
      const parts = (node.content ?? []);
      const text = node.type === 'taskItem' ? inline(node)
        : parts.filter((c) => !/List$/.test(c.type)).map((c) => adfToText(c, indent)).join(' ');
      const nested = parts.filter((c) => /List$/.test(c.type)).map((c) => adfToText(c, `${indent}  `));
      return [`${indent}- ${box}${text}`, ...nested].join('\n');
    }
    case 'table': return (node.content ?? []).map((row) => (row.content ?? []).map((cell) => blocks(cell).replace(/\n/g, ' ')).join(' | ')).join('\n');
    case 'rule': return '---';
    case 'media': case 'mediaSingle': case 'mediaGroup': return '';
    default: return node.content ? blocks(node) : '';
  }
}

// What a field holding the acceptance criteria is called, folded.
const CRITERIA_FIELD = /^(acceptance criteria|criteres? d acceptation|ac)$/;

/** The ids of the site's fields that hold acceptance criteria ("Acceptance Criteria", a custom field). */
export async function criteriaFields(client) {
  const fields = await client.get('/rest/api/3/field');
  return fields.filter((f) => CRITERIA_FIELD.test(fold(f.name))).map((f) => f.id);
}

/** The issues a JQL query finds, page after page (at most 500), with the fields asked for. */
export async function searchIssues(client, jql, fields) {
  const issues = [];
  let nextPageToken;
  do {
    const page = await client.post('/rest/api/3/search/jql', { jql, fields, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) });
    issues.push(...(page.issues ?? []));
    nextPageToken = page.isLast === false || (page.isLast == null && page.nextPageToken) ? page.nextPageToken : undefined;
  } while (nextPageToken && issues.length < MAX_ISSUES);
  return issues.slice(0, MAX_ISSUES);
}

/** A Jira issue as a requirement: its summary, description as text, criteria from their own field when it has one. */
export function requirementOfIssue(issue, { baseUrl, criteriaFieldIds = [] }) {
  const fields = issue.fields ?? {};
  const fromField = criteriaFieldIds.map((id) => fields[id]).filter((v) => v != null && v !== '')
    .map((v) => (typeof v === 'string' ? v : adfToText(v))).join('\n');
  return {
    key: issue.key, title: String(fields.summary ?? '').trim() || issue.key,
    description: adfToText(fields.description), criteria: splitCriteria(fromField),
    priority: priorityOf(fields.priority?.name) ?? 'medium', url: `${baseUrl}/browse/${issue.key}`,
  };
}

/** The keys a JQL "key in (…)" refused: they do not exist, or this account cannot see them. */
const refusedKeys = (messages) => messages.flatMap((m) => [...m.matchAll(/'([A-Z][A-Z0-9_]+-\d+)'/g)].map((x) => x[1]));

/**
 * The stories to read as requirements: those a JQL query finds, those of `keys`, or those imported
 * already (`known`, read again). A key that is not in Jira is told, the others read.
 */
async function readStories(client, { query, keys, known }) {
  const wanted = (known ? known.map((k) => k.key) : keys.map((k) => k.toUpperCase())).filter((k) => !known || KEY.test(k));
  const bad = wanted.filter((k) => !KEY.test(k));
  if (bad.length) throw new Error(`Not Jira keys: ${bad.join(', ')} (e.g. SHOP-12)`);

  const fieldIds = await criteriaFields(client);
  const fields = ['summary', 'description', 'priority', 'issuetype', 'status', ...fieldIds];
  const warnings = [];
  let issues;
  if (wanted.length) {
    // "key in (…)" fails as a whole on a key that does not exist: those are told, the others read.
    let left = [...new Set(wanted)];
    for (;;) {
      if (!left.length) { issues = []; break; }
      try {
        issues = await searchIssues(client, `key in (${left.join(', ')}) ORDER BY key`, fields);
        break;
      } catch (err) {
        const refused = err.status === 400 ? refusedKeys(err.messages ?? []).filter((k) => left.includes(k)) : [];
        if (!refused.length) throw err;
        left = left.filter((k) => !refused.includes(k));
      }
    }
    const found = new Set(issues.map((i) => i.key));
    for (const key of wanted) if (!found.has(key)) warnings.push(`${key} is not in Jira, or this account cannot see it`);
  } else {
    issues = await searchIssues(client, query, fields);
  }
  return { records: issues.map((issue) => requirementOfIssue(issue, { baseUrl: client.baseUrl, criteriaFieldIds: fieldIds })), warnings };
}

// ─── Writing back: a story's coverage, as a comment ─────────────────

const COVERAGE_LABELS = { passing: '✅ Passing', failing: '❌ Failing', not_run: '⏳ Not run yet', not_covered: '⚠️ Not covered' };

/** How a test did last, in words: "passed (2026-11-02)", "failed (…)", "not run yet". */
function lastResult(c) {
  const status = c.last_run?.status;
  if (!status) return 'not run yet';
  const word = status === 'success' ? 'passed' : status;
  return c.last_run.started_at ? `${word} (${c.last_run.started_at.slice(0, 10)})` : word;
}

/**
 * A story's coverage as IziTest has it, as an Atlassian document: where it stands, each of
 * its criteria with the tests of it and how they did last, the campaign it comes from, when.
 */
export function coverageComment(requirement, { campaign = null, now = new Date() } = {}) {
  const t = (text, marks) => ({ type: 'text', text, ...(marks ? { marks: marks.map((type) => ({ type })) } : {}) });
  const p = (...content) => ({ type: 'paragraph', content });
  const { coverage, criteria, cases } = requirement;
  const testsOf = (list) => list.map((c) => `${c.test}: ${lastResult(c)}`).join(', ');
  const markOf = (list) => (!list.length ? '○' : list.some((c) => c.last_run?.status === 'failed') ? '✗'
    : list.every((c) => c.last_run?.status === 'success') ? '✓' : '…');
  const items = criteria.map((criterion) => {
    const tested = cases.filter((c) => c.test && c.criterion_id === criterion.id);
    return { type: 'listItem', content: [p(t(`${markOf(tested)} ${criterion.position}. ${criterion.text} — `), t(tested.length ? testsOf(tested) : 'no test yet', ['em']))] };
  });
  const others = cases.filter((c) => c.test && !c.criterion_id);
  const counts = `${criteria.length ? `${coverage.covered}/${coverage.criteria} criteria covered, ` : ''}${coverage.tests} test${coverage.tests === 1 ? '' : 's'}`;
  const from = campaign
    ? `Campaign #${campaign.id} "${campaign.name}"${campaign.version ? ` (${campaign.version})` : ''}: ${campaign.totals.passed}/${campaign.total} passed. `
    : '';
  return {
    type: 'doc', version: 1,
    content: [
      p(t(`IziTest — ${COVERAGE_LABELS[coverage.status] ?? coverage.status}`, ['strong']), t(` · ${counts}`)),
      ...(items.length ? [{ type: 'bulletList', content: items }] : [p(t('No acceptance criteria.'))]),
      ...(others.length ? [p(t('Also checked by: '), t(testsOf(others), ['em']))] : []),
      p(t(`${from}Updated by IziTest on ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC.`, ['em'])),
    ],
  };
}

/** Posts a story's comment — IziTest's one (`ref`), updated when it is still there: its id, what was done, its link. */
async function postComment(client, requirement, body, ref) {
  const path = `/rest/api/3/issue/${encodeURIComponent(requirement.key)}/comment`;
  const link = (id) => `${client.baseUrl}/browse/${requirement.key}?focusedCommentId=${id}`;
  if (ref) {
    try {
      await client.put(`${path}/${ref}`, { body });
      return { ref, action: 'updated', url: link(ref) };
    } catch (err) {
      if (err.status !== 404) throw err; // deleted in Jira since: a new one
    }
  }
  const comment = await client.post(path, { body });
  return { ref: String(comment.id), action: 'added', url: link(comment.id) };
}

// ─── Writing back: a bug, as an issue ────────────────────────────────

const BUG_STATUS_WORDS = {
  open: 'open', to_retest: 'said fixed — waiting for its test to confirm', deferred: 'fix deferred', duplicate: 'duplicate',
  fixed: 'fixed — its test passes again', dismissed: 'dismissed',
};
const BUG_KIND_WORDS = { non_conformity: 'a requirement is not met', regression: 'regression', reported: 'reported by a person' };
const JIRA_PRIORITIES = { high: 'High', medium: 'Medium', low: 'Low' };

/** A Jira project key, as given: upper case, checked. */
function projectKeyOf(value) {
  const key = String(value ?? '').trim().toUpperCase();
  if (!key) throw new Error('Say which Jira project the bug goes in: its key (e.g. SHOP)');
  if (!/^[A-Z][A-Z0-9_]+$/.test(key)) throw new Error(`Not a Jira project key: "${value}"`);
  return key;
}

/**
 * A bug of IziTest's as a Jira issue: its title, and a description saying what goes wrong, what
 * was expected, the test that reproduces it, the requirement it breaks, where it was last seen
 * and how it stands in IziTest.
 */
export function bugIssue(bug, { projectKey, issueType = 'Bug', now = new Date() } = {}) {
  const t = (text, marks) => ({ type: 'text', text, ...(marks ? { marks: marks.map((type) => ({ type })) } : {}) });
  const p = (...content) => ({ type: 'paragraph', content });
  const line = (label, value) => p(t(`${label}: `, ['strong']), t(String(value)));
  const d = bug.details ?? {};
  const requests = (d.failed_requests ?? []).map((r) => `${r.method ?? 'GET'} ${r.url} → ${r.status || 'no answer'}`);
  const criteria = (d.requirements ?? []).flatMap((r) => (r.criteria?.length
    ? r.criteria.map((c) => `${r.key} criterion ${c.number}: ${c.text}`)
    : [`${r.key} ${r.title}`]));
  const content = [
    ...(d.description ? [p(t(d.description))] : []),
    ...(d.summary ? [p(t(d.summary))] : []),
    ...(d.expected ? [line('Expected', d.expected)] : []),
    ...(d.actual ? [line('Actual', d.actual)] : []),
    ...(bug.page_url ? [line('Page', bug.page_url)] : []),
    ...(requests.length ? [line('Requests refused', requests.join(' ; '))] : []),
    ...(criteria.length ? [p(t('Requirement not met: ', ['strong'])), { type: 'bulletList', content: criteria.map((c) => ({ type: 'listItem', content: [p(t(c))] })) }] : []),
    ...(bug.repro_test
      ? [line('Reproduced by the test', `${bug.repro_test}${d.step?.order ? `, step ${d.step.order}${d.step.intent ? ` (${d.step.intent})` : ''}` : ''} — it passes again once the bug is fixed`)]
      : [p(t('No test reproduces it yet.', ['em']))]),
    ...(d.campaign ? [line('Last seen in', `campaign #${d.campaign.id} "${d.campaign.name}"${d.campaign.version ? ` (${d.campaign.version})` : ''}${d.campaign.commit ? `, commit ${d.campaign.commit}` : ''}`)] : []),
    line('Severity', `${bug.severity}${bug.priority ? ` · fix priority ${bug.priority}` : ''} · ${BUG_KIND_WORDS[bug.kind] ?? bug.kind} · seen ${bug.occurrences} time${bug.occurrences > 1 ? 's' : ''}`),
    p(t(`IziTest bug #${bug.id} — ${BUG_STATUS_WORDS[bug.status] ?? bug.status}. Updated by IziTest on ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC.`, ['em'])),
  ];
  const description = { type: 'doc', version: 1, content };
  const summary = bug.title.length > 250 ? `${bug.title.slice(0, 249)}…` : bug.title;
  return {
    summary, description,
    fields: {
      project: { key: projectKey }, issuetype: { name: issueType }, summary, description, labels: ['izitest'],
      ...(bug.priority ? { priority: { name: JIRA_PRIORITIES[bug.priority] } } : {}),
    },
  };
}

// What a project's screens may not have: left out when Jira refuses them, the issue still made.
const OPTIONAL_FIELDS = ['priority', 'labels'];

/** Sends fields, without those of OPTIONAL_FIELDS Jira refuses. */
async function withoutRefused(fields, send) {
  try {
    return await send(fields);
  } catch (err) {
    const refused = (err.fields ?? []).filter((f) => OPTIONAL_FIELDS.includes(f) && f in fields);
    if (err.status !== 400 || !refused.length) throw err;
    return send(Object.fromEntries(Object.entries(fields).filter(([name]) => !refused.includes(name))));
  }
}

/** Makes a bug's issue, or updates the one made before (`ref`) while it is still there: its key, what was done, its link. */
async function postBug(client, prepared, ref) {
  const link = (key) => `${client.baseUrl}/browse/${key}`;
  const { project, issuetype, ...content } = prepared.payload.fields;
  if (ref) {
    try {
      await withoutRefused(content, (fields) => client.put(`/rest/api/3/issue/${encodeURIComponent(ref)}`, { fields }));
      return { ref, action: 'updated', url: link(ref) };
    } catch (err) {
      if (err.status !== 404) throw err; // deleted in Jira since: a new one
    }
  }
  const issue = await withoutRefused({ project, issuetype, ...content }, (fields) => client.post('/rest/api/3/issue', { fields }));
  return { ref: issue.key, action: 'created', url: link(issue.key) };
}

// ─── The connector ───────────────────────────────────────────────────

export const jira = {
  id: 'jira',
  name: 'Jira',
  description: 'A Jira Cloud site.',
  settings: {
    fields: [
      { name: 'baseUrl', label: 'Site', type: 'url', placeholder: 'https://your-team.atlassian.net', env: 'JIRA_BASE_URL' },
      { name: 'email', label: 'Email of the account', type: 'text', placeholder: 'you@example.com', env: 'JIRA_EMAIL' },
      { name: 'apiToken', label: 'API token', type: 'secret', placeholder: 'Paste a token of that account', env: 'JIRA_API_TOKEN' },
    ],
    hint: 'A token is made at id.atlassian.com → Security → API tokens: a token, not the account password.',
    link: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    normalize: (values) => ({ ...values, baseUrl: siteOf(values.baseUrl) }),
  },
  async test({ config, fetch }) {
    const client = jiraClient(config, { fetch });
    const me = await client.get('/rest/api/3/myself');
    return `Connected to ${client.baseUrl} as ${me.displayName ?? me.emailAddress ?? me.accountId}.`;
  },
  requirements: {
    item: 'story', items: 'stories', keys: 'SHOP-12',
    reads: 'summary, description, priority, link, and their acceptance criteria — from an "Acceptance Criteria" field, or the list under "Acceptance criteria" in the description',
    query: { label: 'JQL query', placeholder: 'project = SHOP AND issuetype = Story ORDER BY key' },
    // The site's projects, each with a query for its stories to start from.
    async scopes({ config, fetch }) {
      const page = await jiraClient(config, { fetch }).get('/rest/api/3/project/search?maxResults=100&orderBy=key&expand=issueTypes');
      return (page.values ?? []).map((p) => ({ label: `${p.key} — ${p.name}`, query: storiesQuery(p) }));
    },
    read: ({ config, fetch }, wanted) => readStories(jiraClient(config, { fetch }), wanted),
  },
  coverage: {
    where: 'a comment on each story',
    render(requirement, { campaign }) {
      const body = coverageComment(requirement, { campaign });
      return { body, text: adfToText(body) };
    },
    post: ({ config, fetch }, requirement, body, { ref }) => postComment(jiraClient(config, { fetch }), requirement, body, ref),
  },
  bugs: {
    what: 'issue',
    options: [
      { name: 'project_key', label: 'Jira project', placeholder: 'SHOP' },
      { name: 'issue_type', label: 'Issue type', placeholder: 'Bug' },
    ],
    note: 'Sent again, the same issue is updated: its title and description, not its Jira status — that stays the team\'s.',
    prepare(bug, options = {}, { ref = null, suggestedProject = null } = {}) {
      const projectKey = ref ? ref.replace(/-\d+$/, '') : projectKeyOf(options.project_key || suggestedProject);
      const issueType = String(options.issue_type ?? '').trim() || 'Bug';
      const issue = bugIssue(bug, { projectKey, issueType });
      return { target: projectKey, type: issueType, summary: issue.summary, text: adfToText(issue.description), payload: { fields: issue.fields } };
    },
    send: ({ config, fetch }, prepared, { ref }) => postBug(jiraClient(config, { fetch }), prepared, ref),
    urlOf: (ctx, key) => {
      const site = ctx.configOf('jira')?.baseUrl;
      return key && site ? `${site}/browse/${key}` : null;
    },
  },
};
