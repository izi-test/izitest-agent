// Connectors: the tools IziTest reads requirements from and writes back to — Jira, Xray, GitHub
// Issues, any other one written the same way. A connector is one file exporting one object:
//
//   {
//     id: 'jira', name: 'Jira', description: 'What it is, in a sentence',
//     settings: {                     // how it is reached, set in Settings → Connectors
//       fields: [{ name, label, type: 'url' | 'text' | 'secret', placeholder?, optional?, env? }],
//       hint?, link?,                 // where a token is made
//       normalize?(values),           // checked and tidied as saved; throws what is wrong
//     },
//     async test(ctx) → a sentence,   // whether the connection works
//     requirements?: {                // a tool requirements live in: read as IziTest's
//       item: 'story', items: 'stories', keys: 'SHOP-12', reads: 'what is read of each',
//       query: { label: 'JQL query', placeholder },
//       async scopes?(ctx) → [{ label, query }],              // where to start: a project's stories
//       async read(ctx, { query, keys, known }) → { records, warnings },
//     },
//     coverage?: {                    // tells an item of the tool where its requirement stands
//       where: 'a comment on each story',
//       render(requirement, { campaign }) → { body, text },  // what is posted, and as text
//       async post(ctx, requirement, body, { ref }) → { ref, action, url },
//     },
//     results?: {                     // a campaign's results, sent
//       what: 'Test Execution', options: [{ name, label, placeholder }], note?,
//       prepare(campaign, options, { ref }) → { target, items: [{ test, status, links }], payload, ... },
//       async send(ctx, prepared, { ref }) → { ref, url },
//     },
//     bugs?: {                        // a bug of IziTest's, sent as an item of the tool
//       what: 'issue', options: [{ name, label, placeholder }], note?,
//       prepare(bug, options, { ref, suggestedProject }) → { target, type, summary, text, payload },
//       async send(ctx, prepared, { ref }) → { ref, action, url },
//       urlOf?(ctx, ref) → its link,
//     },
//   }
//
// ctx is { config, fetch, configOf(id) }: the connector's settings, the fetch to call its API with
// (a stand-in in tests), another connector's settings. This file does the rest, the same for each:
// keeps the settings (a secret never shown back), reads the requirements in (a dry run first, or
// again to see which changed), and writes back only when asked, after a dry run — remembering what
// it sent (connector_refs), so that sent again, it is updated rather than repeated.

import { db, parseJson } from '../db.js';
import { log } from '../logger.js';
import { applyImport } from '../requirement-import.js';
import { getRequirement } from '../requirements.js';
import { getCampaign } from '../campaigns.js';
import { getBug } from '../bugs.js';
import { jira } from './jira.js';
import { xray } from './xray.js';
import { github } from './github.js';

const connectors = new Map();

/** Makes a connector known: its settings and its roles, checked. */
export function registerConnector(connector) {
  if (!/^[a-z][a-z0-9_-]*$/.test(connector?.id ?? '')) throw new Error(`A connector needs an id of lowercase letters, digits, - and _: "${connector?.id}"`);
  if (['prompt', 'manual', 'import'].includes(connector.id)) throw new Error(`"${connector.id}" is a source of requirements of IziTest's own`);
  if (!connector.name || typeof connector.test !== 'function') throw new Error(`The connector ${connector.id} needs a name and a test()`);
  if (!connector.requirements && !connector.coverage && !connector.results && !connector.bugs) throw new Error(`The connector ${connector.id} does nothing: no requirements, coverage, results or bugs`);
  connectors.set(connector.id, connector);
}

for (const connector of [jira, xray, github]) registerConnector(connector);

export const listConnectors = () => [...connectors.values()];

export function connectorOf(id) {
  const connector = connectors.get(id);
  if (!connector) throw new Error(`No connector "${id}": ${listConnectors().map((c) => c.id).join(', ')}`);
  return connector;
}

/** The connectors of a role (requirements, coverage, results, bugs). */
export const connectorsFor = (role) => listConnectors().filter((c) => c[role]);

// ─── Settings ────────────────────────────────────────────────────────

const fieldsOf = (connector) => connector.settings?.fields ?? [];
const required = (connector) => fieldsOf(connector).filter((f) => !f.optional);
const savedOf = (connector) => parseJson(db.prepare('SELECT value FROM settings WHERE key = ?').get(connector.id)?.value);

/** A secret as the dashboard is shown it: its ends, the rest dots. */
export const mask = (secret) => (secret.length > 8 ? `${secret.slice(0, 4)}${'•'.repeat(secret.length - 8)}${secret.slice(-4)}` : '••••••••');

/**
 * A connector's settings: saved in the dashboard, else read from the environment (each field's
 * `env`); null while one it needs is missing. One that needs none (a public API) is always set.
 */
export function connectorConfig(id) {
  const connector = connectorOf(id);
  const saved = savedOf(connector);
  if (saved && required(connector).every((f) => saved[f.name])) return { ...saved, from: 'settings' };
  const env = Object.fromEntries(fieldsOf(connector).filter((f) => f.env && process.env[f.env]).map((f) => [f.name, process.env[f.env]]));
  if (!required(connector).every((f) => env[f.name])) return null;
  if (!Object.keys(env).length) return { from: 'default' };
  return { ...(connector.settings?.normalize?.(env) ?? env), from: 'env' };
}

/** The settings as the dashboard shows them: the secrets masked. */
export function maskedConfig(id) {
  const config = connectorConfig(id);
  if (!config) return null;
  const secrets = fieldsOf(connectorOf(id)).filter((f) => f.type === 'secret' && config[f.name]).map((f) => f.name);
  return { ...config, ...Object.fromEntries(secrets.map((name) => [name, mask(config[name])])) };
}

/**
 * Settings given (by the dashboard, or to test them) made the ones to use: a secret given masked —
 * as the dashboard was shown it — is the one saved; each field it needs, there.
 */
function settingsFrom(connector, values) {
  const saved = savedOf(connector);
  const settings = Object.fromEntries(fieldsOf(connector).map((f) => {
    const given = String(values?.[f.name] ?? '').trim();
    return [f.name, f.type === 'secret' && given.includes('•') ? saved?.[f.name] ?? '' : given];
  }).filter(([, value]) => value));
  const missing = required(connector).filter((f) => !settings[f.name]);
  if (missing.length) throw new Error(`${connector.name} needs: ${missing.map((f) => f.label).join(', ')}`);
  return connector.settings?.normalize?.(settings) ?? settings;
}

/** Keeps the settings the dashboard sets. Nothing in its first field (or in any, when none is needed) removes them. */
export function saveConnectorConfig(id, values) {
  const connector = connectorOf(id);
  const first = required(connector)[0];
  const empty = first ? !String(values?.[first.name] ?? '').trim() : fieldsOf(connector).every((f) => !String(values?.[f.name] ?? '').trim());
  if (empty) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(id);
    return maskedConfig(id);
  }
  const settings = settingsFrom(connector, values);
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
              ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(id, JSON.stringify(settings));
  log(`${connector.name}: settings saved`);
  return maskedConfig(id);
}

/** What a connector is given to work: its settings, the fetch to call with, the settings of another. */
function contextOf(connector, { fetch = globalThis.fetch, config = connectorConfig(connector.id) } = {}) {
  if (!config) {
    const envs = required(connector).map((f) => f.env).filter(Boolean);
    throw new Error(`${connector.name} is not set: Settings → Connectors → ${connector.name}${envs.length ? ` (or ${envs.join(', ')})` : ''}`);
  }
  return { config, fetch, configOf: (other) => connectorConfig(other) };
}

/** Whether a connector's settings work — those given (a secret masked: the saved one), else the saved ones. */
export async function testConnector(id, values = null, { fetch } = {}) {
  const connector = connectorOf(id);
  try {
    const config = values ? settingsFrom(connector, values) : undefined;
    return { success: true, text: await connector.test(contextOf(connector, { fetch, ...(config && { config }) })) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** The connectors as the dashboard and the agents see them: what each does, its fields, its settings masked. */
export function describeConnectors() {
  return listConnectors().map((c) => ({
    id: c.id, name: c.name, description: c.description,
    settings: { fields: fieldsOf(c), hint: c.settings?.hint ?? null, link: c.settings?.link ?? null },
    requirements: c.requirements && {
      item: c.requirements.item, items: c.requirements.items, keys: c.requirements.keys, reads: c.requirements.reads,
      query: c.requirements.query, scopes: typeof c.requirements.scopes === 'function',
    },
    coverage: c.coverage && { where: c.coverage.where },
    results: c.results && { what: c.results.what, options: c.results.options ?? [], note: c.results.note ?? null },
    bugs: c.bugs && { what: c.bugs.what, options: c.bugs.options ?? [], note: c.bugs.note ?? null },
    config: maskedConfig(c.id),
  }));
}

// ─── What was sent: a comment kept on a story, a campaign's Test Execution ──

const refOf = (connector, kind, itemId) =>
  db.prepare('SELECT ref FROM connector_refs WHERE connector = ? AND kind = ? AND item_id = ?').get(connector, kind, itemId)?.ref ?? null;

function keepRef(connector, kind, itemId, ref) {
  db.prepare(`INSERT INTO connector_refs (connector, kind, item_id, ref) VALUES (?, ?, ?, ?)
              ON CONFLICT (connector, kind, item_id) DO UPDATE SET ref = excluded.ref, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    .run(connector, kind, itemId, String(ref));
}

// The role that sends each kind of thing kept.
const ROLE_OF_KIND = { campaign: 'results', bug: 'bugs' };

/** Where a campaign's results (or, `kind` 'bug', a bug) were sent: each connector's ref, and a link to it when it gives one. */
export function sentTo(itemId, kind = 'campaign') {
  return db.prepare('SELECT connector, ref FROM connector_refs WHERE kind = ? AND item_id = ? ORDER BY connector').all(kind, itemId)
    .filter((r) => connectors.has(r.connector))
    .map(({ connector, ref }) => {
      const c = connectorOf(connector);
      return { connector, name: c.name, ref, url: c[ROLE_OF_KIND[kind]]?.urlOf?.({ configOf: connectorConfig }, ref) ?? null };
    });
}

// ─── Requirements read in ────────────────────────────────────────────

/**
 * Reads requirements from a connector's tool and imports them (lib/requirement-import.js): those a
 * query finds, those of `keys`, or — `sync` — the ones imported from it already (in `projectId`,
 * or all), to see which changed. A dry run unless `dryRun` is false.
 */
export async function importFromConnector(id, { query = null, keys = [], sync = false, projectId = null, dryRun = true } = {}, { fetch } = {}) {
  const connector = connectorOf(id);
  const role = connector.requirements;
  if (!role) throw new Error(`${connector.name} holds no requirements to read`);
  const known = sync
    ? db.prepare('SELECT key, external_url AS url FROM requirements WHERE source = ? AND (project_id IS ? OR ? IS NULL) ORDER BY id').all(id, projectId, projectId)
    : null;
  if (sync && !known.length) throw new Error(`No requirement imported from ${connector.name} yet: import some first, by a query or their keys`);
  const wanted = (keys ?? []).map((k) => String(k).trim()).filter(Boolean);
  if (!sync && !wanted.length && !query?.trim()) throw new Error(`Say which ${role.items}: a ${role.query.label}, or their keys`);
  const { records, warnings = [] } = await role.read(contextOf(connector, { fetch }), { query: query?.trim() || null, keys: wanted, known });
  log(`${connector.name}: ${records.length} ${role.items} read${query ? ` for "${query}"` : ''}`);
  return applyImport(records.map((r) => ({ ...r, source: id })), { format: id, warnings, projectId, dryRun });
}

// ─── Written back: a requirement's coverage, a campaign's results ────

/** A campaign done, or why not. */
function doneCampaign(campaignId, doing) {
  const campaign = getCampaign(campaignId);
  if (!campaign) throw new Error(`No campaign #${campaignId}`);
  if (campaign.running) throw new Error(`Campaign #${campaign.id} is still running: ${doing} once it is done`);
  return campaign;
}

/**
 * Tells a connector's tool where requirements imported from it stand in IziTest: those of `keys`,
 * or those a campaign's tests check (the others left out). One a requirement — a comment —,
 * updated when sent again. A dry run unless `dryRun` is false: what each would say.
 */
export async function sendCoverage(id, { keys = [], campaignId = null, dryRun = true } = {}, { fetch } = {}) {
  const connector = connectorOf(id);
  if (!connector.coverage) throw new Error(`${connector.name} is not told the coverage of requirements`);
  const campaign = campaignId != null ? doneCampaign(campaignId, 'send its coverage') : null;
  const warnings = [];
  const chosen = [];
  for (const key of [...new Set(keys.map((k) => String(k).trim()).filter(Boolean))]) {
    const requirement = getRequirement(key) ?? getRequirement(key.toUpperCase());
    if (!requirement) warnings.push(`${key}: no such requirement in IziTest`);
    else if (requirement.source !== id) warnings.push(`${requirement.key} was not imported from ${connector.name}: nothing sent`);
    else chosen.push(requirement);
  }
  // A campaign's: its requirements from this tool, the others left out.
  for (const { key } of campaign?.requirements ?? []) {
    const requirement = getRequirement(key);
    if (requirement?.source === id && !chosen.some((r) => r.id === requirement.id)) chosen.push(requirement);
  }
  if (!chosen.length && !warnings.length) {
    throw new Error(campaign ? `None of the requirements campaign #${campaign.id} checks comes from ${connector.name}` : 'Say which requirements: their keys, or a campaign');
  }
  const ctx = dryRun ? null : contextOf(connector, { fetch });
  const items = [];
  for (const requirement of chosen) {
    const ref = refOf(id, 'requirement', requirement.id);
    const { body, text } = connector.coverage.render(requirement, { campaign });
    const item = { key: requirement.key, action: ref ? 'update' : 'add', status: requirement.coverage.status, text };
    if (!dryRun) {
      // One the tool refuses (gone, not allowed): told, the others still sent.
      try {
        const sent = await connector.coverage.post(ctx, requirement, body, { ref });
        keepRef(id, 'requirement', requirement.id, sent.ref);
        Object.assign(item, { action: sent.action, url: sent.url ?? null });
      } catch (err) {
        item.error = err.message;
      }
    }
    items.push(item);
  }
  if (!dryRun) log(`${connector.name}: coverage sent for ${items.filter((i) => !i.error).map((i) => i.key).join(', ') || 'no requirement'}`);
  return { connector: id, name: connector.name, where: connector.coverage.where, sent: !dryRun, items, warnings };
}

/** A campaign as a connector reads it: each test with its description, when it ran, and the requirements it checks. */
function campaignForConnectors(campaign) {
  const names = campaign.runs.map((t) => t.name);
  const marks = names.map(() => '?').join(',') || "''";
  const runs = new Map(db.prepare('SELECT id, started_at, finished_at FROM test_executions WHERE campaign_id = ?').all(campaign.id).map((r) => [r.id, r]));
  const descriptions = new Map(db.prepare(`SELECT name, description FROM tests WHERE name IN (${marks})`).all(...names).map((t) => [t.name, t.description]));
  const checked = db.prepare(
    `SELECT DISTINCT t.name AS test, r.key, r.source, r.external_url AS url FROM requirement_cases c
     JOIN tests t ON t.id = c.test_id JOIN requirements r ON r.id = c.requirement_id WHERE t.name IN (${marks}) ORDER BY r.key`,
  ).all(...names);
  return {
    ...campaign,
    runs: campaign.runs.map((t) => ({
      ...t, description: descriptions.get(t.name) ?? '',
      started_at: runs.get(t.execution_id)?.started_at ?? null, finished_at: runs.get(t.execution_id)?.finished_at ?? null,
      requirements: checked.filter((r) => r.test === t.name).map(({ key, source, url }) => ({ key, source, url })),
    })),
  };
}

/**
 * Sends a campaign's results to a connector's tool (`options`: the connector's, e.g. the project
 * it goes in) — or, sent before, the same thing updated. A dry run unless `dryRun` is false: what
 * would be sent.
 */
export async function sendResults(id, campaignId, { options = {}, dryRun = true } = {}, { fetch } = {}) {
  const connector = connectorOf(id);
  if (!connector.results) throw new Error(`${connector.name} takes no campaign results`);
  const campaign = doneCampaign(campaignId, 'send it');
  const ref = refOf(id, 'campaign', campaign.id);
  const prepared = connector.results.prepare(campaignForConnectors(campaign), options ?? {}, { ref });
  const summary = { connector: id, name: connector.name, what: connector.results.what, target: prepared.target, ref, updates: !!ref, items: prepared.items };
  if (dryRun) return { sent: false, ...summary, payload: prepared.payload };
  const sent = await connector.results.send(contextOf(connector, { fetch }), prepared, { ref });
  if (sent.ref) keepRef(id, 'campaign', campaign.id, sent.ref);
  log(`${connector.name}: campaign #${campaign.id} sent to ${sent.ref ?? `a ${connector.results.what}`} (${prepared.items.length} test(s))`);
  return { sent: true, ...summary, ref: sent.ref ?? null, url: sent.url ?? null };
}

/**
 * Sends a bug to a connector's tool, as an item of it (`options`: the connector's, e.g. the
 * project it goes in — by default the one of the requirement it breaks, when that came from the
 * tool) — or, sent before, the same item updated. A dry run unless `dryRun` is false.
 */
export async function sendBug(id, bugId, { options = {}, dryRun = true } = {}, { fetch } = {}) {
  const connector = connectorOf(id);
  if (!connector.bugs) throw new Error(`${connector.name} takes no bugs`);
  const bug = getBug(bugId);
  if (!bug) throw new Error(`No bug #${bugId}`);
  const ref = refOf(id, 'bug', bug.id);
  // The project of the requirement it breaks, when that one was read from this tool.
  const fromTool = (bug.details?.requirements ?? []).map((r) => getRequirement(r.key)).find((r) => r?.source === id);
  const suggestedProject = fromTool ? fromTool.key.replace(/-\d+$/, '') : null;
  const prepared = connector.bugs.prepare(bug, options ?? {}, { ref, suggestedProject });
  const summary = { connector: id, name: connector.name, what: connector.bugs.what, bug: bug.id, target: prepared.target, type: prepared.type ?? null, ref, updates: !!ref, title: prepared.summary, text: prepared.text };
  if (dryRun) return { sent: false, ...summary, payload: prepared.payload };
  const sent = await connector.bugs.send(contextOf(connector, { fetch }), prepared, { ref });
  keepRef(id, 'bug', bug.id, sent.ref);
  log(`${connector.name}: bug #${bug.id} ${sent.action} as ${sent.ref}`);
  return { sent: true, ...summary, ref: sent.ref, action: sent.action, url: sent.url ?? null };
}

// ─── For the agent ───────────────────────────────────────────────────

/** A bug sent (or to be) as the agent reads it. */
export function formatBugSent(result) {
  if (result.sent) return `Sent to ${result.name}: bug #${result.bug} ${result.action} as ${result.ref}${result.url ? ` (${result.url})` : ''}.`;
  const note = connectorOf(result.connector).bugs.note;
  return [
    `Dry run — would ${result.updates ? `update the ${result.what} ${result.ref}` : `create a ${result.type ?? result.what} in ${result.target}`}. Nothing sent; dry_run: false sends it.`,
    `Title: ${result.title}`,
    result.text.replace(/^/gm, '    '),
    ...(note ? [note] : []),
  ].join('\n');
}

/** A coverage sent (or to be) as the agent reads it. */
export function formatCoverage(result) {
  const lines = result.items.map((i) => (i.error
    ? `${i.key}: NOT sent — ${i.error}`
    : result.sent ? `${i.key}: ${i.action}${i.url ? ` — ${i.url}` : ''}` : `${i.key}: would ${i.action} IziTest's:\n${i.text.replace(/^/gm, '    ')}`));
  return [
    result.sent ? `Sent to ${result.name}, ${result.where}:` : `Dry run — nothing sent; dry_run: false sends ${result.where}:`,
    ...lines, ...result.warnings.map((w) => `Note: ${w}`),
  ].join('\n');
}

/** A campaign's results sent (or to be) as the agent reads it. */
export function formatResults(result) {
  const counts = Object.entries(result.items.reduce((acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }), {}))
    .map(([status, n]) => `${n} ${status}`).join(', ');
  const head = result.sent
    ? `Sent to ${result.name}: ${result.ref ?? `a ${result.what}`}${result.url ? ` (${result.url})` : ''}, in ${result.target} — ${counts}.`
    : `Dry run — would ${result.updates ? `update the ${result.what} ${result.ref}` : `create a ${result.what}`} in ${result.target}: ${counts}. Nothing sent; dry_run: false sends it.`;
  const note = result.sent ? null : connectorOf(result.connector).results.note;
  return [
    head,
    ...result.items.map((t) => `- ${t.test}: ${t.status}${t.links.length ? ` — covers ${t.links.join(', ')}` : ''}`),
    ...(note ? [note] : []),
  ].join('\n');
}
