import test from 'node:test';
import assert from 'node:assert/strict';

const { fetchPage } = await import('../src/fetch.js');

const BLOCKED_MESSAGE = 'blocked: private or internal URL';

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
  try {
    await fetchPage('example.com');
  } catch (err) {
    assert.ok(!err.message.includes(BLOCKED_MESSAGE), `unexpected block: ${err.message}`);
  }
});

test('fetchPage does not false-positive on a public hostname that merely starts with a private-looking numeric label', async () => {
  // Regression check: an earlier version of this guard matched the URL's
  // hostname STRING against ^-anchored prefixes like "10." and could not
  // tell a private IPv4 octet from an ordinary DNS label, so a domain like
  // 10.example.com (subdomain "10" of example.com) was wrongly blocked as if
  // it were 10.0.0.0/8. Validating the resolved address instead of the
  // string fixes this.
  try {
    await fetchPage('10.example.com');
  } catch (err) {
    assert.ok(!err.message.includes(BLOCKED_MESSAGE), `unexpected block: ${err.message}`);
  }
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

test('fetchPage re-validates every redirect hop, not just the original URL', async () => {
  // httpbin.org is a public host with no reason to be blocked itself; its
  // /redirect-to endpoint 302s wherever it's told, which is exactly the
  // shape of an SSRF that hides the real target behind a public-looking
  // first hop.
  const redirector = `https://httpbin.org/redirect-to?url=${encodeURIComponent('http://127.0.0.1/admin')}`;
  await assert.rejects(() => fetchPage(redirector), new RegExp(BLOCKED_MESSAGE));
});
