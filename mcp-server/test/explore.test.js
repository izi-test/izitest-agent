// Unit tests for the explorer: what it reports from what the checks read, what it never
// clicks, the bug a finding is, the test that reproduces it — and that test's checks in the
// replay and in exported code. A fake browser stands for the site explored.
// Run with: node --test test/explore.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findingsOf, isSafeToClick, messageFragment, fingerprintOf, severityOf, titleOf, assertionOf, reproStepsOf, explore, normalizeUrl,
} from '../lib/explore.js';
import { evaluateAssertion } from '../lib/test-execute.js';
import { generatePlaywrightPlain } from '../lib/codegen/playwright-plain.js';
import { generatePlaywrightCucumber } from '../lib/codegen/playwright-cucumber.js';
import { serializeTestToFeatureWith } from '../lib/gherkin/serialize.js';
import { parseFeatureToStepsWith } from '../lib/gherkin/parse.js';
import { DEFAULT_STEP_DEFINITIONS } from '../lib/gherkin/default-step-definitions.js';

const DEFAULTS = DEFAULT_STEP_DEFINITIONS.map((d, i) => ({ id: i + 1, ...d, steps_template: null, is_default: 1 }));
const SHOP = 'http://127.0.0.1:8777/shop';

test('what a page does wrong, from what the checks read — from `since` on', () => {
  const findings = findingsOf({
    page: `${SHOP}/product.html`, since: 1000,
    console: { messages: [
      { level: 'error', text: "Uncaught TypeError: Cannot read properties of undefined (reading 'price')", timestamp: 1200 },
      { level: 'error', text: 'from the page before', timestamp: 900 },
      { level: 'warning', text: 'deprecated', timestamp: 1300 },
    ] },
    requests: { requests: [
      { method: 'GET', url: `${SHOP}/api/stock.json`, status: 404, resourceType: 'fetch', timestamp: 1100 },
      { method: 'GET', url: `${SHOP}/favicon.ico`, status: 404, resourceType: 'other', timestamp: 1100 },
      { method: 'GET', url: `${SHOP}/style.css`, status: 200, resourceType: 'stylesheet', timestamp: 1100 },
    ] },
    links: { links: [{ href: `${SHOP}/pricing.html`, attr: 'pricing.html', text: 'Pricing', status: 404 }, { href: `${SHOP}/about.html`, attr: 'about.html', text: 'About', status: 200 }] },
    axe: { violations: [{ id: 'image-alt', impact: 'critical', help: 'Images must have alternative text', count: 1, nodes: [] }, { id: 'region', impact: 'moderate', help: 'x', count: 3, nodes: [] }] },
  });
  assert.deepEqual(findings.map((f) => f.kind), ['console_error', 'failed_request', 'broken_link', 'a11y']);
  assert.equal(findings[0].message, "Uncaught TypeError: Cannot read properties of undefined (reading 'price')");
});

test('the same error logged five times is one finding', () => {
  const logged = { messages: Array.from({ length: 5 }, () => ({ level: 'error', text: 'boom', timestamp: 1 })) };
  assert.equal(findingsOf({ page: `${SHOP}/`, console: logged }).length, 1);
});

test('never clicked: what deletes, pays, logs out, sends; nor what is no control', () => {
  for (const name of ['Delete account', 'Supprimer', 'Log out', 'Se déconnecter', 'Pay now', 'Payer', 'Place order', 'Send', 'Confirm', 'Cancel subscription']) {
    assert.equal(isSafeToClick({ role: 'button', name }), false, name);
  }
  assert.equal(isSafeToClick({ role: 'button', name: 'Show details' }), true);
  assert.equal(isSafeToClick({ role: 'tab', name: 'Reviews' }), true);
  assert.equal(isSafeToClick({ role: 'link', name: 'Home' }), false, 'links are followed, not clicked');
  assert.equal(isSafeToClick({ role: 'button', name: '' }), false);
});

const ERROR = { kind: 'console_error', page: `${SHOP}/cart.html`, message: 'Uncaught Error: Coupon service unavailable',
  via: { selector: '#apply', locators: [{ type: 'css', value: '#apply' }], name: 'Apply coupon', role: 'button' } };

test('a bug: what makes it the same one, how bad, how it reads', () => {
  assert.equal(messageFragment("Uncaught TypeError: Cannot read properties of undefined (reading 'price')\n    at product.html:9"), "Cannot read properties of undefined (reading 'price')");
  assert.equal(fingerprintOf(ERROR), 'console|/shop/cart.html > #apply|Coupon service unavailable');
  assert.equal(severityOf(ERROR), 'high');
  assert.equal(titleOf(ERROR), 'Console error on /shop/cart.html after clicking "Apply coupon": Coupon service unavailable');
  const failed = { kind: 'failed_request', page: `${SHOP}/product.html`, request: { method: 'GET', url: `${SHOP}/api/stock.json?v=2`, status: 404 } };
  assert.equal(severityOf(failed), 'medium');
  assert.equal(severityOf({ ...failed, request: { ...failed.request, status: 500 } }), 'high');
  assert.equal(titleOf(failed), 'GET /shop/api/stock.json?v=2 → 404 on /shop/product.html');
});

test('the test that reproduces a bug: the page, the click, a moment, the check it fails', () => {
  const steps = reproStepsOf(ERROR);
  assert.deepEqual(steps.map((s) => s.command), ['navigate', 'click', 'wait', 'assert']);
  assert.equal(steps[1].params.selector, '#apply');
  assert.deepEqual(steps[3].assertion, { type: 'no_console_errors', expected: 'Coupon service unavailable' });
  assert.deepEqual(assertionOf({ kind: 'broken_link', link: { attr: 'pricing.html' } }), { type: 'link_ok', selector: 'a[href="pricing.html"]' });
  assert.deepEqual(assertionOf({ kind: 'a11y', rule: { id: 'image-alt' } }), { type: 'no_a11y_violations', expected: 'image-alt' });
  assert.deepEqual(assertionOf({ kind: 'failed_request', request: { url: `${SHOP}/api/stock.json` } }), { type: 'no_failed_requests', expected: '/shop/api/stock.json' });
});

test('the replay checks them on the tab: failing while the bug is there', async () => {
  const page = async (_profile, command, params) => {
    if (command === 'console_messages') return { messages: [{ level: 'error', text: 'Uncaught Error: Coupon service unavailable' }] };
    if (command === 'network_requests') return { requests: [{ method: 'POST', url: `${SHOP}/api/cart`, status: 501 }] };
    if (command === 'check_links') return { links: params.selector === 'a[href="pricing.html"]' ? [{ href: `${SHOP}/pricing.html`, status: 404 }] : [] };
    if (command === 'run_axe') return { violations: params.rules?.[0] === 'image-alt' ? [{ id: 'image-alt', count: 1, nodes: [{ target: 'img' }] }] : [] };
    throw new Error(command);
  };
  assert.equal((await evaluateAssertion(page, { type: 'no_console_errors', expected: 'Coupon service' })).passed, false);
  assert.equal((await evaluateAssertion(page, { type: 'no_console_errors', expected: 'other error' })).passed, true);
  assert.match((await evaluateAssertion(page, { type: 'no_failed_requests', expected: '/api/cart' })).actual, /POST .*api\/cart → 501/);
  assert.equal((await evaluateAssertion(page, { type: 'link_ok', selector: 'a[href="pricing.html"]' })).passed, false);
  assert.equal((await evaluateAssertion(page, { type: 'link_ok', selector: 'a[href="gone.html"]' })).passed, false, 'no such link: not a pass');
  assert.equal((await evaluateAssertion(page, { type: 'no_a11y_violations', expected: 'image-alt' })).passed, false);
  assert.equal((await evaluateAssertion(page, { type: 'no_a11y_violations', expected: 'label' })).passed, true);
});

const BUG_TEST = { name: 'bug_6_console_error', steps: [...reproStepsOf(ERROR), { command: 'assert', params: {}, assertion: { type: 'no_a11y_violations', expected: 'image-alt' } }] };

test('plain Playwright: errors collected from the start, checked at the end; axe for accessibility', () => {
  const out = generatePlaywrightPlain(BUG_TEST);
  assert.match(out, /import AxeBuilder from '@axe-core\/playwright';/);
  assert.ok(out.indexOf("page.on('pageerror'") < out.indexOf('page.goto('), 'listening before the page loads');
  assert.match(out, /expect\(consoleErrors\.filter\(\(text\) => text\.includes\('Coupon service unavailable'\)\)\)\.toEqual\(\[\]\);/);
  assert.match(out, /new AxeBuilder\(\{ page: page \}\)\.withRules\(\['image-alt'\]\)\.analyze\(\)/);
  const link = generatePlaywrightPlain({ name: 't', steps: [{ command: 'assert', params: {}, assertion: { type: 'link_ok', selector: 'a[href="pricing.html"]' } }] });
  assert.match(link, /page\.request\.get\(new URL\(href, page\.url\(\)\)\.href\)/);
  assert.doesNotMatch(link, /consoleErrors|AxeBuilder/, 'only what the test needs');
});

test('Gherkin phrases, read back the same; Cucumber collects in the World', () => {
  const feature = serializeTestToFeatureWith(BUG_TEST, DEFAULTS);
  assert.match(feature, /Then the page should log no error containing "Coupon service unavailable"/);
  assert.match(feature, /And the page should not break the accessibility rule "image-alt"/);
  const parsed = parseFeatureToStepsWith(feature, DEFAULTS);
  assert.deepEqual(parsed.at(-2).assertion, { type: 'no_console_errors', expected: 'Coupon service unavailable' });
  for (const [assertion, phrase] of [
    [{ type: 'no_failed_requests', expected: '/api/cart' }, 'Then no request to "/api/cart" should fail'],
    [{ type: 'link_ok', selector: 'a[href="pricing.html"]' }, `Then the link 'a[href="pricing.html"]' should work`],
  ]) {
    assert.ok(serializeTestToFeatureWith({ name: 't', steps: [{ command: 'assert', params: {}, assertion }] }, DEFAULTS).includes(phrase), phrase);
  }
  const files = generatePlaywrightCucumber({ name: 't', project_id: 1, steps: [] }, DEFAULTS).files;
  assert.match(files.find((f) => f.path === 'features/support/world.js').content, /this\.page\.on\('pageerror', \(error\) => this\.consoleErrors\.push\(error\.message\)\);/);
  assert.match(files.find((f) => f.path === 'package.json').content, /"@axe-core\/playwright"/);
});

test('exploring: the site\'s pages from its links, safe clicks, a bug after a click', async () => {
  const calls = [];
  let page = null;
  let clickedAt = Infinity;
  const site = {
    [`${SHOP}/index.html`]: { links: [{ href: `${SHOP}/cart.html`, status: 200, type: 'text/html' }, { href: 'https://elsewhere.example/', status: 200, type: 'text/html' }], controls: [] },
    [`${SHOP}/cart.html`]: { links: [{ href: `${SHOP}/index.html`, status: 200, type: 'text/html' }], controls: [
      { role: 'button', name: 'Apply coupon', selector: '#apply', locators: [] },
      { role: 'button', name: 'Delete account', selector: '#delete', locators: [] },
    ] },
  };
  const browser = async (_profile, command, params) => {
    calls.push([command, params.selector ?? params.url ?? '']);
    switch (command) {
      case 'navigate': page = params.url; return { tabId: 7, url: params.url };
      case 'console_messages': return { pageLoadedAt: 0, messages: clickedAt < Infinity ? [{ level: 'error', text: 'Uncaught Error: Coupon service unavailable', timestamp: clickedAt + 1 }] : [] };
      case 'network_requests': return { requests: [] };
      case 'check_links': return { page, links: site[page].links };
      case 'run_axe': return { page, violations: [] };
      case 'snapshot': return { refs: Object.fromEntries(site[page].controls.map((c, i) => [`e${i}`, c])) };
      case 'click': clickedAt = Date.now(); return { success: true, changes: ['no visible change detected right away'] };
      default: throw new Error(command);
    }
  };
  const result = await explore({ startUrl: `${SHOP}/index.html#top`, sendCommand: browser, maxPages: 5 });
  assert.deepEqual(result.pages.map((p) => p.url), [`${SHOP}/index.html`, `${SHOP}/cart.html`], 'the fragment dropped, the other site not visited');
  assert.ok(!calls.some(([command, target]) => command === 'click' && target === '#delete'), 'Delete account never clicked');
  const bug = result.findings.find((f) => f.via);
  assert.equal(titleOf(bug), 'Console error on /shop/cart.html after clicking "Apply coupon": Coupon service unavailable');
  assert.equal(normalizeUrl('not a url'), null);
});
