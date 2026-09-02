import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { cachedFile } = await import('../src/cache.js');

// The cache fetches through fetchPage, which honors HTTP_PROXY, so a local
// proxy stands in for the network: it records every request and answers with
// whatever body the test hands it. A public IP literal keeps the target guard
// offline (no DNS), same as the fetch tests. Nothing leaves the machine.
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
const URL_JSON = 'http://1.1.1.1/docs/all.json';
const parseJSON = (text) => JSON.parse(text);

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// Runs fn with a fresh OC_HOME and a proxy serving `body`. Returns what the
// proxy saw so a test can prove the network was, or was not, touched.
async function withCache(body, fn) {
  const home = mkdtempSync(join(tmpdir(), 'oc-cache-'));
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  const port = await listen(proxy);
  const prevHome = process.env.OC_HOME;
  const prev = Object.fromEntries(PROXY_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of PROXY_ENV_KEYS) delete process.env[k];
  process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
  process.env.OC_HOME = home;
  try {
    await fn({ home, seen, file: join(home, 'sphinx', '1.1.1.1.json') });
  } finally {
    proxy.close();
    for (const k of PROXY_ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    if (prevHome === undefined) delete process.env.OC_HOME;
    else process.env.OC_HOME = prevHome;
  }
}

test('a miss fetches, parses, and writes the file under host and extension', () => withCache('{"n":1}', async ({ seen, file }) => {
  const { data, via } = await cachedFile('sphinx', URL_JSON, parseJSON);
  assert.deepEqual(data, { n: 1 });
  assert.equal(via, 'network');
  assert.deepEqual(seen, [URL_JSON]);
  // One directory per backend, one file per host, the URL's own extension.
  assert.equal(readFileSync(file, 'utf8'), '{"n":1}');
}));

test('a fresh file is served from disk and the network is never asked', () => withCache('{"n":"from network"}', async ({ home, seen, file }) => {
  mkdirSync(join(home, 'sphinx'), { recursive: true });
  writeFileSync(file, '{"n":"from disk"}');
  const { data, via } = await cachedFile('sphinx', URL_JSON, parseJSON);
  assert.deepEqual(data, { n: 'from disk' });
  assert.equal(via, 'cache');
  assert.equal(seen.length, 0);
}));

test('a file older than a day is refetched and replaced', () => withCache('{"n":"fresh"}', async ({ home, seen, file }) => {
  mkdirSync(join(home, 'sphinx'), { recursive: true });
  writeFileSync(file, '{"n":"stale"}');
  const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
  utimesSync(file, dayAgo, dayAgo);
  const { data, via } = await cachedFile('sphinx', URL_JSON, parseJSON);
  assert.deepEqual(data, { n: 'fresh' });
  assert.equal(via, 'network');
  assert.deepEqual(seen, [URL_JSON]);
  assert.equal(readFileSync(file, 'utf8'), '{"n":"fresh"}');
}));

test('a body the parser rejects is not written, so a block page cannot poison the cache', () => withCache('<html>please verify you are human</html>', async ({ seen, file }) => {
  await assert.rejects(() => cachedFile('sphinx', URL_JSON, parseJSON), SyntaxError);
  assert.deepEqual(seen, [URL_JSON]);
  assert.ok(!existsSync(file), 'the unparseable body was written to the cache');
}));

test('a stale copy survives a refetch whose body the parser rejects', () => withCache('not the index', async ({ home, file }) => {
  // The disk copy is too old to serve, but it is also the only good copy, and
  // the file is parsed before it is written, so the bad fetch leaves it alone.
  mkdirSync(join(home, 'sphinx'), { recursive: true });
  writeFileSync(file, '{"n":"stale but real"}');
  const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
  utimesSync(file, dayAgo, dayAgo);
  await assert.rejects(() => cachedFile('sphinx', URL_JSON, parseJSON), SyntaxError);
  assert.equal(readFileSync(file, 'utf8'), '{"n":"stale but real"}');
}));

test('a cache directory that cannot be created costs only the refetch', () => withCache('{"n":2}', async ({ home, seen }) => {
  // A regular file where the backend directory should be makes mkdir fail.
  // The same policy as session state: the answer still comes back, and the
  // next call pays for the network again rather than failing.
  writeFileSync(join(home, 'sphinx'), 'in the way');
  let result = await cachedFile('sphinx', URL_JSON, parseJSON);
  assert.deepEqual(result.data, { n: 2 });
  assert.equal(result.via, 'network');
  result = await cachedFile('sphinx', URL_JSON, parseJSON);
  assert.equal(result.via, 'network');
  assert.deepEqual(seen, [URL_JSON, URL_JSON]);
}));

test('a URL with no extension caches under the bare host, and kinds do not share files', () => withCache('{"n":3}', async ({ home }) => {
  await cachedFile('nodedoc', 'http://1.1.1.1/api/all', parseJSON);
  assert.ok(existsSync(join(home, 'nodedoc', '1.1.1.1')));
  assert.ok(!existsSync(join(home, 'sphinx')), 'a nodedoc fetch created the sphinx directory');
}));
