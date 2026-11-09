// The tests a change needs: of a project's tests, those that touch what the changed files are
// part of — each chosen with why, each left out with why. A test not run that would have
// failed is the risk: when in doubt, more tests run, and the selection says so.
//
// What ties a file to a test:
// - its name: the words of its path (server/routes/notes.js: "note") in the routes a test went
//   to or called (/notes/new, POST /api/notes) — its footprint (lib/footprint.js);
// - `touched`: the routes or pages the change touches, told by whoever knows the code (the
//   agent that wrote it): POST /api/notes, /notes/*;
// - the requirements the commit message names (NDF-3): their tests.
// Always chosen: a test whose pages' calls are not known yet (no run kept its footprint), one
// that failed last time (does the change fix it?), those asked (`include`), and a test that
// keeps a value a chosen one uses (capture).
// Everything runs when a file is shared — dependencies, configuration, a middleware, global
// styles, the database schema —, or when `touched` does not say what the change touches and a
// file says no part of the app by its name (App.tsx, server.js, api.ts: what all pages use, or
// every route in one file) or ties to no test.
// Ignored: documentation, the app's own unit tests, editor and CI settings.

import { db } from './db.js';
import { footprintOfTest, pathOf } from './footprint.js';
import { loadTest } from './test-store.js';
import { keptNames } from './server-steps.js';

// What does not change the app as its tests see it.
const IGNORED = [
  [/^(?!.*requirements[^/]*\.txt$).*\.(md|mdx|txt|rst|adoc)$/i, 'documentation'],
  [/(^|\/)(docs?|documentation)\//i, 'documentation'],
  [/(^|\/)(LICEN[CS]E|CHANGELOG|AUTHORS|CONTRIBUTING|NOTICE)[^/]*$/i, 'documentation'],
  [/(^|\/)(tests?|__tests__|__mocks__|specs?|e2e|cypress|playwright)\//i, "the app's own tests"],
  [/\.(test|spec|stories)\.[a-z]+$/i, "the app's own tests"],
  [/(^|\/)(\.vscode|\.idea|\.github|\.husky|\.claude)\//i, 'editor or CI settings'],
  [/(^|\/)(\.gitignore|\.gitattributes|\.editorconfig|\.prettierrc[^/]*|\.eslintrc[^/]*|eslint\.config\.[a-z]+|prettier\.config\.[a-z]+|\.gitlab-ci\.ya?ml|\.mcp\.json|\.nvmrc)$/i, 'editor or CI settings'],
];

// What every page uses: a change there can break any test.
const SHARED = [
  [/(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|requirements[^/]*\.txt|Pipfile(\.lock)?|poetry\.lock|pyproject\.toml|Gemfile(\.lock)?|go\.(mod|sum)|Cargo\.(toml|lock)|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?|[^/]+\.csproj)$/i, 'the dependencies'],
  [/(^|\/)((vite|webpack|rollup|babel|next|nuxt|svelte|tailwind|postcss|astro|remix|jest|vitest)\.config\.[a-z]+|tsconfig[^/]*\.json|\.babelrc|angular\.json|Dockerfile[^/]*|(docker-)?compose[^/]*\.ya?ml|Procfile|nginx[^/]*\.conf|\.env[^/]*)$/i, 'the build or the configuration'],
  [/(^|\/)(config|configs|settings)\//i, 'the configuration'],
  [/(^|\/)(middlewares?)\/|(^|\/)middlewares?\.[a-z]+$/i, 'a middleware: every request goes through it'],
  [/(^|\/)(migrations?|schemas?|prisma|seeds?|seeders)\/|\.sql$|(^|\/)(schema|seed)\.[a-z]+$/i, 'the database'],
  [/(^|\/)(locales?|i18n|translations?|lang)\//i, 'the texts of every page'],
  [/(^|\/)(styles?|themes?)\/|(^|\/)(index|globals?|app|main|styles?|reset|theme)\.(css|scss|sass|less)$/i, 'the styles of every page'],
  [/(^|\/)index\.html?$/i, 'the page every page is drawn in'],
];

// Words that say where a file is in the code, or what kind of file it is, not which part of
// the app: a file made only of them is used everywhere (App.tsx, server/index.js, api.ts).
const GENERIC = new Set(`src source app apps client server frontend front backend back web www public static assets asset dist build
lib libs util utils helper helpers common shared core component components page pages view views screen screens route routes
router routing controller controllers service services model models api apis handler handlers index main base hook hooks use
context contexts store stores state slice slices reducer reducers action actions type types interface interfaces const constant
constants style styles module modules package packages mock mocks fixture fixtures data http request requests response query
queries provider providers layout layouts template templates partial partials widget widgets element elements item items list
form new edit detail details modal dialog table card button input field row column panel header footer nav navbar sidebar menu
icon icons image images img font fonts react express next vite node default shell root entry global globals the and for with des
les une pour par sur avec dans`.split(/\s+/).map((w) => singular(w)));

function singular(word) {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(word)) return word;
  if (/(sses|xes|ches|shes)$/.test(word)) return word.slice(0, -2);
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

/** The words of a path or a route: camelCase and kebab-case split, plural made singular. */
export function wordsOf(text) {
  return String(text ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w))
    .map(singular);
}

/** The words of a file that can say which part of the app it is: those of its folders and name, not its extension. */
function fileWords(path) {
  const parts = path.split('/');
  const name = parts.pop().split('.')[0];
  return [...new Set(wordsOf([...parts, name].join('/')).filter((w) => !GENERIC.has(w)))];
}

/** A route as a footprint keeps it: "POST /api/notes/*" or "/notes/*". */
function routeOf(entry) {
  const match = String(entry).trim().match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)$/i);
  const method = match ? match[1].toUpperCase() : null;
  let path = match ? match[2] : String(entry).trim();
  // A route's parameters as frameworks write them: :id, {id}, [id], <id>.
  path = path.replace(/\/(:[^/]+|\{[^/]+\}|\[[^/]+\]|<[^/]+>)/g, '/0');
  const normalized = /^https?:/i.test(path) ? pathOf(path) : path.startsWith('/') ? pathOf(`http://x${path}`) : null;
  return normalized ? { method, path: normalized } : null;
}

/** Whether a footprint route ("GET /api/notes/*" or "/notes") is `route` or under it. */
function reaches(entry, route) {
  const [method, path] = entry.includes(' ') ? entry.split(' ') : [null, entry];
  if (route.method && method !== route.method) return false;
  if (route.method && !method) return false;
  const under = (a, b) => a === b || a.startsWith(b === '/' ? '/' : `${b}/`);
  // A starred part of either matches any part of the other.
  const parts = (p) => p.split('/');
  const same = (a, b) => {
    const [pa, pb] = [parts(a), parts(b)];
    if (pa.length < pb.length) return false;
    return pb.every((part, i) => part === pa[i] || part === '*' || pa[i] === '*');
  };
  return under(path, route.path) || same(path, route.path);
}

/** How a file of the change is weighed: ignored, shared, or the words that tie it to tests. */
export function classifyFile(path) {
  const clean = String(path).trim().replace(/\\/g, '/').replace(/^\.\//, '');
  // The app's own tests and docs first: test/fixtures/seed.sql changes no page.
  for (const [pattern, why] of IGNORED) if (pattern.test(clean)) return { path: clean, kind: 'ignored', why };
  for (const [pattern, why] of SHARED) if (pattern.test(clean)) return { path: clean, kind: 'shared', why };
  const words = fileWords(clean);
  // App.tsx, server.js, api.ts: what all pages use — or all the routes, in one file.
  if (!words.length) return { path: clean, kind: 'general', why: 'its name says no part of the app' };
  return { path: clean, kind: 'code', words };
}

const routesOf = (footprint) => [...footprint.pages, ...footprint.api];
const describe = (entry) => (entry.includes(' ') ? `it calls ${entry}` : `it goes to ${entry}`);

/**
 * The tests of a project a change needs. `changedFiles`: the files it changes (git diff
 * --name-only); `touched`: the routes or pages it changes, when known; `commitMessage`: its
 * message, for the requirements it names; `include`: tests to run anyway.
 * { tests: [{ name, reasons }], left_out: [{ name, why }], full, why_full, files, uncovered, requirements, total }
 */
export function selectTests({ projectId, changedFiles = [], touched = [], commitMessage = '', include = [] }) {
  if (!projectId) throw new Error('project_id: the project whose tests are chosen');
  const names = db.prepare('SELECT name FROM tests WHERE project_id = ? ORDER BY name').all(projectId).map((r) => r.name);
  if (!names.length) throw new Error(`Project #${projectId} has no test`);
  const files = [...new Set(changedFiles.map(String).filter((f) => f.trim()))].map(classifyFile);
  const routes = touched.map((entry) => ({ entry: String(entry).trim(), route: routeOf(entry) }));
  const badRoute = routes.find((r) => !r.route);
  if (badRoute) throw new Error(`touched: "${badRoute.entry}" is no route nor page — e.g. "POST /api/notes", "/notes/:id"`);
  const unknown = include.filter((name) => !names.includes(name));
  if (unknown.length) throw new Error(`include: no test ${unknown.map((n) => `"${n}"`).join(', ')} in project #${projectId}`);

  // The requirements the message names, among the project's.
  const requirements = db.prepare('SELECT id, key FROM requirements WHERE project_id = ? AND key IS NOT NULL').all(projectId)
    .filter((r) => new RegExp(`(^|[^A-Za-z0-9-])${r.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`, 'i').test(commitMessage ?? ''));
  if (!files.length && !routes.length && !requirements.length) {
    throw new Error('changed_files: the files the change touches (git diff --name-only), or touched: the routes it changes');
  }

  const footprints = new Map(names.map((name) => [name, footprintOfTest(name)]));
  const reasons = new Map();
  const choose = (name, why) => {
    const list = reasons.get(name) ?? [];
    if (!list.includes(why)) list.push(why);
    reasons.set(name, list);
  };

  // Each file of the app's code: the tests whose routes say one of its words — else whose name
  // does (ManagerPage.tsx: ndf_manager_approuve), in an app whose pages share one URL.
  for (const file of files.filter((f) => f.kind === 'code')) {
    const tied = [];
    for (const name of names) {
      const route = routesOf(footprints.get(name)).find((entry) => {
        const words = new Set(wordsOf(entry.replace(/^[A-Z]+ /, '')));
        return file.words.some((w) => words.has(w));
      });
      const named = route ? null : file.words.find((w) => wordsOf(name).includes(w));
      if (route || named) {
        tied.push(name);
        choose(name, route ? `${file.path} → ${describe(route)}` : `${file.path} → its name says "${named}"`);
      }
    }
    file.tests = tied;
    if (!tied.length) {
      file.kind = 'untied';
      file.why = `no test's routes nor name say ${file.words.map((w) => `"${w}"`).join(' or ')}`;
    }
    delete file.words;
  }

  // The routes the change touches, as told.
  const uncovered = [];
  for (const { entry, route } of routes) {
    let any = false;
    for (const name of names) {
      const hit = routesOf(footprints.get(name)).find((e) => reaches(e, route));
      if (hit) { any = true; choose(name, `the change touches ${entry} → ${describe(hit)}`); }
    }
    if (!any) uncovered.push(entry);
  }

  for (const requirement of requirements) {
    const tests = db.prepare('SELECT DISTINCT t.name FROM requirement_cases c JOIN tests t ON t.id = c.test_id WHERE c.requirement_id = ?').all(requirement.id);
    for (const { name } of tests) if (names.includes(name)) choose(name, `the commit names ${requirement.key}, which it checks`);
  }

  // Everything, when a file can break any test; or when one says no part of the app, or ties to
  // no test, and nothing says what the change touches (touched).
  const shared = files.filter((f) => f.kind === 'shared');
  const unsure = files.filter((f) => f.kind === 'general' || f.kind === 'untied');
  const whyFull = [
    ...shared.map((f) => `${f.path}: ${f.why}`),
    ...(routes.length ? [] : unsure.map((f) => `${f.path}: ${f.why} — say what it changes (touched), or every test runs`)),
  ];
  // Told what the change touches: those files are taken as told.
  if (routes.length) for (const f of unsure) f.why = `${f.why} — taken as told by touched`;
  const full = whyFull.length > 0;

  if (full) {
    for (const name of names) choose(name, `every test: ${whyFull[0]}${whyFull.length > 1 ? ` (and ${whyFull.length - 1} more)` : ''}`);
  } else {
    for (const name of names) {
      const footprint = footprints.get(name);
      if (!footprint.run) choose(name, 'no run of it kept what its pages call: what it touches is not known');
      const last = db.prepare(`SELECT status FROM test_executions WHERE test_name = ? AND status IN ('success', 'failed') ORDER BY id DESC LIMIT 1`).get(name);
      if (last?.status === 'failed') choose(name, 'it failed last time: does the change fix it?');
    }
    for (const name of include) choose(name, 'asked');
    // A chosen test using a value another one keeps (capture) needs it to run first.
    const keeper = new Map();
    for (const name of names) for (const kept of keptNames(loadTest(name)?.steps)) if (!keeper.has(kept)) keeper.set(kept, name);
    const queue = [...reasons.keys()];
    while (queue.length) {
      const test = loadTest(queue.shift());
      const own = new Set([...Object.keys(test.variables ?? {}), ...keptNames(test.steps)]);
      const used = new Set([...JSON.stringify(test.steps).matchAll(/\{\{\s*([A-Za-z_]\w*)/g)].map((m) => m[1]));
      for (const value of used) {
        const giver = keeper.get(value);
        if (own.has(value) || !giver || giver === test.name) continue;
        if (!reasons.has(giver)) queue.push(giver);
        choose(giver, `it keeps {{${value}}} for ${test.name}`);
      }
    }
  }

  const chosen = names.filter((name) => reasons.has(name));
  // What a test left out does that not every test does: what tells it apart.
  const known = names.filter((name) => footprints.get(name).run);
  const everyone = new Set(known.length > 1 ? routesOf(footprints.get(known[0])).filter((r) => known.every((n) => routesOf(footprints.get(n)).includes(r))) : []);
  const leftOut = names.filter((name) => !reasons.has(name)).map((name) => {
    const own = routesOf(footprints.get(name)).filter((r) => !everyone.has(r));
    return { name, why: `touches nothing the change does${own.length ? ` (${own.slice(0, 4).join(', ')}${own.length > 4 ? '…' : ''})` : everyone.size ? ' (only what every test does)' : ''}` };
  });
  return {
    project_id: projectId, total: names.length, full, why_full: whyFull,
    tests: chosen.map((name) => ({ name, reasons: reasons.get(name) })),
    left_out: leftOut,
    files: files.map((f) => ({ path: f.path, kind: f.kind, ...(f.why ? { why: f.why } : {}), ...(f.tests ? { tests: f.tests } : {}) })),
    uncovered,
    requirements: requirements.map((r) => r.key),
  };
}

/** A selection as the agent reads it. */
export function formatSelection(s) {
  const lines = [`${s.tests.length} of ${s.total} test(s) to run${s.full ? ' — all of them' : ''}.`];
  if (s.full) lines.push(`Every test runs: ${s.why_full.join('; ')}`);
  for (const f of s.files) {
    const how = { code: `→ ${f.tests?.join(', ')}`, untied: `tied to no test — ${f.why}`, general: `used everywhere — ${f.why}`, shared: `shared — ${f.why}`, ignored: `ignored — ${f.why}` }[f.kind];
    lines.push(`  ${f.path}: ${how}`);
  }
  if (s.requirements.length) lines.push(`The commit names ${s.requirements.join(', ')}.`);
  if (s.uncovered.length) lines.push(`No test goes to ${s.uncovered.join(', ')}: what the change does there is not tested — record a test for it.`);
  if (!s.full && s.tests.length) {
    lines.push('Chosen:');
    for (const t of s.tests) lines.push(`  ${t.name}: ${t.reasons.join('; ')}`);
  }
  if (s.left_out.length) {
    lines.push('Left out:');
    for (const t of s.left_out) lines.push(`  ${t.name}: ${t.why}`);
  }
  return lines.join('\n');
}
