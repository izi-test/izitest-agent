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
}

export interface RefNodeInfo {
  role: string;
  name: string;
  level?: number;
  selector?: string;
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
    await new Promise(r => setTimeout(r, 150));
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

  const container = document.createElement('div');
  container.id = 'browser-pilot-annotations';
  container.style.position = 'fixed'; // viewport relative!
  container.style.top = '0';
  container.style.left = '0';
  container.style.width = '100vw';
  container.style.height = '100vh';
  container.style.pointerEvents = 'none';
  container.style.zIndex = '2147483647';
  
  const refMap = window.__browserPilotRefMap || new Map();
  refMap.forEach((el, ref) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) return;
    
    // Label
    const marker = document.createElement('div');
    marker.style.position = 'absolute';
    marker.style.left = `${Math.max(0, rect.left)}px`;
    marker.style.top = `${Math.max(0, rect.top)}px`;
    marker.style.backgroundColor = '#ef4444';
    marker.style.color = '#fff';
    marker.style.padding = '1px 4px';
    marker.style.fontSize = '12px';
    marker.style.fontWeight = 'bold';
    marker.style.fontFamily = 'monospace';
    marker.style.borderRadius = '3px';
    marker.style.border = '1px solid #fff';
    marker.style.zIndex = '2147483647';
    marker.textContent = ref;
    
    // Bounding Box
    const box = document.createElement('div');
    box.style.position = 'absolute';
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    box.style.border = '2px solid #ef4444';
    box.style.boxSizing = 'border-box';
    box.style.pointerEvents = 'none';

    container.appendChild(box);
    container.appendChild(marker);
  });
  
  // Debug banner to ensure it actually injects
  const banner = document.createElement('div');
  banner.style.position = 'absolute';
  banner.style.top = '10px';
  banner.style.left = '10px';
  banner.style.padding = '5px 10px';
  banner.style.backgroundColor = 'blue';
  banner.style.color = 'white';
  banner.style.zIndex = '2147483647';
  banner.style.fontWeight = 'bold';
  banner.style.fontFamily = 'monospace';
  banner.textContent = `Browser Pilot: ${refMap.size} Refs Annotated`;
  container.appendChild(banner);
  
  document.documentElement.appendChild(container);
}

export function clearAnnotations() {
  const el = document.getElementById('browser-pilot-annotations');
  if (el) el.remove();
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

  const isVisible = (el: Element): boolean => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      if (style.display === 'contents') {
        // Elements with display: contents have a 0x0 rect, but render children normally.
        // We must consider them visible so we can traverse their children.
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

    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label && label.textContent) return label.textContent.trim();
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

  const buildSelector = (el: Element): string => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    let current = el;
    const path: string[] = [];
    while (current && current !== document.body) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
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

  const treeLines: string[] = [];

  const traverse = (el: Element, depth: number) => {
    if (depth > options.maxDepth!) return;
    if (!options.includeHidden && !isVisible(el)) return;

    const tag = el.tagName.toLowerCase();
    const role = getRole(el);
    const name = getAccessibleName(el);
    let interactive = isInteractiveRole(role, tag) || el.hasAttribute('onclick');
    if (!interactive && el.hasAttribute('tabindex')) {
      const ti = parseInt(el.getAttribute('tabindex') || '', 10);
      if (!isNaN(ti) && ti >= 0) interactive = true;
    }

    let skipNodeRender = false;

    // Check if we should skip rendering this specific node (but still traverse children)
    if (options.interactiveOnly && !interactive) {
      skipNodeRender = true;
    } else if (options.compact && role === 'generic' && !name && !interactive) {
      skipNodeRender = true;
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
        if (htmlEl.required) line += ` [required]`;
        if (htmlEl.disabled) line += ` [disabled]`;
        if (htmlEl.readOnly) line += ` [readonly]`;
      }
      if (tag === 'textarea') {
        if (htmlEl.placeholder) line += ` placeholder="${truncate(htmlEl.placeholder)}"`;
      }
      
      if (role === 'checkbox' || role === 'radio') {
        line += htmlEl.checked ? ` [checked]` : ` [unchecked]`;
      }
      
      if (tag === 'select') {
        const option = el.querySelector('option:checked');
        if (option) line += ` value="${truncate(option.textContent || '')}"`;
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

      if (el.hasAttribute('aria-expanded')) {
        line += ` [expanded=${el.getAttribute('aria-expanded')}]`;
      }
      if (el.hasAttribute('aria-selected')) {
        line += ` [selected=${el.getAttribute('aria-selected')}]`;
      }
      if (el.hasAttribute('aria-disabled')) {
        line += ` [disabled=${el.getAttribute('aria-disabled')}]`;
      }
      
      if (options.includeRects) {
        const rect = el.getBoundingClientRect();
        line += ` [${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)}x${Math.round(rect.height)}]`;
      }

      treeLines.push(line);

      // JSON mapping
      if (options.format === 'json') {
        const refInfo: RefNodeInfo = {
          role,
          name: truncate(name),
          selector: buildSelector(el)
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
    }

    // Recurse children
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

  const result: SnapshotResult = {
    url: window.location.href,
    title: document.title,
    timestamp: Date.now(),
    tree: treeLines.join('\n')
  };

  if (options.format === 'json') {
    result.refs = jsonRefs;
  }

  return result;
}
