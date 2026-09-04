import test from 'node:test';
import assert from 'node:assert/strict';

const { resolveSite, listSites, sites } = await import('../src/sites.js');

test('a site resolves by short name, bare name, and full domain alike', () => {
  const expected = 'https://news.ycombinator.com/item?id=4711';
  for (const name of ['hn', 'ycombinator', 'news.ycombinator.com']) {
    assert.equal(resolveSite(name, ['item', '4711']).url, expected, `via ${name}`);
  }
});

test('a name oc ships no definition for resolves to null, not an error', () => {
  // cli.js reports 'unknown command' on null, so a typo must not be reported
  // as a site problem.
  assert.equal(resolveSite('example.com', ['open']), null);
  assert.equal(resolveSite('opne', []), null);
});

test('templating fills every arg in order and percent-encodes each value', () => {
  assert.equal(
    resolveSite('gh', ['repo', 'only-cli', 'oc']).url,
    'https://github.com/only-cli/oc');
  assert.equal(
    resolveSite('ddg', ['search', 'c++ operator?']).url,
    'https://html.duckduckgo.com/html/?q=c%2B%2B%20operator%3F');
});

test('the last arg takes every remaining word, so a query needs no quoting', () => {
  const quoted = resolveSite('ddg', ['search', 'claude code cli']).url;
  const bare = resolveSite('ddg', ['search', 'claude', 'code', 'cli']).url;
  assert.equal(bare, quoted);
});

test('a shortcut with no args ignores nothing and takes no args', () => {
  assert.equal(resolveSite('hn', ['top']).url, 'https://news.ycombinator.com');
});

test('a real site with a missing or unknown verb names the verbs it has', () => {
  assert.throws(() => resolveSite('reddit', []), /usage: oc reddit <verb>.*sub <name>/s);
  assert.throws(() => resolveSite('reddit', ['subreddit', 'ClaudeAI']),
    /not a reddit\.com shortcut.*sub <name>/s);
});

test('reddit verbs reach the www.reddit.com atom feeds, not old.reddit.com', () => {
  // old.reddit.com sends every logged-out request to a login page and the
  // .json views on www answer 403, so the feeds are the only public reading.
  assert.equal(resolveSite('reddit', ['sub', 'ClaudeAI']).url, 'https://www.reddit.com/r/ClaudeAI/.rss');
  assert.equal(resolveSite('reddit', ['post', '1w48zcr']).url, 'https://www.reddit.com/comments/1w48zcr/.rss');
  assert.equal(resolveSite('reddit', ['search', 'claude code']).url, 'https://www.reddit.com/search.rss?q=claude%20code');
  for (const verb of Object.keys(sites().get('reddit').commands)) {
    const { url } = resolveSite('reddit', [verb, 'x']);
    assert.ok(url.startsWith('https://www.reddit.com/'), `${verb} left www: ${url}`);
    assert.ok(/\.rss(\?|$)/.test(url), `${verb} is not a feed: ${url}`);
  }
});

test('a shortcut called with too few args says what it needs', () => {
  assert.throws(() => resolveSite('gh', ['repo', 'only-cli']), /usage: oc gh repo <owner> <name>/);
});

test('every shipped definition is reachable and every url template is filled', () => {
  const domains = new Set([...sites().values()].map((s) => s.domain));
  assert.ok(domains.size >= 10, `expected the shipped definitions, saw ${domains.size}`);
  for (const [name, site] of sites()) {
    for (const [verb, def] of Object.entries(site.commands)) {
      const args = (def.args ?? []).map((a) => `test-${a}`);
      const resolved = resolveSite(name, [verb, ...args]);
      // A search verb resolves to a site root or endpoint to ask, not a
      // URL: an API endpoint keeps {query} until search time, so it is
      // filled here the way apiSearch fills it before the template check.
      const url = resolved.url ?? resolved.sphinx ?? resolved.nodedoc ?? resolved.rdoc
        ?? (def.args ?? []).reduce((u, a) => u.replaceAll(`{${a}}`, `test-${a}`), resolved.api?.api ?? '');
      assert.doesNotMatch(url, /[{}]/, `oc ${name} ${verb} left a template var in ${url}`);
      assert.equal(new URL(url).protocol, 'https:', `oc ${name} ${verb} is not https`);
    }
  }
});

test('oc sites lists every site once, with a verb line an agent can copy', () => {
  const text = listSites();
  const domains = new Set([...sites().values()].map((s) => s.domain));
  for (const domain of domains) {
    assert.equal(text.split(domain).length - 1, 1, `${domain} should appear exactly once`);
  }
  assert.match(text, /^oc hn <verb> \(ycombinator, news\.ycombinator\.com\): top \| new \| item <id>/m);
});

test('language docs shortcuts resolve, and a doc path keeps its slashes', () => {
  assert.equal(
    resolveSite('py', ['library', 'json']).url,
    'https://docs.python.org/3/library/json.html');
  assert.equal(
    resolveSite('python', ['doc', 'reference/datamodel']).url,
    'https://docs.python.org/3/reference/datamodel.html');
  assert.equal(
    resolveSite('mdn', ['js', 'Array/map']).url,
    'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map');
  assert.equal(
    resolveSite('mozilla', ['css', 'grid-template-columns']).url,
    'https://developer.mozilla.org/en-US/docs/Web/CSS/grid-template-columns');
  assert.equal(
    resolveSite('node', ['api', 'fs']).url,
    'https://nodejs.org/api/fs.html');
  const node = resolveSite('nodejs.org', ['search', 'readFile', 'options']);
  assert.equal(node.nodedoc, 'https://nodejs.org/api/');
  assert.equal(node.query, 'readFile options');
  const py = resolveSite('py', ['search', 'json', 'dumps']);
  assert.equal(py.sphinx, 'https://docs.python.org/3/');
  assert.equal(py.query, 'json dumps');
  const mdn = resolveSite('mdn', ['search', 'array', 'map']);
  assert.equal(mdn.api.api, 'https://developer.mozilla.org/api/v1/search?q={query}&locale=en-US');
  assert.equal(mdn.query, 'array map');
});

test('the second wave of language docs resolves the same way', () => {
  assert.equal(resolveSite('go', ['pkg', 'net/http']).url, 'https://pkg.go.dev/net/http');
  assert.equal(
    resolveSite('go', ['search', 'json decode']).url,
    'https://pkg.go.dev/search?q=json%20decode');
  assert.equal(
    resolveSite('php', ['fn', 'array_map']).url,
    'https://www.php.net/manual-lookup.php?pattern=array_map');
  assert.equal(
    resolveSite('cpp', ['cpp', 'container/vector']).url,
    'https://en.cppreference.com/cpp/container/vector');
  assert.equal(
    resolveSite('cppreference', ['search', 'push_back']).url,
    'https://html.duckduckgo.com/html/?q=site%3Aen.cppreference.com+push_back');
  assert.equal(
    resolveSite('rust', ['std', 'vec/struct.Vec']).url,
    'https://doc.rust-lang.org/std/vec/struct.Vec.html');
  assert.equal(
    resolveSite('rust', ['search', 'Vec', 'retain']).url,
    'https://html.duckduckgo.com/html/?q=site%3Adoc.rust-lang.org+Vec%20retain');
  assert.equal(
    resolveSite('java', ['api', 'java.base/java/util/HashMap']).url,
    'https://docs.oracle.com/en/java/javase/26/docs/api/java.base/java/util/HashMap.html');
  assert.equal(
    resolveSite('java', ['search', 'HashMap', 'computeIfAbsent']).url,
    'https://html.duckduckgo.com/html/?q=site%3Adocs.oracle.com+javase+HashMap%20computeIfAbsent');
  assert.equal(
    resolveSite('ts', ['handbook', '2/everyday-types']).url,
    'https://www.typescriptlang.org/docs/handbook/2/everyday-types.html');
  assert.equal(
    resolveSite('ts', ['search', 'satisfies']).url,
    'https://html.duckduckgo.com/html/?q=site%3Atypescriptlang.org+satisfies');
  assert.equal(
    resolveSite('php', ['search', 'array', 'functions']).url,
    'https://html.duckduckgo.com/html/?q=site%3Aphp.net+array%20functions');
  assert.equal(
    resolveSite('learn', ['dotnet', 'system.string']).url,
    'https://learn.microsoft.com/en-us/dotnet/api/system.string');
  assert.equal(
    resolveSite('ruby', ['class', 'Array']).url,
    'https://docs.ruby-lang.org/en/3.4/Array.html');
  const ruby = resolveSite('docs.ruby-lang.org', ['search', 'each_slice']);
  assert.equal(ruby.rdoc, 'https://docs.ruby-lang.org/en/3.4/');
  assert.equal(ruby.query, 'each_slice');
});
