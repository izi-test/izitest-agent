// GitHub Issues, a connector (lib/connectors): the issues of GitHub repositories read as
// requirements — title, body, acceptance criteria (the list under "Acceptance criteria" in the
// body, else its task list), priority from its labels, link — by an issue search, their keys
// (owner/name#12), or again to see which changed. A public repository needs no token; a private
// one, or more than 60 requests an hour, does. Nothing is written to GitHub.
//
// The token, if any, is set in the dashboard (Settings → Connectors → GitHub Issues), else read
// from GITHUB_TOKEN.

import { criteriaFromText, priorityOf } from '../requirement-import.js';

const API = 'https://api.github.com';
const MAX_ISSUES = 500;
// owner/name#12, as GitHub writes an issue of another repository.
const ISSUE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

/** Why GitHub refused a call, in a sentence. */
function refusal(res, body, path, token) {
  if (res.status === 401) return 'GitHub refused the token: check it, or remove it for public repositories';
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    return `GitHub's limit of requests is reached (${res.headers.get('x-ratelimit-limit')} an hour${token ? '' : ' without a token'}): ${token ? 'wait' : 'set a token, or wait'}`;
  }
  if (res.status === 404) return `Not found on GitHub: ${path}${token ? '' : ' (a private repository needs a token)'}`;
  const said = [body?.message, ...(body?.errors ?? []).map((e) => e.message)].filter(Boolean).join(': ');
  return said ? `GitHub: ${said}` : `GitHub answered ${res.status} to ${path}`;
}

/** A client of GitHub's REST API: as the token's account, or as anyone (public repositories). */
export function githubClient({ token = null } = {}, { fetch = globalThis.fetch } = {}) {
  const get = async (path) => {
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'IziTest', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new Error(`GitHub could not be reached: ${err.cause?.message ?? err.message}`);
    }
    const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : null;
    if (!res.ok) {
      const error = new Error(refusal(res, data, path.split('?')[0], token));
      error.status = res.status;
      throw error;
    }
    return data;
  };
  return { get, token };
}

/** An issue's criteria: its task list ("- [ ] …"), when no "Acceptance criteria" list is in its body (that one, the import takes). */
function tasksOf(body) {
  if (criteriaFromText(body).criteria.length) return [];
  return String(body ?? '').split(/\r?\n/).map((line) => /^\s*[-*]\s+\[[ xX]\]\s+(.+)$/.exec(line)?.[1].trim()).filter(Boolean);
}

/** A GitHub issue as a requirement: its key is its repository's name and its number (SHOP-12), uppercase. */
export function requirementOfIssue(issue) {
  const repo = String(issue.repository_url ?? '').split('/').pop() ?? 'ISSUE';
  return {
    key: `${repo.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}-${issue.number}`,
    title: String(issue.title ?? '').trim() || `#${issue.number}`,
    description: String(issue.body ?? '').trim(),
    criteria: tasksOf(issue.body),
    priority: (issue.labels ?? []).map((l) => priorityOf(typeof l === 'string' ? l : l.name?.replace(/^priority\s*[:/-]\s*/i, ''))).find(Boolean) ?? 'medium',
    url: issue.html_url,
  };
}

/** The issues to read: those a search finds (at most 500, pull requests left out), those of keys, or those imported already. */
async function readIssues(client, { query, keys, known }) {
  const warnings = [];
  if (!known && !keys.length) {
    // Issues only: a search finds pull requests too.
    const q = /\b(is|type):(issue|pr|pull-request)\b/i.test(query) ? query : `${query} is:issue`;
    const issues = [];
    for (let page = 1; issues.length < MAX_ISSUES; page += 1) {
      const found = await client.get(`/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`);
      issues.push(...(found.items ?? []));
      if ((found.items ?? []).length < 100 || issues.length >= (found.total_count ?? 0)) break;
    }
    return { records: issues.filter((i) => !i.pull_request).slice(0, MAX_ISSUES).map(requirementOfIssue), warnings };
  }
  // By their keys (owner/name#12), or those imported already (from their links).
  const wanted = known
    ? known.map((k) => /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)$/.exec(k.url ?? '')).filter(Boolean).map((m) => `${m[1]}/${m[2]}#${m[3]}`)
    : keys;
  const bad = wanted.filter((k) => !ISSUE.test(k));
  if (bad.length) throw new Error(`Not GitHub issues: ${bad.join(', ')} (e.g. owner/name#12)`);
  const records = [];
  for (const key of [...new Set(wanted)]) {
    const [, owner, repo, number] = ISSUE.exec(key);
    try {
      const issue = await client.get(`/repos/${owner}/${repo}/issues/${number}`);
      if (issue.pull_request) warnings.push(`${key} is a pull request, not an issue`);
      else records.push(requirementOfIssue(issue));
    } catch (err) {
      if (err.status !== 404 && err.status !== 410) throw err;
      warnings.push(`${key} is not on GitHub, or ${client.token ? 'this token' : 'a token'} is needed to see it`);
    }
  }
  return { records, warnings };
}

// ─── The connector ───────────────────────────────────────────────────

export const github = {
  id: 'github',
  name: 'GitHub Issues',
  description: 'GitHub repositories: a public one needs no token.',
  settings: {
    fields: [
      { name: 'token', label: 'Token', type: 'secret', optional: true, placeholder: 'Only for a private repository, or more than 60 requests an hour', env: 'GITHUB_TOKEN' },
    ],
    hint: 'A fine-grained token that can read the issues of the repositories: github.com → Settings → Developer settings → Personal access tokens.',
    link: 'https://github.com/settings/personal-access-tokens',
  },
  async test({ config, fetch }) {
    const client = githubClient(config, { fetch });
    if (config.token) return `Reads as ${(await client.get('/user')).login}.`;
    const { resources } = await client.get('/rate_limit');
    return `Reads public repositories without a token: ${resources.core.remaining} of ${resources.core.limit} requests left this hour.`;
  },
  requirements: {
    item: 'issue', items: 'issues', keys: 'owner/name#12',
    reads: 'title, body, priority from its labels, link, and its acceptance criteria — the list under "Acceptance criteria" in the body, else its task list',
    query: { label: 'search', placeholder: 'repo:owner/name is:open label:story' },
    read: ({ config, fetch }, wanted) => readIssues(githubClient(config, { fetch }), wanted),
  },
};
