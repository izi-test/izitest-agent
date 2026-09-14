export type SnapshotPurpose = 'fill' | 'click' | 'read';

export interface SnapshotOptions {
  interactiveOnly?: boolean;
  compact?: boolean;
  maxDepth?: number;
  scope?: string | null;
  format?: 'text' | 'json';
  maxTextLength?: number;
  includeHidden?: boolean;
  includeRects?: boolean;
  inlineFrames?: boolean;
  purposeFilter?: SnapshotPurpose;
  searchText?: string;
}

export interface Locator {
  type: string;
  value: string;
}

export interface RefNodeInfo {
  role: string;
  name: string;
  level?: number;
  selector?: string;
  locators?: Locator[];
  rect?: { x: number; y: number; w: number; h: number };
}

export interface SnapshotResult {
  url: string;
  title: string;
  timestamp: number;
  refs?: Record<string, RefNodeInfo>;
  tree: string;
}

// Global store for the current snapshot refs
declare global {
  interface Window {
    __browserPilotRefMap?: Map<string, Element>;
  }
}

function initRefMap() {
  if (!window.__browserPilotRefMap) {
    window.__browserPilotRefMap = new Map();
  } else {
    window.__browserPilotRefMap.clear();
  }
}

export async function resolveRef(ref: string): Promise<{ x: number; y: number; tag: string; text: string } | null> {
  const el = window.__browserPilotRefMap?.get(ref);
  if (!el) return null;

  // Check if the element is already visible in the viewport — avoid
  // scrollIntoView for dropdown/overlay items that are already on screen,
  // because scrolling the page can displace absolutely-positioned overlays.
  let rect = el.getBoundingClientRect();
  const inViewport =
    rect.width > 0 &&
    rect.height > 0 &&
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= window.innerHeight &&
    rect.right <= window.innerWidth;

  if (!inViewport) {
    (el as HTMLElement).scrollIntoView({ behavior: 'instant', block: 'center' });
    // Wait for layout to settle after scrolling
    await new Promise(r => setTimeout(r, 50));
    rect = el.getBoundingClientRect();
  }

  if (rect.width === 0 || rect.height === 0) return null;

  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
    tag: el.tagName.toLowerCase(),
    text: el.textContent?.slice(0, 50) || ''
  };
}

export function drawAnnotations() {
  clearAnnotations();

  // Use a Shadow DOM host to completely isolate annotations from the page's CSS.
  // Sites like lacentrale.fr have aggressive CSS rules (resets, flex overrides,
  // overflow:hidden) that break plain div overlays.
  const host = document.createElement('browser-pilot-annotations');
  host.id = 'browser-pilot-annotations';
  // Host styles must use !important to resist page-level CSS on custom elements
  host.style.cssText = [
    'position: fixed !important',
    'top: 0 !important',
    'left: 0 !important',
    'width: 100vw !important',
    'height: 100vh !important',
    'pointer-events: none !important',
    'z-index: 2147483647 !important',
    'display: block !important',
    'overflow: visible !important',
    'opacity: 1 !important',
    'visibility: visible !important',
    'transform: none !important',
    'margin: 0 !important',
    'padding: 0 !important',
  ].join('; ');

  const shadow = host.attachShadow({ mode: 'open' });

  // All styles scoped inside the shadow — immune to the page's CSS
  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial !important;
      position: fixed !important;
      top: 0 !important; left: 0 !important;
      width: 100vw !important; height: 100vh !important;
      pointer-events: none !important;
      z-index: 2147483647 !important;
    }
    .bp-box {
      position: absolute;
      border: 2px solid #ef4444;
      box-sizing: border-box;
      pointer-events: none;
    }
    .bp-label {
      position: absolute;
      background: #ef4444;
      color: #fff;
      padding: 1px 4px;
      font: bold 12px/1.2 monospace;
      border-radius: 3px;
      border: 1px solid #fff;
      white-space: nowrap;
      z-index: 1;
    }
    .bp-banner {
      position: absolute;
      top: 10px; left: 10px;
      padding: 5px 10px;
      background: #7c3aed;
      color: #fff;
      font: bold 12px/1.4 monospace;
      border-radius: 4px;
      z-index: 2;
    }
  `;
  shadow.appendChild(style);

  const refMap = window.__browserPilotRefMap || new Map();
  refMap.forEach((el, ref) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) return;

    const box = document.createElement('div');
    box.className = 'bp-box';
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    shadow.appendChild(box);

    const label = document.createElement('div');
    label.className = 'bp-label';
    label.style.left = `${Math.max(0, rect.left)}px`;
    label.style.top = `${Math.max(0, rect.top)}px`;
    label.textContent = ref;
    shadow.appendChild(label);
  });

  const banner = document.createElement('div');
  banner.className = 'bp-banner';
  banner.textContent = `IziTest Agent: ${refMap.size} refs`;
  shadow.appendChild(banner);

  document.documentElement.appendChild(host);
}

export function clearAnnotations() {
  const el = document.getElementById('browser-pilot-annotations');
  if (el) el.remove();
}

const FILLABLE_ROLES = new Set([
  'textbox', 'combobox', 'listbox', 'checkbox', 'radio', 'slider',
  'spinbutton', 'searchbox', 'switch'
]);

const CLICKABLE_ROLES = new Set([
  'link', 'button', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'option', 'treeitem', 'switch', 'gridcell'
]);

function matchesPurposeFilter(role: string, tag: string, purpose: SnapshotPurpose | undefined): boolean {
  if (!purpose || purpose === 'read') return true;
  if (purpose === 'fill') {
    if (FILLABLE_ROLES.has(role)) return true;
    // Include <select> even though its role may resolve to 'combobox' or 'listbox'
    if (['input', 'textarea', 'select'].includes(tag)) return true;
    // Include form/region containers so there's structural context around fields
    if (['form', 'region', 'group', 'search'].includes(role)) return true;
    return false;
  }
  if (purpose === 'click') {
    if (CLICKABLE_ROLES.has(role)) return true;
    if (['a', 'button', 'summary', 'details'].includes(tag)) return true;
    return false;
  }
  return true;
}

export function buildSnapshot(providedOptions: SnapshotOptions = {}): SnapshotResult {
  const options = {
    interactiveOnly: false,
    compact: false,
    maxDepth: 50,
    scope: null,
    format: 'text',
    maxTextLength: 80,
    includeHidden: false,
    includeRects: false,
    inlineFrames: true,
    ...providedOptions
  };

  initRefMap();
  const refMap = window.__browserPilotRefMap!;
  let refCounter = 1;
  const jsonRefs: Record<string, RefNodeInfo> = {};

  const truncate = (text: string) => {
    if (!text) return '';
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length > options.maxTextLength!) {
      return clean.slice(0, options.maxTextLength! - 3) + '...';
    }
    return clean;
  };

  const isCustomElement = (tag: string): boolean => tag.includes('-');

  // Returns true when the element AND all descendants are truly not rendered.
  // Only display:none guarantees that children cannot be visible.
  const isSubtreeHidden = (el: Element): boolean => {
    const style = window.getComputedStyle(el);
    return style.display === 'none';
  };

  // Returns true when the element itself appears visible.
  // When false, the element node is skipped but children are still traversed
  // because wrappers with aria-hidden, opacity:0, visibility:hidden, or zero
  // dimensions can still contain visually-visible children (drawers, modals,
  // CSS transitions, overflow:visible containers).
  const isVisible = (el: Element): boolean => {
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    if (rect.width === 0 || rect.height === 0) {
      if (style.display === 'contents') {
        // Elements with display: contents have a 0x0 rect, but render children normally.
      } else if (isCustomElement(tag) || el.shadowRoot) {
        // Custom elements (Angular, Web Components) may have 0x0 host dimensions
        // but render visible children — treat as visible to traverse them.
      } else if (el.tagName !== 'A' && el.tagName !== 'SPAN' && el.tagName !== 'SVG') {
        return false;
      }
    }
    if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) {
      return false;
    }
    return true;
  };

  const getRole = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;

    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'a': return el.hasAttribute('href') ? 'link' : 'generic';
      case 'button': return 'button';
      case 'input': {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (['text', 'email', 'search', 'tel', 'url', 'password', 'number'].includes(type)) return 'textbox';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (['submit', 'reset', 'button'].includes(type)) return 'button';
        return type;
      }
      case 'select': return (el as HTMLSelectElement).size <= 1 ? 'combobox' : 'listbox';
      case 'textarea': return 'textbox';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'ul': case 'ol': return 'list';
      case 'li': return 'listitem';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'header': // Simplified: usually banner if top level
        return 'banner';
      case 'footer': 
        return 'contentinfo';
      case 'aside': return 'complementary';
      case 'section':
      case 'form': 
        if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) return tag === 'form' ? 'form' : 'region';
        return 'generic';
      case 'p': return 'paragraph';
      case 'table': return 'table';
      case 'img': return el.hasAttribute('alt') ? 'img' : 'presentation';
      case 'dialog': return 'dialog';
      case 'details': return 'group';
      case 'summary': return 'button';
      default: return 'generic';
    }
  };

  const getAccessibleName = (el: Element): string => {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const parts = labelledby.split(/\s+/).map(id => document.getElementById(id)?.textContent?.trim() || '');
      const str = parts.filter(Boolean).join(' ');
      if (str) return str;
    }

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;

    // Explicit label: <label for="id">
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label && label.textContent) return label.textContent.trim();
    }

    // Implicit label: <label><input ...> text</label>
    // W3C spec: an input nested inside a label inherits the label's text as its accessible name
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const parentLabel = el.closest('label');
      if (parentLabel) {
        // Collect text from the label excluding the input element itself
        let labelText = '';
        for (const child of parentLabel.childNodes) {
          if (child === el) continue;
          if (child.nodeType === Node.TEXT_NODE) {
            labelText += child.textContent || '';
          } else if (child.nodeType === Node.ELEMENT_NODE && child !== el) {
            labelText += (child as Element).textContent || '';
          }
        }
        labelText = labelText.replace(/\s+/g, ' ').trim();
        if (labelText) return labelText;
      }
    }

    const htmlEl = el as HTMLElement;
    if (el.tagName === 'IMG') return (el as HTMLImageElement).alt || htmlEl.title || '';
    if (htmlEl.title) return htmlEl.title;

    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return placeholder;
      const val = (el as HTMLInputElement).value;
      if (val) return val;
    }

    // Check direct text nodes first (to avoid grabbing massive child text globally)
    let directText = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
        directText += child.textContent.trim() + ' ';
      }
    }
    
    if (directText.trim()) return directText.trim();

    // Check if it's specifically an interactive role where we deeply want the text
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    const isActivable = ['a', 'button'].includes(tag) || ['button', 'link', 'menuitem', 'tab', 'option', 'switch', 'checkbox', 'radio', 'treeitem'].includes(role) || el.hasAttribute('onclick');

    if (isActivable) {
      const fullText = el.textContent?.trim() || '';
      if (fullText) return fullText.replace(/\s+/g, ' ');

      // If no text, check for images or SVGs inside that might serve as the icon name
      const img = el.querySelector('img[alt]');
      if (img) return img.getAttribute('alt')?.trim() || '';
      
      const svg = el.querySelector('svg title');
      if (svg) return svg.textContent?.trim() || '';
    }
    
    return '';
  };

  const isInteractiveRole = (role: string, tag: string) => {
    const interactiveRoles = ['link', 'button', 'textbox', 'checkbox', 'radio', 'slider', 'combobox', 'listbox', 'search', 'menuitem', 'tab', 'option', 'treeitem', 'switch', 'gridcell'];
    if (interactiveRoles.includes(role)) return true;
    if (['select', 'textarea', 'input', 'button', 'a'].includes(tag)) return true;
    return false;
  };

  const isDynamicId = (id: string): boolean => {
    if (/react-aria|radix-|ember|ng-|_r_|rc-|headlessui-/i.test(id)) return true;
    if (/\d{4,}/.test(id)) return true;
    if (/^[a-f0-9-]{8,}$/i.test(id)) return true;
    if (/^:.*:$/.test(id)) return true;
    return false;
  };

  // ── Dynamic class detection ──────────────────────────────────────────
  const isDynamicClass = (cls: string): boolean => {
    // Tailwind/utility — these are fine, but single-char or hash-based are not
    if (/^[a-z]{1,2}\d+$/i.test(cls)) return true;           // e.g. "a0", "b12"
    if (/^_/.test(cls)) return true;                          // CSS modules: _1a2b3c
    if (/^css-/.test(cls)) return true;                       // Emotion: css-1a2b3c
    if (/^sc-/.test(cls)) return true;                        // styled-components
    if (/^styles?_/.test(cls)) return true;                   // CSS modules variant
    if (/[A-Za-z0-9]{6,}$/.test(cls) && /[_-]/.test(cls) && /\d/.test(cls)) return true; // hash suffix
    if (/^[a-f0-9]{5,}$/i.test(cls)) return true;            // pure hex hashes
    if (/^jsx-\d+$/.test(cls)) return true;                   // styled-jsx
    if (/^go\d+$/.test(cls)) return true;                     // Goober
    return false;
  };

  // ── Uniqueness helpers ───────────────────────────────────────────────
  const isUniqueCSS = (selector: string): boolean => {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch { return false; }
  };

  const isUniqueXPath = (xpath: string): boolean => {
    try {
      const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return result.snapshotLength === 1;
    } catch { return false; }
  };

  // ── Robust CSS selector builder ──────────────────────────────────────
  // Strategy order:
  //   1. #stableId
  //   2. [data-testid="..."]
  //   3. tag[semantic-attr="value"] (name, placeholder, aria-label, alt, for, title, type+name)
  //   4. tag.stableClass (single or pair of non-dynamic classes)
  //   5. Shortest unique ancestor path (walk up, at each level try to anchor)
  //   6. Structural fallback (full child-combinator path)
  const buildSelector = (el: Element): string => {
    const tag = el.tagName.toLowerCase();

    // 1. Stable ID
    if (el.id && !isDynamicId(el.id)) return `#${CSS.escape(el.id)}`;

    // 2. data-testid / data-test-id / data-cy
    for (const attr of ['data-testid', 'data-test-id', 'data-cy']) {
      const val = el.getAttribute(attr);
      if (val) {
        const sel = `[${attr}="${CSS.escape(val)}"]`;
        if (isUniqueCSS(sel)) return sel;
      }
    }

    // 3. Semantic attribute selectors
    const semanticAttrs: Array<[string, string | null]> = [
      ['name', el.getAttribute('name')],
      ['placeholder', el.getAttribute('placeholder')],
      ['aria-label', el.getAttribute('aria-label')],
      ['alt', el.getAttribute('alt')],
      ['for', el.getAttribute('for')],
      ['title', el.getAttribute('title')],
      ['role', el.getAttribute('role')],
      ['href', tag === 'a' ? el.getAttribute('href') : null],
      ['type', tag === 'input' ? el.getAttribute('type') : null],
    ];

    for (const [attr, val] of semanticAttrs) {
      if (!val) continue;
      // For href, use startsWith match to handle long URLs
      if (attr === 'href' && val.length > 60) {
        const shortHref = CSS.escape(val.slice(0, 50));
        const sel = `${tag}[href^="${shortHref}"]`;
        if (isUniqueCSS(sel)) return sel;
        continue;
      }
      const sel = `${tag}[${attr}="${CSS.escape(val)}"]`;
      if (isUniqueCSS(sel)) return sel;
    }

    // For inputs: combine type + name for uniqueness
    if (tag === 'input') {
      const type = el.getAttribute('type');
      const nameA = el.getAttribute('name');
      if (type && nameA) {
        const sel = `input[type="${CSS.escape(type)}"][name="${CSS.escape(nameA)}"]`;
        if (isUniqueCSS(sel)) return sel;
      }
    }

    // 4. Stable class-based selectors
    const classes = Array.from(el.classList).filter(c => !isDynamicClass(c));
    if (classes.length > 0) {
      // Try single class first
      for (const cls of classes) {
        const sel = `${tag}.${CSS.escape(cls)}`;
        if (isUniqueCSS(sel)) return sel;
      }
      // Try pairs of classes
      if (classes.length >= 2) {
        for (let i = 0; i < Math.min(classes.length, 4); i++) {
          for (let j = i + 1; j < Math.min(classes.length, 5); j++) {
            const sel = `${tag}.${CSS.escape(classes[i])}.${CSS.escape(classes[j])}`;
            if (isUniqueCSS(sel)) return sel;
          }
        }
      }
    }

    // 5. Shortest unique path: walk up the tree, at each ancestor try to build
    //    a short selector that uniquely identifies the target
    {
      let target = el;
      let childPart = tag;
      // Disambiguate at target level with class or nth-of-type
      const targetClasses = classes.length > 0 ? `.${CSS.escape(classes[0])}` : '';
      if (targetClasses) {
        const withClass = `${tag}${targetClasses}`;
        if (isUniqueCSS(withClass)) return withClass;
        childPart = withClass;
      }

      let current: Element | null = el.parentElement;
      let depth = 0;
      const MAX_CLIMB = 5;

      while (current && current !== document.body && current !== document.documentElement && depth < MAX_CLIMB) {
        depth++;
        let anchorParts: string[] = [];
        const pTag = current.tagName.toLowerCase();

        // Try to anchor on ancestor's ID
        if (current.id && !isDynamicId(current.id)) {
          const sel = `#${CSS.escape(current.id)} ${childPart}`;
          if (isUniqueCSS(sel)) return sel;
          // Try with direct child combinator
          if (depth === 1) {
            const directSel = `#${CSS.escape(current.id)} > ${childPart}`;
            if (isUniqueCSS(directSel)) return directSel;
          }
        }

        // Try ancestor's data-testid
        for (const attr of ['data-testid', 'data-test-id', 'data-cy']) {
          const aVal = current.getAttribute(attr);
          if (aVal) {
            const sel = `[${attr}="${CSS.escape(aVal)}"] ${childPart}`;
            if (isUniqueCSS(sel)) return sel;
          }
        }

        // Try ancestor's semantic attributes
        const anchorAttrs: Array<[string, string | null]> = [
          ['aria-label', current.getAttribute('aria-label')],
          ['name', current.getAttribute('name')],
          ['role', current.getAttribute('role')],
        ];
        for (const [attr, val] of anchorAttrs) {
          if (!val) continue;
          const sel = `${pTag}[${attr}="${CSS.escape(val)}"] ${childPart}`;
          if (isUniqueCSS(sel)) return sel;
        }

        // Try ancestor's stable classes
        const pClasses = Array.from(current.classList).filter(c => !isDynamicClass(c));
        for (const cls of pClasses.slice(0, 3)) {
          const sel = `${pTag}.${CSS.escape(cls)} ${childPart}`;
          if (isUniqueCSS(sel)) return sel;
        }

        // Build childPart for next iteration (prepend this ancestor's tag)
        const siblings = Array.from(current.parentElement?.children || []).filter(e => e.tagName === current!.tagName);
        let anchorTag = pTag;
        if (pClasses.length > 0) {
          anchorTag = `${pTag}.${CSS.escape(pClasses[0])}`;
        } else if (siblings.length > 1) {
          anchorTag = `${pTag}:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
        childPart = `${anchorTag} > ${childPart}`;

        current = current.parentElement;
      }
    }

    // 6. Structural fallback (last resort — full path with nth-of-type)
    let current = el;
    const path: string[] = [];
    while (current && current !== document.body) {
      let part = current.tagName.toLowerCase();
      if (current.id && !isDynamicId(current.id)) {
        path.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      if (current.parentElement) {
        const siblings = Array.from(current.parentElement.children).filter(e => e.tagName === current.tagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      path.unshift(part);
      current = current.parentElement!;
    }
    return path.join(' > ');
  };

  // ── Robust XPath builder ─────────────────────────────────────────────
  // Strategy order:
  //   1. //*[@id="stableId"]
  //   2. //tag[@data-testid="..."]
  //   3. //tag[@semantic-attr="value"]
  //   4. //tag[normalize-space()="short text"] (for buttons, links, labels)
  //   5. Relative from nearest identifiable ancestor
  //   6. Positional fallback
  const buildXPath = (el: Element): string => {
    const tag = el.tagName.toLowerCase();

    // 1. Stable ID
    if (el.id && !isDynamicId(el.id) && !el.id.includes('"') && !el.id.includes("'")) {
      return `//*[@id="${el.id}"]`;
    }

    if (tag === 'html') return '/html';
    if (tag === 'body') return '/html/body';

    // 2. data-testid
    for (const attr of ['data-testid', 'data-test-id', 'data-cy']) {
      const val = el.getAttribute(attr);
      if (val && !val.includes('"')) {
        const xp = `//${tag}[@${attr}="${val}"]`;
        if (isUniqueXPath(xp)) return xp;
      }
    }

    // 3. Semantic attribute XPath
    const semanticAttrs: Array<[string, string | null]> = [
      ['name', el.getAttribute('name')],
      ['placeholder', el.getAttribute('placeholder')],
      ['aria-label', el.getAttribute('aria-label')],
      ['alt', el.getAttribute('alt')],
      ['title', el.getAttribute('title')],
      ['for', el.getAttribute('for')],
    ];

    for (const [attr, val] of semanticAttrs) {
      if (!val || val.includes('"')) continue;
      const xp = `//${tag}[@${attr}="${val}"]`;
      if (isUniqueXPath(xp)) return xp;
    }

    // For inputs: combine type + name
    if (tag === 'input') {
      const type = el.getAttribute('type');
      const nameA = el.getAttribute('name');
      if (type && nameA && !type.includes('"') && !nameA.includes('"')) {
        const xp = `//input[@type="${type}"][@name="${nameA}"]`;
        if (isUniqueXPath(xp)) return xp;
      }
    }

    // 4. Text-based XPath (only for short, stable text on interactive elements)
    const interactiveTags = ['button', 'a', 'label', 'th', 'summary', 'legend'];
    if (interactiveTags.includes(tag) || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') {
      const text = el.textContent?.trim().replace(/\s+/g, ' ');
      if (text && text.length > 0 && text.length < 60 && !text.includes('"')) {
        // Exact text match
        const xp = `//${tag}[normalize-space()="${text}"]`;
        if (isUniqueXPath(xp)) return xp;
        // Contains match for slightly longer text
        if (text.length > 20) {
          const shortText = text.slice(0, 25);
          if (!shortText.includes('"')) {
            const xpContains = `//${tag}[contains(normalize-space(),"${shortText}")]`;
            if (isUniqueXPath(xpContains)) return xpContains;
          }
        }
      }
    }

    // 5. Relative from nearest identifiable ancestor
    let ancestor: Element | null = el.parentElement;
    let relDepth = 0;
    const MAX_ANCESTOR_CLIMB = 5;

    while (ancestor && ancestor !== document.body && ancestor !== document.documentElement && relDepth < MAX_ANCESTOR_CLIMB) {
      relDepth++;
      let anchorXPath = '';
      const aTag = ancestor.tagName.toLowerCase();

      // Anchor on ID
      if (ancestor.id && !isDynamicId(ancestor.id) && !ancestor.id.includes('"')) {
        anchorXPath = `//*[@id="${ancestor.id}"]`;
      }
      // Anchor on data-testid
      if (!anchorXPath) {
        for (const attr of ['data-testid', 'data-test-id', 'data-cy']) {
          const aVal = ancestor.getAttribute(attr);
          if (aVal && !aVal.includes('"')) {
            anchorXPath = `//${aTag}[@${attr}="${aVal}"]`;
            break;
          }
        }
      }
      // Anchor on aria-label
      if (!anchorXPath) {
        const ariaL = ancestor.getAttribute('aria-label');
        if (ariaL && !ariaL.includes('"')) {
          anchorXPath = `//${aTag}[@aria-label="${ariaL}"]`;
        }
      }

      if (anchorXPath && isUniqueXPath(anchorXPath)) {
        // Try descendant axis with just the tag
        let relXp = `${anchorXPath}//${tag}`;
        if (isUniqueXPath(relXp)) return relXp;

        // Try with an attribute on the target
        for (const [attr, val] of semanticAttrs) {
          if (!val || val.includes('"')) continue;
          relXp = `${anchorXPath}//${tag}[@${attr}="${val}"]`;
          if (isUniqueXPath(relXp)) return relXp;
        }

        // Try with position among same-tag descendants
        const descendants = document.evaluate(
          `${anchorXPath}//${tag}`, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
        );
        for (let i = 0; i < descendants.snapshotLength; i++) {
          if (descendants.snapshotItem(i) === el) {
            relXp = `(${anchorXPath}//${tag})[${i + 1}]`;
            if (isUniqueXPath(relXp)) return relXp;
            break;
          }
        }
      }

      ancestor = ancestor.parentElement;
    }

    // 6. Positional fallback (full path)
    let current: Element | null = el;
    const path: string[] = [];

    while (current && current !== document.body && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) index++;
        sibling = sibling.previousElementSibling;
      }

      const hasSameTagSiblings = index > 1 || Array.from(current.parentElement?.children || []).some(
        e => e !== current && e.tagName === current!.tagName
      );

      if (hasSameTagSiblings) {
        part += `[${index}]`;
      }
      path.unshift(part);
      current = current.parentElement;
    }
    return `/html/body/${path.join('/')}`;
  };

  // ── Locator builder ──────────────────────────────────────────────────
  const buildLocators = (el: Element, name: string, role: string): Array<{type: string, value: string}> => {
    const locators: Array<{type: string, value: string}> = [];
    const tag = el.tagName.toLowerCase();
    const seen = new Set<string>();

    const addLocator = (type: string, value: string) => {
      const key = `${type}::${value}`;
      if (!seen.has(key)) {
        seen.add(key);
        locators.push({ type, value });
      }
    };

    // 1. data-testid (most stable — developer-intentional)
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-cy');
    if (testId) {
      addLocator('testid', `[data-testid="${CSS.escape(testId)}"]`);
    }

    // 2. Stable ID
    if (el.id && !isDynamicId(el.id)) {
      addLocator('css', `#${CSS.escape(el.id)}`);
    }

    // 3. ARIA / accessible name
    if (name && name.length > 0 && name.length < 100) {
      addLocator('aria', name);
    }

    // 4. Semantic attributes
    const nameAttr = el.getAttribute('name');
    if (nameAttr) {
      addLocator('attribute', `${tag}[name="${CSS.escape(nameAttr)}"]`);
    }

    const placeholder = el.getAttribute('placeholder');
    if (placeholder) {
      addLocator('placeholder', placeholder);
      addLocator('attribute', `${tag}[placeholder="${CSS.escape(placeholder)}"]`);
    }

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      addLocator('attribute', `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`);
    }

    const altAttr = el.getAttribute('alt');
    if (altAttr) {
      addLocator('attribute', `${tag}[alt="${CSS.escape(altAttr)}"]`);
    }

    const titleAttr = el.getAttribute('title');
    if (titleAttr && titleAttr.length < 100) {
      addLocator('attribute', `${tag}[title="${CSS.escape(titleAttr)}"]`);
    }

    // 5. Text content
    const textContent = el.textContent?.trim().replace(/\s+/g, ' ');
    if (textContent && textContent.length > 0 && textContent.length < 100) {
      addLocator('text', textContent);
    }

    // 6. CSS selector (robust algorithm)
    const cssSelector = buildSelector(el);
    addLocator('css', cssSelector);

    // 7. XPath (robust algorithm)
    const xpath = buildXPath(el);
    addLocator('xpath', xpath);

    return locators;
  };

  const treeLines: string[] = [];

  const traverse = (el: Element, depth: number) => {
    if (depth > options.maxDepth!) return;

    if (!options.includeHidden) {
      // display:none truly hides the entire subtree — skip completely
      if (isSubtreeHidden(el)) return;
    }

    const tag = el.tagName.toLowerCase();
    const role = getRole(el);
    const name = getAccessibleName(el);
    let interactive = isInteractiveRole(role, tag) || el.hasAttribute('onclick');
    if (!interactive && el.hasAttribute('tabindex')) {
      const ti = parseInt(el.getAttribute('tabindex') || '', 10);
      if (!isNaN(ti) && ti >= 0) interactive = true;
    }

    let skipNodeRender = false;

    // Element-level visibility: don't render this node but still traverse children.
    // Handles aria-hidden, opacity:0, visibility:hidden on wrapper elements
    // whose children may still be visually visible (drawers, modals, transitions).
    if (!options.includeHidden && !isVisible(el)) {
      skipNodeRender = true;
    }

    // Check if we should skip rendering this specific node (but still traverse children)
    if (options.interactiveOnly && !interactive) {
      skipNodeRender = true;
    } else if (options.compact && role === 'generic' && !name && !interactive) {
      skipNodeRender = true;
    }

    // Purpose-based filtering: skip elements that don't match the intended action
    if (!skipNodeRender && providedOptions.purposeFilter && providedOptions.purposeFilter !== 'read') {
      if (!matchesPurposeFilter(role, tag, providedOptions.purposeFilter)) {
        skipNodeRender = true;
      }
    }

    // Process iframes
    if (tag === 'iframe' && options.inlineFrames) {
      const iframe = el as HTMLIFrameElement;
      let crossOrigin = false;
      let iframeDoc: Document | null = null;
      try {
        iframeDoc = iframe.contentDocument;
        if (!iframeDoc) crossOrigin = true;
      } catch (e) {
        crossOrigin = true;
      }

      const ref = `@e${refCounter++}`;
      refMap.set(ref, el);
      const indent = '  '.repeat(depth);
      const frameName = name || iframe.name || iframe.title || 'iframe';
      
      treeLines.push(`${indent}${ref} [iframe] "${truncate(frameName)}"${crossOrigin ? ' [cross-origin]' : ''}`);
      
      if (!crossOrigin && iframeDoc && iframeDoc.body) {
        traverse(iframeDoc.body, depth + 1);
      }
      return; 
    }

    if (!skipNodeRender && tag !== 'body') {
      const ref = `@e${refCounter++}`;
      refMap.set(ref, el);

      const indent = '  '.repeat(depth);
      let line = `${indent}${ref} [${role}]`;
      if (name) line += ` "${truncate(name)}"`;

      // Active/focus state
      if (document.activeElement === el) line += ` [active]`;

      // Specific attributes mapping
      if (role === 'heading') {
        const level = tag.replace('h', '');
        if (['1','2','3','4','5','6'].includes(level)) line += ` [level=${level}]`;
      }
      
      const htmlEl = el as HTMLInputElement;
      if (tag === 'a' && el.hasAttribute('href')) {
        let href = el.getAttribute('href')!;
        if (href.length > 30) href = href.slice(0, 27) + '...';
        line += ` href="${href}"`;
      }
      if (tag === 'input') {
        if (htmlEl.type) line += ` type="${htmlEl.type}"`;
        if (htmlEl.placeholder) line += ` placeholder="${truncate(htmlEl.placeholder)}"`;
        // Show current value for text-like inputs and sliders
        const inputType = (htmlEl.type || 'text').toLowerCase();
        if (!['checkbox', 'radio', 'submit', 'reset', 'button', 'hidden', 'file'].includes(inputType) && htmlEl.value) {
          line += ` value="${truncate(htmlEl.value)}"`;
        }
        if (htmlEl.required) line += ` [required]`;
        if (htmlEl.disabled) line += ` [disabled]`;
        if (htmlEl.readOnly) line += ` [readonly]`;
      }
      if (tag === 'textarea') {
        if (htmlEl.placeholder) line += ` placeholder="${truncate(htmlEl.placeholder)}"`;
        if (htmlEl.value) line += ` value="${truncate(htmlEl.value)}"`;
      }
      
      if (role === 'checkbox' || role === 'radio') {
        line += htmlEl.checked ? ` [checked]` : ` [unchecked]`;
      }
      
      if (tag === 'select') {
        const selectedOpt = el.querySelector('option:checked');
        if (selectedOpt) line += ` value="${truncate(selectedOpt.textContent || '')}"`;
      }
      
      if (role === 'button' && (el as HTMLButtonElement).disabled) {
        line += ` [disabled]`;
      }
      
      if (tag === 'img' && el.hasAttribute('alt')) {
        line += ` alt="${truncate(el.getAttribute('alt')!)}"`;
      }
      
      if (tag === 'details') {
        line += el.hasAttribute('open') ? ` [open]` : ` [closed]`;
      }

      // cursor=pointer indicates clickable non-semantic elements (divs, spans with click handlers)
      if (!interactive) {
        const cursor = window.getComputedStyle(el).cursor;
        if (cursor === 'pointer') line += ` [cursor=pointer]`;
      }

      if (el.hasAttribute('aria-expanded')) {
        line += ` [expanded=${el.getAttribute('aria-expanded')}]`;
      }
      if (el.hasAttribute('aria-selected')) {
        line += ` [selected=${el.getAttribute('aria-selected')}]`;
      }
      if (el.hasAttribute('aria-disabled')) {
        line += ` [disabled=${el.getAttribute('aria-disabled')}]`;
      }
      
      // Show data-testid in tree for easy identification
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-cy');
      if (testId) line += ` [testid="${testId}"]`;

      if (options.includeRects) {
        const rect = el.getBoundingClientRect();
        line += ` [${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)}x${Math.round(rect.height)}]`;
      }

      treeLines.push(line);

      // Render <option> children for select/combobox/listbox so the AI knows available values
      if (tag === 'select') {
        const optIndent = '  '.repeat(skipNodeRender ? depth : depth + 1);
        for (const opt of Array.from(el.querySelectorAll('option'))) {
          const optText = truncate(opt.textContent || '');
          let optLine = `${optIndent}[option] "${optText}"`;
          if ((opt as HTMLOptionElement).selected) optLine += ` [selected]`;
          if ((opt as HTMLOptionElement).disabled) optLine += ` [disabled]`;
          treeLines.push(optLine);
        }
      }

      // Always build ref mapping (needed for workflow recording)
      const refInfo: RefNodeInfo = {
        role,
        name: truncate(name),
        selector: buildSelector(el),
        locators: buildLocators(el, name, role)
      };
      if (role === 'heading') {
         const level = parseInt(tag.replace('h', ''), 10);
         if (!isNaN(level)) refInfo.level = level;
      }
      if (options.includeRects) {
        const rect = el.getBoundingClientRect();
        refInfo.rect = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
      }
      jsonRefs[ref.substring(1)] = refInfo; // removing the '@' for json keys
    }

    // Recurse into Shadow DOM if present
    if (el.shadowRoot) {
      for (const child of el.shadowRoot.children) {
        if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || child.tagName === 'NOSCRIPT' || child.tagName === 'LINK' || child.tagName === 'META') {
          continue;
        }
        traverse(child, skipNodeRender ? depth : depth + 1);
      }
    }

    // Recurse light DOM children
    for (const child of el.children) {
      if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || child.tagName === 'NOSCRIPT' || child.tagName === 'LINK' || child.tagName === 'META') {
        continue;
      }
      traverse(child, skipNodeRender ? depth : depth + 1);
    }
  };

  const root = options.scope ? document.querySelector(options.scope) || document.body : document.body;

  if (root) {
    traverse(root, 0);
  }

  // Traverse Angular CDK overlay container (dropdowns, modals, tooltips)
  // and other portal containers that render outside the main DOM tree.
  if (!options.scope) {
    const overlayContainers = document.querySelectorAll(
      '.cdk-overlay-container, [id="portal-root"], [id="modal-root"], [class*="overlay-container"]'
    );
    overlayContainers.forEach(container => {
      if (container !== root && container.children.length > 0) {
        traverse(container, 0);
      }
    });
  }

  // ─── Post-filter: searchText ──────────────────────────────────────
  let filteredTreeLines = treeLines;
  let filteredRefs = jsonRefs;

  if (providedOptions.searchText) {
    const needle = providedOptions.searchText.toLowerCase();

    // Keep only tree lines whose text content matches the search
    filteredTreeLines = treeLines.filter(line => line.toLowerCase().includes(needle));

    // Extract ref IDs from the matching lines (pattern: @eNN at start of trimmed line)
    const matchedRefIds = new Set<string>();
    for (const line of filteredTreeLines) {
      const match = line.trimStart().match(/^@(e\d+)/);
      if (match) matchedRefIds.add(match[1]);
    }

    // Filter refs to only matched ones and clean refMap
    filteredRefs = {};
    for (const [key, value] of Object.entries(jsonRefs)) {
      if (matchedRefIds.has(key)) {
        filteredRefs[key] = value;
      } else {
        refMap.delete(`@${key}`);
      }
    }
  }

  const result: SnapshotResult = {
    url: window.location.href,
    title: document.title,
    timestamp: Date.now(),
    refs: filteredRefs,
    tree: filteredTreeLines.join('\n')
  };

  return result;
}
