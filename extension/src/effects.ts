// What a click changed, in a few lines an agent can act on.
//
// A click answered "success" and nothing else: on idealo, a click opened a warning dialog
// inside an iframe, and the agent only learnt it by taking a screenshot. Now every frame of
// the tab notes, just before the click, its address and which panels are visible (dialogs,
// menus, banners, overlays…) and watches its DOM; after the click each frame reports what
// appeared, what went away and what expanded, and the tab what it navigated to.
//
// The two injected functions are serialised by chrome.scripting: everything they use has to
// be defined inside them.

import { TOP_FRAME } from './helpers';

interface FrameEffects {
  /** False when the frame holds a new document since armEffects: it navigated or reloaded. */
  armed: boolean;
  url: string;
  title: string;
  appeared: string[];
  disappeared: string[];
  expanded: string[];
}

export interface EffectsWatch {
  /** Stop watching and describe what changed. */
  collect(): Promise<string[]>;
}

const NO_CHANGE =
  'no visible change detected right away (the page may still be reacting — check with snapshot if the click should have done something)';
const MAX_LINES = 8;

/** Start watching every frame of the tab. Call it right before the click. */
export async function armEffects(tabId: number): Promise<EffectsWatch> {
  const token = crypto.randomUUID();
  const before = await chrome.tabs.get(tabId).catch(() => null);
  const armed = await withTimeout(
    chrome.scripting.executeScript({ target: { tabId, allFrames: true }, injectImmediately: true, func: armInPage, args: [token] }),
    ARM_TIMEOUT_MS
  );
  const armedFrames = new Map((armed ?? []).map((r) => [r.frameId, String(r.result ?? '')]));

  // The tab starting to load another page: nothing more to wait for on this one.
  let navigated = false;
  let onNavigation: () => void = () => {};
  const navigation = new Promise<null>((resolve) => { onNavigation = () => resolve(null); });
  const onUpdated = (id: number, change: chrome.tabs.TabChangeInfo) => {
    if (id !== tabId || change.status !== 'loading') return;
    navigated = true;
    onNavigation();
  };
  chrome.tabs.onUpdated.addListener(onUpdated);

  return {
    async collect() {
      // Bounded: while the tab navigates, an injection can wait on a document that is being
      // replaced — a click on a Wikipedia link waited out the whole 30 s command timeout.
      const results = await Promise.race([
        withTimeout(
          chrome.scripting.executeScript({
            // Immediately: a click that navigates would otherwise wait for the next page to load.
            target: { tabId, allFrames: true }, injectImmediately: true, func: collectInPage, args: [token],
          }),
          COLLECT_TIMEOUT_MS
        ),
        navigation,
      ]);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      const after = await chrome.tabs.get(tabId).catch(() => null);
      const frames = (results ?? []).map((r) => ({ frameId: r.frameId, effects: r.result as FrameEffects | null }));
      return describeEffects(before, after, armedFrames, frames, navigated);
    },
  };
}

const ARM_TIMEOUT_MS = 1000;
// collectInPage waits up to 1.2 s for the DOM to settle.
const COLLECT_TIMEOUT_MS = 2000;

/** The promise's value, or null when it fails or takes longer than `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); }
    );
  });
}

function describeEffects(
  before: chrome.tabs.Tab | null,
  after: chrome.tabs.Tab | null,
  armedFrames: Map<number, string>,
  frames: { frameId: number; effects: FrameEffects | null }[],
  navigated: boolean
): string[] {
  const lines: string[] = [];
  const top = frames.find((f) => f.frameId === TOP_FRAME)?.effects;
  const urlBefore = before?.url ?? armedFrames.get(TOP_FRAME) ?? '';
  const urlAfter = after?.pendingUrl || after?.url || top?.url || '';

  // Same page only when the page that was watched is still the one there (pushState). The
  // watched page can answer just before it is replaced, so the tab has a say too: a pending
  // URL, or a load that started after the click, is a navigation.
  const loadStarted = !!after?.pendingUrl || (after?.status === 'loading' && before?.status === 'complete');
  const samePage = !navigated && !loadStarted && !!top?.armed;
  if (urlAfter && urlAfter !== urlBefore) {
    const loading = after?.status === 'loading' ? ' (still loading)' : '';
    lines.push(`${samePage ? 'URL changed (same page)' : 'navigated'}: ${urlBefore} → ${urlAfter}${loading}`);
  } else if (navigated || loadStarted || (top && !top.armed)) {
    lines.push('the page reloaded');
  }
  if (before?.title && after?.title && after.title !== before.title && after.status !== 'loading') {
    lines.push(`title: "${before.title}" → "${after.title}"`);
  }

  for (const { frameId, effects } of navigated || loadStarted ? [] : frames) {
    if (!effects) continue;
    const where = frameId === TOP_FRAME ? '' : `in iframe ${shortUrl(effects.url)}: `;
    if (frameId !== TOP_FRAME && !effects.armed) {
      if (armedFrames.has(frameId)) lines.push(`iframe ${shortUrl(armedFrames.get(frameId)!)} navigated to ${shortUrl(effects.url)}`);
      continue;
    }
    if (!effects.armed) continue;
    for (const d of effects.appeared) lines.push(`${where}appeared: ${d}`);
    for (const d of effects.expanded) lines.push(`${where}expanded: ${d}`);
    for (const d of effects.disappeared) lines.push(`${where}disappeared: ${d}`);
  }

  if (lines.length === 0) return [NO_CHANGE];
  if (lines.length > MAX_LINES) {
    const more = lines.length - MAX_LINES;
    return [...lines.slice(0, MAX_LINES), `…and ${more} more change${more > 1 ? 's' : ''} (snapshot shows the page as it is now)`];
  }
  return lines;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 40 ? u.pathname.slice(0, 40) + '…' : u.pathname;
    return u.host + (path === '/' ? '' : path);
  } catch {
    return url.slice(0, 60);
  }
}

// ─── In the page ─────────────────────────────────────────────────────

interface PageWatch {
  token: string;
  visibleBefore: WeakSet<Element>;
  beforeList: Element[];
  added: Element[];
  expanded: Element[];
  lastMutation: number;
  observer: MutationObserver;
}

/** Note what is visible now, and watch the DOM. Returns the frame's URL. */
function armInPage(token: string): string {
  const w = window as unknown as { __izitestEffects?: PageWatch };
  w.__izitestEffects?.observer.disconnect();

  // Panels that show and hide: what a click usually opens or closes.
  const PANELS = [
    'dialog', '[role=dialog]', '[role=alertdialog]', '[aria-modal=true]', '[role=alert]', '[role=status]',
    '[role=menu]', '[role=listbox]', '[role=tooltip]', '[role=tabpanel]', '[popover]', 'details',
    '[class*=modal i]', '[class*=popup i]', '[class*=popover i]', '[class*=dropdown i]', '[class*=menu i]',
    '[class*=overlay i]', '[class*=drawer i]', '[class*=dialog i]', '[class*=toast i]', '[class*=flyout i]',
    '[class*=banner i]', '[class*=consent i]', '[class*=cookie i]', '[class*=layer i]', '[class*=panel i]',
  ].join(',');
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true);
  };

  const panels = Array.from(document.querySelectorAll(PANELS)).slice(0, 3000);
  const beforeList = panels.filter(visible);
  const watch: PageWatch = {
    token,
    visibleBefore: new WeakSet(beforeList),
    beforeList,
    added: [],
    expanded: [],
    lastMutation: 0,
    observer: new MutationObserver((records) => {
      watch.lastMutation = performance.now();
      for (const rec of records) {
        if (rec.type === 'childList') {
          for (const node of rec.addedNodes) {
            if (node.nodeType === 1 && watch.added.length < 300) watch.added.push(node as Element);
          }
        } else if (rec.attributeName === 'aria-expanded' && rec.oldValue !== 'true') {
          const el = rec.target as Element;
          if (el.getAttribute('aria-expanded') === 'true' && !watch.expanded.includes(el)) watch.expanded.push(el);
        }
      }
    }),
  };
  watch.observer.observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['aria-expanded'], attributeOldValue: true,
  });
  w.__izitestEffects = watch;
  return location.href;
}

/** Wait for the DOM to settle, then say what appeared, expanded and went away. */
async function collectInPage(token: string): Promise<FrameEffects> {
  const w = window as unknown as { __izitestEffects?: PageWatch };
  const watch = w.__izitestEffects;
  const base = { url: location.href, title: document.title, appeared: [], disappeared: [], expanded: [] };
  if (!watch || watch.token !== token) return { ...base, armed: false };

  // Let a dialog finish appearing: wait until nothing has changed for a moment.
  const QUIET_MS = 250;
  const MAX_WAIT_MS = 1200;
  const start = performance.now();
  while (performance.now() - start < MAX_WAIT_MS && performance.now() - watch.lastMutation < QUIET_MS) {
    await new Promise((r) => setTimeout(r, 50));
  }
  watch.observer.disconnect();
  delete w.__izitestEffects;

  const PANELS = [
    'dialog', '[role=dialog]', '[role=alertdialog]', '[aria-modal=true]', '[role=alert]', '[role=status]',
    '[role=menu]', '[role=listbox]', '[role=tooltip]', '[role=tabpanel]', '[popover]', 'details',
    '[class*=modal i]', '[class*=popup i]', '[class*=popover i]', '[class*=dropdown i]', '[class*=menu i]',
    '[class*=overlay i]', '[class*=drawer i]', '[class*=dialog i]', '[class*=toast i]', '[class*=flyout i]',
    '[class*=banner i]', '[class*=consent i]', '[class*=cookie i]', '[class*=layer i]', '[class*=panel i]',
  ].join(',');
  const visible = (el: Element) => {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true);
  };
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const ours = (el: Element) => el.tagName.toLowerCase().startsWith('izitest-agent');
  const TAG_ROLES: Record<string, string> = {
    DIALOG: 'dialog', DETAILS: 'details', NAV: 'navigation', FORM: 'form', UL: 'list', OL: 'list',
    ASIDE: 'aside', SECTION: 'section', HEADER: 'header', FOOTER: 'footer', IFRAME: 'iframe',
  };
  const describe = (el: Element, live: boolean): string => {
    const role = el.getAttribute('role') || TAG_ROLES[el.tagName] || el.tagName.toLowerCase();
    const labelledBy = el.getAttribute('aria-labelledby');
    const heading = el.querySelector('h1,h2,h3,h4,[role=heading]');
    const text = live ? (el as HTMLElement).innerText : el.textContent;
    const name = clean(el.getAttribute('aria-label'))
      || clean(labelledBy ? document.getElementById(labelledBy)?.textContent : '')
      || clean(heading?.textContent)
      || clean(text);
    let line = `${role} "${cut(name, 90)}"`;
    if (live) {
      const buttons = Array.from(el.querySelectorAll('button,[role=button],a[href],input[type=submit],input[type=button]'))
        .filter(visible)
        .map((b) => clean((b as HTMLElement).innerText || (b as HTMLInputElement).value || b.getAttribute('aria-label')))
        .filter(Boolean);
      const unique = [...new Set(buttons)];
      if (unique.length) line += ` — buttons: ${unique.slice(0, 5).map((b) => cut(b, 30)).join(', ')}${unique.length > 5 ? ', …' : ''}`;
    }
    return line;
  };
  const hasContent = (el: Element) =>
    clean((el as HTMLElement).innerText).length > 1 || !!el.querySelector('button,a[href],input,select,textarea,iframe,img');
  /** Keep the outermost ones only: a dialog, not also every block inside it. */
  const outermost = (els: Element[]) => els.filter((el) => !els.some((other) => other !== el && other.contains(el)));

  const panelsNow = Array.from(document.querySelectorAll(PANELS)).slice(0, 3000);
  const appearedCandidates = [
    ...panelsNow.filter((el) => !watch.visibleBefore.has(el)),
    ...watch.added.filter((el) => el.isConnected),
  ].filter((el) => !ours(el) && visible(el) && hasContent(el));
  const appeared = outermost([...new Set(appearedCandidates)]).slice(0, 4).map((el) => describe(el, true));

  const gone = outermost(watch.beforeList.filter((el) => !ours(el) && !visible(el)))
    .filter((el) => clean(el.textContent).length > 1)
    .slice(0, 3)
    .map((el) => describe(el, false));

  const expanded = watch.expanded.filter((el) => el.isConnected).slice(0, 3).map((el) => {
    const name = clean(el.getAttribute('aria-label')) || clean((el as HTMLElement).innerText);
    return `${el.getAttribute('role') || el.tagName.toLowerCase()} "${cut(name, 60)}"`;
  });

  return { ...base, armed: true, appeared, disappeared: gone, expanded };
}
