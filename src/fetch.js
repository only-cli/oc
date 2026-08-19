/**
 * HTTP layer. impers (libcurl-impersonate) presents a real browser TLS and
 * HTTP/2 fingerprint so ordinary public pages load the way they would in
 * Chrome. It is loaded lazily and native fetch is the silent fallback, so a
 * bare `npm install --omit=optional` still gives a working tool. The headless
 * fallback for script-gated pages lands in v0.3 and must stay lazy too:
 * never import a browser here.
 */

// The fetch fallback can't fake a TLS fingerprint like impers does, but it
// should at least send the same Chrome identity in its headers.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

/** @type {Promise<any> | null} */
let impersPromise = null;
const loadImpers = () => {
  impersPromise ??= import('impers').catch(() => null);
  return impersPromise;
};

/**
 * Fetch a page.
 * @param {string} url - with or without a scheme, https is assumed
 * @returns {Promise<{url: string, html: string, status: number, via: string}>}
 *   final URL after redirects, the body, the HTTP status, and which client
 *   identity got the page (impers:chrome, impers:firefox, or fetch)
 */
export async function fetchPage(url) {
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const hostname = new URL(target).hostname.toLowerCase();
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|\[::1\])/.test(hostname)) {
    throw new Error(`blocked: private or internal URL`);
  }
  const impers = await loadImpers();
  return impers ? viaImpers(impers, target) : viaFetch(target);
}

async function viaImpers(impers, target) {
  // Some sites (Reddit) 403 the chrome fingerprint but accept firefox, so a
  // blocked first attempt gets one cheap retry with a second identity.
  let via = 'impers:chrome';
  let res = await impers.get(target, { impersonate: 'chrome' });
  // impers mirrors the curl_cffi response shape, not the WHATWG one.
  let status = res.status ?? res.statusCode ?? 0;
  if (status >= 400) {
    via = 'impers:firefox';
    res = await impers.get(target, { impersonate: 'firefox' });
    status = res.status ?? res.statusCode ?? 0;
  }
  if (status >= 400) throw new Error(`fetch failed: ${status} for ${target}`);
  const html = typeof res.text === 'function' ? await res.text() : String(res.text ?? res.body ?? '');
  return { url: res.url ?? target, html, status, via };
}

async function viaFetch(target) {
  const res = await fetch(target, {
    redirect: 'follow',
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) {
    throw new Error(`fetch failed: ${res.status} ${res.statusText} for ${target}`);
  }
  const type = res.headers.get('content-type') ?? '';
  if (type && !type.includes('html') && !type.includes('xml')) {
    throw new Error(`not an HTML page (${type.split(';')[0]}), nothing to distill`);
  }
  return { url: res.url, html: await res.text(), status: res.status, via: 'fetch' };
}
