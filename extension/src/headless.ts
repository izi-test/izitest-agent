// Whether this extension runs in a Chrome without windows: the one the server starts to replay
// tests out of sight (mcp-server/lib/headless.js). It is then always the "headless" profile,
// and the pages it drives are told the browser's usual name.

export const HEADLESS_PROFILE = 'headless';

const START_PAGE_PROFILE = /[#&]izitest-profile=([A-Za-z0-9_-]+)/;

/**
 * The profile a headless Chrome is, told by the page it was started on
 * (data:text/html,headless-2#izitest-profile=headless-2): one per lane of a campaign, each with cookies of
 * its own. Null when no page tells it.
 */
export function profileOfStartPage(urls: Array<string | undefined>): string | null {
  for (const url of urls) {
    const found = url ? START_PAGE_PROFILE.exec(url) : null;
    if (found) return found[1];
  }
  return null;
}

export function isHeadless(userAgent: string = navigator.userAgent): boolean {
  return userAgent.includes('HeadlessChrome');
}

/** The user agent pages see: a site may refuse "HeadlessChrome", never plain Chrome. */
export function pageUserAgent(userAgent: string = navigator.userAgent): string {
  return userAgent.replace('HeadlessChrome', 'Chrome');
}
