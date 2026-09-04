import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { distill, toMarkdown, toHTML, feedToHTML, jsonToHTML, youtubeToHTML, transcriptToHTML, TEXT_CAP } from '../src/distill.js';
import { render, estimateTokens, contentTokens, contentFailure } from '../src/render.js';

const PAGES = new URL('./pages/', import.meta.url).pathname;
const html = readFileSync(new URL('./pages/news.html', import.meta.url), 'utf8');
const page = () => distill(html, 'https://example.test/news');
const feed = readFileSync(new URL('./pages/feed.xml', import.meta.url), 'utf8');
const forum = readFileSync(new URL('./pages/forum.html', import.meta.url), 'utf8');
const thread = () => distill(forum, 'https://example.test/t/1');
const timeline = readFileSync(new URL('./pages/social.html', import.meta.url), 'utf8');
const social = () => distill(timeline, 'https://social.test/fixture');
const api = readFileSync(new URL('./pages/api.json', import.meta.url), 'utf8');
const API_URL = 'https://api.example.test/2.3/search/advanced?site=fixture&q=sky+blue';
const results = () => distill(api, API_URL);
// Turndown escapes the underscores in field names, which is correct markdown
// and only noise to assert against.
const rawApi = () => toMarkdown(api, API_URL).replace(/\\_/g, '_');
const searchHTML = readFileSync(new URL('./pages/search.html', import.meta.url), 'utf8');
const search = () => distill(searchHTML, 'https://fixture.test/html/?q=s3+cp+recursive');
const docsHTML = readFileSync(new URL('./pages/docs.html', import.meta.url), 'utf8');
const docs = () => distill(docsHTML, 'https://docs.fixture.test/s3/cp.html');
const codeBlock = (match) => docs().blocks.find((b) => (b.text ?? '').includes(match))?.text ?? '';

test('noise never reaches the output, compact or raw', () => {
  for (const out of [render(page(), { budget: 5000 }).text, toMarkdown(html), toHTML(html)]) {
    assert.ok(!out.includes('tracker'), 'script content leaked');
    assert.ok(!out.includes('font-family'), 'style content leaked');
    assert.ok(!out.includes('cookies'), 'display:none content leaked');
    assert.ok(!out.includes('hidden drawer'), 'hidden attribute content leaked');
    assert.ok(!out.includes('csrf'), 'hidden input leaked');
  }
});

test('raw mode emits real markdown with hrefs an agent can follow', () => {
  const md = toMarkdown(html);
  assert.ok(md.startsWith('# Fixture News'));
  assert.ok(md.includes('[Show HN: I built a tiny CSV toolkit](/item?id=1)'), 'link markdown missing');
});

test('raw html mode keeps markup', () => {
  const out = toHTML(html);
  assert.ok(out.includes('<a href="/item?id=1">'), 'anchor tag missing');
  assert.ok(!out.includes('<script'), 'script tag survived');
});

test('elements get numbered handles in document order', () => {
  const p = page();
  const links = p.blocks.filter((b) => b.type === 'link');
  assert.equal(links[0].text, 'Show HN: I built a tiny CSV toolkit');
  assert.equal(links[0].n, 2, 'the page heading takes [1]');
  const input = p.blocks.find((b) => b.type === 'input');
  assert.equal(input.name, 'q');
  const button = p.blocks.find((b) => b.type === 'button');
  assert.equal(button.text, 'Search');
  // Numbers rise once, in document order, and never repeat.
  const nums = p.blocks.filter((b) => b.n != null).map((b) => b.n);
  assert.deepEqual(nums, nums.map((_, i) => i + 1));
});

test('a text block long enough to be cut is numbered, a short one is not', () => {
  const p = page();
  const long = p.blocks.find((b) => b.type === 'text' && b.text.length > TEXT_CAP);
  assert.ok(long.n, 'a cut block with no number cannot be read back');
  const short = p.blocks.find((b) => b.type === 'text' && b.text === '312 points');
  assert.equal(short.n, undefined);
});

test('same page yields the same output', () => {
  assert.equal(render(page()).text, render(page()).text);
});

test('a page well past the budget is cut, and what was cut is priced', () => {
  const { text, stats } = render(page(), { budget: 25 });
  assert.ok(stats.tokens <= 60, `render cost ~${stats.tokens} tokens against a budget of 25`);
  assert.match(text, /\.\.\. \d+ more blocks \(~\d+ tokens\)/, 'what was cut must be priced');
  assert.ok(text.includes("'oc next'"), 'the cheapest way to the rest must be named');
  assert.ok(text.includes('| next |'), 'next belongs in the actions of a cut page');
});

test('a page that ends just past the budget is finished instead of cut', () => {
  // The fixture costs about 134 tokens whole. Cutting it at 40 would save 90
  // tokens and charge a whole extra turn to get them back, which is a bad trade.
  const { text, stats } = render(page(), { budget: 40 });
  assert.equal(stats.next, null, 'a page within reach of the budget must come out whole');
  assert.ok(!text.includes('more blocks'), 'nothing was cut, so nothing should be priced');
  assert.ok(text.includes('newest'), 'the last block of the page must be there');
  // The allowance is not unlimited: a page far past the budget still gets cut.
  assert.equal(typeof render(thread(), { budget: 100 }).stats.next, 'number');
});

test('what a render stops at is where the next one starts', () => {
  const p = page();
  const first = render(p, { budget: 25 });
  assert.equal(typeof first.stats.next, 'number');
  const rest = render(p, { budget: 500, from: first.stats.next });
  assert.ok(rest.text.startsWith('# Fixture News (continued)'));
  assert.equal(rest.stats.next, null, 'the second render finishes the page');
  // Nothing is printed twice and nothing is lost between the two.
  assert.ok(!rest.text.includes('Show HN'));
  assert.ok(first.text.includes('Show HN'));
  assert.ok(rest.text.includes('Postgres 18 released'));
  assert.ok(rest.text.includes('input q'));
});

test('a page render never stalls on a block bigger than the budget', () => {
  const { text, stats } = render(page(), { budget: 1 });
  assert.ok(stats.next > 0, 'one block must always go out or next can never advance');
  assert.ok(text.includes('Show HN'), 'the block that did not fit is printed anyway');
  assert.ok(text.includes('more blocks'));
});

test('default render of a normal page fits the 500 token target', () => {
  const { stats } = render(page());
  assert.ok(stats.tokens <= 500, `render cost ~${stats.tokens} tokens`);
});

test('long text is truncated with a marker', () => {
  const { text } = render(page(), { budget: 2000 });
  assert.ok(text.includes(' ...'), 'expected a truncation marker');
  assert.ok(!text.includes('safely does'), 'text cap was not applied');
});

test('title becomes the page heading', () => {
  assert.ok(render(page()).text.startsWith('# Fixture News'));
});

test('token estimate is stable and roughly chars over four', () => {
  assert.equal(estimateTokens('abcdefgh'), 2);
});

test('atom feeds render as pages: entries become headings, bodies unescape', () => {
  const p = distill(feed, 'https://example.test/feeds/question/42');
  assert.equal(p.title, 'Why is the sky blue? - Fixture Overflow');
  const headings = p.blocks.filter((b) => b.type === 'heading');
  assert.equal(headings[0].text, 'Why is the sky blue?');
  assert.equal(headings[1].text, 'Answer by Tyndall for Why is the sky blue?');
  const open = p.blocks.find((b) => b.type === 'link' && b.text === 'open');
  assert.equal(open.href, 'https://example.test/questions/42/why-is-the-sky-blue');
  const text = p.blocks.map((b) => b.text).join(' ');
  assert.ok(text.includes('Rayleigh scattering'), 'entry body missing');
  assert.ok(text.includes('by Ray Leigh, 2026-04-08'), 'byline missing');
  assert.ok(!text.includes('&lt;'), 'entry body left escaped');
});

test('a reddit post feed renders as the post followed by its comments', () => {
  // Reddit closed old.reddit.com and its .json views to logged-out readers in
  // 2026; the Atom feeds on www.reddit.com are what oc reddit rides now. A
  // post feed is one entry for the post and one per comment, each comment
  // titled "/u/name on <post title>", so the whole thread reads as one page.
  const xml = readFileSync(new URL('./pages/reddit_post.xml', import.meta.url), 'utf8');
  const p = distill(xml, 'https://www.reddit.com/comments/1fixture/.rss');
  assert.equal(p.title, 'Why does the budget flag round up? : reddit.com');
  const headings = p.blocks.filter((b) => b.type === 'heading').map((b) => b.text);
  assert.deepEqual(headings, [
    'Why does the budget flag round up?',
    '/u/first_reply on Why does the budget flag round up?',
    '/u/second_reply on Why does the budget flag round up?',
  ]);
  const text = p.blocks.map((b) => b.text).join(' ');
  assert.ok(text.includes('Is that on purpose?'), 'post body missing');
  assert.ok(text.includes('by /u/fixture_poster, 2026-09-01'), 'post byline missing');
  assert.ok(text.includes('One extra tool call costs more'), 'comment body missing');
  assert.ok(!text.includes('SC_OFF'), 'reddit markup comments leaked into the text');
  const rendered = render(p).text;
  assert.ok(rendered.includes('## [1] Why does the budget flag round up?'), 'post is not the first numbered heading');
  assert.ok(estimateTokens(rendered) < 500, `three-entry thread should fit the default budget, got ${estimateTokens(rendered)}`);
});

test('feed entry code blocks survive raw markdown', () => {
  const md = toMarkdown(feed);
  assert.ok(md.startsWith('# Why is the sky blue? - Fixture Overflow'));
  assert.ok(md.includes('wavelength < 450nm'), 'code content missing');
  assert.ok(md.includes('[the derivation](https://example.test/scattering)'), 'link inside entry body missing');
});

test('rss with cdata bodies converts too, ordinary html does not', () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture Blog</title>
    <item><title>Post one</title><guid>https://example.test/p/1</guid>
    <pubDate>Mon, 17 Aug 2026 00:00:00 GMT</pubDate>
    <description><![CDATA[<p>A <em>cdata</em> body with markup.</p>]]></description></item>
    </channel></rss>`;
  const p = distill(rss, 'https://example.test/rss');
  assert.equal(p.title, 'Fixture Blog');
  const text = p.blocks.map((b) => b.text).join(' ');
  assert.ok(text.includes('A cdata body with markup.'), 'cdata body missing');
  assert.equal(feedToHTML(html), null, 'ordinary html misread as a feed');
});

test('a youtube watch page renders as title, byline, description, and transcript links', () => {
  const watch = readFileSync(new URL('./pages/youtube_watch.html', import.meta.url), 'utf8');
  const p = distill(watch, 'https://www.youtube.com/watch?v=fixture123');
  assert.equal(p.title, 'Rust for busy people: the borrow checker in five minutes');
  const heading = p.blocks.find((b) => b.type === 'heading');
  assert.equal(heading.text, 'Rust for busy people: the borrow checker in five minutes');
  const text = p.blocks.map((b) => b.text).join(' | ');
  assert.ok(text.includes('by Fixture Channel'), 'author missing from byline');
  assert.ok(text.includes('128,453 views'), 'view count missing');
  assert.ok(text.includes('2026-03-04'), 'publish date missing');
  assert.ok(text.includes('A quick walkthrough of ownership and borrowing.'), 'description missing');
  const channel = p.blocks.find((b) => b.type === 'link' && b.text === 'channel');
  assert.equal(channel.href, 'https://www.youtube.com/channel/UCexampleChannelId000001');
  const transcripts = p.blocks.filter((b) => b.type === 'link' && b.text.startsWith('transcript:'));
  assert.equal(transcripts.length, 2);
  assert.ok(transcripts[0].text.includes('auto-generated'), 'asr track not labeled auto-generated');
  assert.equal(transcripts[0].href, 'https://www.youtube.com/api/timedtext?v=fixture123&lang=en');
  assert.ok(!transcripts[1].text.includes('auto-generated'), 'manual track mislabeled auto-generated');
  assert.equal(youtubeToHTML(html), null, 'ordinary html misread as a watch page');
});

test('a youtube timedtext response becomes one readable block, duplicates dropped', () => {
  const xml = '<?xml version="1.0" encoding="utf-8" ?><transcript>'
    + '<text start="0.0" dur="2.5">We&#39;re no strangers to love</text>'
    + '<text start="2.5" dur="2.5">We&#39;re no strangers to love</text>'
    + '<text start="5.0" dur="3.0">You know the rules and so do I</text>'
    + '</transcript>';
  const p = distill(xml, 'https://www.youtube.com/api/timedtext?v=fixture123&lang=en');
  const text = p.blocks.map((b) => b.text).join(' ');
  assert.equal((text.match(/We're no strangers to love/g) ?? []).length, 1, 'duplicate cue was not dropped');
  assert.ok(text.includes('You know the rules and so do I'), 'second cue missing');
  assert.equal(transcriptToHTML(html), null, 'ordinary html misread as a transcript');
});

test('the content leads the page and the chrome follows it', () => {
  const { text } = render(thread(), { budget: 500 });
  const lines = text.split('\n');
  // The budget is spent top down, so what matters is that comments are inside
  // the first view at all: on this page they used to start below it.
  assert.ok(text.includes('Lynx is the one I keep coming back to'), `content missed the first view:\n${text}`);
  assert.ok(!text.includes('section 7'), 'nav still printed ahead of the content');
  const blocks = thread().blocks;
  const divider = blocks.findIndex((b) => b.type === 'divider' && b.text.includes('rest of page'));
  const nav = blocks.findIndex((b) => b.text === 'section 7');
  assert.ok(divider > 0 && nav > divider, 'the nav was not moved below the content');
  assert.ok(lines[1].startsWith('# '), 'the first line under the title is not the content heading');
});

test('nothing is dropped when the content is moved up, only reordered', () => {
  const blocks = thread().blocks;
  const text = blocks.map((b) => b.text).join(' ');
  assert.ok(text.includes('section 13'), 'a nav link went missing');
  assert.ok(text.includes('terms'), 'a footer link went missing');
  assert.ok(text.includes('This sidebar exists on every page'), 'sidebar text went missing');
});

test('per item controls that repeat down a page are dropped, and say so', () => {
  const blocks = thread().blocks;
  assert.ok(!blocks.some((b) => b.type === 'link' && b.text === 'permalink'), 'per comment chrome survived');
  assert.ok(blocks.some((b) => b.type === 'link' && b.text === 'commenter3'), 'a unique link was dropped with them');
  const note = blocks.find((b) => b.type === 'divider' && b.text.includes('repeated controls hidden'));
  assert.ok(note, 'links vanished with nothing said about it');
  assert.ok(note.text.includes("'oc raw' has them"), 'the note does not say how to get them back');
  assert.ok(toMarkdown(forum).includes('permalink'), 'raw lost them too, so the note lies');
});

test('a page that fits the budget is left in document order', () => {
  const blocks = page().blocks;
  assert.ok(!blocks.some((b) => b.type === 'divider'), 'a small page was reordered for no reason');
  assert.equal(blocks[0].text, 'Fixture News');
});

test('an entity does not put spaces inside a word', () => {
  // linkedom splits a text node at every entity, so `isn&#x27;t` arrives as
  // three nodes and used to come back out as `isn ' t`.
  const text = social().blocks.map((b) => b.text).join('\n');
  assert.ok(text.includes("isn't drawing"), `apostrophe split:\n${text.slice(0, 400)}`);
  assert.ok(text.includes('interface & its restraint'), 'a real space was swallowed');
});

test('an icon button is named by its aria-label, a nameless one is dropped', () => {
  const blocks = social().blocks;
  assert.ok(blocks.some((b) => b.type === 'button' && b.text === 'Follow'), 'a labelled button went missing');
  assert.ok(!blocks.some((b) => b.type === 'button' && b.text === 'button'), 'a button with no name was printed anyway');
  const html = '<html><head><title>T</title></head><body><button aria-label="Reply"></button></body></html>';
  const one = distill(html, 'https://x.test').blocks.find((b) => b.type === 'button');
  assert.equal(one.text, 'Reply');
});

test('per item buttons repeat sooner than links before they count as furniture', () => {
  const blocks = social().blocks;
  // Six posts, six sets of Reply/Repost/Like/Bookmark/Share/More.
  assert.ok(!blocks.some((b) => b.type === 'button' && b.text === 'Reply'), 'per post controls survived');
  const note = blocks.find((b) => b.type === 'divider' && b.text.includes('repeated controls hidden'));
  assert.ok(note, 'controls vanished with nothing said about it');
});

test('separate posts stay separate blocks', () => {
  // With the per post controls gone there is nothing left between one post and
  // the next, so without a block boundary six posts merge into one long line
  // and `read <n>` can no longer address any single one of them.
  const texts = social().blocks.filter((b) => b.type === 'text').map((b) => b.text);
  const ncurses = texts.find((t) => t.includes('ncurses'));
  assert.ok(ncurses, 'the first post went missing');
  assert.ok(!ncurses.includes('1987 manual'), `two posts merged into one block:\n${ncurses}`);
});

test('a json api response renders as items, each title a link to its page', () => {
  const p = results();
  assert.equal(p.title, 'api.example.test/2.3/search/advanced: "sky blue" (3 items)');
  const links = p.blocks.filter((b) => b.type === 'link');
  assert.equal(links[0].text, 'Why is the sky blue, and why does "blue" scatter most?', 'title left html-escaped');
  assert.equal(links[0].href, 'https://example.test/questions/42/why-is-the-sky-blue');
  assert.ok(links[0].n, 'a result with no handle cannot be followed');
  const text = p.blocks.map((b) => b.text).join('\n');
  assert.ok(/score: 512/.test(text), 'the fields that vary went missing');
});

test('fields identical on every item are stated once, not thirty times', () => {
  const { text } = render(results(), { budget: 2000 });
  assert.equal(text.match(/content_license/g).length, 1, 'a constant field repeated per item');
  assert.ok(text.includes('same on every item: is_answered=true, content_license=CC BY-SA 4.0'));
  assert.ok(text.includes('empty on every item: closed_date'), 'a null-everywhere field vanished silently');
});

test('the compact view drops low-value fields and says which, raw keeps them all', () => {
  const { text } = render(results(), { budget: 2000 });
  assert.ok(!text.includes('profile_image'), 'an image url outscored the fields worth reading');
  assert.ok(/\d+ fields per item not shown \(/.test(text), 'fields went missing with nothing said about it');
  const md = rawApi();
  assert.ok(md.includes('profile_image'), 'raw mode is the escape hatch and has to hold everything');
  assert.ok(md.includes('owner.display_name: Ray Leigh'), 'nested objects flatten one level');
});

test('request metadata sits in the footer instead of on every row', () => {
  const { text } = render(results(), { budget: 2000 });
  assert.ok(text.includes('response: has_more=true, quota_max=300, quota_remaining=297'));
  assert.equal(text.match(/quota_remaining/g).length, 1);
});

test('epoch timestamps under a date key render as dates', () => {
  const md = rawApi();
  assert.ok(md.includes('creation_date: 2012-06-27 13:51:36'), `epoch left raw:\n${md.slice(0, 400)}`);
  // A number that is not a date must stay the number it is.
  assert.ok(md.includes('view_count: 91234'), 'a plain count was mangled into a date');
});

test('an html field in json goes through the distiller, not into a cell', () => {
  const md = rawApi();
  assert.ok(md.includes('```\nwavelength < 450nm'), 'code block in a json body field was flattened');
  assert.ok(md.includes('[the derivation](https://example.test/scattering)'), 'link inside a json body field lost');
  const p = results();
  assert.ok(p.blocks.some((b) => b.type === 'link' && b.text === 'the derivation'), 'body link is not followable');
});

test('json shapes other than a wrapped array still render', () => {
  const bare = distill('[{"name":"one","url":"https://example.test/1"},{"name":"two","url":"https://example.test/2"}]', 'https://x.test/a.json');
  assert.equal(bare.blocks.filter((b) => b.type === 'link').length, 2, 'a root array lost its items');
  const single = distill('{"title":"Just one","score":3}', 'https://x.test/one.json');
  assert.ok(single.blocks.some((b) => b.text === 'Just one'), 'an object with no array rendered nothing');
  assert.ok(single.blocks.some((b) => b.text?.includes('score: 3')), 'a single resource lost its fields');
});

test('a resource with its own name is the subject, not the array hanging off it', () => {
  // The npm registry shape: a named package carrying a short array of
  // maintainers. Picking the longest array made the maintainers the subject
  // and pushed the package into the metadata line.
  const pkg = JSON.stringify({
    name: 'turnstile', license: 'MIT', description: 'does a thing',
    maintainers: [{ name: 'ada', email: 'ada@example.test' }, { name: 'grace', email: 'grace@example.test' }],
  });
  const p = distill(pkg, 'https://registry.example.test/turnstile');
  assert.ok(p.title.includes('(1 item)'), `the package was not the subject:\n${p.title}`);
  assert.ok(p.blocks.some((b) => b.text === 'turnstile'), 'the resource lost its name');
  assert.ok(!p.blocks.some((b) => b.text?.startsWith('response:')), 'the resource was demoted to metadata');
  // A conventional container key still wins over the root's own name, so a
  // named collection is still read as the collection it is.
  const coll = distill(JSON.stringify({ name: 'a collection', items: [{ title: 'one' }, { title: 'two' }] }), 'https://x.test/c.json');
  assert.ok(coll.title.includes('(2 items)'), `a named collection lost its items:\n${coll.title}`);
});

test('one long field at the root cannot spend the whole page budget', () => {
  const long = 'sentence about the package. '.repeat(400);
  const body = JSON.stringify({ readme: long, total: 2, items: [{ title: 'one' }, { title: 'two' }] });
  const p = distill(body, 'https://x.test/list.json');
  const meta = p.blocks.find((b) => b.text?.startsWith('response:'));
  assert.ok(meta, 'the request metadata went missing');
  assert.ok(meta.text.includes('total=2'), 'a short metadata field was lost with the long one');
  assert.ok(!meta.text.includes(long.slice(0, 200)), 'a long field stayed on the summary line');
  assert.ok(meta.text.length < TEXT_CAP * 2, `the summary line is not a line:\n${meta.text.slice(0, 300)}`);
  // Off the line, not out of the page: it is its own block, and raw has it.
  assert.ok(p.blocks.some((b) => b.text?.startsWith('readme:')), 'the long field vanished instead of moving');
  assert.ok(toMarkdown(body, 'https://x.test/list.json').includes('sentence about the package'), 'raw lost the long field');
});

test('a body too long for the compact view becomes a line, not a dozen blocks', () => {
  const short = '<p>A <em>short</em> body with <a href="https://example.test/x">a link</a>.</p>';
  const huge = `<p>${'A paragraph that goes on. '.repeat(400)}</p><pre><code>code()</code></pre>`;
  const withShort = distill(JSON.stringify({ items: [{ title: 'q', body: short }] }), 'https://x.test/a.json');
  assert.ok(withShort.blocks.some((b) => b.type === 'link' && b.text === 'a link'), 'a body that fits lost its links');
  const withHuge = distill(JSON.stringify({ items: [{ title: 'q', body: huge }] }), 'https://x.test/b.json');
  const line = withHuge.blocks.find((b) => b.text?.startsWith('body:'));
  assert.ok(line, 'an oversized body left nothing behind');
  assert.ok(!line.text.includes('<p>'), 'markup reached the line unstripped');
  // raw is still the escape hatch, and still reads the markup as markup.
  assert.ok(toMarkdown(JSON.stringify({ items: [{ title: 'q', body: huge }] }), 'https://x.test/b.json').includes('code()'), 'raw lost the oversized body');
});

test('only json is read as json', () => {
  assert.equal(jsonToHTML(html), null, 'an html page was parsed as json');
  assert.equal(jsonToHTML(feed), null, 'a feed was parsed as json');
  assert.equal(jsonToHTML('{"broken": '), null, 'invalid json did not fall through to the html path');
  assert.equal(jsonToHTML('"a string"'), null, 'a bare scalar has no items to render');
  // The feed path must still win for xml, and html must reach the html parser.
  assert.ok(distill(feed, 'https://x.test/f').title.includes('Fixture Overflow'));
});

test('long runs of short links collapse into a range marker', () => {
  const nav = Array.from({ length: 15 }, (_, i) => `<a href="/s/${i}">sub${i}</a>`).join(' ');
  const navHtml = `<html><head><title>T</title></head><body>${nav}<p>actual content</p></body></html>`;
  const { text } = render(distill(navHtml, 'https://x.test'), { budget: 2000 });
  assert.ok(text.includes('[6-15] 10 similar links'), `run not collapsed:\n${text}`);
  assert.ok(text.includes('actual content'), 'content after the run was lost');
  assert.ok(!text.includes('sub9'), 'collapsed link still rendered');
});

test('a result title that is a link stays a link', () => {
  const headings = search().blocks.filter((b) => b.type === 'heading');
  const [first, second] = headings;
  assert.equal(first.text, 'cp - Fixture CLI Command Reference');
  assert.ok(first.href.includes('docs.example.test'), 'the title anchor of a search result must survive');
  assert.equal(second.href, 'https://docs.example.test/s3/index.html');
});

test('a heading that merely contains a link is not one', () => {
  const headings = search().blocks.filter((b) => b.type === 'heading');
  const partial = headings.find((b) => b.text.startsWith('Related searches'));
  assert.equal(partial.href, undefined, 'the link is part of the heading, not the whole of it');
  // Documentation hangs a permalink off every heading. Following one refetches
  // the page the agent is already reading, so it must stay a read.
  const pilcrow = headings.find((b) => b.text.startsWith('Options'));
  assert.equal(pilcrow.href, undefined);
  const selfAnchor = headings.find((b) => b.text === 'See also');
  assert.equal(selfAnchor.href, undefined, 'a bare fragment is not a destination');
});

test('a truncated block ends on a sentence, so what is shown can be trusted', () => {
  const first = 'Welcome to The Rust Programming Language, an introductory book about Rust.';
  const second = ' The Rust programming language helps you write faster, more reliable software.';
  const rest = ' High-level ergonomics and low-level control are often at odds with each other, and Rust challenges that conflict.';
  const line = render(
    { url: '', title: '', blocks: [{ n: 1, type: 'text', text: first + second + rest }] },
    { budget: 60 },
  ).text;
  assert.ok(line.includes(second.trim()), 'a sentence that finished inside the cap must be shown whole');
  assert.ok(!line.includes('High-level'), 'the sentence that did not finish must not be half shown');
  assert.match(line, /\.\.\. \+\d+ chars/, 'and the reader must still be told there is more');

  // Nothing to end on means the plain cut stands rather than most of the
  // window being thrown away for the sake of a boundary.
  const unbroken = render(
    { url: '', title: '', blocks: [{ n: 1, type: 'text', text: `A. ${'word '.repeat(60)}` }] },
    { budget: 60 },
  ).text;
  assert.ok(unbroken.length > TEXT_CAP, `an early sentence end must not shrink the view:\n${unbroken}`);
});

test('a highlighted command comes out runnable', () => {
  // Every token of this command is its own element on the page. Space-joining
  // them gave `aws s3 cp s3 : // bucket / -- recursive`, which is not a command
  // an agent can run, and the agent has no way to see that from the output.
  assert.equal(codeBlock('aws s3 cp test.txt'), 'aws s3 cp test.txt s3://amzn-demo/ --recursive');
});

test('a code sample keeps its lines, so a comment cannot eat the rest', () => {
  assert.equal(
    codeBlock('readFileSync'),
    "const fs = require('node:fs');\n// read it back\nfs.readFileSync('out.txt');",
  );
  // A shell continuation is only a continuation while the break is still there.
  assert.equal(codeBlock('--expires'), 'aws s3 cp test.txt s3://amzn-demo/ \\\n    --expires 2014-10-01T20:30:00Z');
});

test('a code block loses the indentation it all shares and keeps the rest', () => {
  assert.equal(codeBlock('def load'), 'def load(path):\n    with open(path) as fh:\n        return json.load(fh)');
});

test('a toolbar inside a code block is not part of the sample', () => {
  const block = codeBlock("import fs from 'node:fs'");
  assert.equal(block, "import fs from 'node:fs';");
  const out = render(docs(), { budget: 5000 }).text;
  assert.ok(!out.includes('javascript'), 'the language label leaked into the page');
  // The controls go with it: a copy button is not something oc can press, and
  // `do` on it would be a turn spent on nothing.
  assert.equal(docs().blocks.filter((b) => b.type === 'button' || b.type === 'input').length, 0);
});

test('inline code joins the sentence it sits in', () => {
  assert.ok(docs().blocks.some((b) => b.text === 'Pass the --recursive flag to copy a directory.'));
  assert.ok(docs().blocks.some((b) => b.text === 'A period (.) means the working directory.'));
});

test('a truncated code block ends on a line, not mid-statement', () => {
  const code = ['first();', 'second();', ...Array.from({ length: 20 }, (_, i) => `line${i}('${'x'.repeat(20)}');`)].join('\n');
  const page = { url: 'https://fixture.test/c', title: 'c', blocks: [{ type: 'text', n: 1, text: code }] };
  const shown = render(page, { budget: 10 }).text.split('\n');
  const marker = shown.findIndex((l) => l.includes('... +'));
  assert.ok(marker > 0, 'nothing was truncated');
  // The kept part stops where a statement did, so every line shown is whole.
  assert.ok(shown[marker].startsWith('line'), `cut mid-line: ${shown[marker]}`);
  assert.ok(shown[marker].includes(');'), `cut mid-statement: ${shown[marker]}`);
});

test('a page that arrives with no readable text is reported as a failure', () => {
  // The failure mode issue #14 reports: HTTP 200, real markup, nothing to read.
  // It has to be distinguishable from a page that renders short, because the
  // caller's next move (fall back to a browser) depends on the difference.
  const verdict = (body, size) => {
    const filler = `<script>const pad = "${'x'.repeat(size)}";</script>`;
    const page = distill(`<html><head><title>Reddit</title></head><body>${body}${filler}</body></html>`,
      'https://fixture.test/js');
    return contentFailure(contentTokens(page), estimateTokens(filler));
  };

  // Nothing at all, whatever the page weighed.
  assert.match(verdict('<div id="root"></div>', 0), /no text on the whole page/);

  // Menu links only: short labels are furniture, so this page has no content
  // either, however much markup came with it.
  const chrome = ['Help', 'Log in', 'Content Policy', 'About', 'Careers', 'Press']
    .map((t) => `<a href="/${t}">${t}</a>`).join('');
  assert.match(verdict(chrome, 60_000), /no text on the whole page/);

  // A consent wall or a login gate: a sentence or two of real text, out of
  // markup far too big to have carried only that.
  const gate = '<p>To continue, accept cookies. We and our partners store and access '
    + 'information on your device to personalise the content you see here.</p>';
  assert.match(verdict(gate, 60_000), /tokens of text out of ~\d+ of HTML/);
  // The same page without that weight behind it is a short page, not a failed
  // render, so it has to pass.
  assert.equal(verdict(gate, 0), null);
});

test('a terse page that arrived terse is content, not a failed render', () => {
  // A status endpoint or a one-line answer distills fine and has to exit 0:
  // calling it gated would send an agent to a browser for a page it was
  // already holding. Only weight it never rendered is evidence of a gate.
  const html = '<html><head><title>status</title></head><body><p>All systems operational.</p></body></html>';
  const page = distill(html, 'https://fixture.test/status');
  assert.equal(contentFailure(contentTokens(page), estimateTokens(html)), null);
  const json = distill('{"status":"ok"}', 'https://fixture.test/health');
  assert.equal(contentFailure(contentTokens(json), 4), null);
});

test('page-written scalars are capped at the render boundary', () => {
  // The title and every heading are the page's to write, so without a cap one
  // hostile scalar prints unbounded output whatever the budget says.
  const bigTitle = 'title word '.repeat(1000).trim();
  const bigHeading = 'heading word '.repeat(1000).trim();
  const page = distill(
    `<html><head><title>${bigTitle}</title></head><body><h1>${bigHeading}</h1><p>short</p></body></html>`,
    'https://fixture.test/big');
  const { text } = render(page, { budget: 100 });
  for (const line of text.split('\n')) {
    assert.ok(line.length < 300, `a render line ran to ${line.length} chars`);
  }
  assert.match(text, /\.\.\. \+[\d,]+ chars/);
  // The distilled page keeps the full values: --json is the machine-stable
  // view, its size is bounded by the fetch cap, and machines cut for
  // themselves.
  assert.equal(page.title, bigTitle);
});

test('a link-list page counts as content even with no prose on it', () => {
  // Hacker News and search results are links and nothing else, so a rule that
  // counted only prose would call the tool's best pages empty.
  const links = Array.from({ length: 12 }, (_, i) =>
    `<a href="/${i}">A headline long enough to be a headline, number ${i}</a>`).join('');
  const page = distill(`<html><body>${links}</body></html>`, 'https://fixture.test/list');
  assert.equal(contentFailure(contentTokens(page), 30_000), null);
});

test('every fixture page reads as content, none as a failed render', () => {
  // Feeds, a JSON API, and a YouTube watch page are all thin by design, which
  // is exactly where this check must not cry wolf. login.html is an auth-gate
  // fixture, not a page that should distill as content.
  for (const name of readdirSync(PAGES)) {
    if (name === 'login.html') continue;
    const raw = readFileSync(PAGES + name, 'utf8');
    const page = distill(raw, `https://api.example.test/2.3/search/advanced?site=fixture&f=${name}`);
    assert.equal(contentFailure(contentTokens(page), estimateTokens(raw)), null, name);
  }
});
