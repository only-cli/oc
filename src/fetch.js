/**
 * HTTP layer. impers (libcurl-impersonate) presents a real browser TLS and
 * HTTP/2 fingerprint so ordinary public pages load the way they would in
 * Chrome. It is loaded lazily and native fetch is the silent fallback, so a
 * bare `npm install --omit=optional` still gives a working tool. The headless
 * fallback for script-gated pages lands in v0.3 and must stay lazy too:
 * never import a browser here.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

// The fetch fallback can't fake a TLS fingerprint like impers does, but it
// should at least send the same Chrome identity in its headers.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

/** @type {Promise<any> | null} */
let impersPromise = null;
const loadImpers = () => {
  impersPromise ??= import('impers').catch(() => null);
  return impersPromise;
};

const BLOCKED_MESSAGE = 'blocked: private or internal URL';
const MAX_REDIRECTS = 20;

// IPv4 ranges with no business receiving a server-initiated fetch: loopback,
// link-local, the three RFC 1918 private blocks, carrier-grade NAT, the
// unspecified/broadcast addresses, and the documentation/benchmark ranges.
const IPV4_BLOCKED_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['255.255.255.255', 32],
];

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isBlockedIPv4Int(addr) {
  return IPV4_BLOCKED_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (addr & mask) === (ipv4ToInt(base) & mask);
  });
}

function isBlockedIPv4(ip) {
  return isBlockedIPv4Int(ipv4ToInt(ip));
}

// Expand a parsed IPv6 literal (as given by URL.hostname or dns.lookup, so
// already bracket-free and lowercase) into its 8 16-bit groups.
function expandIPv6(ip) {
  const sides = ip.split('::');
  if (sides.length > 2) return null;
  const head = sides[0] ? sides[0].split(':') : [];
  const tail = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...Array(missing).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g, 16));
}

function isBlockedIPv6(ip) {
  const g = expandIPv6(ip);
  if (!g) return true; // unparsable - fail closed
  if (g.every((x) => x === 0)) return true; // :: (unspecified)
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) {
    return true; // ::1 (loopback)
  }
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (g[5] === 0xffff || g[5] === 0)) {
    // ::ffff:a.b.c.d (IPv4-mapped) or the deprecated ::a.b.c.d (IPv4-compatible)
    return isBlockedIPv4Int(((g[6] << 16) | g[7]) >>> 0);
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 (unique local)
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  return false;
}

// Validates the target a socket is actually about to connect to: the parsed
// IP if the URL is a literal, or every address the hostname resolves to
// otherwise. Resolving before connecting (rather than pattern-matching the
// hostname string) is what closes off IPv4-mapped IPv6 loopback, 0.0.0.0,
// and DNS rebinding through an attacker-controlled domain. It runs again on
// every redirect hop, since a public URL that later 302s to an internal
// address is the same attack one step removed.
//
// It does not pin the resolved address for the connection itself - neither
// impers (curl) nor Node's fetch expose that here - so a name that
// re-resolves to a different address between this check and the actual
// connect is a known residual gap, not one this guard can close without
// deeper transport changes.
async function assertSafeTarget(urlStr) {
  const u = new URL(urlStr);
  if (!/^https?:$/.test(u.protocol)) throw new Error(BLOCKED_MESSAGE);
  // URL.hostname keeps the brackets around an IPv6 literal (e.g. "[::1]");
  // net.isIP and the group-based checks below expect the bare address.
  const hostname = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ipType = net.isIP(hostname);
  if (ipType === 4) {
    if (isBlockedIPv4(hostname)) throw new Error(BLOCKED_MESSAGE);
    return;
  }
  if (ipType === 6) {
    if (isBlockedIPv6(hostname)) throw new Error(BLOCKED_MESSAGE);
    return;
  }
  if (hostname === 'localhost') throw new Error(BLOCKED_MESSAGE);
  const addresses = await dns.lookup(hostname, { all: true }).catch(() => []);
  for (const { address, family } of addresses) {
    if (family === 4 && isBlockedIPv4(address)) throw new Error(BLOCKED_MESSAGE);
    if (family === 6 && isBlockedIPv6(address)) throw new Error(BLOCKED_MESSAGE);
  }
}

/**
 * Fetch a page.
 * @param {string} url - with or without a scheme, https is assumed
 * @returns {Promise<{url: string, html: string, status: number, via: string}>}
 *   final URL after redirects, the body, the HTTP status, and which client
 *   identity got the page (impers:chrome, impers:firefox, or fetch)
 */
export async function fetchPage(url) {
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  await assertSafeTarget(target);
  const impers = await loadImpers();
  return impers ? viaImpers(impers, target) : viaFetch(target);
}

async function followImpersRedirects(impers, startUrl, impersonate) {
  let current = startUrl;
  for (let i = 0; ; i++) {
    if (i > MAX_REDIRECTS) throw new Error(`too many redirects for ${startUrl}`);
    const res = await impers.get(current, { impersonate, allowRedirects: false });
    const status = res.status ?? res.statusCode ?? 0;
    const location = res.headers.get('location');
    if (status >= 300 && status < 400 && location) {
      current = new URL(location, current).toString();
      await assertSafeTarget(current);
      continue;
    }
    return res;
  }
}

async function viaImpers(impers, target) {
  // Some sites (Reddit) 403 the chrome fingerprint but accept firefox, so a
  // blocked first attempt gets one cheap retry with a second identity.
  let via = 'impers:chrome';
  let res = await followImpersRedirects(impers, target, 'chrome');
  let status = res.status ?? res.statusCode ?? 0;
  if (status >= 400) {
    via = 'impers:firefox';
    res = await followImpersRedirects(impers, target, 'firefox');
    status = res.status ?? res.statusCode ?? 0;
  }
  if (status >= 400) throw new Error(`fetch failed: ${status} for ${target}`);
  const html = typeof res.text === 'function' ? await res.text() : String(res.text ?? res.body ?? '');
  return { url: res.url ?? target, html, status, via };
}

async function viaFetch(target) {
  let current = target;
  let res;
  for (let i = 0; ; i++) {
    if (i > MAX_REDIRECTS) throw new Error(`too many redirects for ${target}`);
    res = await fetch(current, {
      redirect: 'manual',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      await assertSafeTarget(current);
      continue;
    }
    break;
  }
  if (!res.ok) {
    throw new Error(`fetch failed: ${res.status} ${res.statusText} for ${current}`);
  }
  const type = res.headers.get('content-type') ?? '';
  if (type && !type.includes('html') && !type.includes('xml')) {
    throw new Error(`not an HTML page (${type.split(';')[0]}), nothing to distill`);
  }
  return { url: res.url || current, html: await res.text(), status: res.status, via: 'fetch' };
}
