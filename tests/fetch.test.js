import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const { fetchPage, followRedirects, identityOrder, resolveProxy, proxyGet, viaImpers } = await import('../src/fetch.js');

const BLOCKED_MESSAGE = 'blocked: private or internal URL';

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

function withoutProxyEnv(run) {
  const prev = Object.fromEntries(PROXY_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of PROXY_ENV_KEYS) delete process.env[k];
  return run().finally(() => {
    for (const k of PROXY_ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

test('fetchPage blocks literal loopback and RFC 1918 / link-local hosts', async () => {
  const blocked = [
    'localhost',
    'localhost:8080',
    '127.0.0.1',
    '127.0.0.1/admin',
    '10.0.0.1',
    '192.168.1.1/admin',
    '172.16.0.5',
    '172.31.255.255',
    '169.254.169.254/latest/meta-data/',
    '0.0.0.0',
    '[::1]',
  ];
  for (const host of blocked) {
    await assert.rejects(() => fetchPage(host), new RegExp(BLOCKED_MESSAGE), `expected ${host} to be blocked`);
  }
});

test('fetchPage does not block an ordinary public hostname', async () => {
  // A live fetch of example.com should succeed outright, or at worst fail for
  // a network reason - it must never be rejected by the private-URL guard.
  await withoutProxyEnv(async () => {
    try {
      await fetchPage('example.com');
    } catch (err) {
      assert.ok(!err.message.includes(BLOCKED_MESSAGE), `unexpected block: ${err.message}`);
    }
  });
});

test('fetchPage does not false-positive on a public hostname that merely starts with a private-looking numeric label', async () => {
  // Regression check: an earlier version of this guard matched the URL's
  // hostname STRING against ^-anchored prefixes like "10." and could not
  // tell a private IPv4 octet from an ordinary DNS label, so a domain like
  // 10.example.com (subdomain "10" of example.com) was wrongly blocked as if
  // it were 10.0.0.0/8. Validating the resolved address instead of the
  // string fixes this.
  await withoutProxyEnv(async () => {
    try {
      await fetchPage('10.example.com');
    } catch (err) {
      assert.ok(!err.message.includes(BLOCKED_MESSAGE), `unexpected block: ${err.message}`);
    }
  });
});

test('fetchPage blocks an IPv4-mapped IPv6 loopback literal', async () => {
  // new URL('https://[::ffff:127.0.0.1]/').hostname === '::ffff:7f00:1'
  // (compressed hex) - a string blocklist checking for "127." or "::1" never
  // matches this form, so it has to be decoded and checked as the IPv4
  // address it embeds.
  await assert.rejects(() => fetchPage('https://[::ffff:127.0.0.1]/'), new RegExp(BLOCKED_MESSAGE));
});

test('fetchPage blocks a hostname that merely resolves to a loopback address (DNS rebinding shape)', async () => {
  // localtest.me is a public, real-world domain that resolves to 127.0.0.1 /
  // ::1. Its hostname string looks nothing like a private address, so this
  // can only be caught by resolving it and validating the resulting IP -
  // exactly the shape of a DNS-rebinding attack.
  await assert.rejects(() => fetchPage('localtest.me'), new RegExp(BLOCKED_MESSAGE));
});

// A response, as little of one as the redirect loop reads.
const replies = (...hops) => {
  const asked = [];
  const get = (url) => {
    asked.push(url);
    const hop = hops[asked.length - 1] ?? { status: 200 };
    return Promise.resolve({ status: hop.status, headers: new Map(hop.location ? [['location', hop.location]] : []) });
  };
  return { get, asked };
};

test('every redirect hop is re-validated, not just the original URL', () => withoutProxyEnv(async () => {
  // An SSRF hides the real target behind a public-looking first hop, so the
  // check has to run again on what the 302 names. This used to be proven
  // against httpbin.org, which meant a third party's uptime could fail the
  // release, and it never covered the impers transport's own copy of the loop.
  const { get, asked } = replies({ status: 302, location: 'http://127.0.0.1/admin' });
  await assert.rejects(() => followRedirects(get, 'https://public.example/start'), new RegExp(BLOCKED_MESSAGE));
  // Blocked before the socket, not after: the private address is never asked for.
  assert.deepEqual(asked, ['https://public.example/start']);
}));

test('a hop to somewhere public is followed', () => withoutProxyEnv(async () => {
  // The other half of the guarantee. A loop that rejected everything would
  // pass the test above and break every redirect on the web.
  const { get, asked } = replies(
    { status: 301, location: 'https://elsewhere.example/moved' },
    { status: 302, location: '/relative' },
  );
  const { res, url } = await followRedirects(get, 'https://public.example/start');
  assert.equal(res.status, 200);
  assert.equal(url, 'https://elsewhere.example/relative');
  assert.equal(asked.length, 3);
}));

test('a redirect loop gives up instead of spinning', () => withoutProxyEnv(async () => {
  const get = () => Promise.resolve({ status: 302, headers: new Map([['location', 'https://public.example/again']]) });
  await assert.rejects(() => followRedirects(get, 'https://public.example/start'), /too many redirects/);
}));

test('the readable-type gate accepts text and refuses binary, on either transport', async () => {
  const { assertReadableType } = await import('../src/fetch.js');

  // Everything oc has something to say about.
  for (const type of [
    'text/html; charset=utf-8',
    'text/plain',
    'text/markdown',
    'application/json',
    'application/json; charset=utf-8',
    'application/xml',
    'application/atom+xml',
    'application/rss+xml',
    'application/ld+json',
    ' text/html ',
  ]) {
    assert.doesNotThrow(() => assertReadableType(type), `expected ${type} to be readable`);
  }

  // A missing header is not a refusal: small servers omit it and the page
  // behind it is usually fine.
  assert.doesNotThrow(() => assertReadableType(undefined));
  assert.doesNotThrow(() => assertReadableType(''));

  // Binary renders as pages of mojibake the agent pays for, so it is named
  // and refused rather than distilled.
  for (const type of ['image/png', 'image/jpeg', 'application/pdf', 'application/octet-stream', 'video/mp4', 'application/zip']) {
    assert.throws(() => assertReadableType(type), /not a page oc can read/, `expected ${type} to be refused`);
  }
  assert.throws(() => assertReadableType('image/png'), /image\/png/);
});

test('resolveProxy reads the usual env vars and honors NO_PROXY', () => {
  const none = {};
  assert.equal(resolveProxy('https://example.com', none), null);

  assert.equal(
    resolveProxy('https://example.com', { HTTPS_PROXY: 'http://proxy.corp:8080' }),
    'http://proxy.corp:8080',
  );
  assert.equal(
    resolveProxy('https://example.com', { HTTP_PROXY: 'http://proxy.corp:8080' }),
    'http://proxy.corp:8080',
  );
  assert.equal(
    resolveProxy('http://example.com', { HTTP_PROXY: 'http://proxy.corp:8080' }),
    'http://proxy.corp:8080',
  );
  assert.equal(
    resolveProxy('http://example.com', { HTTPS_PROXY: 'http://secure-proxy.corp:8080' }),
    null,
  );
  assert.equal(
    resolveProxy('https://example.com', { http_proxy: 'proxy.corp:8080' }),
    'http://proxy.corp:8080',
  );

  assert.equal(
    resolveProxy('https://example.com/foo', { HTTPS_PROXY: 'http://proxy.corp:8080', NO_PROXY: 'example.com' }),
    null,
  );
  assert.equal(
    resolveProxy('https://foo.example.com', { HTTPS_PROXY: 'http://proxy.corp:8080', NO_PROXY: '.example.com' }),
    null,
  );
  assert.equal(
    resolveProxy('https://elsewhere.test', { HTTPS_PROXY: 'http://proxy.corp:8080', NO_PROXY: 'example.com' }),
    'http://proxy.corp:8080',
  );
  assert.equal(
    resolveProxy('https://example.com', { HTTPS_PROXY: 'http://proxy.corp:8080', no_proxy: '*' }),
    null,
  );
  assert.equal(
    resolveProxy('https://example.com:8443', { HTTPS_PROXY: 'http://proxy.corp:8080', NO_PROXY: 'example.com:8443' }),
    null,
  );
  assert.equal(
    resolveProxy('https://example.com:8443', { HTTPS_PROXY: 'http://proxy.corp:8080', NO_PROXY: 'example.com:443' }),
    'http://proxy.corp:8080',
  );
  assert.equal(
    resolveProxy('http://[2606:4700::1]/', { HTTP_PROXY: 'http://proxy.corp:8080', NO_PROXY: '2606:4700::1' }),
    null,
  );
  assert.equal(
    resolveProxy('http://10.0.0.5/', { HTTP_PROXY: 'http://proxy.corp:8080', NO_PROXY: '10.0.0.0/8' }),
    null,
  );
  assert.equal(
    resolveProxy('https://foo.example.com', { HTTPS_PROXY: 'http://proxy.corp:8080', NO_PROXY: '*.example.com' }),
    null,
  );
  assert.equal(
    resolveProxy('https://example.com', { HTTPS_PROXY: 'http://proxy.corp:8080', NO_PROXY: '*.example.com' }),
    'http://proxy.corp:8080',
  );
});

test('resolveProxy rejects a socks proxy URL', () => {
  assert.throws(
    () => resolveProxy('https://example.com', { HTTP_PROXY: 'socks5://127.0.0.1:1080' }),
    /unsupported proxy protocol \(socks5\)/,
  );
});

test('a private page URL is still blocked when a proxy is configured', async () => {
  // The proxy itself is often loopback; that must not punch a hole in the
  // page-target guard. fetchPage rejects before any socket is opened.
  const prev = Object.fromEntries(PROXY_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of PROXY_ENV_KEYS) delete process.env[k];
  process.env.HTTP_PROXY = 'http://127.0.0.1:8080';
  process.env.HTTPS_PROXY = 'http://127.0.0.1:8080';
  try {
    await assert.rejects(() => fetchPage('127.0.0.1'), new RegExp(BLOCKED_MESSAGE));
    await assert.rejects(() => fetchPage('https://192.168.1.1/admin'), new RegExp(BLOCKED_MESSAGE));
  } finally {
    for (const k of PROXY_ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
});

test('an unresolvable hostname is blocked when a proxy is configured', async () => {
  // Internal names are often NXDOMAIN on the client but reachable via the
  // corporate proxy. Without this, assertSafeTarget sees [] and the proxy
  // fetches what the guard exists to stop.
  const prev = Object.fromEntries(PROXY_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of PROXY_ENV_KEYS) delete process.env[k];
  process.env.HTTP_PROXY = 'http://127.0.0.1:8080';
  try {
    await assert.rejects(
      () => fetchPage('http://intranet.invalid/admin'),
      new RegExp(BLOCKED_MESSAGE),
    );
  } finally {
    for (const k of PROXY_ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
});

test('fetchPage honors lowercase no_proxy and bypasses the proxy', async () => {
  // Regression for the impers path: libcurl re-reads lowercase http_proxy from
  // the environment when the proxy option is omitted. resolveProxy must stick,
  // and impers must receive proxy: '' so curl does not override oc's decision.
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<html>via proxy</html>');
  });
  const port = await listen(proxy);
  const prev = Object.fromEntries(PROXY_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of PROXY_ENV_KEYS) delete process.env[k];
  process.env.http_proxy = `http://127.0.0.1:${port}`;
  process.env.no_proxy = '1.1.1.1';
  try {
    // Direct fetch may fail offline; the point is the proxy never sees the request.
    await fetchPage('http://1.1.1.1/page').catch(() => {});
    assert.equal(seen.length, 0);
  } finally {
    proxy.close();
    for (const k of PROXY_ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
});

test('fetchPage routes through HTTP_PROXY instead of connecting directly', async () => {
  // Wiring test: resolveProxy → proxyGet/viaFetch (or impers with proxy) must
  // actually hit the configured proxy. Unit tests for resolveProxy and proxyGet
  // alone would still pass if this branch were deleted. A public IP literal
  // keeps assertSafeTarget offline-friendly (no DNS lookup for the target).
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, host: req.headers.host });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>via fetchPage</title></html>');
  });
  const port = await listen(proxy);
  const prev = Object.fromEntries(PROXY_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of PROXY_ENV_KEYS) delete process.env[k];
  process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
  try {
    const page = await fetchPage('http://1.1.1.1/page');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].url, 'http://1.1.1.1/page');
    assert.equal(seen[0].host, '1.1.1.1');
    assert.equal(page.html, '<html><title>via fetchPage</title></html>');
    assert.equal(page.status, 200);
  } finally {
    proxy.close();
    for (const k of PROXY_ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('proxyGet sends an absolute-URI GET to an HTTP proxy', async () => {
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      host: req.headers.host,
      ua: req.headers['user-agent'],
      auth: req.headers['proxy-authorization'],
    });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>via proxy</title></html>');
  });
  const port = await listen(proxy);
  try {
    const res = await proxyGet(
      'http://example.test/page',
      `http://user:secret@127.0.0.1:${port}`,
      { 'user-agent': 'oc-test' },
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html');
    assert.equal(await res.text(), '<html><title>via proxy</title></html>');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].url, 'http://example.test/page');
    assert.equal(seen[0].host, 'example.test');
    assert.equal(seen[0].ua, 'oc-test');
    assert.equal(seen[0].auth, `Basic ${Buffer.from('user:secret').toString('base64')}`);
  } finally {
    proxy.close();
  }
});

test('proxyGet strips page URL credentials from the absolute-URI request line', async () => {
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html></html>');
  });
  const port = await listen(proxy);
  try {
    await proxyGet(
      'http://alice:s3cr3t@example.test/private',
      `http://127.0.0.1:${port}`,
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0], 'http://example.test/private');
  } finally {
    proxy.close();
  }
});

test('proxyGet tolerates an unencoded percent in proxy credentials', async () => {
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push({ auth: req.headers['proxy-authorization'] });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html></html>');
  });
  const port = await listen(proxy);
  try {
    await proxyGet(
      'http://example.test/page',
      `http://user:pa%ss@127.0.0.1:${port}`,
      { 'user-agent': 'oc-test' },
    );
    assert.equal(seen[0].auth, `Basic ${Buffer.from('user:pa%ss').toString('base64')}`);
  } finally {
    proxy.close();
  }
});

test('proxyGet issues CONNECT for an HTTPS target and fails loud on a refused tunnel', async () => {
  const seen = [];
  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => {
    seen.push({ url: req.url, auth: req.headers['proxy-authorization'] });
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.end();
  });
  const port = await listen(proxy);
  try {
    await assert.rejects(
      () => proxyGet('https://example.test/page', `http://127.0.0.1:${port}`),
      /proxy CONNECT failed: 403/,
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'example.test:443');
  } finally {
    proxy.close();
  }
});

// Self-signed localhost cert so the HTTPS success path can run offline. The
// client is handed the same cert as `ca`, so verification stays on.
const LOCAL_CERT = `-----BEGIN CERTIFICATE-----
MIIBmDCCAT+gAwIBAgIUMrBi6hKtC1hrvo+Ttf70VHSofLkwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDgyMzE1MzU1MFoXDTM2MDgyMDE1
MzU1MFowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAESbtFNb5R3K9iqcJJ6J9HII9DRylOGKutU+uoJ4TTsopcsRz2jMns8UYa
+oABlqC0ef+LAcaTwkPHgTwzfS1GuqNvMG0wHQYDVR0OBBYEFPPKq83hQvf8KTZB
r0bMcGIo18wBMB8GA1UdIwQYMBaAFPPKq83hQvf8KTZBr0bMcGIo18wBMA8GA1Ud
EwEB/wQFMAMBAf8wGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMAoGCCqGSM49
BAMCA0cAMEQCIHBWYJSTt1qGyhySr2CY+JYWFdpApMvHVqED54/GivKcAiBchJFW
8FrIy8Paiv8v+us5Ahlpr1QheS5LZX+LUWPUIg==
-----END CERTIFICATE-----`;

const LOCAL_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtusH8iEEA2S7nGrF
DrJVWIHwY2v4DoYibYK0wTwAQEuhRANCAARJu0U1vlHcr2Kpwknon0cgj0NHKU4Y
q61T66gnhNOyilyxHPaMyezxRhr6gAGWoLR5/4sBxpPCQ8eBPDN9LUa6
-----END PRIVATE KEY-----`;

test('proxyGet returns the origin body through an HTTPS CONNECT tunnel', async () => {
  // The 403 test above only proves we open the tunnel. This one proves the
  // GET after TLS actually reaches the origin: the old path wrapped TLS twice
  // and the origin never saw a request.
  const originGot = [];
  const origin = https.createServer({ cert: LOCAL_CERT, key: LOCAL_KEY }, (req, res) => {
    originGot.push({ method: req.method, url: req.url, host: req.headers.host, ua: req.headers['user-agent'] });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>via tunnel</title></html>');
  });
  const originPort = await listen(origin);

  const connected = [];
  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => {
    connected.push(req.url);
    const { hostname, port } = new URL(`http://${req.url}`);
    const dest = net.connect(Number(port), hostname, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      dest.pipe(socket);
      socket.pipe(dest);
    });
    dest.on('error', () => socket.destroy());
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await proxyGet(
      `https://127.0.0.1:${originPort}/page`,
      `http://127.0.0.1:${proxyPort}`,
      { 'user-agent': 'oc-test' },
      { ca: LOCAL_CERT },
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html');
    assert.equal(await res.text(), '<html><title>via tunnel</title></html>');
    assert.deepEqual(connected, [`127.0.0.1:${originPort}`]);
    assert.deepEqual(originGot, [{
      method: 'GET',
      url: '/page',
      host: `127.0.0.1:${originPort}`,
      ua: 'oc-test',
    }]);
  } finally {
    origin.close();
    proxy.close();
  }
});

// A separate cert whose SAN covers the IPv6 loopback ::1, so the tunneled
// TLS handshake to an IPv6 literal can be validated offline.
const LOCAL_CERT_V6 = `-----BEGIN CERTIFICATE-----
MIIBsjCCAVigAwIBAgIUYhesMP2mQCQ6S4SrcGJshDK0g9owCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMb2MtaXB2Ni10ZXN0MB4XDTI2MDgyNDE4NTM1MVoXDTM2MDgy
MTE4NTM1MVowFzEVMBMGA1UEAwwMb2MtaXB2Ni10ZXN0MFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAE26JWljo6HQCqheYsEL/xViNZpq+6NPKBlEjlvXf/WtJa2mAl
qELRtfWYJeRS+0ogeMNjYXTYME2WKHL3il88cqOBgTB/MB0GA1UdDgQWBBSx4h35
MCnlyDhcx7ATZiWyJ/IYEzAfBgNVHSMEGDAWgBSx4h35MCnlyDhcx7ATZiWyJ/IY
EzAPBgNVHRMBAf8EBTADAQH/MCwGA1UdEQQlMCOHEAAAAAAAAAAAAAAAAAAAAAGH
BH8AAAGCCWxvY2FsaG9zdDAKBggqhkjOPQQDAgNIADBFAiAFJGgQcNAAXI5HWj02
NYBPF1nTo3BfOoT/PY5pUsSjuAIhAP9oPp1R2+ckC9sXTOL8n1vw2qVElGDLuvES
Hi24p3Qi
-----END CERTIFICATE-----`;

const LOCAL_KEY_V6 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgjZ74TmqrsdfKIelm
KQFHEBF+5zD8lk8lDLuPgvz2dNGhRANCAATbolaWOjodAKqF5iwQv/FWI1mmr7o0
8oGUSOW9d/9a0lraYCWoQtG19Zgl5FL7SiB4w2NhdNgwTZYocveKXzxy
-----END PRIVATE KEY-----`;

test('an IPv6 literal target tunnels through a proxy with its brackets stripped', async () => {
  // URL.hostname keeps the brackets ("[::1]"); before the fix they reached
  // tls.connect as a DNS name and the handshake never happened, so what this
  // test is really about is the host oc hands to the identity check.
  //
  // It asserts that host directly rather than letting the handshake stand in
  // for it: node 24.19 stopped matching IPv6 addresses in a certificate's SAN
  // (IPv4 still matches), so the default check now rejects an ::1 origin on
  // grounds that have nothing to do with oc, and 24.8 accepts it. Chain
  // verification against `ca` stays on; only the hostname step is ours.
  const origin = https.createServer({ cert: LOCAL_CERT_V6, key: LOCAL_KEY_V6 }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>v6 tunnel</title></html>');
  });
  await new Promise((r) => origin.listen(0, '::1', r));
  const originPort = origin.address().port;

  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => {
    const host = req.url.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const port = Number(req.url.slice(req.url.lastIndexOf(':') + 1));
    const dest = net.connect(port, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      dest.pipe(socket);
      socket.pipe(dest);
    });
    dest.on('error', () => socket.destroy());
  });
  const proxyPort = await listen(proxy);

  const realConnect = tls.connect;
  let identity = null;
  let servername = 'unset';
  tls.connect = (opts, onSecure) => {
    servername = opts.servername;
    return realConnect({
      ...opts,
      checkServerIdentity: (host) => {
        identity = host;
        return undefined;
      },
    }, onSecure);
  };

  try {
    const res = await proxyGet(
      `https://[::1]:${originPort}/page`,
      `http://127.0.0.1:${proxyPort}`,
      { 'user-agent': 'oc-test' },
      { ca: LOCAL_CERT_V6 },
    );
    // The bare address, and no SNI: an IP literal is not a server name.
    assert.equal(identity, '::1');
    assert.equal(servername, undefined);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '<html><title>v6 tunnel</title></html>');
  } finally {
    tls.connect = realConnect;
    origin.close();
    proxy.close();
  }
});

test('followRedirects still blocks a private hop when the transport is a proxy', async () => {
  // The page 302s to loopback. The proxy is also loopback, which is allowed;
  // the hop is not. Blocked before the second request goes out.
  let n = 0;
  const proxy = http.createServer((req, res) => {
    n += 1;
    if (n === 1) {
      res.writeHead(302, { location: 'http://127.0.0.1/admin' });
      res.end();
      return;
    }
    res.writeHead(200);
    res.end('should not happen');
  });
  const port = await listen(proxy);
  try {
    await assert.rejects(
      () => followRedirects((url) => proxyGet(url, `http://127.0.0.1:${port}`), 'http://public.example/start'),
      new RegExp(BLOCKED_MESSAGE),
    );
    assert.equal(n, 1);
  } finally {
    proxy.close();
  }
});

test('proxyGet refuses a non-HTTP proxy scheme', () => {
  assert.throws(
    () => proxyGet('https://example.test/', 'socks5://127.0.0.1:1080'),
    /unsupported proxy protocol \(socks5\)/,
  );
});

test('followRedirects sends jar cookies on every hop and stores Set-Cookie', () => withoutProxyEnv(async () => {
  const { jarFromCookieHeader, createJarHandle } = await import('../src/cookies.js');
  const seed = jarFromCookieHeader('sid=abc', 'public.example');
  const jar = createJarHandle('test', seed);
  const seen = [];
  const get = (url) => {
    seen.push({ url, cookie: jar.cookieHeaderFor(url) });
    const setCookie = url.includes('/two')
      ? ['fresh=1; Path=/; Domain=public.example']
      : [];
    return Promise.resolve({
      status: url.includes('/two') ? 200 : 302,
      headers: {
        get(name) {
          if (name === 'location' && !url.includes('/two')) return 'https://public.example/two';
          if (name === 'set-cookie') return setCookie.join(', ');
          return null;
        },
        getSetCookie() { return setCookie; },
      },
    });
  };
  const { getSetCookieHeaders } = await import('../src/cookies.js');
  await followRedirects(get, 'https://public.example/one', {
    onResponse: (url, res) => jar.storeFromResponse(url, getSetCookieHeaders(res)),
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].cookie, 'sid=abc');
  assert.equal(seen[1].cookie, 'sid=abc');
  assert.ok(jar.toJSON().cookies.some((c) => c.name === 'fresh'));
}));

test('proxyGet forwards a cookie header from the jar', async () => {
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push({ cookie: req.headers.cookie });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>ok</title></html>');
  });
  const port = await listen(proxy);
  try {
    await proxyGet('http://example.test/page', `http://127.0.0.1:${port}`, { cookie: 'a=1; b=2' });
    assert.equal(seen[0].cookie, 'a=1; b=2');
  } finally {
    proxy.close();
  }
});

test('a proxied response exposes each Set-Cookie intact, even with a comma in Expires', async () => {
  const { getSetCookieHeaders } = await import('../src/cookies.js');
  const proxy = http.createServer((req, res) => {
    // Two separate Set-Cookie headers, one carrying a comma inside Expires:
    // joining them into one string would make them impossible to split back.
    res.writeHead(200, {
      'content-type': 'text/html',
      'set-cookie': [
        'sid=abc; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
        'theme=dark; Path=/',
      ],
    });
    res.end('<html><title>ok</title></html>');
  });
  const port = await listen(proxy);
  try {
    const res = await proxyGet('http://example.test/page', `http://127.0.0.1:${port}`);
    const headers = getSetCookieHeaders(res);
    assert.equal(headers.length, 2);
    assert.match(headers[0], /^sid=abc;/);
    assert.match(headers[1], /^theme=dark;/);
  } finally {
    proxy.close();
  }
});

test('a body over the cap is refused, from the header or from the bytes', async () => {
  const { assertBodySize, readBody, MAX_BODY } = await import('../src/fetch.js');

  // The header check catches a response honest about its size early.
  assert.doesNotThrow(() => assertBodySize(MAX_BODY, 'https://example.test/big'));
  assert.throws(() => assertBodySize(MAX_BODY + 1, 'https://example.test/big'), /more than oc will read/);

  // The header is optional and untrusted, so the stream is counted too: a
  // chunked response crossing the cap fails deterministically, and one just
  // below it arrives whole.
  const mb = new Uint8Array(1024 * 1024).fill(120);
  const stream = (chunks) => new Response(new ReadableStream({
    start(c) {
      for (let i = 0; i < chunks; i++) c.enqueue(mb);
      c.close();
    },
  }));
  await assert.rejects(() => readBody(stream(26), 'https://example.test/bomb'), /more than oc will read/);
  const small = await readBody(stream(2), 'https://example.test/fine');
  assert.equal(small.length, 2 * 1024 * 1024);
});

test('the proxy transport counts the body against the same cap', async () => {
  const proxy = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    const mb = Buffer.alloc(1024 * 1024, 'x');
    for (let i = 0; i < 26; i++) res.write(mb);
    res.end();
  });
  const port = await listen(proxy);
  try {
    const res = await proxyGet('http://example.test/bomb', `http://127.0.0.1:${port}`);
    await assert.rejects(() => res.text(), /more than oc will read/);
  } finally {
    proxy.close();
  }
});

// A stand-in for the impers module whose get() either answers with a minimal
// 200 page or refuses the identity the way impers does when the loaded native
// library does not know the fingerprint an alias resolves to: it throws an
// ImpersonateError before any request leaves the process (issue #40, where a
// stale system libcurl-impersonate predating chrome150 broke oc outright).
const fakeImpers = (refuse, html = '<html>ok</html>') => {
  const identities = [];
  const get = (url, opts) => {
    identities.push(opts.impersonate);
    if (refuse.includes(opts.impersonate)) {
      const err = new Error(`Impersonating ${opts.impersonate} is not supported`);
      err.name = 'ImpersonateError';
      return Promise.reject(err);
    }
    return Promise.resolve({
      status: 200,
      headers: new Map([['content-type', 'text/html']]),
      text: () => Promise.resolve(html),
      url,
    });
  };
  return { get, identities };
};

test('a refused chrome fingerprint falls back to the firefox identity', () => withoutProxyEnv(async () => {
  const impers = fakeImpers(['chrome']);
  const page = await viaImpers(impers, 'https://public.example/page');
  assert.deepEqual(impers.identities, ['chrome', 'firefox']);
  assert.equal(page.via, 'impers:firefox');
  assert.equal(page.status, 200);
  assert.equal(page.html, '<html>ok</html>');
}));

test('when both identities are refused the page still arrives via plain fetch', async () => {
  // The proxy is only here to give viaFetch somewhere real to land without
  // leaving the machine, same shape as the HTTP_PROXY wiring test above.
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>via fetch</title></html>');
  });
  const port = await listen(proxy);
  const prev = Object.fromEntries(PROXY_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of PROXY_ENV_KEYS) delete process.env[k];
  process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
  try {
    const impers = fakeImpers(['chrome', 'firefox']);
    const page = await viaImpers(impers, 'http://1.1.1.1/page');
    assert.deepEqual(impers.identities, ['chrome', 'firefox']);
    assert.equal(page.via, 'fetch');
    assert.equal(page.status, 200);
    assert.equal(page.html, '<html><title>via fetch</title></html>');
    assert.deepEqual(seen, ['http://1.1.1.1/page']);
  } finally {
    proxy.close();
    for (const k of PROXY_ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
});

test('reddit.com is asked with the firefox fingerprint first', () => withoutProxyEnv(async () => {
  // Reddit's edge answers the chrome fingerprint with a 403 or a 429 while
  // letting firefox through (#52), and it rate-limits anonymous readers per
  // address, so a wasted chrome attempt there is a real cost, not a retry.
  assert.deepEqual(identityOrder('https://www.reddit.com/r/ClaudeAI/.rss'), ['firefox', 'chrome']);
  assert.deepEqual(identityOrder('https://old.reddit.com/r/ClaudeAI/'), ['firefox', 'chrome']);
  assert.deepEqual(identityOrder('https://reddit.com/'), ['firefox', 'chrome']);
  assert.deepEqual(identityOrder('https://notreddit.com/'), ['chrome', 'firefox']);
  assert.deepEqual(identityOrder('https://reddit.com.example/'), ['chrome', 'firefox']);
  assert.deepEqual(identityOrder('https://news.ycombinator.com/'), ['chrome', 'firefox']);
  assert.deepEqual(identityOrder('not a url'), ['chrome', 'firefox']);

  const impers = fakeImpers([]);
  const page = await viaImpers(impers, 'https://www.reddit.com/r/ClaudeAI/.rss');
  assert.deepEqual(impers.identities, ['firefox']);
  assert.equal(page.via, 'impers:firefox');
  assert.equal(page.status, 200);
}));

test('a refused firefox fingerprint on reddit.com falls back to chrome', () => withoutProxyEnv(async () => {
  const impers = fakeImpers(['firefox']);
  const page = await viaImpers(impers, 'https://www.reddit.com/r/ClaudeAI/.rss');
  assert.deepEqual(impers.identities, ['firefox', 'chrome']);
  assert.equal(page.via, 'impers:chrome');
  assert.equal(page.status, 200);
}));

test('only an ImpersonateError downgrades; other impers failures propagate', () => withoutProxyEnv(async () => {
  const impers = {
    get: () => Promise.reject(new Error('connection reset')),
  };
  await assert.rejects(() => viaImpers(impers, 'https://public.example/page'), /connection reset/);
}));
