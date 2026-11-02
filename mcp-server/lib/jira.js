// Jira Cloud: requirements read from a Jira site — its stories, by their keys or a JQL query —
// into the records IziTest keeps (lib/requirement-import.js): key, summary, description,
// acceptance criteria (a field of their own, or the list under "Acceptance criteria" in the
// description), priority, link. Read again, a story changed since is told, with its tests to
// check. Written to Jira only when asked, and once tried as a dry run: a story's coverage, as a
// comment of IziTest's — one a story, updated after.
//
// The site, the account's email and an API token of that account are set in the dashboard
// (Settings → Jira), else read from JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN.

import { db, parseJson } from './db.js';
import { log } from './logger.js';
import { applyImport, splitCriteria, priorityOf, fold } from './requirement-import.js';
import { getRequirement } from './requirements.js';
import { getCampaign } from './campaigns.js';

const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const MAX_ISSUES = 500;

// ─── Connection ──────────────────────────────────────────────────────

/** The Jira site to read: set in the dashboard, else in the environment; null when neither is. */
export function jiraConfig() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'jira'").get();
  const saved = parseJson(row?.value);
  if (saved?.baseUrl && saved?.email && saved?.apiToken) return { ...saved, from: 'settings' };
  const { JIRA_BASE_URL: baseUrl, JIRA_EMAIL: email, JIRA_API_TOKEN: apiToken } = process.env;
  return baseUrl && email && apiToken ? { baseUrl: baseUrl.replace(/\/+$/, ''), email, apiToken, from: 'env' } : null;
}

/** A secret as the dashboard is shown it: its ends, the rest dots. */
export const mask = (token) => (token.length > 8 ? `${token.slice(0, 4)}${'•'.repeat(token.length - 8)}${token.slice(-4)}` : '••••••••');

/** The connection as the dashboard shows it: the token masked. */
export function maskedJiraConfig() {
  const config = jiraConfig();
  return config ? { ...config, apiToken: mask(config.apiToken) } : null;
}

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

/**
 * Keep the connection the dashboard sets. A token given masked (as the dashboard was shown it)
 * keeps the one saved; an empty address removes the connection.
 */
export function saveJiraConfig({ baseUrl, email, apiToken }) {
  if (!baseUrl?.trim()) {
    db.prepare("DELETE FROM settings WHERE key = 'jira'").run();
    return null;
  }
  const saved = parseJson(db.prepare("SELECT value FROM settings WHERE key = 'jira'").get()?.value);
  const token = apiToken?.includes('•') ? saved?.apiToken : apiToken?.trim();
  if (!email?.trim() || !token) throw new Error('Jira needs the account\'s email and an API token');
  const value = { baseUrl: siteOf(baseUrl), email: email.trim(), apiToken: token };
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('jira', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
              ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(JSON.stringify(value));
  log(`Jira connection set: ${value.baseUrl} as ${value.email}`);
  return maskedJiraConfig();
}

/** Why Jira refused a call, in a sentence. */
function refusal(status, body, path) {
  const messages = [...(body?.errorMessages ?? []), ...Object.values(body?.errors ?? {})].join(' ');
  if (status === 401) return 'Jira refused the email and API token: check them (an API token, not the account password)';
  if (status === 403) return `This account may not do that in Jira${messages ? `: ${messages}` : ''}`;
  if (status === 404 && !messages) return `Not found on the Jira site: ${path}`;
  return messages || `Jira answered ${status} to ${path}`;
}

/** A client of a Jira site's REST API, as its account. `fetch` can be given (tests). */
export function jiraClient(config = jiraConfig(), { fetch = globalThis.fetch } = {}) {
  if (!config) throw new Error('No Jira site set: Settings → Jira in the dashboard (or JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)');
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
      throw error;
    }
    return data;
  };
  return {
    baseUrl: config.baseUrl, get: (path) => call('GET', path), post: (path, body) => call('POST', path, body), put: (path, body) => call('PUT', path, body),
  };
}

/** Whether the connection works: who it reads as. */
export async function testJira(client) {
  const me = await client.get('/rest/api/3/myself');
  return { user: me.displayName ?? me.emailAddress ?? me.accountId, site: client.baseUrl };
}

/** The site's projects, for a query to start from. */
export async function jiraProjects(client) {
  const page = await client.get('/rest/api/3/project/search?maxResults=100&orderBy=key&expand=issueTypes');
  return (page.values ?? []).map((p) => ({ key: p.key, name: p.name, jql: storiesQuery(p) }));
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
    priority: priorityOf(fields.priority?.name) ?? 'medium', url: `${baseUrl}/browse/${issue.key}`, source: 'jira',
  };
}

/** The keys a JQL "key in (…)" refused: they do not exist, or this account cannot see them. */
const refusedKeys = (messages) => messages.flatMap((m) => [...m.matchAll(/'([A-Z][A-Z0-9_]+-\d+)'/g)].map((x) => x[1]));

/**
 * Read stories from Jira and import them as requirements (lib/requirement-import.js): those
 * a JQL query finds, those of `keys`, or — `sync` — the ones imported from Jira already (in
 * `projectId`, or all), to see which changed. A dry run unless `dryRun` is false.
 */
export async function importFromJira({ jql, keys, sync = false, projectId = null, dryRun = true }, { client = jiraClient() } = {}) {
  let wanted = keys?.map((k) => String(k).trim().toUpperCase()).filter(Boolean) ?? [];
  if (sync) {
    wanted = db.prepare(`SELECT key FROM requirements WHERE source = 'jira' AND (project_id IS ? OR ? IS NULL) ORDER BY id`)
      .all(projectId, projectId).map((r) => r.key).filter((k) => KEY.test(k));
    if (!wanted.length) throw new Error('No requirement imported from Jira yet: import some first, by a query or their keys');
  }
  const bad = wanted.filter((k) => !KEY.test(k));
  if (bad.length) throw new Error(`Not Jira keys: ${bad.join(', ')} (e.g. SHOP-12)`);
  if (!wanted.length && !jql?.trim()) throw new Error('Say which stories: a JQL query, or their keys');

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
    issues = await searchIssues(client, jql.trim(), fields);
  }
  log(`Jira: ${issues.length} issue(s) read${jql ? ` for "${jql}"` : ''}`);
  const requirements = issues.map((issue) => requirementOfIssue(issue, { baseUrl: client.baseUrl, criteriaFieldIds: fieldIds }));
  return applyImport(requirements, { format: 'jira', warnings, projectId, dryRun });
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

/** Post a story's comment — IziTest's one, updated when it is still there; its id, and what was done. */
async function postComment(client, requirement, body) {
  const path = `/rest/api/3/issue/${encodeURIComponent(requirement.key)}/comment`;
  if (requirement.jira_comment_id) {
    try {
      await client.put(`${path}/${requirement.jira_comment_id}`, { body });
      return { id: requirement.jira_comment_id, action: 'updated' };
    } catch (err) {
      if (err.status !== 404) throw err; // deleted in Jira since: a new one
    }
  }
  const comment = await client.post(path, { body });
  db.prepare('UPDATE requirements SET jira_comment_id = ? WHERE id = ?').run(String(comment.id), requirement.id);
  return { id: String(comment.id), action: 'added' };
}

/**
 * Tell Jira stories where they stand in IziTest: those of `keys`, or those a campaign's tests
 * check (its requirements imported from Jira). One comment a story, IziTest's, updated when it
 * is there already. A dry run unless `dryRun` is false: what each comment would say.
 */
export async function commentOnJira({ keys = [], campaignId = null, dryRun = true }, { client = null } = {}) {
  const campaign = campaignId != null ? getCampaign(campaignId) : null;
  if (campaignId != null && !campaign) throw new Error(`No campaign #${campaignId}`);
  if (campaign?.running) throw new Error(`Campaign #${campaign.id} is still running: comment once it is done`);
  const warnings = [];
  const stories = [];
  for (const key of [...new Set(keys.map((k) => String(k).trim().toUpperCase()).filter(Boolean))]) {
    const requirement = getRequirement(key);
    if (!requirement) warnings.push(`${key}: no such requirement in IziTest`);
    else if (requirement.source !== 'jira' || !KEY.test(requirement.key)) warnings.push(`${key} was not imported from Jira: no comment`);
    else stories.push(requirement);
  }
  // A campaign's: its requirements from Jira, the others left out.
  for (const { key } of campaign?.requirements ?? []) {
    const requirement = getRequirement(key);
    if (requirement?.source === 'jira' && KEY.test(requirement.key) && !stories.some((s) => s.id === requirement.id)) stories.push(requirement);
  }
  if (!stories.length && !warnings.length) {
    throw new Error(campaign ? `None of the requirements campaign #${campaign.id} checks comes from Jira` : 'Say which stories: their keys, or a campaign');
  }
  if (!dryRun) client ??= jiraClient();
  const comments = [];
  for (const requirement of stories) {
    const body = coverageComment(requirement, { campaign });
    const entry = { key: requirement.key, action: requirement.jira_comment_id ? 'update' : 'add', status: requirement.coverage.status, text: adfToText(body) };
    if (!dryRun) {
      // A story Jira refuses (gone, not allowed): told, the others still commented.
      try {
        const { id, action } = await postComment(client, requirement, body);
        Object.assign(entry, { action, url: `${client.baseUrl}/browse/${requirement.key}?focusedCommentId=${id}` });
      } catch (err) {
        entry.error = err.message;
      }
    }
    comments.push(entry);
  }
  if (!dryRun) log(`Jira: coverage commented on ${comments.filter((c) => !c.error).map((c) => c.key).join(', ') || 'no story'}`);
  return { sent: !dryRun, comments, warnings };
}
