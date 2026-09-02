import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// Dispatch tests: the first word of argv reaches the right handler with the
// right arguments, and every wrong first word fails in one line that names the
// way out. Each case spawns the real binary against a throwaway OC_HOME, and
// none of them fetches: the page under test is seeded straight into a session
// file, so 'read', 'next', 'find', and 'do' on text all have something to
// answer with. Auth commands have their own file (cli-auth.test.js).
const OC_HOME = mkdtempSync(join(tmpdir(), 'oc-cli-'));
process.env.OC_HOME = OC_HOME;

const { distill } = await import('../src/distill.js');
const { render } = await import('../src/render.js');
const { saveSession, sessionFromPage } = await import('../src/session.js');

const bin = new URL('../src/cli.js', import.meta.url).pathname;
const newsHtml = readFileSync(new URL('./pages/news.html', import.meta.url), 'utf8');

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

function oc(args, envExtra = {}) {
  const env = { ...process.env, OC_HOME, ...envExtra };
  for (const k of PROXY_ENV_KEYS) if (!(k in envExtra)) delete env[k];
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env });
}

// Seeds a session the way 'oc open' would have, and hands back the page so a
// test can pick a number that means what it needs.
function seed(name = 'default') {
  const page = distill(newsHtml, 'https://example.test/news');
  const { stats } = render(page, { budget: 500 });
  saveSession(name, sessionFromPage(page, null, { cursor: stats.next }));
  return page;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('no command, --help, and -h all print the usage and exit 0', () => {
  for (const args of [[], ['--help'], ['-h']]) {
    const r = oc(args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^only-cli: the web as a compact terminal/);
    assert.match(r.stdout, /usage: oc <command> \[args\] \[flags\]/);
  }
});

test('the usage names every dispatchable command exactly once', () => {
  // The help text and the dispatch table live a hundred lines apart. A command
  // that dispatches but is not in the help is undiscoverable; one in the help
  // that does not dispatch is a wasted turn.
  const { stdout } = oc(['--help']);
  for (const command of ['open', 'find', 'next', 'read', 'raw', 'do', 'fill', 'submit', 'back', 'login', 'logout', 'session', 'sites']) {
    const listed = stdout.split('\n').filter((line) => new RegExp(`^  ${command}( |$)`).test(line));
    assert.equal(listed.length, 1, `'${command}' should be listed once in --help, found ${listed.length}`);
  }
});

test('an unknown first word fails in one line that points at --help', () => {
  const r = oc(['frobnicate']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim(), "oc: unknown command 'frobnicate', run oc --help");
});

test('a site name is tried as a shortcut before it is called unknown', () => {
  // The shortcut resolver owns the error here, so a wrong verb reports the
  // site's verbs, not 'unknown command'.
  const r = oc(['hn', 'frobnicate']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^oc: 'frobnicate' is not a news\.ycombinator\.com shortcut, try: /);
  assert.doesNotMatch(r.stderr, /unknown command/);
});

test('--budget must be a positive number, checked before any command runs', () => {
  // The negative case uses the '=' form: as a separate token, parseArgs reads
  // '-5' as a flag and refuses it itself before oc sees a value.
  for (const flag of [['--budget', 'abc'], ['--budget', '0'], ['--budget=-5']]) {
    const r = oc(['sites', ...flag]);
    assert.equal(r.status, 1, `${flag.join(' ')} should fail`);
    assert.equal(r.stderr.trim(), 'oc: --budget must be a positive number');
    assert.equal(r.stdout, '', `${flag.join(' ')} still ran the command`);
  }
});

test('a session name that is a path is refused before anything is read or written', () => {
  for (const bad of ['../etc', 'a/b', '.', '..']) {
    const r = oc(['next', '--session', bad]);
    assert.equal(r.status, 1, `--session ${bad} should fail`);
    assert.match(r.stderr, /^oc: invalid session name/);
  }
});

test('read, next, find, and do with nothing open say to run open first', () => {
  for (const args of [['read', '1'], ['next'], ['find', 'anything'], ['do', '1']]) {
    const r = oc([...args, '--session', 'never-opened']);
    assert.equal(r.status, 1, args.join(' '));
    assert.equal(r.stderr.trim(), "oc: nothing open in this session yet, run 'oc open <url>' first", args.join(' '));
  }
});

test('open and raw with no URL and nothing open print a usage line', () => {
  for (const command of ['open', 'raw']) {
    const r = oc([command, '--session', 'never-opened']);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trim(), `oc: usage: oc ${command} <url>`);
  }
});

test('read <n> prints the region at n from the saved page', () => {
  const page = seed('reading');
  const block = page.blocks.find((b) => b.n != null && b.type === 'heading');
  const r = oc(['read', String(block.n), '--session', 'reading']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(block.text), `read ${block.n} should print the block text:\n${r.stdout}`);
});

test('read without a valid number fails with usage rather than a stack trace', () => {
  seed('reading');
  for (const args of [['read'], ['read', 'abc'], ['read', '0']]) {
    const r = oc([...args, '--session', 'reading']);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /^oc: usage: oc read <n>/);
    assert.doesNotMatch(r.stderr, /\n\s+at /, 'stack trace leaked to stderr');
  }
});

test('next continues the saved page and reports the end when nothing is left', () => {
  seed('paging');
  // The news fixture fits in one render, so the saved cursor is already null
  // and next has nothing more to show. Either branch of next is one line an
  // agent can act on; this fixture exercises the end.
  const r = oc(['next', '--session', 'paging']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^end of https:\/\/example\.test\/news, nothing left to render/);
});

test('find joins the rest of argv into one query', () => {
  seed('finding');
  // Unquoted words reach find as separate argv entries; the footer offers
  // 'find <query>' without quotes, so this is how agents type it.
  const r = oc(['find', 'Show', 'HN', '--session', 'finding']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^1 match for "Show HN"|^\d+ matches for "Show HN"/);
});

test('find with no query fails with usage', () => {
  seed('finding');
  const r = oc(['find', '--session', 'finding']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^oc: usage: oc find <query>/);
});

test('do on a text number reads it in place and never fetches', async () => {
  const page = seed('doing');
  const block = page.blocks.find((b) => b.n != null && b.type === 'text' && !b.href);
  assert.ok(block, 'the news fixture should have a numbered text block');
  // A proxy that records requests is the proof: if do decided to fetch, the
  // request would land here.
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>should not be fetched</html>');
  });
  const port = await listen(proxy);
  try {
    const r = oc(['do', String(block.n), '--session', 'doing'], {
      HTTP_PROXY: `http://127.0.0.1:${port}`,
      HTTPS_PROXY: `http://127.0.0.1:${port}`,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(block.text), `do ${block.n} should print the text at [${block.n}]:\n${r.stdout}`);
    assert.equal(seen.length, 0, 'do on text sent a request');
  } finally {
    proxy.close();
  }
});

test('do without a number, or with one the page does not have, fails in one line', () => {
  seed('doing');
  let r = oc(['do', '--session', 'doing']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^oc: usage: oc do <n>/);
  r = oc(['do', '9999', '--session', 'doing']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^oc: no \[9999\] on https:\/\/example\.test\/news \(handles 1-\d+\), run 'oc open <url>' again/);
});

test('the planned commands fail with the same one-line message, naming themselves', () => {
  seed('stubs');
  for (const args of [['fill', '1', 'hello'], ['submit'], ['submit', '1'], ['back'], ['session', 'ls']]) {
    const r = oc([...args, '--session', 'stubs']);
    assert.equal(r.status, 1, args.join(' '));
    assert.equal(r.stdout, '', `${args[0]} printed to stdout`);
    assert.equal(r.stderr.trim(), `oc: 'oc ${args[0]}' is not available yet. Until then use 'oc open' and 'oc raw'.`);
  }
});

test('sites lists the bundled shortcuts and exits 0', () => {
  const r = oc(['sites']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /news\.ycombinator\.com/);
  assert.match(r.stdout, /\bhn\b/);
});

test('flags are accepted anywhere in argv, before or after the command', () => {
  seed('flags');
  const before = oc(['--session', 'flags', 'next']);
  const after = oc(['next', '--session', 'flags']);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(before.stdout, after.stdout);
});
