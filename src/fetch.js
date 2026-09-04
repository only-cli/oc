/**
 * HTTP layer. impers (libcurl-impersonate) presents a real browser TLS and
 * HTTP/2 fingerprint so ordinary public pages load the way they would in
 * Chrome. It is loaded lazily and native fetch is the silent fallback, so a
 * bare `npm install --omit=optional` still gives a working tool. The headless
 * fallback for script-gated pages lands in v0.3 and must stay lazy too:
 * never import a browser here.
 */

import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

import { getSetCookieHeaders } from './cookies.js';

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
// Match undici's default so proxy transport does not hang indefinitely.
const PROXY_TIMEOUT_MS = 300_000;

// What oc can turn into text: any text/* type, plus the application/* types
// that are really text (json, xml, and the +json / +xml families a feed or an
// API answers with). A PNG matches none of these, and rendering one produces
// pages of mojibake an agent then pays for, so it is refused by name instead.
const READABLE_TYPE = /^\s*(?:text\/|application\/(?:json|xml|javascript|x-ndjson|[\w.+-]*\+(?:json|xml)))/i;

// The whole decoded body is buffered before the distiller sees it, so an
// unbounded response is an unbounded allocation, and a URL is often the
// page's to name, not the caller's. The cap is generous because oc fetches
// some large corpora on purpose (the Node.js docs reference is 8.5MB
// decoded); three times that and a response is not a page anyone reads.
// Content-Length rejects a known-large response before its bytes arrive, but
// the header is optional and untrusted, so every transport also counts what
// actually lands, after decoding, which is what stops a decompression bomb.
export const MAX_BODY = 25 * 1024 * 1024;

/**
 * Refuse a body larger than oc will buffer. Called on the Content-Length
 * header first and again on the bytes as they arrive, since only the second
 * count is trustworthy.
 * @param {number} size - bytes seen so far, or claimed by the header
 * @param {string} url
 */
export function assertBodySize(size, url) {
  if (size > MAX_BODY) {
    throw new Error(`response body over ${MAX_BODY / 1048576}MB for ${url}, more than oc will read`);
  }
}

/**
 * Refuse a response oc cannot read as text. Both transports call this: the
 * gate has to live on whichever client got the page, or the same URL renders
 * as an error through fetch and as binary noise through impers.
 * @param {string | null | undefined} type - the content-type header
 */
export function assertReadableType(type) {
  // No header at all is not a refusal: plenty of small servers omit it, and
  // the distiller handles whatever comes back.
  if (!type || READABLE_TYPE.test(type)) return;
  throw new Error(`not a page oc can read (${type.split(';')[0].trim()}), it renders HTML, XML feeds, JSON, and plain text`);
}

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
  const addresses = await dns.lookup(hostname, { all: true }).catch(() => {
    // With a proxy the client never resolves the target; the proxy does, often
    // on corporate DNS where internal names are NXDOMAIN locally. Fail closed.
    if (resolveProxy(urlStr)) throw new Error(BLOCKED_MESSAGE);
    return [];
  });
  for (const { address, family } of addresses) {
    if (family === 4 && isBlockedIPv4(address)) throw new Error(BLOCKED_MESSAGE);
    if (family === 6 && isBlockedIPv6(address)) throw new Error(BLOCKED_MESSAGE);
  }
}

function envFirst(env, ...names) {
  for (const name of names) {
    const value = env[name];
    if (value) return value;
  }
}

function normalizeProxy(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function assertHttpProxyProtocol(proxyUrl) {
  if (!/^https?:$/.test(proxyUrl.protocol)) {
    throw new Error(`unsupported proxy protocol (${proxyUrl.protocol.slice(0, -1)}), oc honors HTTP and HTTPS proxies`);
  }
}

// Split host[:port], including [IPv6]:port. Unbracketed IPv6 literals never
// carry a port suffix (use [addr]:port); a trailing :digits on ::1 is part of
// the address, not a port.
function splitHostPort(entry) {
  if (entry.startsWith('[')) {
    const end = entry.indexOf(']');
    if (end === -1) return { host: entry, port: '' };
    const rest = entry.slice(end + 1);
    return { host: entry.slice(1, end), port: rest.startsWith(':') ? rest.slice(1) : '' };
  }
  if (net.isIP(entry) === 6) return { host: entry, port: '' };
  const colon = entry.lastIndexOf(':');
  if (colon !== -1 && /^\d+$/.test(entry.slice(colon + 1))) {
    const host = entry.slice(0, colon);
    if (net.isIP(host) === 6) return { host: entry, port: '' };
    return { host, port: entry.slice(colon + 1) };
  }
  return { host: entry, port: '' };
}

function ipv4InCidr(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

function ipv6InCidr(ip, base, bits) {
  const g = expandIPv6(ip);
  const b = expandIPv6(base);
  if (!g || !b) return false;
  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    if (remaining >= 16) {
      if (g[i] !== b[i]) return false;
      remaining -= 16;
    } else {
      const mask = (0xffff << (16 - remaining)) & 0xffff;
      if ((g[i] & mask) !== (b[i] & mask)) return false;
      remaining = 0;
    }
  }
  return true;
}

function ipInCidr(ip, base, bits) {
  const family = net.isIP(ip);
  if (family === 4) return ipv4InCidr(ip, base, bits);
  if (family === 6) return ipv6InCidr(ip, base, bits);
  return false;
}

function bypassesProxy(target, noProxy) {
  const list = noProxy.trim();
  if (!list) return false;
  const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  for (let entry of list.split(',')) {
    entry = entry.trim();
    if (!entry) continue;
    if (entry === '*') return true;
    const { host: rawHost, port: entryPort } = splitHostPort(entry);
    if (entryPort && entryPort !== port) continue;
    let pattern = rawHost.toLowerCase().replace(/^\[|\]$/g, '');
    const wildcard = pattern.startsWith('*.');
    if (wildcard) pattern = pattern.slice(2);
    const slash = pattern.indexOf('/');
    if (slash !== -1 && net.isIP(pattern.slice(0, slash))) {
      const bits = Number(pattern.slice(slash + 1));
      if (Number.isInteger(bits) && net.isIP(hostname) && ipInCidr(hostname, pattern.slice(0, slash), bits)) {
        return true;
      }
      continue;
    }
    const host = pattern.replace(/^\./, '');
    if (!host) continue;
    if (wildcard) {
      if (hostname.endsWith(`.${host}`)) return true;
      continue;
    }
    if (hostname === host || hostname.endsWith(`.${host}`)) return true;
  }
  return false;
}

/**
 * Pick a proxy for this URL from HTTP_PROXY / HTTPS_PROXY / NO_PROXY (and
 * their lowercase forms). The proxy host is not run through assertSafeTarget:
 * corporate proxies live on loopback or RFC 1918 addresses, and they are not
 * the page being fetched. Redirect hops still go through that check.
 * @param {string} url
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null} proxy URL, or null to connect directly
 */
export function resolveProxy(url, env = process.env) {
  const target = new URL(url);
  if (bypassesProxy(target, envFirst(env, 'NO_PROXY', 'no_proxy') ?? '')) return null;
  const httpsProxy = envFirst(env, 'HTTPS_PROXY', 'https_proxy');
  const httpProxy = envFirst(env, 'HTTP_PROXY', 'http_proxy');
  const chosen = target.protocol === 'https:' ? (httpsProxy || httpProxy) : httpProxy;
  const normalized = normalizeProxy(chosen);
  if (!normalized) return null;
  assertHttpProxyProtocol(new URL(normalized));
  return normalized;
}

function decodeCredential(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function proxyAuthHeader(proxy) {
  if (!proxy.username) return undefined;
  const token = Buffer.from(`${decodeCredential(proxy.username)}:${decodeCredential(proxy.password)}`).toString('base64');
  return `Basic ${token}`;
}

function authority(target) {
  const host = net.isIP(target.hostname) === 6 ? `[${target.hostname}]` : target.hostname;
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  return `${host}:${port}`;
}

function wrapNodeResponse(res, url) {
  const headers = {
    get(name) {
      const v = res.headers[name.toLowerCase()];
      if (v == null) return null;
      return Array.isArray(v) ? v.join(', ') : v;
    },
    // Node keeps Set-Cookie as an array of raw values. Expose it unjoined so
    // the cookie jar reads each header intact: a comma in an Expires date
    // makes the joined form ambiguous to split back apart.
    getSetCookie() {
      const v = res.headers['set-cookie'];
      if (v == null) return [];
      return Array.isArray(v) ? v : [v];
    },
  };
  const text = () => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (c) => {
      size += c.length;
      try {
        assertBodySize(size, url);
      } catch (err) {
        // destroy surfaces the refusal through 'error', and stops the read.
        res.destroy(err);
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
  const status = res.statusCode ?? 0;
  return {
    status,
    statusText: res.statusMessage || '',
    headers,
    ok: status >= 200 && status < 300,
    url,
    text,
  };
}

function proxyTransport(proxy) {
  return proxy.protocol === 'https:' ? https : http;
}

function proxyPort(proxy) {
  return Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
}

function armRequestTimeout(req, reject, label) {
  req.setTimeout(PROXY_TIMEOUT_MS, () => {
    req.destroy();
    reject(new Error(`proxy timed out after ${PROXY_TIMEOUT_MS / 1000}s for ${label}`));
  });
}

function pickTlsCa(tlsOpts) {
  return tlsOpts.ca != null ? { ca: tlsOpts.ca } : {};
}

function httpViaProxy(target, proxy, headers) {
  const auth = proxyAuthHeader(proxy);
  return new Promise((resolve, reject) => {
    const req = proxyTransport(proxy).request({
      hostname: proxy.hostname,
      port: proxyPort(proxy),
      method: 'GET',
      path: `${target.protocol}//${target.host}${target.pathname}${target.search}`,
      headers: {
        ...headers,
        host: target.host,
        ...(auth && { 'proxy-authorization': auth }),
      },
    }, (res) => resolve(wrapNodeResponse(res, target.href)));
    armRequestTimeout(req, reject, target.href);
    req.on('error', (err) => reject(new Error(`proxy failed: ${err.message} for ${target.href}`)));
    req.end();
  });
}

function httpsViaConnect(target, proxy, headers, tlsOpts = {}) {
  const dest = authority(target);
  const auth = proxyAuthHeader(proxy);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const req = proxyTransport(proxy).request({
      hostname: proxy.hostname,
      port: proxyPort(proxy),
      method: 'CONNECT',
      path: dest,
      headers: {
        host: dest,
        ...(auth && { 'proxy-authorization': auth }),
      },
    });
    armRequestTimeout(req, fail, target.href);
    req.on('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`proxy CONNECT failed: ${res.statusCode} for ${target.href}`));
        return;
      }
      if (head.length) socket.unshift(head);
      // tls.connect already opened the tunnel. https.request would wrap TLS
      // again, and the origin would see a second ClientHello as garbage.
      // SNI is a hostname; an IP literal is only used for the cert check.
      // URL.hostname keeps the brackets around an IPv6 literal ("[::1]"), which
      // tls.connect would treat as a DNS name; strip them like assertSafeTarget.
      const hostname = target.hostname.replace(/^\[|\]$/g, '');
      const tlsSocket = tls.connect({
        socket,
        host: hostname,
        ...(net.isIP(hostname) ? {} : { servername: hostname }),
        ...pickTlsCa(tlsOpts),
      }, () => {
        const tunneled = http.request({
          createConnection: () => tlsSocket,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: { ...headers, host: target.host },
        }, (httpsRes) => {
          if (settled) return;
          settled = true;
          resolve(wrapNodeResponse(httpsRes, target.href));
        });
        armRequestTimeout(tunneled, fail, target.href);
        tunneled.on('error', (err) => fail(new Error(`proxy failed: ${err.message || err.code} for ${target.href}`)));
        tunneled.end();
      });
      tlsSocket.on('error', (err) => fail(new Error(`proxy failed: ${err.message || err.code} for ${target.href}`)));
    });
    req.on('error', (err) => fail(new Error(`proxy failed: ${err.message || err.code} for ${target.href}`)));
    req.end();
  });
}

/**
 * One GET through an HTTP(S) proxy. HTTP targets use the absolute-URI form;
 * HTTPS targets open a CONNECT tunnel first. Redirects are not followed:
 * followRedirects owns that so each hop still goes through assertSafeTarget.
 * @param {string} url
 * @param {string} proxy
 * @param {Record<string, string>} [headers]
 * @param {import('node:tls').ConnectionOptions} [tlsOpts]
 */
export function proxyGet(url, proxy, headers = {}, tlsOpts = {}) {
  const target = new URL(url);
  const proxyUrl = new URL(proxy);
  assertHttpProxyProtocol(proxyUrl);
  return target.protocol === 'https:'
    ? httpsViaConnect(target, proxyUrl, headers, tlsOpts)
    : httpViaProxy(target, proxyUrl, headers);
}

/**
 * Fetch a page.
 * @param {string} url - with or without a scheme, https is assumed
 * @param {{ jar?: { cookieHeaderFor(url: string): string|undefined, storeFromResponse(url: string, headers: string[]): void } }} [opts]
 * @returns {Promise<{url: string, html: string, status: number, via: string}>}
 *   final URL after redirects, the body, the HTTP status, and which client
 *   identity got the page (impers:chrome, impers:firefox, or fetch)
 */
export async function fetchPage(url, { jar } = {}) {
  let target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  // A reader with no cookies for reddit.com gets the feed where the page
  // would be a login wall; one who logged in gets the page it asked for.
  if (!jar?.cookieHeaderFor(target)) target = redditFeedURL(target) ?? target;
  await assertSafeTarget(target);
  const impers = await loadImpers();
  return impers ? viaImpers(impers, target, jar) : viaFetch(target, jar);
}

/**
 * Follow redirects one hop at a time, validating each destination before the
 * next request goes out.
 *
 * Both transports share this loop. They used to carry one each, which made the
 * check that matters something a change could fix in one place and leave broken
 * in the other, and made the guarantee testable only through a third party
 * willing to 302 wherever it was told. Taking the request as a callback is what
 * lets the hop check be proven against a transport that never leaves the
 * process.
 * @param {(url: string) => Promise<any>} get - one request, redirects not followed
 * @param {string} start
 * @returns {Promise<{res: any, url: string}>} the first non-redirect response
 */
export async function followRedirects(get, start, { onResponse } = {}) {
  let current = start;
  for (let i = 0; ; i++) {
    if (i > MAX_REDIRECTS) throw new Error(`too many redirects for ${start}`);
    const res = await get(current);
    onResponse?.(current, res);
    const status = res.status ?? res.statusCode ?? 0;
    const location = res.headers.get('location');
    if (status >= 300 && status < 400 && location) {
      current = new URL(location, current).toString();
      await assertSafeTarget(current);
      continue;
    }
    return { res, url: current };
  }
}

const FETCH_HEADERS = {
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

function mergeHeaders(base, extra) {
  return extra ? { ...base, ...extra } : base;
}

function jarHeaders(jar, url, base) {
  if (!jar) return base;
  const cookie = jar.cookieHeaderFor(url);
  return cookie ? mergeHeaders(base, { cookie }) : base;
}

function captureSetCookie(jar, url, res) {
  if (!jar) return;
  jar.storeFromResponse(url, getSetCookieHeaders(res));
}

// Hosts whose edge answers the chrome fingerprint with a 403 or a 429 while
// letting firefox through. reddit.com started doing this in 2026 (#52), so
// starting with chrome there would turn every read into two requests against
// a per-address rate limit of about ten a minute. Subdomains inherit the
// entry.
const FIREFOX_FIRST_HOSTS = ['reddit.com'];

// Reddit has sent logged-out readers of its HTML pages to a login page since
// June 2026 (#52), while the Atom feed beside each of those pages still
// answers. A feed entry links to the page, so following a post out of a
// subreddit feed used to land on the wall. The front page, subreddit
// listings, posts, user pages and search are mapped to their feeds here;
// anything else on reddit.com is fetched as asked.
const REDDIT_HOSTS = ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com', 'np.reddit.com'];
const SEG = '[A-Za-z0-9_.-]+';
const REDDIT_FEED_PATHS = new RegExp(
  `^(?:|/r/${SEG}(?:/(?:new|top|hot|rising))?|/(?:r/${SEG}/)?comments/${SEG}(?:/${SEG}){0,2}|/u(?:ser)?/${SEG})$`,
);

/**
 * The www.reddit.com Atom feed for a reddit.com page URL, or null when the URL
 * is not one of the page shapes that has a feed, or is a feed already.
 * @param {string} target
 * @returns {string | null}
 */
export function redditFeedURL(target) {
  let u;
  try {
    u = new URL(target);
  } catch {
    return null;
  }
  if (!REDDIT_HOSTS.includes(u.hostname.toLowerCase())) return null;
  const path = u.pathname.replace(/\/+$/, '');
  if (/\.(?:rss|json|xml)$/i.test(path)) return null;
  if (path === '/search') return `https://www.reddit.com/search.rss${u.search}`;
  if (!REDDIT_FEED_PATHS.test(path)) return null;
  return `https://www.reddit.com${path.replace(/^\/u\//, '/user/')}/.rss${u.search}`;
}

/**
 * The order in which impers identities are tried for a URL.
 * @param {string} target
 * @returns {['chrome', 'firefox'] | ['firefox', 'chrome']}
 */
export function identityOrder(target) {
  let host = '';
  try {
    host = new URL(target).hostname.toLowerCase();
  } catch {
    return ['chrome', 'firefox'];
  }
  const firefoxFirst = FIREFOX_FIRST_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  return firefoxFirst ? ['firefox', 'chrome'] : ['chrome', 'firefox'];
}

/**
 * Fetch a page through impers, downgrading identity when one is refused.
 * Exported so the downgrade chain can be proven against a fake impers; the
 * real entry point is fetchPage.
 * @param {any} impers - the impers module (or a stand-in with a get method)
 * @param {string} target
 * @param {object} [jar]
 * @returns {Promise<{url: string, html: string, status: number, via: string}>}
 */
export async function viaImpers(impers, target, jar) {
  // A blocked first attempt gets one cheap retry with the other identity. An
  // ImpersonateError is the same story one layer down: impers resolves the
  // 'chrome' alias to its newest fingerprint, but the native library it loads
  // can be an older system copy of libcurl-impersonate that predates that
  // fingerprint and refuses it before any request leaves. Firefox aliases to
  // an older target that such a library usually still knows, and when both
  // identities are refused the plain fetch transport still gets the page.
  // Hosts that are known to refuse chrome outright start with firefox, so the
  // usual case there costs one request instead of a 403 and a retry.
  const asking = (impersonate) => (url) =>
    impers.get(url, {
      impersonate,
      allowRedirects: false,
      proxy: resolveProxy(url) ?? '',
      headers: jarHeaders(jar, url, {}),
    });
  const onResponse = (url, res) => captureSetCookie(jar, url, res);
  const attempt = async (impersonate) => {
    try {
      const { res } = await followRedirects(asking(impersonate), target, { onResponse });
      return { res, status: res.status ?? res.statusCode ?? 0 };
    } catch (err) {
      if (err?.name !== 'ImpersonateError') throw err;
      return null;
    }
  };
  const [first, second] = identityOrder(target);
  let via = `impers:${first}`;
  let got = await attempt(first);
  if (!got || got.status >= 400) {
    via = `impers:${second}`;
    got = (await attempt(second)) ?? got;
  }
  if (!got) return viaFetch(target, jar);
  const { res, status } = got;
  if (status >= 400) throw new Error(`fetch failed: ${status} for ${target}`);
  assertReadableType(res.headers.get('content-type'));
  assertBodySize(Number(res.headers.get('content-length')) || 0, target);
  // impers buffers inside its own binding, so the size of what it already
  // holds is all there is to check; the bound still stops an oversized body
  // from travelling any further.
  const html = typeof res.text === 'function' ? await res.text() : String(res.text ?? res.body ?? '');
  assertBodySize(html.length, target);
  return { url: res.url ?? target, html, status, via };
}

async function viaFetch(target, jar) {
  const get = (url) => {
    const proxy = resolveProxy(url);
    const headers = jarHeaders(jar, url, FETCH_HEADERS);
    return proxy
      ? proxyGet(url, proxy, headers)
      : fetch(url, { redirect: 'manual', headers });
  };
  const onResponse = (url, res) => captureSetCookie(jar, url, res);
  const { res, url: current } = await followRedirects(get, target, { onResponse });
  if (!res.ok) {
    throw new Error(`fetch failed: ${res.status} ${res.statusText} for ${current}`);
  }
  assertReadableType(res.headers.get('content-type'));
  assertBodySize(Number(res.headers.get('content-length')) || 0, current);
  return { url: res.url || current, html: await readBody(res, current), status: res.status, via: 'fetch' };
}

/**
 * The decoded body as text, counted as it arrives so crossing the cap aborts
 * the transfer instead of finishing it. Throwing mid-iteration cancels the
 * stream. A proxy response has no web stream to iterate; its text() counts
 * inside wrapNodeResponse instead.
 * @param {any} res
 * @param {string} url
 * @returns {Promise<string>}
 */
export async function readBody(res, url) {
  if (!res.body?.getReader) return res.text();
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    assertBodySize(size, url);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
