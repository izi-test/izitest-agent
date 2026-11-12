// The certificates of the system, trusted as well as Node's own.
//
// A company network often inspects HTTPS through a proxy (Zscaler, a PKI of its own): the
// certificates it presents are signed by the company's root, which the system trusts and Node
// does not — Node ships its own list. Downloading Chrome for Testing then failed with
// "self-signed certificate in certificate chain", and so would a call to an internal API.
//
// Where Node can read the system's store (tls.getCACertificates('system'), Node 22.15 / 23.8 and
// later), its roots are added to Node's, for every HTTPS request of the server. Otherwise,
// NODE_EXTRA_CA_CERTS=<file.pem> does it (docs/installation.md). IZITEST_SYSTEM_CA=0 turns it off.

import tls from 'tls';
import { log } from './logger.js';

/**
 * Trusts the system's roots too, when Node can read them. Returns how many were added, 0 when
 * none could be (an older Node, turned off), or null when it failed.
 */
export function trustSystemCertificates({ env = process.env, tlsModule = tls } = {}) {
  if (env.IZITEST_SYSTEM_CA === '0') return 0;
  if (typeof tlsModule.getCACertificates !== 'function' || typeof tlsModule.setDefaultCACertificates !== 'function') return 0;
  try {
    const bundled = tlsModule.getCACertificates('default');
    const system = tlsModule.getCACertificates('system');
    const known = new Set(bundled);
    const added = system.filter((cert) => !known.has(cert));
    if (added.length) tlsModule.setDefaultCACertificates([...bundled, ...added]);
    return added.length;
  } catch (err) {
    log(`System certificates not read: ${err.message}`);
    return null;
  }
}
