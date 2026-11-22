import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { distill, toMarkdown, jsonToHTML, fillTemplate, pick, TEXT_CAP } from '../src/distill.js';
import { render } from '../src/render.js';
import { resultsToHTML } from '../src/apisearch.js';
import { resolveSite, sites } from '../src/sites.js';

// Trimmed copies of real answers: PyPI's package endpoint for requests,
// crates.io's dependency list for tokio 1.47.1, npm's search for "http client",
// Keenable's search for "postgres 18 release notes".
const pypi = readFileSync(new URL('./pages/pypi_package.json', import.meta.url), 'utf8');
const deps = readFileSync(new URL('./pages/crates_dependencies.json', import.meta.url), 'utf8');
const npmSearch = JSON.parse(readFileSync(new URL('./pages/npm_search.json', import.meta.url), 'utf8'));
const keenableSearch = JSON.parse(readFileSync(new URL('./pages/keenable_search.json', import.meta.url), 'utf8'));

const PYPI_URL = 'https://pypi.org/pypi/requests/json';
const DEPS_URL = 'https://crates.io/api/v1/crates/tokio/1.47.1/dependencies';
const pypiView = () => resolveSite('pypi', ['pkg', 'requests']).view;
const depsView = () => resolveSite('crates', ['deps', 'tokio', '1.47.1']).view;
const texts = (page) => page.blocks.map((b) => b.text ?? '');

test('a view shows the named fields, in the named order, and nothing else', () => {
  // Left to guess, the generic view rendered the wheel files and their
  // hashes as the two items and never mentioned the version.
  const page = distill(pypi, PYPI_URL, { view: pypiView() });
  const lines = texts(page);
  assert.equal(lines[0], 'requests', 'a name-like first field is the bare title');
  assert.match(lines[1], /^version: 2\.34\.2 \| summary: Python HTTP for Humans\. \| requires_python: >=3\.10/);
  assert.ok(lines.some((t) => t.startsWith('requires_dist: charset_normalizer')), 'the last named field is missing');
  assert.ok(!lines.some((t) => /2a0d60c1|\.whl|sha256/.test(t)), 'an unnamed field leaked into the view');
  assert.ok(page.title.startsWith('pypi.org/pypi/requests/json'), `the endpoint is not the title:\n${page.title}`);
});

test('an object of scalars prints as key=value pairs when it is named', () => {
  const page = distill(pypi, PYPI_URL, { view: { keep: ['info.name', 'info.project_urls'] } });
  assert.ok(texts(page).some((t) => t === 'project_urls: Documentation=https://requests.readthedocs.io, Source=https://github.com/psf/requests'),
    `project_urls did not render as pairs:\n${texts(page).join('\n')}`);
});

test('a field holding a URL is a link of its own, so do <n> can follow it', () => {
  const page = distill(pypi, PYPI_URL, { view: { keep: ['info.name', 'info.package_url', 'info.version'] } });
  const link = page.blocks.find((b) => b.type === 'link');
  assert.equal(link?.href, 'https://pypi.org/project/requests/');
  assert.equal(link?.text, 'package_url: https://pypi.org/project/requests/');
  assert.ok(link.n, 'the link has no number');
});

test('list mode applies the fields to each item, and a template makes one line of them', () => {
  // The generic view spent two lines per dependency, one of them on a row id
  // and the same `optional: false` thirty times over, and lost `kind`, the
  // field that says whether a dependency is dev-only.
  const page = distill(deps, DEPS_URL, { view: depsView() });
  const lines = texts(page);
  assert.deepEqual(lines, [
    'async-stream ^0.3 dev',
    'backtrace ^0.3.58 normal cfg(tokio_taskdump)',
    'libc ^0.2.168 normal cfg(all(tokio_uring, target_os = "linux"))',
    'libc ^0.2.168 dev cfg(unix)',
    'pin-project-lite ^0.2.11 normal',
    'bytes ^1.2.1 normal optional',
  ]);
  assert.ok(page.title.includes('(6 items)'), `the count is not the list's:\n${page.title}`);
});

test('a true boolean prints its own name and a false one prints nothing', () => {
  const item = { name: 'widget', optional: true, yanked: false, nested: { dev: true } };
  assert.equal(fillTemplate('{name} {optional} {yanked} {nested.dev}', item), 'widget optional dev');
  const page = distill(JSON.stringify(item), 'https://x.test/i.json', { view: { keep: ['name', 'optional', 'yanked'] } });
  assert.deepEqual(texts(page), ['widget', 'optional']);
});

test('a template whose every slot is empty counts as a missing field', () => {
  assert.equal(fillTemplate('{a} {b}', { c: 1 }), '');
  assert.equal(fillTemplate('https://docs.rs/{id}', {}), '', 'literal text alone is not a value');
  assert.equal(fillTemplate('https://docs.rs/{id}', { id: 'serde' }), 'https://docs.rs/serde');
  assert.equal(pick({ a: { b: [{ c: 3 }] } }, 'a.b.0.c'), 3);
  assert.deepEqual(pick([1], ''), [1], 'the empty path is the value itself');
});

test('a response holding none of the named fields renders untouched', () => {
  // An error body or a changed API must show what the site actually said,
  // not an empty page shaped like the answer that never came.
  const error = JSON.stringify({ error: 'Not found', code: 404 });
  const withView = render(distill(error, PYPI_URL, { view: pypiView() }), { budget: 500 }).text;
  const without = render(distill(error, PYPI_URL), { budget: 500 }).text;
  assert.equal(withView, without);
  assert.match(withView, /Not found/);
  // A list path that is not a list falls through the same way.
  const notList = JSON.stringify({ dependencies: 'gone', errors: [{ detail: 'crate not found' }] });
  assert.match(render(distill(notList, DEPS_URL, { view: depsView() }), { budget: 500 }).text, /crate not found/);
});

test('raw ignores the view, since it exists to show what the view left out', () => {
  const markdown = toMarkdown(pypi, PYPI_URL);
  assert.match(markdown, /2a0d60c172f83ac6ab31e4554906c0f3b3588d37b5cb939b1c061f4907e278e0/);
  assert.equal(jsonToHTML(pypi, PYPI_URL, { full: true, view: pypiView() }), jsonToHTML(pypi, PYPI_URL, { full: true }));
});

test('short fields share a line but never one the compact view would cut', () => {
  const item = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`field_${i}`, `value number ${i} `.repeat(3).trim()]));
  const page = distill(JSON.stringify(item), 'https://x.test/wide.json', { view: { keep: Object.keys(item) } });
  const lines = texts(page);
  assert.ok(lines.length > 1, 'twelve fields fit one line only by being cut');
  for (const line of lines) assert.ok(line.length <= TEXT_CAP, `a shared line runs past the cap:\n${line}`);
  assert.equal(lines.join(' | ').split(' | ').length, 12, 'a field went missing in the wrap');
});

test('an ISO timestamp under a date-ish key drops its fraction and zone', () => {
  const page = distill(JSON.stringify({ name: 'v1', created_at: '2026-09-24T14:22:14.180Z', note: '2026-09-24T14:22:14.180Z' }),
    'https://x.test/v.json', { view: { keep: ['name', 'created_at', 'note'] } });
  assert.deepEqual(texts(page), ['v1', 'created_at: 2026-09-24 14:22:14 | note: 2026-09-24T14:22:14.180Z']);
});

test('the same response and view render the same page every time', () => {
  const a = render(distill(deps, DEPS_URL, { view: depsView() }), { budget: 500 }).text;
  const b = render(distill(deps, DEPS_URL, { view: depsView() }), { budget: 500 }).text;
  assert.equal(a, b);
});

test('an api search result can take its text and link from templates', () => {
  // npm's search answers with names and a version, description pair per
  // result; crates.io's answers with no URL at all, so the definition
  // builds one from the id.
  const npm = resolveSite('npm', ['search', 'http client']).api;
  const html = resultsToHTML(npm, 'http client', npmSearch, 'https://registry.npmjs.org/-/v1/search?text=http%20client');
  assert.match(html, /<a href="https:\/\/www\.npmjs\.com\/package\/axios">axios<\/a> 1\.20\.0 Promise based HTTP client/);
  assert.match(html, /754341 pages match/);
  const crates = resolveSite('crates', ['search', 'serde']).api;
  const data = { crates: [{ id: 'serde_json', name: 'serde_json', max_stable_version: '1.0.151', description: 'A JSON serialization file format' }], meta: { total: 1 } };
  assert.match(resultsToHTML(crates, 'serde', data, 'https://crates.io/api/v1/crates?q=serde'),
    /<a href="https:\/\/docs\.rs\/serde_json">serde_json<\/a> 1\.0\.151 A JSON/);
});

test('a Keenable search names oc in the URL and reads its text from snippet', () => {
  // The keyless endpoint wants the calling app named, and oc sends no custom
  // headers, so the name rides in keenable_title. Its description field is
  // always empty; the page text is in snippet, capped by the definition.
  const keenable = resolveSite('keenable', ['search', 'postgres', '18', 'release', 'notes']);
  assert.equal(keenable.query, 'postgres 18 release notes');
  const api = new URL(keenable.api.api.replace('{query}', 'x'));
  assert.equal(api.origin + api.pathname, 'https://api.keenable.ai/v1/search/public');
  assert.equal(api.searchParams.get('keenable_title'), 'only-cli');
  assert.equal(api.searchParams.get('snippet_max_length'), '200');
  const endpoint = 'https://api.keenable.ai/v1/search/public?query=postgres%2018%20release%20notes';
  const html = resultsToHTML(keenable.api, keenable.query, keenableSearch, endpoint);
  assert.match(html, /<a href="https:\/\/postgresql\.org\/docs\/18\/release-18-7\.html">E\.1\. Release 18\.7<\/a> Release 18\.7 #/);
  assert.match(html, /<p>4 pages match/);
  const { stats } = render(distill(html, endpoint), { budget: 500 });
  assert.equal(stats.rendered, stats.blocks, 'a result was cut from a four-result page');
});

test('an empty results path means the response itself is the list', () => {
  // RubyGems answers a search with a bare array.
  const gem = resolveSite('gem', ['search', 'http']).api;
  assert.equal(gem.results, '');
  const html = resultsToHTML(gem, 'http', [{ name: 'http', version: '6.0.4', info: 'A client.', project_uri: 'https://rubygems.org/gems/http' }], 'https://rubygems.org/api/v1/search.json?query=http');
  assert.match(html, /<a href="https:\/\/rubygems\.org\/gems\/http">http<\/a> 6\.0\.4 A client\./);
});

test('registry shortcuts resolve by alias, bare name, and domain, and carry their view', () => {
  for (const name of ['npm', 'npmjs', 'npmjs.com']) {
    const r = resolveSite(name, ['pkg', '@types/node']);
    assert.equal(r.url, 'https://registry.npmjs.org/@types/node/latest', `via ${name}`);
    assert.ok(r.view?.keep.includes('version'), 'the npm view is missing');
  }
  assert.equal(resolveSite('pip', ['version', 'django', '4.2']).url, 'https://pypi.org/pypi/django/4.2/json');
  assert.equal(resolveSite('pypi', ['search', 'http client']).url, 'https://html.duckduckgo.com/html/?q=site%3Apypi.org%2Fproject+http%20client');
  assert.equal(resolveSite('cargo', ['deps', 'tokio', '1.47.1']).url, DEPS_URL);
  assert.equal(resolveSite('crates.io', ['docs', 'serde']).url, 'https://docs.rs/serde');
  assert.equal(resolveSite('gem', ['versions', 'rails']).url, 'https://rubygems.org/api/v1/versions/rails.json');
  assert.equal(resolveSite('rubygems', ['gem', 'rails']).url, 'https://rubygems.org/api/v1/gems/rails.json');
  assert.equal(resolveSite('docker', ['official', 'redis']).url, 'https://hub.docker.com/v2/repositories/library/redis');
  assert.equal(resolveSite('docker', ['tags', 'library', 'redis']).view.list, 'results');
  // A shortcut with no keep carries no view, so nothing changes for the rest.
  assert.equal(resolveSite('hn', ['top']).view, undefined);
});

test('every view a shipped definition declares is well formed', () => {
  for (const [, site] of sites()) {
    for (const [verb, def] of Object.entries(site.commands)) {
      if (!def.keep && def.list == null) continue;
      assert.ok(def.open, `${site.domain} ${verb} has a view but no URL to apply it to`);
      assert.ok(Array.isArray(def.keep) && def.keep.length, `${site.domain} ${verb} keeps nothing`);
      for (const field of def.keep) assert.equal(typeof field, 'string', `${site.domain} ${verb} keep entries are strings`);
    }
  }
});
