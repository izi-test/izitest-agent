// Whether this extension runs in a Chrome without windows: the one the server starts to replay
// tests out of sight (mcp-server/lib/headless.js). It is then always the "headless" profile,
// and the pages it drives are told the browser's usual name.

export const HEADLESS_PROFILE = 'headless';

export function isHeadless(userAgent: string = navigator.userAgent): boolean {
  return userAgent.includes('HeadlessChrome');
}

/** The user agent pages see: a site may refuse "HeadlessChrome", never plain Chrome. */
export function pageUserAgent(userAgent: string = navigator.userAgent): string {
  return userAgent.replace('HeadlessChrome', 'Chrome');
}
