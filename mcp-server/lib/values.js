// Computed values in a test: a variable or a step may hold {{expression}}, worked out when the
// test runs — {{today + 3 days | dd/MM/yyyy}}, user-{{unique}}@example.com, {{price * 1.2}},
// {{random(1000, 9999)}}. Once per run: the date typed in step 3 is the one an assertion checks
// in step 9. A small language read here, never eval'd.
//
// Self-contained, with no import: the code exported for a test that uses computed values
// carries this very file (lib/codegen), so they are computed the same way there.
//
//   values      today, tomorrow, yesterday (dates); now (date and time); timestamp (ms);
//               uuid; unique (a short token, the same everywhere in the run); the test's variables
//   durations   3 days, 2 weeks, 1 month, 1 year, 4 hours, 30 minutes, 10 seconds
//               (or jours, semaines, mois, ans, heures, minutes, secondes)
//   operators   + - * / % and ( ); a date plus or minus a duration is a date; two dates
//               subtracted are a number of days; + joins text
//   functions   random(min, max), round(x, digits), floor(x), ceil(x), abs(x), min(…), max(…)
//   datasets    utilisateurs[2].email: a value of a project's dataset, its rows numbered from 1
//   format      after |: a date as dd/MM/yyyy, d MMMM yyyy, EEEE, HH:mm…; a number as 0.00

const UNITS = {
  second: 'second', seconds: 'second', sec: 'second', seconde: 'second', secondes: 'second',
  minute: 'minute', minutes: 'minute', min: 'minute',
  hour: 'hour', hours: 'hour', heure: 'hour', heures: 'hour',
  day: 'day', days: 'day', jour: 'day', jours: 'day',
  week: 'week', weeks: 'week', semaine: 'week', semaines: 'week',
  month: 'month', months: 'month', mois: 'month',
  year: 'year', years: 'year', an: 'year', ans: 'year', annee: 'year', annees: 'year', 'année': 'year', 'années': 'year',
};
const KEYWORDS = new Set(['today', 'tomorrow', 'yesterday', 'now', 'timestamp', 'uuid', 'unique']);
const FUNCTIONS = new Set(['random', 'round', 'floor', 'ceil', 'abs', 'min', 'max']);
const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const NAME = /^[A-Za-z_][\w]*$/;
const NUMERIC = /^-?\d+(?:\.\d+)?$/;

class ValueError extends Error {}

// ─── Reading an expression ──────────────────────────────────────────

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { i += 1; continue; }
    const number = /^\d+(?:\.\d+)?/.exec(source.slice(i));
    if (number) { tokens.push({ type: 'number', value: Number(number[0]) }); i += number[0].length; continue; }
    const word = /^[A-Za-z_À-ſ][\wÀ-ſ]*/.exec(source.slice(i));
    if (word) { tokens.push({ type: 'name', value: word[0] }); i += word[0].length; continue; }
    if ('+-*/%(),[].'.includes(c)) { tokens.push({ type: c }); i += 1; continue; }
    throw new ValueError(`unexpected "${c}"`);
  }
  return tokens;
}

/** The expression as a tree: { op, left, right } | { call, args } | { name } | { number } | { duration }. */
function parse(source) {
  const tokens = tokenize(source);
  let at = 0;
  const peek = () => tokens[at];
  const take = (type) => {
    if (peek()?.type !== type) throw new ValueError(`expected "${type}"${peek() ? '' : ' at the end'}`);
    return tokens[at++];
  };

  const additive = () => {
    let left = multiplicative();
    while (peek() && '+-'.includes(peek().type)) left = { op: tokens[at++].type, left, right: multiplicative() };
    return left;
  };
  const multiplicative = () => {
    let left = unary();
    while (peek() && '*/%'.includes(peek().type)) left = { op: tokens[at++].type, left, right: unary() };
    return left;
  };
  const unary = () => (peek()?.type === '-' ? (at++, { op: 'neg', left: unary() }) : withUnit(postfix(primary())));
  // A row of a dataset and a column of it: utilisateurs[2].email.
  const postfix = (node) => {
    for (;;) {
      if (peek()?.type === '[') { at += 1; const index = additive(); take(']'); node = { row: index, of: node }; continue; }
      if (peek()?.type === '.') { at += 1; node = { column: take('name').value, of: node }; continue; }
      return node;
    }
  };
  // A number, or what gives one (a variable, a parenthesis), followed by a unit is a duration.
  const withUnit = (node) => {
    const next = peek();
    if (next?.type === 'name' && UNITS[next.value.toLowerCase()]) {
      at += 1;
      return { duration: node, unit: UNITS[next.value.toLowerCase()] };
    }
    return node;
  };
  const primary = () => {
    const token = peek();
    if (!token) throw new ValueError('the expression ends too soon');
    if (token.type === 'number') { at += 1; return { number: token.value }; }
    if (token.type === '(') { at += 1; const inner = additive(); take(')'); return inner; }
    if (token.type === 'name') {
      at += 1;
      if (peek()?.type === '(') {
        if (!FUNCTIONS.has(token.value)) throw new ValueError(`no function "${token.value}"`);
        at += 1;
        const args = [];
        if (peek()?.type !== ')') {
          args.push(additive());
          while (peek()?.type === ',') { at += 1; args.push(additive()); }
        }
        take(')');
        return { call: token.value, args };
      }
      return { name: token.value };
    }
    throw new ValueError(`unexpected "${token.type}"`);
  };

  const tree = additive();
  if (at < tokens.length) throw new ValueError(`unexpected "${tokens[at].value ?? tokens[at].type}"`);
  return tree;
}

// ─── Working it out ─────────────────────────────────────────────────

const num = (value) => ({ type: 'number', value });
const text = (value) => ({ type: 'string', value: String(value) });
const date = (value, time) => ({ type: 'date', value, time });

function startOfDay(at) {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** A date moved by `amount` units; a month or a year later keeps the day, or the month's last. */
function shift(at, amount, unit) {
  const d = new Date(at);
  const ms = { second: 1e3, minute: 6e4, hour: 36e5 }[unit];
  if (ms) return new Date(d.getTime() + amount * ms);
  if (unit === 'day' || unit === 'week') {
    d.setDate(d.getDate() + amount * (unit === 'week' ? 7 : 1));
    return d;
  }
  const months = amount * (unit === 'year' ? 12 : 1);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d;
}

function asNumber(value, what) {
  if (value.type === 'number') return value.value;
  if (value.type === 'string' && NUMERIC.test(value.value.trim())) return Number(value.value);
  throw new ValueError(`${what} is not a number`);
}

function evaluate(node, context) {
  if ('number' in node) return num(node.number);
  if ('name' in node) return named(node.name, context);
  if ('row' in node) {
    const dataset = evaluate(node.of, context);
    if (dataset.type !== 'dataset') throw new ValueError('[…] picks a row of a dataset: utilisateurs[2]');
    const number = asNumber(evaluate(node.row, context), 'a row');
    const row = dataset.rows[number - 1];
    if (!row) throw new ValueError(`${dataset.name} has ${dataset.rows.length} row(s), numbered from 1: no row ${number}`);
    return { type: 'row', row, name: dataset.name };
  }
  if ('column' in node) {
    const row = evaluate(node.of, context);
    if (row.type !== 'row') throw new ValueError(`.${node.column} reads a column of a row: utilisateurs[2].${node.column}`);
    if (!(node.column in row.row)) throw new ValueError(`${row.name} has no column "${node.column}" (it has ${Object.keys(row.row).join(', ')})`);
    return text(row.row[node.column]);
  }
  if ('duration' in node) {
    const amount = evaluate(node.duration, context);
    return { type: 'duration', amount: asNumber(amount, 'a duration'), unit: node.unit };
  }
  if ('call' in node) return call(node.call, node.args.map((arg) => evaluate(arg, context)));

  const left = evaluate(node.left, context);
  if (node.op === 'neg') return left.type === 'duration' ? { ...left, amount: -left.amount } : num(-asNumber(left, 'it'));
  const right = evaluate(node.right, context);
  if (left.type === 'date' && right.type === 'duration' && '+-'.includes(node.op)) {
    return date(shift(left.value, node.op === '+' ? right.amount : -right.amount, right.unit), left.time || ['hour', 'minute', 'second'].includes(right.unit));
  }
  if (left.type === 'duration' && right.type === 'date' && node.op === '+') {
    return date(shift(right.value, left.amount, left.unit), right.time);
  }
  if (left.type === 'date' && right.type === 'date' && node.op === '-') {
    return num(Math.round((startOfDay(left.value) - startOfDay(right.value)) / 864e5));
  }
  if (left.type === 'date' || right.type === 'date' || left.type === 'duration' || right.type === 'duration') {
    throw new ValueError(`a date takes + or - a duration (3 days), or - another date`);
  }
  const numeric = (v) => v.type === 'number' || NUMERIC.test(v.value.trim());
  if (node.op === '+' && !(numeric(left) && numeric(right))) return text(format(left) + format(right));
  const a = asNumber(left, 'the left side');
  const b = asNumber(right, 'the right side');
  switch (node.op) {
    case '+': return num(a + b);
    case '-': return num(a - b);
    case '*': return num(a * b);
    case '/': if (b === 0) throw new ValueError('a division by zero'); return num(a / b);
    default: return num(a % b);
  }
}

function named(name, context) {
  // A variable of the test comes first: one named "today" is that variable.
  const variable = context.lookup(name);
  if (variable !== undefined) return text(variable);
  const rows = context.datasets?.(name);
  if (rows) return { type: 'dataset', rows, name };
  const now = context.now;
  switch (name) {
    case 'today': return date(startOfDay(now), false);
    case 'tomorrow': return date(shift(startOfDay(now), 1, 'day'), false);
    case 'yesterday': return date(shift(startOfDay(now), -1, 'day'), false);
    case 'now': return date(new Date(now), true);
    case 'timestamp': return num(new Date(now).getTime());
    case 'uuid': return text(context.uuid());
    case 'unique': return text(context.unique());
    default: throw new ValueError(`nothing is named "${name}"`);
  }
}

function call(name, args) {
  const n = (i) => asNumber(args[i] ?? num(0), `argument ${i + 1} of ${name}`);
  switch (name) {
    case 'random': {
      const low = Math.ceil(n(0));
      const high = Math.floor(args.length > 1 ? n(1) : n(0));
      if (high < low) throw new ValueError('random(min, max) needs min ≤ max');
      return num(low + Math.floor(Math.random() * (high - low + 1)));
    }
    case 'round': { const f = 10 ** (args.length > 1 ? n(1) : 0); return num(Math.round(n(0) * f) / f); }
    case 'floor': return num(Math.floor(n(0)));
    case 'ceil': return num(Math.ceil(n(0)));
    case 'abs': return num(Math.abs(n(0)));
    case 'min': return num(Math.min(...args.map((_, i) => n(i))));
    default: return num(Math.max(...args.map((_, i) => n(i))));
  }
}

// ─── Writing it ─────────────────────────────────────────────────────

const pad = (value, size = 2) => String(value).padStart(size, '0');
const LOCALES = { fr: 'fr-FR', en: 'en-US' };

function formatDate(d, pattern, language) {
  const locale = LOCALES[language] ?? 'en-US';
  const name = (options) => new Intl.DateTimeFormat(locale, options).format(d);
  return pattern.replace(/yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|HH|H|mm|ss|'[^']*'/g, (token) => {
    switch (token) {
      case 'yyyy': return String(d.getFullYear());
      case 'yy': return pad(d.getFullYear() % 100);
      case 'MMMM': return name({ month: 'long' });
      case 'MMM': return name({ month: 'short' });
      case 'MM': return pad(d.getMonth() + 1);
      case 'M': return String(d.getMonth() + 1);
      case 'dd': return pad(d.getDate());
      case 'd': return String(d.getDate());
      case 'EEEE': return name({ weekday: 'long' });
      case 'EEE': return name({ weekday: 'short' });
      case 'HH': return pad(d.getHours());
      case 'H': return String(d.getHours());
      case 'mm': return pad(d.getMinutes());
      case 'ss': return pad(d.getSeconds());
      default: return token.slice(1, -1);
    }
  });
}

function format(value, pattern = '', language = 'en') {
  if (value.type === 'date') return formatDate(value.value, pattern || (value.time ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd'), language);
  if (value.type === 'duration') throw new ValueError('a duration alone is no value: add it to a date');
  if (value.type === 'dataset' || value.type === 'row') throw new ValueError(`${value.name} is a dataset: pick a row and a column, ${value.name}[1].column`);
  if (value.type === 'number') {
    const decimals = /^0(?:[.,](0+))?$/.exec(pattern.trim());
    if (decimals) {
      const fixed = value.value.toFixed(decimals[1]?.length ?? 0);
      return pattern.includes(',') ? fixed.replace('.', ',') : fixed;
    }
    return String(Number(value.value.toFixed(10)));
  }
  return value.value;
}

// ─── Templates ──────────────────────────────────────────────────────

/** Whether the inside of {{…}} is an expression, not just the name of a variable. */
const isExpression = (inner) => !NAME.test(inner) || KEYWORDS.has(inner);

/** Whether `text` holds a computed value: {{today}}, {{price * 2}}, not just {{name}}. */
export function hasExpression(textValue) {
  for (const [, inner] of String(textValue ?? '').matchAll(TEMPLATE)) if (isExpression(inner)) return true;
  return false;
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r % 4) + 8).toString(16);
  });
}

/**
 * What one run computes values with: the moment it started, its language, and what it already
 * worked out (the same expression gives the same value all through the run). `datasets(name)`:
 * the rows of a dataset of the project.
 */
export function valueContext({ now = new Date(), language = 'en', lookup = () => undefined, datasets = () => undefined } = {}) {
  let token = null;
  return {
    now, language, lookup, datasets, cache: new Map(), uuid,
    unique: () => (token ??= (Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6))),
  };
}

/**
 * `text` with its {{expressions}} worked out: { text, problems }. A {{name}} of a variable is
 * its value; one nothing is named after is left as it is. An expression that does not work
 * out is left as it is too, and told in `problems` ("{{todya}}: nothing is named "todya"").
 * `escape` is applied to each value put in (to write it inside JSON, say). One using a name in
 * `waiting` is left for later, untold.
 */
export function resolveValues(textValue, context = valueContext(), { escape = (v) => v, waiting = new Set() } = {}) {
  const problems = [];
  const out = String(textValue ?? '').replace(TEMPLATE, (whole, inner) => {
    const [source, ...rest] = inner.split('|');
    const pattern = rest.join('|').trim();
    const plain = source.trim();
    // Using a variable a step keeps later in the run (lib/server-steps.js): worked out then.
    if ((plain.match(/[A-Za-z_]\w*/g) ?? []).some((name) => waiting.has(name))) return whole;
    if (NAME.test(plain) && !pattern) {
      const variable = context.lookup(plain);
      if (variable !== undefined) return escape(variable);
      if (!KEYWORDS.has(plain)) return whole;
    }
    const key = `${plain}|${pattern}`;
    if (!context.cache.has(key)) {
      try {
        context.cache.set(key, format(evaluate(parse(plain), context), pattern, context.language));
      } catch (err) {
        if (!(err instanceof ValueError)) throw err;
        problems.push(`${whole}: ${err.message}`);
        return whole;
      }
    }
    return escape(context.cache.get(key));
  });
  return { text: out, problems };
}

/**
 * The variables of a test with their values worked out: { values, problems }. A variable may
 * use another one ({{price * quantity}}); one that would use itself, round and round, is told.
 */
export function computeVariables(raw, { now = new Date(), language = 'en', datasets } = {}) {
  const values = {};
  const problems = [];
  const busy = new Set();
  const context = valueContext({ now, language, datasets, lookup: (name) => valueOf(name) });

  function valueOf(name) {
    if (!(name in raw)) return undefined;
    if (name in values) return values[name];
    if (busy.has(name)) {
      problems.push(`{{${name}}} uses itself`);
      return '';
    }
    busy.add(name);
    const { text: worked, problems: found } = resolveValues(String(raw[name] ?? ''), context);
    busy.delete(name);
    problems.push(...found.map((p) => `{{${name}}} — ${p}`));
    values[name] = worked;
    return worked;
  }

  for (const name of Object.keys(raw)) valueOf(name);
  return { values, problems, context };
}

/**
 * The value at `path` in an answer read as JSON: "id", "data.items[0].id", "$.user.email"; an
 * object or a list as JSON text. Undefined when the answer has nothing there.
 */
export function pathValue(data, path) {
  const parts = String(path ?? '').replace(/^\$\.?/, '').match(/[^.[\]]+|\[\d+\]/g) ?? [];
  let at = data;
  for (const part of parts) {
    if (at == null) return undefined;
    at = at[/^\[\d+\]$/.test(part) ? Number(part.slice(1, -1)) : part];
  }
  if (at === undefined) return undefined;
  return at !== null && typeof at === 'object' ? JSON.stringify(at) : String(at);
}

/** The part of `text` a regular expression picks: its first group, or all it matched; all of it without one. */
export function pick(text, pattern) {
  if (!pattern) return text;
  const match = new RegExp(pattern).exec(text);
  if (!match) throw new Error(`"${pattern}" is not in "${String(text).slice(0, 120)}"`);
  return match[1] ?? match[0];
}

/**
 * In exported Playwright code: the value at `path` of the answer to the last request of the page
 * whose URL holds `url` (`answers`: the page's responses, as page.on('response') gives them), or
 * its whole body without a path; waited for, up to 10 s, when the page has not had it yet.
 */
export async function answerTo(answers, url, path = null, method = null) {
  for (const deadline = Date.now() + 10_000; ;) {
    const answer = answers.findLast((r) => r.url().includes(url) && (!method || r.request().method() === method));
    if (answer) {
      const body = await answer.text();
      if (!path) return body;
      const found = pathValue(JSON.parse(body), path);
      if (found === undefined) throw new Error(`The answer to ${answer.url()} has nothing at "${path}"`);
      return found;
    }
    if (Date.now() > deadline) throw new Error(`The page made no request to "${url}"`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}
