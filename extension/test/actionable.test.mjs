// A replayed click waits until its element can take it — visible, enabled, still, on top — and
// says why when it never could. The DOM is a stand-in: plain objects shaped like the nodes.
// Run with: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands', 'actionable.ts');

async function load() {
  const dir = await mkdtemp(join(tmpdir(), 'actionable-'));
  const outfile = join(dir, 'actionable.mjs');
  await build({ entryPoints: [SRC], outfile, bundle: true, format: 'esm', target: 'node20', logLevel: 'silent' });
  return import(outfile);
}
const { actionStateOf, waitActionable, notActionable, untilReady, linkLeadsAway } = await load();

// ─── The page side ──────────────────────────────────────────────────

function page({ hitAt } = {}) {
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 800;
  globalThis.getComputedStyle = (node) => node.style ?? { visibility: 'visible', display: 'block' };
  globalThis.document = { elementFromPoint: () => hitAt() };
}

function node(tagName, { parent = null, rect = { left: 100, top: 100, width: 80, height: 30 }, attrs = {}, ...rest } = {}) {
  return {
    tagName, parentElement: parent, isConnected: true, id: '', className: '', textContent: '',
    getBoundingClientRect: () => rect,
    getAttribute: (name) => attrs[name] ?? null,
    closest: () => null,
    getRootNode: () => globalThis.document,
    ...rest,
  };
}

test('a visible, enabled element on top can be clicked; so through an icon inside it', () => {
  const button = node('BUTTON');
  page({ hitAt: () => button });
  assert.equal(actionStateOf(button).state, 'ok');
  const icon = node('SPAN', { parent: button });
  page({ hitAt: () => icon });
  assert.equal(actionStateOf(button).state, 'ok');
});

test('a link wrapped over two lines is hit-tested at its first line, where the click lands', () => {
  // the portal's user list: "$duplicate-1081d8.1" wrapped, its last character alone on a second line.
  const cell = node('TD', { className: 'sorting_1' });
  const firstLine = { left: 284, top: 337, width: 108, height: 14 };
  const link = node('A', {
    parent: cell, rect: { left: 284, top: 337, width: 108, height: 31 },
    getClientRects: () => [firstLine, { left: 284, top: 354, width: 5, height: 14 }],
  });
  const points = [];
  page({ hitAt: () => link });
  globalThis.document.elementFromPoint = (x, y) => { points.push([x, y]); return y < 351 ? link : cell; };
  assert.equal(actionStateOf(link).state, 'ok');
  assert.deepEqual(points, [[338, 344]], 'the centre of its first line, not of its frame (352.5, on the cell)');
  assert.deepEqual(actionStateOf(link).rect, { x: 284, y: 337, w: 108, h: 31 }, 'its frame still tells whether it moves');
});

test('a loading veil over it: covered, and named', () => {
  const button = node('BUTTON');
  const veil = node('DIV', { id: 'spinner', textContent: 'Loading…' });
  veil.id = 'spinner';
  page({ hitAt: () => veil });
  const state = actionStateOf(button);
  assert.equal(state.state, 'covered');
  assert.match(state.detail, /div#spinner/);
});

test('an ancestor taking the click does not count', () => {
  const card = node('DIV');
  const button = node('BUTTON', { parent: card });
  page({ hitAt: () => card });
  assert.equal(actionStateOf(button).state, 'covered');
});

test('disabled, aria-disabled, hidden, gone', () => {
  page({ hitAt: () => null });
  assert.equal(actionStateOf(node('BUTTON', { disabled: true })).state, 'disabled');
  assert.equal(actionStateOf(node('DIV', { attrs: { 'aria-disabled': 'true' } })).state, 'disabled');
  assert.equal(actionStateOf(node('DIV', { rect: { left: 0, top: 0, width: 0, height: 0 } })).state, 'hidden');
  assert.equal(actionStateOf(node('DIV', { isConnected: false })).state, 'detached');
});

// ─── Waiting ────────────────────────────────────────────────────────

/** A handle whose page answers these states in turn (the last one again after). */
function handle(states) {
  let i = 0;
  return { evaluate: async () => states[Math.min(i++, states.length - 1)] };
}
const box = (x) => ({ x, y: 10, w: 80, h: 30 });
const noSleep = async () => {};

test('it waits for the veil to go and the element to stand still', async () => {
  const h = handle([
    { state: 'covered', detail: '<div#spinner>', rect: box(10) },
    { state: 'ok', rect: box(40) },
    { state: 'ok', rect: box(20) },
    { state: 'ok', rect: box(20) },
  ]);
  assert.equal(await waitActionable(h, 5000, noSleep), null);
});

test('never ready: the error says why', async () => {
  const covered = await waitActionable(handle([{ state: 'covered', detail: '<div#spinner>' }]), 0, noSleep);
  assert.match(covered, /covered by <div#spinner> within 0 s/);
  assert.match(await waitActionable(handle([{ state: 'disabled' }]), 0, noSleep), /stayed disabled/);
  assert.match(await waitActionable(handle([{ state: 'detached' }]), 5000, noSleep), /left the page/);
  assert.match(notActionable({ state: 'ok' }, 10000), /kept moving within 10 s/);
});

// ─── A step with no locators ────────────────────────────────────────

const covered = () => new Error('Not clicked: <div> "Home" is covered at its centre (66,133) by <div class="loading-bg">, which would receive the click instead.');

test('a step with no locators, refused under a loading veil, is played once the veil is gone', async () => {
  let tries = 0;
  const result = await untilReady(async () => { if (++tries < 3) throw covered(); return { clicked: true }; }, 5000, async () => {});
  assert.deepEqual(result, { clicked: true });
  assert.equal(tries, 3);
});

test('a veil that stays is told once the time is up; another error at once', async () => {
  await assert.rejects(untilReady(async () => { throw covered(); }, 0, async () => {}), /is covered at its centre/);
  let tries = 0;
  await assert.rejects(untilReady(async () => { tries++; throw new Error('Not clicked: the element is disabled'); }, 5000, async () => {}), /disabled/);
  assert.equal(tries, 1);
});

test('a step with no locators waits for its element to show', async () => {
  let tries = 0;
  const result = await untilReady(async () => { if (++tries < 2) throw new Error('Element not found: [data-testid="menu"]'); return 'ok'; }, 5000, async () => {});
  assert.equal(result, 'ok');
});

test('a click whose element left the page is told so, in words replay knows to look again for', async () => {
  const { isLeftThePage } = await load();
  assert.ok(isLeftThePage(new Error(`Not clicked: ${notActionable({ state: 'detached' }, 10000)}`)));
  assert.ok(!isLeftThePage(new Error('Not clicked: the element stayed hidden within 10 s')));
});

// ─── A click on a link ──────────────────────────────────────────────

function link(href, attrs = {}) {
  globalThis.location = { href: 'https://portal.test/ECM/workflowmanagement/createupdateuserrequestfirststep' };
  const a = {
    href: new URL(href, globalThis.location.href).href,
    target: attrs.target ?? '',
    getAttribute: (name) => (name === 'href' ? href : attrs[name] ?? null),
    hasAttribute: (name) => name in attrs,
  };
  return { closest: (selector) => (selector === 'a[href]' ? a : null) };
}

test('a link to another page is one whose click has to open it', () => {
  assert.equal(linkLeadsAway(link('/ECM/workflowmanagement/requestaccessforothers/UPDATEUSERARS?tileType=UpdateUserRequest')), true);
});

test('an anchor, a script link, a download, a new tab or the same page are not', () => {
  assert.equal(linkLeadsAway(link('#top')), false);
  assert.equal(linkLeadsAway(link('javascript:void(0)')), false);
  assert.equal(linkLeadsAway(link('/report.pdf', { download: '' })), false);
  assert.equal(linkLeadsAway(link('/other', { target: '_blank' })), false);
  assert.equal(linkLeadsAway(link('/ECM/workflowmanagement/createupdateuserrequestfirststep#form')), false);
  assert.equal(linkLeadsAway({ closest: () => null }), false);
});
