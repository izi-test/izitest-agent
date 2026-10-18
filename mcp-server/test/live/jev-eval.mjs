// LIVE evaluation of the `act` decision prompts against the real Jev model.
// Not a unit test (costs API calls, ~$0.0002 each; not matched by the *.test.js glob).
//
//   OPENROUTER_API_KEY=... node test/live/jev-eval.mjs [runs-per-case=3]
//
// Each case is a frozen page state + the decision we expect from lib/jev-act.js.
// Jev's probabilities move a little from call to call, so every case runs several
// times: a prompt change is only good if EVERY case passes EVERY run. Run this
// before and after touching RULES, the operation labels, or any threshold.

import { evaluate } from '../../lib/jev.js';
import { parseElements, buildRequest, decide } from '../../lib/jev-act.js';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) { console.error('Set OPENROUTER_API_KEY'); process.exit(2); }
const RUNS = Number(process.argv[2]) || 3;

// ─── Page states ───────────────────────────────────────────────────

const LOGIN = [
  '@e1 [link] "Accueil" href="/"', '@e2 [link] "Créer un compte" href="/signup"',
  '@e3 [textbox] "Adresse e-mail" type="email" placeholder="vous@exemple.com" [required]',
  '@e4 [textbox] "Mot de passe" type="password" [required]', '@e5 [checkbox] "Se souvenir de moi" [unchecked]',
  '@e6 [button] "Se connecter"', '@e7 [link] "Mot de passe oublié ?" href="/reset"', '@e8 [button] "Continuer avec Google"',
];

const LOGIN_WITH_SEARCH = [
  '@e1 [link] "Accueil" href="/"', '@e2 [searchbox] "Rechercher un produit" placeholder="Rechercher…"', '@e3 [button] "Rechercher"',
  '@e4 [textbox] "Adresse e-mail" type="email" [required]', '@e5 [textbox] "Mot de passe" type="password" [required]',
  '@e6 [button] "Se connecter"', '@e7 [link] "Mot de passe oublié ?" href="/reset"',
];

const SHOP_HOME = [
  '@e1 [button] "Tout accepter"', '@e2 [button] "Tout refuser"', '@e3 [link] "Paramétrer les cookies" href="/cookies"',
  '@e4 [link] "Hommes" href="/h"', '@e5 [link] "Femmes" href="/f"', '@e6 [link] "Promotions" href="/promo"',
  '@e7 [searchbox] "Rechercher un produit" placeholder="Rechercher…"', '@e8 [button] "Rechercher"',
  '@e9 [link] "Panier (0)" href="/cart"', '@e10 [link] "Connexion" href="/login"',
];

const WIZARD_STEP1 = [
  '@e1 [textbox] "Workspace name" placeholder="Acme Inc." [required]', '@e2 [textbox] "Workspace URL" placeholder="acme"',
  '@e3 [button] "Next"', '@e4 [textbox] "Search docs" placeholder="Search…"',
];

// Modelled on browser-pilot-test.html: six sections, many empty required fields outside the contact form.
const testPage = (filled) => {
  const v = filled ? ' value="[filled]"' : '';
  return [
    '@e1 [textbox] "Email" type="email" placeholder="you@example.com" [required]', '@e2 [textbox] "Password" type="password" placeholder="••••••••" [required]',
    '@e3 [checkbox] "Remember me" [unchecked]', '@e4 [button] "Sign in"', '@e5 [button] "Reset"',
    `@e6 [textbox] "First name" type="text" placeholder="Jane"${v} [required]`, `@e7 [textbox] "Last name" type="text" placeholder="Doe"${v} [required]`,
    `@e8 [textbox] "Email" type="email" placeholder="jane@company.com"${v} [required]`, `@e9 [textbox] "Phone" type="tel" placeholder="+1 (555) 000-0000"${v}`,
    `@e10 [combobox] "Subject" value="${filled ? '[filled]' : 'Choose a topic'}"`, '  [option] "Choose a topic" [disabled]', '  [option] "Sales inquiry"', '  [option] "Technical support"',
    '@e11 [radio] "Low" [unchecked]', '@e12 [radio] "Medium" [checked]', '@e13 [radio] "High" [unchecked]', '@e14 [radio] "Urgent" [unchecked]',
    `@e15 [textbox] "Message" placeholder="Tell us what you need..."${v} [required]`, '@e16 [button] "Send message"', '@e17 [button] "Clear"',
    '@e18 [textbox] "Display name" type="text" placeholder="janedoe42" [required]', '@e19 [textbox] "Website" type="url" placeholder="https://yoursite.com"',
    '@e20 [textbox] "Bio" placeholder="A few words about yourself..."', '@e21 [textbox] "Date of birth" type="date"',
    '@e22 [checkbox] "Tech" [unchecked]', '@e23 [checkbox] "Design" [unchecked]', '@e24 [checkbox] "Music" [unchecked]', '@e27 [button] "Save profile"',
    '@e28 [button] "★ 1"', '@e29 [button] "★ 2"', '@e30 [button] "★ 3"', '@e33 [textbox] "Add a tag" placeholder="Type and press Enter"',
    '@e34 [switch] "Notify me" [unchecked]', '@e35 [slider] "Volume" value="50"', '@e36 [button] "Show details"',
    '@e37 [textbox] "Workspace name" placeholder="Acme Inc." [required]', '@e38 [textbox] "Workspace URL" placeholder="acme" [required]',
    '@e39 [button] "Next"', '@e40 [button] "Back" [disabled]', '@e41 [button] "Open confirmation"', '@e42 [link] "Back to top" href="#top"',
  ];
};

// ── Cases taken from a real agent run on seloger.com / pap.fr ──

// After typing a city: the suggestions are <li> with a JS click handler (cursor:pointer),
// which only reach Jev because act asks the snapshot for pointerInteractive.
const PAP_AUTOCOMPLETE = [
  '@e1 [link] "Acheter" href="/acheteur"', '@e2 [link] "Louer" href="/locataire"', '@e3 [link] "Vendre" href="/vendeur"',
  '@e4 [textbox] "Localisation" type="text" placeholder="Localisation" value="[filled]"',
  '@e5 [listitem] "Antony (92160)" [cursor=pointer]', '@e6 [listitem] "Antonne-et-Trigonant (24420)" [cursor=pointer]', '@e7 [listitem] "Antony-Parc-de-Sceaux (92)" [cursor=pointer]',
  '@e8 [button] "Maison Appartement Terrain Garage, parking Immeuble" [expanded=false]', '@e9 [link] "Rechercher" href="#"',
  '@e10 [button] "Créer une alerte"',
];

// Same page once the suggestion is chosen and the type set — but the search was NOT launched.
// Live, Jev called this DONE. page.text is what should stop it.
const PAP_NOT_LAUNCHED = [
  '@e1 [link] "Acheter" href="/acheteur"', '@e2 [link] "Louer" href="/locataire"',
  '@e4 [textbox] "Localisation" type="text" placeholder="Localisation" value="[filled]"',
  '@e8 [button] "Maison" [expanded=false]', '@e9 [link] "Rechercher" href="#"', '@e10 [button] "Créer une alerte"',
];

// Two "Acheter": a header navigation menu, and the search form's own tab. Live, Jev only saw
// the header one (the form was cut off by the 200-element cap) and clicked it at p=0.93.
const SELOGER_HOME = [
  '@e1 [link] "SeLoger Homepage" href="https://www.seloger.com/"', '@e2 [button] "Acheter" [expanded=false]', '@e3 [button] "Louer" [expanded=false]',
  '@e4 [button] "Vendre" [expanded=false]', '@e5 [button] "Estimer" [expanded=false]', '@e6 [link] "Déposer une annonce" href="/depot-annonce"',
  '@e7 [tab] "Acheter" [selected]', '@e8 [tab] "Louer"', '@e9 [tab] "Neuf"',
  '@e10 [button] "Appartement, Maison" [expanded=false] [cursor=pointer]', '@e11 [textbox] "Où cherchez-vous ?" placeholder="Ville, quartier, code postal"',
  '@e12 [button] "Rechercher"', '@e13 [link] "Maisons à vendre – Antony, 92160" href="/classified-search?..."',
  '@e14 [link] "Voir les 27 biens à vendre" href="https://www.seloger.com/pro..."',
];

const CONTACT_KEYS = ['First name', 'Last name', 'Email', 'Phone', 'Subject', 'Message'];
const CONTACT_GOAL = 'Fill in the "Get in touch" contact form and send the message';
const filledHistory = CONTACT_KEYS.map((k) => ({ summary: `FILL "${k}" → textbox "${k}"` }));

// ─── Cases: expect(decision) returns null when OK, or a reason string ──────

const isFill = (d, keys) => (d.operation === 'FILL' && keys.includes(d.inputKey) ? null : `expected FILL of ${keys.join('/')}`);

const CASES = [
  { name: 'login: values provided → fill', tree: LOGIN, title: 'Connexion — Shop', goal: 'Se connecter au compte client',
    inputs: ['adresse e-mail', 'mot de passe'], expect: (d) => isFill(d, ['adresse e-mail', 'mot de passe']) },
  { name: 'login: NO values → refuse to guess', tree: LOGIN, title: 'Connexion — Shop', goal: 'Se connecter au compte client',
    inputs: [], expect: (d) => (d.stop === 'blocked' ? null : 'expected BLOCKED') },
  { name: 'test page: 6 values → fill (probability split across FILL_k)', tree: testPage(false), title: 'Browser Pilot — Test page', goal: CONTACT_GOAL,
    inputs: CONTACT_KEYS, expect: (d) => isFill(d, CONTACT_KEYS), note: (d) => `batch=${d.batch?.length ?? 0}` },
  { name: 'test page: all typed, other forms empty → click Send', tree: testPage(true), title: 'Browser Pilot — Test page', goal: CONTACT_GOAL,
    inputs: [], history: filledHistory, expect: (d) => (d.operation === 'CLICK' && d.target?.ref === 'e16' ? null : 'expected CLICK on e16 "Send message"') },
  { name: 'shop home with cookie banner → fill the search box', tree: SHOP_HOME, title: 'Shop — Accueil', goal: 'Rechercher "chaussures de running" et arriver sur la page de résultats',
    inputs: ['recherche'], expect: (d) => (d.operation === 'FILL' && d.target?.ref === 'e7' ? null : 'expected FILL on e7 searchbox') },
  { name: 'after submit → done', tree: ['@e1 [button] "Send another message"', '@e2 [link] "Back to top" href="#top"'], title: 'Message sent — Browser Pilot', goal: CONTACT_GOAL,
    inputs: [], history: [...filledHistory, { summary: 'CLICK button "Send message"' }], expect: (d) => (d.stop === 'done' ? null : 'expected DONE') },
  { name: 'login then search: the search value must NOT be batched on the login page', tree: LOGIN_WITH_SEARCH, title: 'Connexion — Shop',
    goal: 'Se connecter au compte, puis rechercher "chaussures de running"', inputs: ['adresse e-mail', 'mot de passe', 'recherche'],
    expect: (d) => isFill(d, ['adresse e-mail', 'mot de passe']) || ((d.batch || []).some((b) => b.inputKey === 'recherche') ? '"recherche" was batched on the login page' : null),
    note: (d) => `batch=[${(d.batch || []).map((b) => b.inputKey).join(', ')}]` },
  { name: 'wizard step 1: the step-2 value must NOT be batched', tree: WIZARD_STEP1, title: 'Create workspace — step 1 of 2',
    goal: 'Create the workspace "Acme" then invite bob@acme.io on the next step', inputs: ['workspace name', 'workspace url', 'invite email'],
    expect: (d) => isFill(d, ['workspace name', 'workspace url']) || ((d.batch || []).some((b) => b.inputKey === 'invite email') ? '"invite email" was batched on step 1' : null),
    note: (d) => `batch=[${(d.batch || []).map((b) => b.inputKey).join(', ')}]` },

  { name: 'real run (pap.fr): pick the autocomplete suggestion, a cursor:pointer <li>', tree: PAP_AUTOCOMPLETE, title: 'IMMOBILIER - Annonces immobilières | PAP',
    goal: 'Dans le formulaire de recherche : localisation Antony (92160) via l\'autocomplétion, type Maison, puis lancer la recherche',
    inputs: [], history: [{ summary: 'FILL "localisation" → textbox "Localisation"' }], text: ['h1: Trouvez le bien qui vous correspond'],
    expect: (d) => (d.operation === 'CLICK' && d.target?.ref === 'e5' ? null : 'expected CLICK on e5 "Antony (92160)"') },
  { name: 'real run (pap.fr): search not launched yet → must NOT say DONE', tree: PAP_NOT_LAUNCHED, title: 'IMMOBILIER - Annonces immobilières | PAP',
    goal: 'Dans le formulaire de recherche : localisation Antony (92160) via l\'autocomplétion, type Maison, puis lancer la recherche',
    inputs: [], text: ['h1: Trouvez le bien qui vous correspond'],
    history: [{ summary: 'FILL "localisation" → textbox "Localisation"' }, { summary: 'CLICK listitem "Antony (92160)"' }, { summary: 'CLICK button "Maison Appartement Terrain"' }, { summary: 'CLICK option "Maison"' }],
    expect: (d) => (d.operation === 'CLICK' && d.target?.ref === 'e9' ? null : 'expected CLICK on e9 "Rechercher"') },
  { name: 'real run (seloger.com): two "Acheter" — must work in the search FORM, not the header menu', tree: SELOGER_HOME, title: 'Petites annonces immobilières | SeLoger',
    goal: 'Dans la recherche, choisir Acheter, type Maison, localisation Antony (92160), puis lancer la recherche', inputs: ['localisation'],
    expect: (d) => {
      if (d.target?.ref === 'e2') return 'clicked the HEADER "Acheter" menu';
      const ok = (d.operation === 'FILL' && d.target?.ref === 'e11') || (d.operation === 'CLICK' && ['e7', 'e10'].includes(d.target?.ref));
      return ok ? null : 'expected FILL e11 (location) or CLICK e10 (type) / e7 (form tab)';
    } },
];

// ─── Runner ────────────────────────────────────────────────────────

let failures = 0;
for (const c of CASES) {
  const elements = parseElements(c.tree.join('\n'));
  const page = { url: 'https://eval.test/', title: c.title, ...(c.text ? { text: c.text } : {}) };
  const request = buildRequest({ goal: c.goal, page, elements, pendingInputs: c.inputs, history: c.history || [] });
  const lines = [];
  let ok = 0;
  for (let i = 0; i < RUNS; i++) {
    const { answers } = await evaluate(apiKey, request.state, request.questions);
    const d = decide(answers, { ...request, pendingInputs: c.inputs });
    const problem = c.expect(d);
    if (!problem) ok++;
    const what = d.stop ? `STOP ${d.stop}${d.ranking ? ` (${d.ranking})` : d.detail ? ` (${d.detail})` : ''}` : `${d.operation}${d.inputKey ? ` "${d.inputKey}"` : ''} → ${d.target?.ref ?? '-'} (op p=${d.p}, target p=${d.targetP ?? '-'})`;
    lines.push(`     ${problem ? '✖' : '✔'} ${what}${c.note && !d.stop ? ` ${c.note(d)}` : ''}${problem ? `   ← ${problem}` : ''}`);
  }
  if (ok < RUNS) failures++;
  console.log(`${ok === RUNS ? 'PASS' : 'FAIL'} ${ok}/${RUNS}  ${c.name}\n${lines.join('\n')}`);
}
console.log(`\n${CASES.length - failures}/${CASES.length} cases passed every run.`);
process.exit(failures ? 1 : 0);
