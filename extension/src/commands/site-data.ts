// What a site left in the browser — cookies, local storage, IndexedDB, caches, service workers —,
// cleared before a test so that it starts logged out: the test logs in itself, as a user would.
// A session kept from the test before (or from the agent recording it) otherwise led the app
// elsewhere: a login page that refuses a user already logged in ("Access Denied") had no field
// left for the test to fill.
//
// Only in IziTest's browser without windows, whose profile is its own (headless.ts). Never in the
// user's Chrome: it would log them out of their own sessions on those sites.

import { isHeadless } from '../headless';

export interface ClearSiteDataParams {
  /** The origins of the app under test, e.g. https://app.example.com. */
  origins?: string[];
}

/** Origins only: what browsingData accepts (scheme://host[:port]), each once. */
export function originsOf(urls: string[] = []): string[] {
  const out = new Set<string>();
  for (const url of urls) {
    try {
      const { protocol, origin } = new URL(url);
      if (protocol === 'http:' || protocol === 'https:') out.add(origin);
    } catch { /* not a URL */ }
  }
  return [...out];
}

export async function cmdClearSiteData({ origins = [] }: ClearSiteDataParams, headless = isHeadless()) {
  if (!headless) return { cleared: false, reason: 'not the browser without windows: the user\'s own sessions are left alone' };
  const list = originsOf(origins);
  if (!list.length) return { cleared: false, reason: 'no origin to clear' };
  // Cookies go for the whole registrable domain of each origin (Chrome's rule for this filter).
  await chrome.browsingData.remove({ origins: list }, {
    cookies: true, localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true, fileSystems: true,
  });
  return { cleared: true, origins: list };
}
