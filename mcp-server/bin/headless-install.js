#!/usr/bin/env node
// Installs IziTest's browser without windows (Chrome for Testing, ~150 MB in ~/.izitest/browsers),
// the same as Settings → Headless browser → Install, from a terminal — on Windows, macOS or Linux.
// Where Chrome may not have extensions, it is the browser agents record tests in.
//
//   npm run headless:install
//
// Behind a company proxy that inspects HTTPS, the system's certificates are trusted when Node
// can read them; otherwise NODE_EXTRA_CA_CERTS=<root.pem> (docs/installation.md). Where the
// download is blocked altogether: unzip Chrome for Testing by hand and set IZITEST_CHROME_PATH.

import { trustSystemCertificates } from '../lib/system-ca.js';
import { installHeadless, headlessStatus } from '../lib/headless.js';

const added = trustSystemCertificates();
if (added) console.log(`Trusting ${added} certificate${added > 1 ? 's' : ''} of the system as well.`);

const before = await headlessStatus();
if (before.installed) {
  console.log(`Already installed: Chrome for Testing ${before.installed.version} (${before.browsers_dir}).`);
  process.exit(0);
}

console.log(`Downloading Chrome for Testing into ${before.browsers_dir}…`);
let shown = -1;
const progress = setInterval(async () => {
  const { installing } = await headlessStatus();
  if (!installing?.total) return;
  const percent = Math.floor((installing.downloaded / installing.total) * 100);
  if (percent >= shown + 10) {
    shown = percent - (percent % 10);
    console.log(`  ${shown}%`);
  }
}, 1000);

try {
  const version = await installHeadless();
  clearInterval(progress);
  console.log(`Installed: Chrome for Testing ${version}. The server starts it when a run or an agent needs it.`);
  process.exit(0);
} catch (err) {
  clearInterval(progress);
  console.error(`Not installed: ${err.message}`);
  if (/certificate|self[- ]signed|UNABLE_TO_GET_ISSUER|CERT_/i.test(err.message)) {
    console.error('A proxy of your network presents its own certificate. Give Node its root certificate:');
    console.error('  NODE_EXTRA_CA_CERTS=C:\\path\\to\\company-root.pem npm run headless:install   (Windows: set it with setx, then open a new terminal)');
    console.error('or unzip Chrome for Testing by hand (https://googlechromelabs.github.io/chrome-for-testing/) and set IZITEST_CHROME_PATH to its chrome executable.');
  }
  process.exit(1);
}
