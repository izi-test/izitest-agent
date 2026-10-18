// Does a click at the element's centre actually reach it? Reported live: a test link sat
// under example.com's SVG; the click landed on a <path>, the link got nothing, and the
// tool answered `success: true, tag: a`. Same failure as a cookie banner or a sticky header.
//
// Pure functions over plain objects shaped like DOM nodes — no browser needed.
// Run with: node --test test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'dom', 'hit-test.ts');

async function load() {
  const dir = await mkdtemp(join(tmpdir(), 'hit-test-'));
  const outfile = join(dir, 'hit-test.mjs');
  await build({ entryPoints: [SRC], outfile, bundle: true, format: 'esm', target: 'node20', logLevel: 'silent' });
  return import(outfile);
}
const ht = await load();

/** A minimal element: tag, parent, optional attributes. */
function el(tagName, parentNode = null, extra = {}) {
  return { nodeType: 1, tagName, parentNode, textContent: '', getAttribute: () => null, ...extra };
}

test('the target itself receives the click', () => {
  const a = el('A');
  assert.equal(ht.isHitOnTarget(a, a), true);
});

test('a descendant of the target counts — an icon inside a button', () => {
  const button = el('BUTTON');
  const icon = el('SPAN', button);
  assert.equal(ht.isHitOnTarget(button, icon), true);
});

test('an unrelated element on top does not — the reported case', () => {
  const body = el('BODY');
  const link = el('A', body);
  const svg = el('svg', body);
  const path = el('path', svg);
  assert.equal(ht.isHitOnTarget(link, path), false);
});

test('an ancestor taking the click does not count either', () => {
  // e.g. the target has pointer-events: none, so its container receives the click
  const card = el('DIV');
  const link = el('A', card);
  assert.equal(ht.isHitOnTarget(link, card), false);
});

test('nothing at the point does not count', () => {
  assert.equal(ht.isHitOnTarget(el('A'), null), false);
});

test('a label covering its own input counts — custom checkboxes', () => {
  const label = el('LABEL');
  const input = el('INPUT', label);
  label.control = input;
  const decoration = el('SPAN', label); // the styled box drawn over the hidden input
  assert.equal(ht.isHitOnTarget(input, decoration), true);
  assert.equal(ht.isHitOnTarget(input, label), true);
});

test('clicking a label\'s control counts as clicking the label', () => {
  const label = el('LABEL');
  const input = el('INPUT');
  label.control = input;
  assert.equal(ht.isHitOnTarget(label, input), true);
});

test('another field\'s label does not count', () => {
  const mine = el('INPUT');
  const otherLabel = el('LABEL');
  otherLabel.control = el('INPUT');
  assert.equal(ht.isHitOnTarget(mine, otherLabel), false);
});

test('the walk crosses shadow roots up to their host', () => {
  const host = el('MY-BUTTON');
  const shadowRoot = { nodeType: 11, host, parentNode: null };
  const inner = el('SPAN', shadowRoot);
  assert.equal(ht.isHitOnTarget(host, inner), true);
});

test('an <a> is not mistaken for a shadow root because it has a `host`', () => {
  // HTMLAnchorElement.host is the URL's hostname — a string. Treating it as a shadow
  // root's host would end the walk on a string and miss the real ancestors.
  const button = el('BUTTON');
  const link = el('A', button, { host: 'www.iana.org' });
  const span = el('SPAN', link);
  assert.equal(ht.isHitOnTarget(button, span), true);
  assert.equal(ht.isHitOnTarget(link, span), true);
});

test('deepElementFromPoint looks inside open shadow roots', () => {
  const inner = el('BUTTON');
  const host = el('COOKIE-BANNER', null, { shadowRoot: { elementFromPoint: () => inner } });
  const doc = { elementFromPoint: () => host };
  assert.equal(ht.deepElementFromPoint(doc, 1, 1), inner);
});

test('deepElementFromPoint stops when a shadow root points back at its host', () => {
  const host = el('X-WIDGET');
  host.shadowRoot = { elementFromPoint: () => host };
  assert.equal(ht.deepElementFromPoint({ elementFromPoint: () => host }, 1, 1), host);
});

test('the blocker is named in terms an agent can act on', () => {
  const body = el('BODY');
  const banner = el('DIV', body, { id: 'onetrust-banner-sdk' });
  const inner = el('DIV', banner, { className: 'ot-sdk-container ot-sdk-row extra' });
  const button = el('BUTTON', inner, { textContent: '  Tout accepter \n' });
  assert.equal(ht.describeBlocker(button), '<button> "Tout accepter" inside #onetrust-banner-sdk');
  assert.equal(ht.describeBlocker(inner), '<div class="ot-sdk-container ot-sdk-row"> inside #onetrust-banner-sdk');
});

test('an SVG part is reported as its <svg>, not as a <path>', () => {
  const header = el('HEADER', null, { id: 'site-header' });
  const svg = el('svg', header, { className: { baseVal: 'logo' } });
  const g = el('g', svg);
  const path = el('path', g);
  assert.equal(ht.describeBlocker(path), '<svg class="logo"> inside #site-header');
});

test('an empty point is explained rather than left blank', () => {
  assert.match(ht.describeBlocker(null), /nothing at that point/);
});
