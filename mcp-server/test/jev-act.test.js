// Unit tests for the Jev action loop (fake browser + scripted Jev — no network, no DB).
// Run with: node --test test/jev-act.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseElements, prioritize, redactInputValues, buildRequest, decide, runJevAct, formatReport, choiceTargets, choiceInputs } from '../lib/jev-act.js';

const LOGIN_TREE = [
  '@e1 [link] "Accueil" href="/"',
  '  @e2 [textbox] "Adresse e-mail" type="email" placeholder="vous@exemple.com"',
  '  @e3 [textbox] "Mot de passe" type="password"',
  '  @e4 [combobox] "Langue" value="Français"',
  '    [option] "Français" [selected]',
  '    [option] "English"',
  '  @e5 [button] "Se connecter"',
].join('\n');

const DASHBOARD_TREE = '@e1 [link] "Mon compte" href="/account"\n@e2 [button] "Déconnexion"';

// Fake extension: a login page that turns into a dashboard once the button is clicked.
// Like the real extension, the snapshot echoes current field values — passwords included.
function fakeBrowser() {
  const calls = [];
  const filled = {};
  let loggedIn = false;
  const loginTree = () => LOGIN_TREE.split('\n').map((line) => {
    const ref = line.trim().match(/^@(e\d+) \[textbox\]/)?.[1];
    return ref && filled[ref] ? `${line} value="${filled[ref]}"` : line;
  }).join('\n');
  const sendCommand = async (profile, command, params) => {
    calls.push({ command, params });
    if (command === 'snapshot') {
      return loggedIn
        ? { url: 'https://app.test/dashboard', title: 'Tableau de bord', tree: DASHBOARD_TREE, refs: { e1: {}, e2: {} } }
        : { url: 'https://app.test/login', title: 'Connexion', tree: loginTree(), refs: { e1: {}, e2: {}, e3: {}, e4: {}, e5: {} } };
    }
    if (command === 'fill') filled[params.ref.replace('@', '')] = params.value;
    if (command === 'click' && params.ref === '@e5') loggedIn = true;
    return { ok: true };
  };
  return { sendCommand, calls };
}

function makeDeps(sendCommand, script) {
  const recorded = [];
  const requests = [];
  return {
    recorded,
    requests,
    deps: {
      sendCommand,
      evaluate: async (state, questions) => {
        requests.push({ state, questions });
        const next = script.shift();
        if (!next) throw new Error('script exhausted');
        return { answers: next, latencyMs: 100 };
      },
      saveActionToHistory: (command, params, ref) => { recorded.push({ command, params, ref }); return 'act_1'; },
      setLastRefMap: () => {},
      getRecording: () => null,
    },
  };
}

const op = (choice, p = 0.95) => ({ type: 'choice', choice, probabilities: { [choice]: p } });
const target = (ref, p = 0.95) => ({ type: 'choice', choice: ref, probabilities: { [ref]: p } });

test('parseElements reads refs, roles and native selects', () => {
  const els = parseElements(LOGIN_TREE);
  assert.deepEqual(els.map((e) => e.ref), ['e1', 'e2', 'e3', 'e4', 'e5']);
  assert.equal(els[1].role, 'textbox');
  assert.match(els[1].desc, /^textbox "Adresse e-mail" type="email"/);
  assert.equal(els[3].nativeSelect, true);
  assert.equal(els[4].nativeSelect, false);
});

test('parseElements drops refs the extension filtered out', () => {
  const els = parseElements(LOGIN_TREE, { e2: {}, e5: {} });
  assert.deepEqual(els.map((e) => e.ref), ['e2', 'e5']);
});

test('parseElements reads the box, and drops a testid only when the element has a real label', () => {
  const els = parseElements([
    '@e1 [button] "Acheter" [expanded=false] [testid="shell_ufrn_header-NavigationBar-NavigationBarEntryExpandable"] [10,20,80x32]',
    '@e2 [button] [testid="close-modal"] [-5,900,24x24]',
    '@e3 [listitem] "Antony (92160)" [cursor=pointer]',
  ].join('\n'));
  assert.equal(els[0].desc, 'button "Acheter" [expanded=false]');
  assert.deepEqual(els[0].rect, { x: 10, y: 20, w: 80, h: 32 });
  assert.equal(els[1].desc, 'button [testid="close-modal"]'); // sole identifier: kept
  assert.deepEqual(els[1].rect, { x: -5, y: 900, w: 24, h: 24 });
  assert.equal(els[2].rect, null);
  assert.match(els[2].desc, /cursor=pointer/);
});

test('icon-only buttons are never offered as click targets (seen live: 4 blind clicks on pap.fr)', () => {
  const elements = parseElements([
    '@e1 [button]',
    '@e2 [button] [active]',
    '@e3 [button] [testid="close-modal"]',
    '@e4 [button] "Localisation"',
    '@e5 [textbox]',
  ].join('\n'));
  const { questions, fillables } = buildRequest({ goal: 'g', page: {}, elements, pendingInputs: ['ville'], history: [] });
  assert.deepEqual(Object.keys(questions.click_target.criteria), ['e3', 'e4']);
  assert.deepEqual(fillables.map((f) => f.ref), ['e5']); // an unnamed field is still fillable
});

test('prioritize keeps what is on screen when a page has more elements than Jev accepts', () => {
  // 150 header/menu elements scrolled ABOVE the screen, the search form ON screen but late
  // in DOM order, 150 footer links BELOW: a DOM-order cut at 200 would lose half the footer
  // AND keep all the invisible header — here the form must survive.
  const mk = (ref, y) => ({ ref, role: 'link', desc: `link "${ref}"`, nativeSelect: false, rect: { x: 10, y, w: 100, h: 20 } });
  const above = Array.from({ length: 150 }, (_, i) => mk(`a${i}`, -3000 + i * 20));
  const form = Array.from({ length: 10 }, (_, i) => mk(`f${i}`, 100 + i * 40));
  const below = Array.from({ length: 150 }, (_, i) => mk(`b${i}`, 900 + i * 20));
  const { elements, offscreen, dropped } = prioritize([...above, ...form, ...below], { w: 1280, h: 800 });

  assert.equal(elements.length, 200);
  assert.ok(form.every((f) => elements.includes(f)), 'on-screen form kept');
  assert.equal(dropped, 110);
  assert.ok(offscreen.above > 0 && offscreen.below >= 0);
  assert.ok(elements.includes(below[0]) && elements.includes(above[149]), 'nearest off-screen elements kept');
  assert.ok(!elements.includes(above[0]), 'farthest element dropped');
  // Kept elements are presented in DOM order.
  const order = elements.map((e) => [...above, ...form, ...below].indexOf(e));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('prioritize is a no-op under the cap and falls back to DOM order without geometry', () => {
  const few = [{ ref: 'e1', rect: null }];
  assert.deepEqual(prioritize(few, { w: 1, h: 1 }), { elements: few, offscreen: null, dropped: 0 });
  const many = Array.from({ length: 250 }, (_, i) => ({ ref: `e${i}`, rect: null }));
  const r = prioritize(many, undefined);
  assert.equal(r.elements.length, 200);
  assert.equal(r.elements[0].ref, 'e0');
  assert.equal(r.dropped, 50);
});

test('scroll operations tell Jev whether anything is actually out of reach', () => {
  const elements = parseElements(LOGIN_TREE);
  const all = buildRequest({ goal: 'g', page: {}, elements, pendingInputs: [], history: [] });
  assert.match(all.questions.operation.criteria.SCROLL_DOWN, /Every listed element can be used without scrolling/);
  assert.equal(all.state.not_listed, undefined);
  const cut = buildRequest({ goal: 'g', page: {}, elements, pendingInputs: [], history: [], offscreen: { below: 40, above: 0 } });
  assert.match(cut.questions.operation.criteria.SCROLL_DOWN, /40 more element\(s\) exist BELOW/);
  assert.deepEqual(cut.state.not_listed, { elements_below_the_screen: 40, elements_above_the_screen: 0 });
});

test('runJevAct looks again once before giving up right after an action', async () => {
  // Autocomplete: the suggestion only shows up in the snapshot AFTER the second look.
  let snapshots = 0;
  const sendCommand = async (profile, command) => {
    if (command !== 'snapshot') return { ok: true };
    snapshots++;
    const tree = ['@e1 [textbox] "Localisation"', '@e2 [button] "Rechercher"'];
    if (snapshots >= 3) tree.push('@e3 [listitem] "Antony (92160)" [cursor=pointer]');
    return { url: 'https://pap.test/', title: 'PAP', tree: tree.join('\n'), digest: ['h1: Trouvez votre bien'] };
  };
  const { deps, requests } = makeDeps(sendCommand, [
    { operation: op('FILL_1'), fill_target_1: target('e1') },
    { operation: op('BLOCKED', 0.66) },                        // suggestions not there yet
    { operation: op('CLICK'), click_target: target('e3') },    // second look: now visible
    { operation: op('DONE') },
  ]);
  const report = await runJevAct(deps, { goal: 'Choisir Antony', inputs: { localisation: 'Antony' } });

  assert.equal(report.outcome.stop, 'done');
  assert.deepEqual(report.history.map((h) => h.summary.split(' ')[0]), ['FILL', 'CLICK']);
  assert.deepEqual(requests[0].state.page.text, ['h1: Trouvez votre bien']);
});

test('runJevAct gives up after ONE second look, and never relooks before any action', async () => {
  const { sendCommand } = fakeBrowser();
  const a = makeDeps(sendCommand, [{ operation: op('BLOCKED', 0.9) }]);
  const first = await runJevAct(a.deps, { goal: 'x' });
  assert.equal(first.outcome.stop, 'blocked');
  assert.equal(a.requests.length, 1); // nothing was done yet: nothing to wait for

  const b = makeDeps(fakeBrowser().sendCommand, [
    { operation: op('CLICK'), click_target: target('e1') },
    { operation: op('BLOCKED', 0.9) },
    { operation: op('BLOCKED', 0.9) },
  ]);
  const second = await runJevAct(b.deps, { goal: 'x' });
  assert.equal(second.outcome.stop, 'blocked');
  assert.equal(b.requests.length, 3);
});

test('the page digest reaches Jev with provided values masked, and the agent through the report', async () => {
  const sendCommand = async (profile, command) => (command === 'snapshot'
    ? { url: 'u', title: 't', tree: '@e1 [button] "OK"', digest: ['h1: Résultats pour chaussures de running', 'alert: Message sent'] }
    : { ok: true });
  const { deps, requests } = makeDeps(sendCommand, [{ operation: op('DONE') }]);
  const report = await runJevAct(deps, { goal: 'x', inputs: { recherche: 'chaussures de running' } });
  assert.deepEqual(requests[0].state.page.text, ['h1: Résultats pour [filled]', 'alert: Message sent']);
  const text = formatReport(report);
  assert.match(text, /Page says \(visible headings \/ alerts \/ dialogs\):\n {2}h1: Résultats pour \[filled\]\n {2}alert: Message sent/);
});

test('redactInputValues masks passwords and provided inputs, keeps other page values', () => {
  const tree = [
    '@e1 [textbox] "Email" type="email" value="a@b.c" [required]',
    '@e2 [textbox] "Mot de passe" type="password" value="pa"ss w0rd" [required]',
    '@e3 [textbox] "Bio" value="Bonjour je suis une très longue descr..."',
    '@e4 [combobox] "Langue" value="Français"',
  ].join('\n');
  const out = redactInputValues(tree, {
    email: 'a@b.c',
    bio: 'Bonjour   je suis une très longue description qui dépasse la limite du snapshot',
  });
  assert.match(out, /@e1 .* value="\[filled\]" \[required\]/);
  assert.ok(!out.includes('a@b.c'));
  // Password fields are masked even when the value was not provided via inputs (and contains a quote).
  assert.ok(!out.includes('w0rd') && !out.includes('pa"ss'));
  // Truncated + whitespace-normalised values still match on prefix.
  assert.ok(!out.includes('longue descr'));
  assert.match(out, /@e4 \[combobox\] "Langue" value="Français"/);
});

test('redactInputValues never masks a short value inside the element box', () => {
  // Seen live: inputs {number: "7"} turned [493,134,470x32] into [493,134,4[filled]0x32].
  const out = redactInputValues('@e2 [textbox] "Number" type="number" value="7" [493,134,470x32]', { number: '7' });
  assert.equal(out, '@e2 [textbox] "Number" type="number" value="[filled]" [493,134,470x32]');
});

test('buildRequest offers one FILL operation per pending input and splits targets by kind', () => {
  const elements = parseElements(LOGIN_TREE);
  const { questions } = buildRequest({ goal: 'Log in', page: {}, elements, pendingInputs: ['email', 'password'], history: [] });

  assert.deepEqual(Object.keys(questions.operation.criteria),
    ['CLICK', 'FILL_1', 'FILL_2', 'PRESS_ENTER', 'SCROLL_DOWN', 'SCROLL_UP', 'DONE', 'BLOCKED']);
  // Text fields and native selects are fill targets, never click targets.
  assert.deepEqual(Object.keys(questions.click_target.criteria), ['e1', 'e5']);
  assert.deepEqual(Object.keys(questions.fill_target_1.criteria), ['e2', 'e3', 'e4']);
  assert.ok(questions.fill_target_2);
});

test('buildRequest skips one-option questions and FILL without pending inputs', () => {
  const elements = parseElements('@e1 [button] "OK"');
  const { questions } = buildRequest({ goal: 'Confirm', page: {}, elements, pendingInputs: [], history: [] });
  assert.equal(questions.click_target, undefined);
  assert.ok(!Object.keys(questions.operation.criteria).some((k) => k.startsWith('FILL_')));
});

test('decide hands back when the operation is uncertain', () => {
  const d = decide({ operation: { choice: 'CLICK', probabilities: { CLICK: 0.41, DONE: 0.39 } } },
    { clickables: [], fillables: [], pendingInputs: [] });
  assert.equal(d.stop, 'uncertain');
  assert.match(d.detail, /CLICK p=0.41, DONE p=0.39/);
});

test('decide judges FILL on the sum of FILL_k (Jev splits its probability between equally good fields)', () => {
  const fillables = parseElements(LOGIN_TREE).filter((e) => ['e2', 'e3'].includes(e.ref));
  // Seen live: no single option reaches 0.5, yet "fill something" is clearly the answer.
  const d = decide({
    operation: { choice: 'FILL_2', probabilities: { FILL_1: 0.23, FILL_2: 0.3, FILL_3: 0.2, BLOCKED: 0.25, CLICK: 0.02 } },
    fill_target_2: target('e3'),
  }, { clickables: [], fillables, pendingInputs: ['email', 'password', 'other'] });
  assert.equal(d.operation, 'FILL');
  assert.equal(d.inputKey, 'password'); // best member of the winning kind
  assert.equal(d.p, 0.75); // confidence in "keep going": FILL 0.73 + CLICK 0.02

  // ...but a real BLOCKED still wins when the FILL sum is lower.
  const blocked = decide({ operation: { choice: 'BLOCKED', probabilities: { FILL_1: 0.2, FILL_2: 0.2, BLOCKED: 0.6 } } },
    { clickables: [], fillables, pendingInputs: ['email', 'password'] });
  assert.equal(blocked.stop, 'blocked');
  assert.match(blocked.detail, /BLOCKED p=0.6, FILL p=0.4/);
});

test('decide acts when CLICK and FILL share the probability, but still hands back when stopping is as likely', () => {
  const clickables = parseElements('@e1 [button] "Type de bien"\n@e9 [button] "Rechercher"');
  const fillables = parseElements('@e2 [textbox] "Où ?"\n@e3 [textbox] "Budget"');
  const ctx = { clickables, fillables, pendingInputs: ['localisation'] };

  // Seen live on seloger.com: two right next actions, neither reaches 0.5 alone.
  const go = decide({
    operation: { choice: 'CLICK', probabilities: { CLICK: 0.49, FILL_1: 0.4, BLOCKED: 0.06, SCROLL_UP: 0.05 } },
    click_target: target('e1'),
  }, ctx);
  assert.equal(go.operation, 'CLICK');
  assert.equal(go.p, 0.89); // confidence in "keep going" (CLICK 0.49 + FILL 0.40) — the scroll is not pooled

  // Same trace, other page: Jev really is lost — must still hand back.
  const lost = decide({ operation: { choice: 'CLICK', probabilities: { CLICK: 0.31, BLOCKED: 0.31, SCROLL_UP: 0.22, DONE: 0.16 } } }, ctx);
  assert.equal(lost.stop, 'uncertain');

  // Majority says "act", but DONE is the single likeliest outcome: acting could repeat a submit.
  const maybeDone = decide({ operation: { choice: 'DONE', probabilities: { DONE: 0.45, CLICK: 0.3, FILL_1: 0.25 } } }, ctx);
  assert.equal(maybeDone.stop, 'uncertain');

  // A confident stop still wins over scattered actions.
  const done = decide({ operation: { choice: 'DONE', probabilities: { DONE: 0.6, CLICK: 0.25, FILL_1: 0.15 } } }, ctx);
  assert.equal(done.stop, 'done');
});

test('decide hands back candidate refs when the target is uncertain', () => {
  const clickables = parseElements('@e1 [button] "Continuer"\n@e2 [link] "Continuer sans compte"');
  const d = decide({
    operation: op('CLICK'),
    click_target: { choice: 'e1', probabilities: { e1: 0.38, e2: 0.35 } },
  }, { clickables, fillables: [], pendingInputs: [] });
  assert.equal(d.stop, 'uncertain');
  assert.deepEqual(d.candidates.map((c) => c.ref), ['e1', 'e2']);
});

test('decide resolves a single candidate without asking Jev', () => {
  const clickables = parseElements('@e7 [button] "OK"');
  const d = decide({ operation: op('CLICK') }, { clickables, fillables: [], pendingInputs: [] });
  assert.equal(d.target.ref, 'e7');
  assert.equal(d.targetP, 1);
});

test('runJevAct fills, clicks, and stops on DONE', async () => {
  const { sendCommand, calls } = fakeBrowser();
  // FILL_1 is re-indexed each step: once "email" is used, "password" becomes FILL_1.
  const { deps, recorded, requests } = makeDeps(sendCommand, [
    { operation: op('FILL_1'), fill_target_1: target('e2') },
    { operation: op('FILL_1'), fill_target_1: target('e3') },
    { operation: op('CLICK'), click_target: target('e5') },
    { operation: op('DONE') },
  ]);

  const report = await runJevAct(deps, { goal: 'Log in', inputs: { email: 'a@b.c', password: 's3cret!' } });

  assert.equal(report.outcome.stop, 'done');
  assert.deepEqual(calls.filter((c) => c.command !== 'snapshot').map((c) => [c.command, c.params.ref, c.params.value]), [
    ['fill', '@e2', 'a@b.c'],
    ['fill', '@e3', 's3cret!'],
    ['click', '@e5', undefined],
  ]);
  assert.deepEqual(recorded.map((r) => [r.command, r.ref]), [['fill', '@e2'], ['fill', '@e3'], ['click', '@e5']]);
  assert.deepEqual(report.pendingInputs, []);
  assert.equal(report.page.url, 'https://app.test/dashboard');
  // Privacy: input values must never reach Jev.
  assert.ok(!JSON.stringify(requests).includes('s3cret!'));
  assert.ok(!JSON.stringify(requests).includes('a@b.c'));
});

const now = (p) => ({ type: 'noul', noul: p });

test('buildRequest asks fill_now only when several inputs are pending', () => {
  const elements = parseElements(LOGIN_TREE);
  const many = buildRequest({ goal: 'Log in', page: {}, elements, pendingInputs: ['email', 'password'], history: [] });
  assert.equal(many.questions.fill_now_1.type, 'noul');
  assert.ok(many.questions.fill_now_2);
  const one = buildRequest({ goal: 'Log in', page: {}, elements, pendingInputs: ['email'], history: [] });
  assert.equal(one.questions.fill_now_1, undefined);
});

test('runJevAct fills every confident field in one step', async () => {
  const { sendCommand, calls } = fakeBrowser();
  const { deps, requests, recorded } = makeDeps(sendCommand, [
    { operation: op('FILL_1'), fill_target_1: target('e2'), fill_target_2: target('e3', 0.97), fill_now_1: now(0.99), fill_now_2: now(0.95) },
    { operation: op('CLICK'), click_target: target('e5') },
    { operation: op('DONE') },
  ]);
  const report = await runJevAct(deps, { goal: 'Log in', inputs: { email: 'a@b.c', password: 's3cret!' } });

  assert.equal(report.outcome.stop, 'done');
  assert.equal(requests.length, 3); // was 4 without batching
  assert.equal(calls.filter((c) => c.command === 'snapshot').length, 3);
  assert.deepEqual(calls.filter((c) => c.command === 'fill').map((c) => [c.params.ref, c.params.value]),
    [['@e2', 'a@b.c'], ['@e3', 's3cret!']]);
  assert.deepEqual(recorded.map((r) => r.command), ['fill', 'fill', 'click']); // batched fills are recorded too
  assert.match(report.history[1].summary, /FILL "password" → .* \(same step\)/);
});

test('decide refuses to batch a later-page value, an uncertain field, or a shared field', () => {
  const fillables = parseElements(LOGIN_TREE).filter((e) => ['e2', 'e3', 'e4'].includes(e.ref));
  const base = { operation: op('FILL_1'), fill_target_1: target('e2') };
  const ctx = { clickables: [], fillables, pendingInputs: ['email', 'other'] };

  const laterPage = decide({ ...base, fill_target_2: target('e3', 0.99), fill_now_2: now(0.2) }, ctx);
  assert.deepEqual(laterPage.batch, []);
  const unsureField = decide({ ...base, fill_target_2: target('e3', 0.7), fill_now_2: now(0.99) }, ctx);
  assert.deepEqual(unsureField.batch, []);
  const sameField = decide({ ...base, fill_target_2: target('e2', 0.99), fill_now_2: now(0.99) }, ctx);
  assert.deepEqual(sameField.batch, []);

  const ok = decide({ ...base, fill_target_2: target('e3', 0.95), fill_now_2: now(0.9) }, ctx);
  assert.deepEqual(ok.batch.map((b) => [b.inputKey, b.target.ref]), [['other', 'e3']]);
});

test('a failed batched fill is not fatal: the value stays pending', async () => {
  const { sendCommand: real } = fakeBrowser();
  const sendCommand = async (profile, command, params) => {
    if (command === 'fill' && params.ref === '@e3') throw new Error('Element not found: @e3');
    return real(profile, command, params);
  };
  const { deps } = makeDeps(sendCommand, [
    { operation: op('FILL_1'), fill_target_1: target('e2'), fill_target_2: target('e3', 0.97), fill_now_1: now(0.99), fill_now_2: now(0.95) },
    { operation: op('BLOCKED') },
    { operation: op('BLOCKED') }, // the one-time second look
  ]);
  const report = await runJevAct(deps, { goal: 'Log in', inputs: { email: 'a@b.c', password: 'x' } });
  assert.equal(report.history.length, 1);
  assert.deepEqual(report.pendingInputs, ['password']);
  assert.equal(report.outcome.stop, 'blocked'); // came from Jev on the next step, not from the failed fill
});

test('typing mode reaches the browser fill but is never recorded in test steps', async () => {
  const { sendCommand, calls } = fakeBrowser();
  const { deps, recorded } = makeDeps(sendCommand, [
    { operation: op('FILL_1'), fill_target_1: target('e2') },
    { operation: op('DONE') },
  ]);
  await runJevAct(deps, { goal: 'Type email', inputs: { email: 'a@b.c' }, typing: 'insert' });
  assert.equal(calls.find((c) => c.command === 'fill').params.typing, 'insert');
  assert.equal(recorded[0].params.typing, undefined);

  // Default: no typing param sent → the extension keeps its human-like key-by-key typing.
  const b = fakeBrowser();
  const d = makeDeps(b.sendCommand, [{ operation: op('FILL_1'), fill_target_1: target('e2') }, { operation: op('DONE') }]);
  await runJevAct(d.deps, { goal: 'Type email', inputs: { email: 'a@b.c' } });
  assert.equal(b.calls.find((c) => c.command === 'fill').params.typing, undefined);
});

test('runJevAct uses the select command for native selects', async () => {
  const { sendCommand, calls } = fakeBrowser();
  const { deps, recorded } = makeDeps(sendCommand, [
    { operation: op('FILL_1'), fill_target_1: target('e4') },
    { operation: op('DONE') },
  ]);
  await runJevAct(deps, { goal: 'Switch to English', inputs: { language: 'English' } });
  const select = calls.find((c) => c.command === 'select');
  assert.deepEqual([select.params.ref, select.params.value, select.params.matchBy], ['@e4', 'English', 'text']);
  assert.equal(recorded[0].command, 'select');
});

test('runJevAct hands back when it keeps repeating the same action', async () => {
  const { sendCommand } = fakeBrowser();
  const click = { operation: op('CLICK'), click_target: target('e1') };
  const { deps } = makeDeps(sendCommand, [click, click, click, click]);
  const report = await runJevAct(deps, { goal: 'Go home' });
  assert.equal(report.outcome.stop, 'stuck');
  assert.equal(report.history.length, 3);
});

test('runJevAct stops on a browser error and respects the step budget', async () => {
  const failing = async (profile, command) => {
    if (command === 'snapshot') return { url: 'u', title: 't', tree: LOGIN_TREE };
    throw new Error('Element not found: @e5');
  };
  const a = makeDeps(failing, [{ operation: op('CLICK'), click_target: target('e5') }]);
  const errored = await runJevAct(a.deps, { goal: 'Log in' });
  assert.equal(errored.outcome.stop, 'error');
  assert.match(errored.outcome.detail, /Element not found/);

  const { sendCommand } = fakeBrowser();
  const b = makeDeps(sendCommand, [{ operation: op('SCROLL_DOWN') }, { operation: op('SCROLL_UP') }]);
  const budget = await runJevAct(b.deps, { goal: 'Browse', maxSteps: 2 });
  assert.equal(budget.outcome.stop, 'max_steps');
});

test('formatReport gives the agent what it needs to take over', () => {
  const text = formatReport({
    outcome: { stop: 'uncertain', detail: 'Unsure which element to click.', candidates: [{ ref: 'e1', p: 0.38, desc: 'button "Continuer"' }] },
    history: [{ summary: 'FILL "email" → textbox "Email"', p: 0.98 }],
    page: { url: 'https://app.test/login', title: 'Connexion' },
    pendingInputs: ['password'],
    timing: { jevMs: 300, browserMs: 500 },
    totalMs: 900,
  });
  assert.match(text, /^act: HANDED BACK — Jev is unsure after 1 action\(s\) in 900ms \(jev 300ms, browser 500ms\)/);
  assert.match(text, /@e1 button "Continuer" \(p=0.38\)/);
  assert.match(text, /Inputs not used: password/);
});

// ─── Radio buttons and checkboxes ───────────────────────────────────
// Seen live on httpbin.org/forms/post: Jev, which never sees values, typed {"pizza size":
// "Medium"} into the Delivery instructions box (p=0.98). The server matches values to labels.

const PIZZA_TREE = [
  '@e1 [textbox] "Customer name:" type="text"',
  '@e2 [radio] "Small" [unchecked]',
  '@e3 [radio] "Medium" [unchecked]',
  '@e4 [checkbox] "Bacon" [unchecked]',
  '@e5 [checkbox] "Extra cheese" [checked]',
  '@e6 [textbox] "Delivery instructions:"',
  '@e7 [button] "Submit order"',
].join('\n');

test('choiceTargets matches a value to an option label, exactly first, then as a whole phrase', () => {
  const els = parseElements(PIZZA_TREE);
  assert.deepEqual(choiceTargets(els, ' medium ').map((e) => e.ref), ['e3']);
  assert.deepEqual(choiceTargets(els, 'cheese').map((e) => e.ref), ['e5']);
  assert.deepEqual(choiceTargets(els, 'Med').map((e) => e.ref), []);           // not a whole word
  assert.deepEqual(choiceTargets(els, 'Customer').map((e) => e.ref), []);      // textboxes are no options
  assert.deepEqual(Object.keys(choiceInputs(els, ['name', 'size'], { name: 'Jean', size: 'Medium' })), ['size']);
});

test('buildRequest offers CHOOSE, never FILL, for a value that names an option', () => {
  const els = parseElements(PIZZA_TREE);
  const choices = choiceInputs(els, ['name', 'size'], { name: 'Jean', size: 'Medium' });
  const { questions, state } = buildRequest({ goal: 'Order', page: {}, elements: els, pendingInputs: ['name', 'size'], history: [], choices });
  const ops = Object.keys(questions.operation.criteria);
  assert.ok(ops.includes('FILL_1') && ops.includes('CHOOSE_2'));
  assert.ok(!ops.includes('FILL_2'), 'the size must not be typable into a text field');
  assert.equal(questions.fill_target_2, undefined);
  assert.equal(questions.choose_target_2, undefined);                          // one option: resolved locally
  assert.match(state.available_inputs.size, /label of an option/);
});

test('runJevAct ticks the option, and leaves an already ticked checkbox alone', async () => {
  const calls = [];
  const sendCommand = async (profile, command, params) => {
    calls.push({ command, params });
    if (command === 'snapshot') return { url: 'https://shop.test/order', title: 'Order', tree: PIZZA_TREE, refs: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [`e${n}`, {}])) };
    return { ok: true };
  };
  const { deps, recorded } = makeDeps(sendCommand, [
    { operation: op('CHOOSE_1') },
    { operation: op('CHOOSE_1') },          // cheese, the only input left
    { operation: op('DONE') },
  ]);
  const report = await runJevAct(deps, { goal: 'Order', inputs: { size: 'Medium', topping: 'Extra cheese' } });
  const clicks = calls.filter((c) => c.command === 'click').map((c) => c.params.ref);
  assert.deepEqual(clicks, ['@e3'], 'Medium is clicked; Extra cheese, already ticked, is not');
  assert.equal(calls.some((c) => c.command === 'fill'), false);
  assert.deepEqual(recorded.map((r) => [r.command, r.ref]), [['click', '@e3']]);
  assert.match(report.history[0].summary, /^CHOOSE "size" → radio "Medium"$/);
  assert.match(report.history[1].summary, /already ticked/);
  assert.equal(report.outcome.stop, 'done');
});

test('decide hands back when several options could be the choice and Jev is unsure', () => {
  const els = parseElements('@e1 [radio] "Oui" [unchecked]\n@e2 [radio] "Oui" [unchecked]');
  const choices = { newsletter: els };
  const d = decide(
    { operation: op('CHOOSE_1'), choose_target_1: { type: 'choice', choice: 'e1', probabilities: { e1: 0.35, e2: 0.33 } } },
    { clickables: els, fillables: [], pendingInputs: ['newsletter'], choices }
  );
  assert.equal(d.stop, 'uncertain');
  assert.equal(d.candidates.length, 2);
});

test('history never shows a field value that was true only before the action', async () => {
  const { sendCommand } = fakeBrowser();
  const { deps } = makeDeps(sendCommand, [
    { operation: op('FILL_1'), fill_target_1: target('e4') },
    { operation: op('DONE') },
  ]);
  const report = await runJevAct(deps, { goal: 'Switch to English', inputs: { language: 'English' } });
  assert.doesNotMatch(report.history[0].summary, /value=/);
});
