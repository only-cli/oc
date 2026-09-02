import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every session helper reads OC_HOME when it runs, so pointing it at a temp
// directory here keeps the suite offline and out of the real home directory.
process.env.OC_HOME = mkdtempSync(join(tmpdir(), 'oc-test-'));

const { distill } = await import('../src/distill.js');
const { activate, read, next, find } = await import('../src/act.js');
const { sessionFromPage, saveSession, loadSession, resolveHref } = await import('../src/session.js');
const { render } = await import('../src/render.js');

const html = readFileSync(new URL('./pages/news.html', import.meta.url), 'utf8');
const searchHTML = readFileSync(new URL('./pages/search.html', import.meta.url), 'utf8');
const page = () => distill(html, 'https://example.test/news');
const open = (name = 'default', budget = 500) => {
  const p = page();
  saveSession(name, sessionFromPage(p, loadSession(name), { cursor: render(p, { budget }).stats.next }));
};

test("read cuts even a first block bigger than its whole budget", () => {
  // The first line of a read always prints, but its text is the page's to
  // write, so alone-over-budget still cuts: 'up to N tokens' is a promise the
  // page must not be able to break.
  const wall = 'sentence after sentence of the same thing. '.repeat(500);
  const p = distill(`<html><body><p id="wall">${wall}</p></body></html>`, 'https://example.test/wall');
  saveSession('wall', sessionFromPage(p, null, { cursor: null }));
  const n = p.blocks.find((b) => b.type === 'text').n;
  const out = read(n, { session: 'wall', budget: 100 });
  assert.ok(out.length < 100 * 4 + 200, `read printed ${out.length} chars against a budget of 100 tokens`);
  assert.match(out, /cut at ~100 tokens, raise --budget/);
});

test('a rendered page is remembered with absolute URLs for every handle', () => {
  open();
  const state = loadSession('default');
  assert.equal(state.url, 'https://example.test/news');
  assert.equal(state.blocks.find((b) => b.n === 2).href, 'https://example.test/item?id=1');
  assert.equal(state.blocks.length, page().blocks.length, 'the whole page must survive for read and next');
});

test('do follows the link behind a number without the agent seeing a URL', () => {
  open();
  assert.deepEqual(activate(2), { url: 'https://example.test/item?id=1', text: 'Show HN: I built a tiny CSV toolkit' });
});

test('do still works on a session saved by an older version', () => {
  saveSession('legacy', { url: 'https://example.test/old', handles: { 1: { type: 'link', text: 'a', href: 'https://example.test/a' } } });
  assert.equal(activate(1, { session: 'legacy' }).url, 'https://example.test/a');
  assert.throws(() => next({ session: 'legacy' }), /older oc, run 'oc open https:\/\/example.test\/old'/);
});

test('read prints the region at a number in full, uncut', () => {
  open();
  const out = read(9);
  assert.ok(out.includes('safely does'), 'read must not stop at the compact cap');
  assert.ok(!out.includes('+144 chars'), 'read must not print a cut marker for text it printed whole');
  assert.ok(out.includes('## [8] About'), 'the heading above the block gives it context');
  assert.ok(!out.includes('Postgres 18 released'), 'the section before it is not part of the region');
});

test('read of a heading takes the section under it', () => {
  open();
  const out = read(8);
  assert.ok(out.startsWith('## [8] About'));
  assert.ok(out.includes('safely does'));
});

test('a region too big for the budget says where to pick it up', () => {
  open();
  const out = read(8, { budget: 20 });
  assert.match(out, /region cut at ~20 tokens, continue with 'oc read \d+'/);
});

test('read and next explain themselves when the number or the page is missing', () => {
  open();
  assert.throws(() => read(9999), /no \[9999\].*oc open/s);
  assert.throws(() => read(0), /usage: oc read <n>/);
  assert.throws(() => read(1, { session: 'never-opened' }), /oc open <url>' first/);
});

test('find reports where a string is, with a number to read it by', () => {
  open();
  const out = find('postgres');
  assert.ok(out.startsWith('1 match for "postgres"'));
  assert.ok(out.includes('[4] Postgres 18 released'), `wrong hit line:\n${out}`);
  assert.ok(out.includes('actions: do <n>'), 'a link hit should offer do');
});

test('find opens the snippet on the match, not on the start of a long block', () => {
  // Several long blocks holding the same term is what puts find on its
  // snippet path: too much to print whole, too many to be the one answer.
  const filler = 'x'.repeat(300);
  saveSession('long', {
    url: 'https://example.test/long',
    blocks: [1, 2, 3].map((n) => ({ n, type: 'text', text: `${filler} needle ${filler}` })),
    cursor: null,
  });
  const out = find('needle', { session: 'long', budget: 40 });
  assert.match(out, /\[1\] \.\.\. .*needle/, 'the window must open on the match');
  assert.ok(!out.includes('x'.repeat(250)), `snippet was not trimmed:\n${out.slice(0, 200)}`);
});

test('find answers with the whole match when the matches fit', () => {
  open();
  // The point of the whole path: the text an agent would have spent a `read
  // <n>` on arrives in the command that found it.
  const many = find('fixture');
  assert.ok(!many.includes('...'), `nothing should be elided:\n${many}`);
  assert.ok(many.includes('which this sentence now safely does'), 'the block must arrive whole');
});

test('a single match is read, not pointed at', () => {
  open();
  // One hit means the agent has already said where it wants to look, so the
  // number alone would cost a turn to resolve into the region behind it.
  const out = find('lazy dog');
  assert.match(out, /1 match for "lazy dog", region \[9\]/);
  assert.ok(out.includes('which this sentence now safely does'), 'the region must arrive with it');
  assert.ok(out.includes('## [8] About'), 'and with the heading that gives it context');
});

test('a phrase that matches nothing falls back to the words, and says so', () => {
  open();
  const out = find('dog quick');
  assert.ok(out.includes('matching the words separately'));
  assert.ok(out.includes('[9]'));
  assert.match(find('nothing here at all'), /no match .* as a phrase or as separate words/);
});

test('find caps its own output and says how many it held back', () => {
  open();
  const out = find('comments', { budget: 3 });
  assert.match(out, /\.\.\. \d+ more matches/);
});

test('find needs a query and a page', () => {
  open();
  assert.throws(() => find('  '), /usage: oc find <query>/);
  assert.throws(() => find('x', { session: 'never-opened' }), /oc open <url>' first/);
});

test('next continues where the budget stopped, then says the page is done', () => {
  // Small enough that the fixture stays well past the budget, or the finish
  // rule would hand the whole page over in one go and there would be no paging.
  open('paged', 25);
  const first = next({ session: 'paged', budget: 25 });
  assert.ok(first.startsWith('# Fixture News (continued)'));
  assert.ok(!first.includes('Show HN'), 'next must not reprint what open already charged for');
  let out = first;
  for (let i = 0; i < 10 && loadSession('paged').cursor != null; i++) {
    out = next({ session: 'paged', budget: 25 });
  }
  assert.equal(loadSession('paged').cursor, null, 'paging must reach the end of the page');
  assert.ok(out.includes('newest'), 'the last block of the page must come out eventually');
  assert.match(next({ session: 'paged' }), /end of https:\/\/example.test\/news/);
});

test('search result redirectors resolve to the page they wrap', () => {
  const wrapped = 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fdoc.rust-lang.org%2Fbook%2F&rut=abc';
  assert.equal(resolveHref(wrapped, 'https://html.duckduckgo.com/html/'), 'https://doc.rust-lang.org/book/');
  assert.equal(resolveHref('https://www.google.com/url?q=https://example.test/a', ''), 'https://example.test/a');
  // A normal link that merely has a url-shaped query parameter is left alone.
  assert.equal(
    resolveHref('/search?url=https://example.test/a', 'https://example.test/'),
    'https://example.test/search?url=https://example.test/a',
  );
});

test('links a browser cannot follow are not offered as handles', () => {
  assert.equal(resolveHref('javascript:void(0)', 'https://example.test/'), null);
  assert.equal(resolveHref('', 'https://example.test/'), null);
});

test('every failure names the command that fixes it', () => {
  open();
  assert.throws(() => activate(9999), /handles 1-\d+.*oc open/s);
  assert.throws(() => activate(0), /usage: oc do <n>/);
  assert.throws(() => activate(1, { session: 'never-opened' }), /oc open <url>' first/);

  const input = page().blocks.find((b) => b.type === 'input');
  assert.throws(() => activate(input.n), /is an input.*oc fill/s);
  const button = page().blocks.find((b) => b.type === 'button');
  assert.throws(() => activate(button.n), /no link to follow/);
});

test('do on a heading or a text block reads it instead of refusing', () => {
  open();
  // Nothing to fetch, so the caller is told to read rather than to open. An
  // error here would cost a turn to say what the next command should be.
  assert.deepEqual(activate(1), { read: 1, text: 'Fixture News' });
  assert.equal(activate(9).read, 9);
  assert.ok(read(activate(9).read).includes('safely does'), 'the read must be the full text');
});

test('do on a search result title opens it instead of reading it back', () => {
  // What this costs when it goes wrong: `do` on the most obvious number on a
  // results page, the title, used to print the title back, so the agent spent
  // one turn learning nothing and another finding the number that navigates.
  const p = distill(searchHTML, 'https://fixture.test/html/?q=s3+cp+recursive');
  saveSession('search', sessionFromPage(p, null, { cursor: render(p, { budget: 500 }).stats.next }));
  const target = activate(1, { session: 'search' });
  assert.equal(target.read, undefined, 'a title that is a link must not be read back');
  // The engine wraps its results in a click tracker whose landing page is a
  // script, so the handle has to resolve to the destination itself.
  assert.equal(target.url, 'https://docs.example.test/s3/cp.html');

  const pilcrow = p.blocks.find((b) => b.type === 'heading' && b.text.startsWith('Options'));
  assert.equal(activate(pilcrow.n, { session: 'search' }).read, pilcrow.n, 'a permalink heading still reads');
});

test('named sessions keep separate page state', () => {
  open('work');
  saveSession('other', { url: 'https://example.test/other', blocks: [], cursor: null });
  assert.equal(activate(2, { session: 'work' }).url, 'https://example.test/item?id=1');
  assert.throws(() => activate(2, { session: 'other' }), /no \[2\]/);
});

test('history grows with each page and stays bounded', () => {
  let state = null;
  for (let i = 0; i < 25; i++) state = sessionFromPage(distill(html, `https://example.test/p${i}`), state);
  assert.equal(state.history.length, 20);
  assert.equal(state.history.at(-1), 'https://example.test/p24');
});

test('a snippet stays one line even when the block it came from is code', () => {
  // Code blocks keep their newlines. An index that prints one match per line
  // cannot, or the header's count stops matching what is on screen. Long
  // filler beside it is what keeps find on the snippet path.
  const filler = 'x'.repeat(600);
  saveSession('code', {
    url: 'https://fixture.test/c',
    blocks: [
      { n: 1, type: 'text', text: ['first();', 'needle();', 'third();'].join('\n') },
      { n: 2, type: 'text', text: `${filler} needle ${filler}` },
    ],
    cursor: null,
  });
  const out = find('needle', { session: 'code', budget: 20 });
  const lines = out.split('\n');
  assert.match(lines[0], /^2 matches for "needle"/);
  assert.equal(lines[1], '[1] first(); needle(); third();');
});

test('no footer names a command that is not available yet', async () => {
  // The footer is the line an agent reads to decide what to run next, so a
  // name in it that always throws costs a turn and returns nothing. Which
  // commands are stubs is probed here rather than listed, so the next stub to
  // land is covered without anyone remembering to come back and add it.
  const act = await import('../src/act.js');
  const stubs = Object.entries(act)
    .filter(([, value]) => typeof value === 'function')
    .filter(([, fn]) => {
      try {
        fn();
        return false;
      } catch (err) {
        return err instanceof act.NotImplemented;
      }
    })
    .map(([name]) => name);
  assert.ok(stubs.length, 'the probe found no stubs, so it is no longer testing anything');

  open();
  const loginHTML = readFileSync(new URL('./pages/login.html', import.meta.url), 'utf8');
  // One output per place that builds a footer: a render with inputs, which is
  // what used to offer fill and submit, and both of find's paths.
  const outputs = [
    render(page(), { budget: 500 }).text,
    render(distill(loginHTML, 'https://example.test/login'), { budget: 500 }).text,
    find('postgres'),
    find('a'),
  ];
  const footers = outputs.flatMap((out) => out.split('\n').filter((line) => line.startsWith('actions:')));
  assert.equal(footers.length, outputs.length, `every output should carry one footer:\n${footers.join('\n')}`);
  for (const footer of footers) {
    for (const stub of stubs) {
      assert.ok(!footer.includes(stub), `footer offers '${stub}', which throws NotImplemented:\n${footer}`);
    }
  }
});

test('every footer offers find, the cheapest way to go deeper on a page', () => {
  // SKILL.md lists find first under "going further, cheapest first", and the
  // footer is what an agent actually reads, so the two have to agree. Same
  // three footer sites as the stub probe above: a render, and both of find's
  // paths.
  open();
  const outputs = [
    render(page(), { budget: 500 }).text,
    find('postgres'),
    find('a'),
  ];
  const footers = outputs.map((out) => out.split('\n').find((line) => line.startsWith('actions:')));
  assert.equal(footers.filter(Boolean).length, outputs.length, `every output should carry a footer:\n${footers.join('\n')}`);
  for (const footer of footers) {
    assert.ok(footer.includes('find <query>'), `footer should offer find:\n${footer}`);
    // Cheapest first: find is listed ahead of read.
    assert.ok(footer.indexOf('find <query>') < footer.indexOf('read <n>'), `find should come before read:\n${footer}`);
  }
});
