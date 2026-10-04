import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

/**
 * @typedef {Object} Block
 * @property {'heading'|'text'|'link'|'input'|'button'|'divider'} type
 * @property {string} text
 * @property {number} [n] - action handle
 * @property {number} [level] - heading level 1..6
 * @property {string} [href] - links, and a heading that is one
 * @property {string} [name] - inputs only
 *
 * @typedef {Object} Page
 * @property {string} url
 * @property {string} title
 * @property {Block[]} blocks
 * @property {string} [base] - document base URL from <base href>, if the page set one
 *
 * @typedef {Object} View
 * @property {string[]} keep - fields to show, in order: a dot path
 *   ('info.version') or a template joining several ('{crate_id} {req}')
 * @property {string} [list] - dot path to the array the fields apply to each
 *   item of; absent means the response itself, whether one object or a list
 */

// Where the compact view cuts a text block. It lives here because numbering
// depends on it: a block long enough to be cut is a block that needs a handle.
export const TEXT_CAP = 200;

// Dropped wholesale, subtree included. Nav and footer stay in v0.1: on many
// sites they carry the only working links, and the budget in render.js is
// what keeps them from costing anything.
const DROP = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'iframe',
  'link', 'meta', 'head', 'canvas', 'video', 'audio', 'object',
]);

// Elements that are furniture by definition. The main content is never one of
// them, so the search below refuses to descend into them.
const FURNITURE = new Set(['nav', 'header', 'footer', 'aside']);

// Controls a page puts inside its own code samples, and the selector that
// finds one. Node's API docs give every code block a copy button, a module
// toggle and a language label, so the text of the sample ends in
// `javascriptcopy` unless the toolbar holding them is left out of it.
const CODE_CONTROLS = new Set(['button', 'input', 'select', 'textarea', 'label']);
const CONTROL = [...CODE_CONTROLS].join(', ');

// Lines in a code block are kept, where every other kind of text has its
// whitespace collapsed. Joining them would put `// comment` in front of the
// statements that followed it, so a sample an agent could run would arrive
// commented out, and the shape of the wreck is invisible on one line. Blank
// runs and the indentation the whole block shares are the parts that carry no
// meaning, so those go.
const codeText = (raw) => {
  const lines = raw.replace(/\r\n?/g, '\n').replace(/[^\S\n]+$/gm, '').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const indent = lines
    .filter((l) => l.trim())
    .reduce((least, l) => Math.min(least, l.length - l.trimStart().length), Infinity);
  return lines
    .map((l) => (Number.isFinite(indent) ? l.slice(indent) : l).trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
};

// Elements that end a line on the page and so must end one here. Without this
// the text of six separate posts merges into a single block, because nothing
// between them survives distillation to keep them apart.
const BLOCKY = new Set([
  'p', 'div', 'article', 'section', 'li', 'ul', 'ol', 'tr', 'td', 'th',
  'blockquote', 'pre', 'figure', 'figcaption', 'dt', 'dd', 'form', 'br', 'hr',
  'main', 'nav', 'header', 'footer', 'aside',
]);

// Selectors a page uses to say where its content is. One match is a claim
// worth believing; several <article> elements mean a listing, where the list
// is the content and taking the first would throw the rest away.
const MAIN_SELECTORS = ['main', '[role="main"]', 'article'];

// Reordering only matters on a page that cannot be printed whole: if the
// budget covers everything, what leads is a question with no consequences.
// Below this much text the page is left in document order.
const MIN_PAGE = 3000;
// A candidate has to hold this share of the page's prose to be believed.
const MIN_SHARE = 0.25;
// How much of its parent's prose a child must hold before the search moves
// down into it, and how much of the page's it must keep to be worth choosing.
const DESCEND_SHARE = 0.6;
const KEEP_SHARE = 0.5;
const MAX_DEPTH = 12;

// A short link or button label repeated this many times down a page is
// per-item furniture (permalink, save, reply, like, repost) rather than
// content. On a forum thread or a social timeline there is one set per item,
// which costs more than the items do.
// A link label can be content, so it gets the benefit of the doubt for longer
// than a button label, which never is.
const REPEAT_LIMIT = 5;
const REPEAT_LIMIT_BUTTON = 3;
const REPEAT_MAX_LEN = 25;

const clean = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Everything that is not a page, made into one. The compact view and both raw
 * modes go through here, so a format is never readable in one of them and a
 * blob in the other. Each converter recognises its own input and returns null
 * otherwise, and HTML falls through untouched.
 * @param {string} text
 * @param {string} url
 * @returns {string}
 */
const asHTML = (text, url = '', opts = {}) =>
  jsonToHTML(text, url, opts) ?? youtubeToHTML(text) ?? transcriptToHTML(text) ?? feedToHTML(text)
    ?? textToHTML(text, url, opts) ?? text;

// What makes a body HTML when it does not open with a tag: one of the tags
// every page has somewhere near the top. A tag name alone is not enough,
// since `Record<string, T>` and `a <b` look like tags to a regex too.
const HTML_MARK = /<(!doctype|html|head|body|div|p|br|a href|span|script|style|meta|link|title|h[1-6]|table|ul|ol|li|img|article|main|section|nav|form|input|pre)[\s>/]/i;

const TEXT_PATH = /\.(md|markdown|txt|rst|adoc)$/i;
const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
};

// One line of a Markdown link list: `- [title](url)`, then an optional
// description. llms.txt is made of these. A title may hold a bracketed
// word of its own, as Markdown allows: drizzle's reads `[Joins [SQL]]`.
const LINK_ITEM = /^[ \t]*[-*+][ \t]+\[((?:[^[\]\n]|\[[^[\]\n]*\])+)\]\(([^()\s]+)\)(.*)$/;

/**
 * A paragraph that is nothing but a Markdown link list, as a list of real
 * links, so `do <n>` follows an entry of an llms.txt index or a README's
 * table of links. Anything else in the paragraph keeps it verbatim.
 * @param {string} p
 * @param {string} base
 * @returns {string | null}
 */
function linkList(p, base) {
  const items = [];
  for (const line of p.split('\n')) {
    const m = line.match(LINK_ITEM);
    if (!m) return null;
    let href;
    try {
      href = new URL(m[2], base);
    } catch {
      return null;
    }
    if (href.protocol !== 'https:' && href.protocol !== 'http:') return null;
    // The description prints on a line of its own under the link, where the
    // `: ` that joined it to the title reads as noise.
    const text = m[3].replace(/^\s*[:-]\s*/, '').trim();
    items.push(`<li><a href="${escHTML(href.href)}">${escHTML(m[1])}</a>${text ? ` ${escHTML(text)}` : ''}</li>`);
  }
  return `<ul>${items.join('')}</ul>`;
}

/**
 * A plain text body as a page: a source file, a manual page, a README
 * fetched raw. The HTML parser eats everything from a `<` to the next `>`,
 * so a JavaScript file lost its generics and comparisons and came out as
 * one shuffled block. Each blank-line-separated paragraph becomes its own
 * block, keeping its line breaks, and a Markdown heading becomes a heading,
 * so `find` and `read` work on a tldr page or an RFC the way they do on a
 * page. The raw modes keep the whole file as one block, verbatim.
 * @param {string} text
 * @param {string} url
 * @param {{full?: boolean, type?: string}} [opts] - type is the declared Content-Type
 * @returns {string | null}
 */
function textToHTML(text, url = '', { full = false, type = '' } = {}) {
  const lead = text.replace(/^\uFEFF/, '').trimStart();
  if (!lead || /^<(!doctype|html)[\s>]/i.test(lead)) return null;
  // A README often opens with a centred logo in a <div>, and read as HTML
  // everything after it was loose text the page reader dropped. A path that
  // names a text format, or a server that says the body is text, is text
  // unless it is a whole HTML document: a forum post quoting a <br> is not
  // a page.
  const declared = /^text\/(plain|markdown)\b/i.test(type) || TEXT_PATH.test(pathOf(url));
  if (!declared && (lead.startsWith('<') || HTML_MARK.test(lead.slice(0, 4000)))) return null;
  const body = lead.replace(/\r\n?/g, '\n').trimEnd();
  const paragraphs = full ? [body] : body.split(/\n[ \t]*\n+/);
  const heading = (p) => /^#{1,6} \S/.test(p) && !p.includes('\n') ? p.match(/^#+/)[0].length : 0;
  const parts = paragraphs.map((p) => {
    const level = heading(p);
    if (level) return `<h${level}>${escHTML(p.slice(level + 1))}</h${level}>`;
    if (full) return `<pre>${escHTML(p)}</pre>`;
    // Expo's llms.txt writes each section heading on the line right above
    // its list, with no blank line between, so the two arrive as one
    // paragraph. The heading line is then a heading and the rest a list.
    const cut = p.indexOf('\n');
    const top = cut > 0 ? heading(p.slice(0, cut)) : 0;
    const list = linkList(top ? p.slice(cut + 1) : p, url);
    if (!list) return `<pre>${escHTML(p)}</pre>`;
    return top ? `<h${top}>${escHTML(p.slice(top + 1, cut))}</h${top}>${list}` : list;
  });
  // Only a heading that opens the file names it. A README that starts with
  // prose and has a `# More information` section further down is not titled
  // "More information". A Setext heading (a line of = under the text) counts.
  const opening = paragraphs[0] ?? '';
  const setext = opening.match(/^([^\n]+)\n=+[ \t]*(?:\n|$)/);
  let title = heading(opening) ? opening.replace(/^#+ /, '') : setext ? setext[1].trim() : '';
  if (!title) {
    try {
      title = `${new URL(url).host}${new URL(url).pathname}`;
    } catch {
      title = 'text';
    }
  }
  // The raw modes find the file again by this mark and hand it back whole.
  const main = full ? '<main data-text>' : '<main>';
  return `<html><head><title>${escHTML(title)}</title></head><body>${main}\n${parts.join('\n')}\n</main></body></html>`;
}

/**
 * The link a heading is, if it is one. A search engine puts the result title
 * in an anchor inside an <h2>, so a heading can be the most followable thing
 * on the page, and taking only its text threw that away.
 *
 * The heading has to BE the link, not merely contain one: exactly one anchor,
 * labelled with the whole heading. Documentation fails that test on purpose.
 * Every heading in the Rust book and every one on an AWS CLI reference page
 * carries a permalink to its own id, so following those would refetch the
 * page the agent is already reading, which is worse than the reading it
 * already gets. A bare fragment is never a destination, and neither is a
 * mailto: or tel: href, which is not a page.
 * @param {any} node - the heading element
 * @param {string} text - its cleaned text
 * @param {string} base - document base, to resolve the href
 * @param {string} pageUrl - the page itself, for same-document checks
 * @returns {string|null}
 */
function headingHref(node, text, base, pageUrl) {
  const anchors = node.querySelectorAll('a[href]');
  if (anchors.length !== 1) return null;
  const href = anchors[0].getAttribute('href') ?? '';
  if (!href || !isFollowableHref(href, base, pageUrl)) return null;
  return clean(anchors[0].textContent) === text ? href : null;
}

/**
 * Whether this href is a page oc can fetch, other than the one already open.
 * A bare fragment is the current page. mailto:/tel:/javascript: are not
 * pages: fetchPage prefixes https:// onto a URL with no http(s) scheme, so
 * mailto:hi@example.com became a GET of example.com with password "hi".
 * The href resolves against <base href>, but "here" is the page URL: under
 * <base href="/">, a link to / is the home page, not this one.
 * @param {string} href
 * @param {string} base
 * @param {string} pageUrl
 * @returns {boolean}
 */
function isFollowableHref(href, base, pageUrl) {
  try {
    const dest = new URL(href, base || pageUrl || undefined);
    if (!/^https?:$/i.test(dest.protocol)) return false;
    if (!pageUrl) return true;
    const here = new URL(pageUrl);
    return dest.origin !== here.origin || dest.pathname !== here.pathname || dest.search !== here.search;
  } catch {
    return false;
  }
}

/**
 * Reduce raw HTML to an interaction tree: readable text plus numbered
 * elements, in document order. The walk is deterministic and numbering is a
 * second pass over its result, so the same page always yields the same
 * numbers.
 * @param {string} html
 * @param {string} url
 * @param {{view?: View|null, type?: string}} [opts] - the Content-Type the
 *   server declared, and a site shortcut's choice of JSON fields,
 *   which only a JSON body reads
 * @returns {Page}
 */
export function distill(html, url = '', { view = null, type = '' } = {}) {
  const { document } = parseHTML(asHTML(html, url, { view, type }));
  lowerAttributeNames(document);
  const title = clean(document.querySelector('title')?.textContent ?? '');
  const base = documentBase(document, url);
  /** @type {Block[]} */
  const blocks = [];

  const hidden = (el) =>
    el.getAttribute('hidden') !== null ||
    el.getAttribute('aria-hidden') === 'true' ||
    /display:\s*none/.test(el.getAttribute('style') ?? '');

  /** Subtree already emitted, skipped when the rest of the page is walked. */
  let done = null;

  /**
   * The text of a code subtree, read as one string.
   *
   * A syntax highlighter gives every token its own element, so `s3://bucket/`
   * reaches the walk as `s3`, `:`, `//`, `bucket`, `/`, and the rule that puts
   * fragments back together only glues the ones that share a parent. The rest
   * are space-joined, which turned an AWS example into
   * `aws s3 cp s3 : // bucket / -- recursive`, a command an agent cannot run.
   * Reading the subtree whole is what fixes that, and it discards nothing: over
   * 172 pre elements on the AWS CLI reference, the Rust book, the Node API docs
   * and the Python library docs, 159 are split this way and not one of them
   * contains a link.
   *
   * textContent would be enough if pages put only code in their code blocks.
   * A control inside one is chrome, and so is the block-level element holding
   * it: that is how the toolbar's `javascript` label leaves with the copy
   * button it sits beside. The test stays on block-level wrappers because a
   * highlighter's own elements are inline, so a stray control can never take a
   * line of code out with it.
   * @param {any} node
   * @returns {string}
   */
  const verbatim = (node) => {
    let out = '';
    const gather = (n) => {
      if (n.nodeType === 3) {
        out += n.textContent ?? '';
        return;
      }
      if (n.nodeType !== 1) return;
      const tag = n.localName;
      if (DROP.has(tag) || CODE_CONTROLS.has(tag) || hidden(n)) return;
      if (n !== node && BLOCKY.has(tag) && n.querySelector(CONTROL)) return;
      for (const child of n.childNodes) gather(child);
    };
    gather(node);
    return out;
  };

  const walk = (node) => {
    if (node.nodeType === 3) {
      const raw = node.textContent ?? '';
      const text = clean(raw);
      // A parser is free to split one run of text into several nodes, and
      // linkedom does it around apostrophes, so `what's` arrives as `what`,
      // `'`, `s`. Remembering the parent and whether the fragment had space
      // at its edges is what lets mergeText put it back without inventing a
      // space that was never in the page.
      if (text) {
        blocks.push({ type: 'text', text, host: node.parentNode, pre: /^\s/.test(raw), post: /\s$/.test(raw) });
      } else if (raw && blocks.at(-1)?.type === 'text') {
        // A node that is only a space still separates the words either side
        // of it. Wikipedia writes every &nbsp; as a span holding nothing
        // else, and the fragments around it share a parent, so without this
        // an infobox read "Firstappeared" and "20February 1991".
        blocks.at(-1).post = true;
      }
      return;
    }
    if (node.nodeType !== 1) return;
    if (node === done) return;
    const tag = node.localName;
    if (DROP.has(tag) || hidden(node)) return;

    if (/^h[1-6]$/.test(tag)) {
      const text = clean(node.textContent);
      if (text) {
        const href = headingHref(node, text, base, url);
        blocks.push({ type: 'heading', level: Number(tag[1]), text, ...(href ? { href } : {}) });
      }
      return;
    }
    if (tag === 'a' && node.getAttribute('href')) {
      // Same rule as headingHref: a fragment is this page, mailto: is not a
      // page. The link keeps its number without the href, because a fragment
      // is often the one handle on a place: rdoc's method signature links to
      // its own id, and as plain text find borrowed the number above it,
      // which read then opened on the method before.
      const raw = node.getAttribute('href');
      const href = isFollowableHref(raw, base, url) ? raw : null;
      // An icon button already takes aria-label or title because it has no
      // text. An anchor around an image is the same shape: img alt is the
      // accessible name and is not a text node, so textContent is empty and
      // the link used to be dropped. Visible text still wins when there is
      // any, because that is what the page wrote for a reader.
      const text = clean(node.textContent)
        || clean(node.getAttribute('aria-label') ?? '')
        || clean(node.getAttribute('title') ?? '')
        || clean(node.querySelector('img')?.getAttribute('alt') ?? '');
      if (text) {
        blocks.push({ type: 'link', text, ...(href ? { href } : {}) });
      }
      return;
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      // HTML's type attribute is ASCII case-insensitive. type=HIDDEN used to
      // appear as a numbered input, type=SUBMIT as an input rather than a
      // button, and type=PASSWORD as a field named PASSWORD, so a login wall
      // written that way was not detected.
      const kind = (node.getAttribute('type') ?? 'text').toLowerCase();
      if (kind === 'hidden') return;
      if (kind === 'submit' || kind === 'button') {
        blocks.push({ type: 'button', text: node.getAttribute('value') ?? 'submit' });
        return;
      }
      const name = node.getAttribute('name') ?? node.getAttribute('placeholder') ?? tag;
      blocks.push({ type: 'input', text: kind, name });
      return;
    }
    if (tag === 'button') {
      // An icon button carries its name in aria-label or title, and a button
      // with none of the three cannot be described or pressed, so printing it
      // spends tokens to say nothing. X puts seven of them under every post.
      const text = clean(node.textContent)
        || clean(node.getAttribute('aria-label') ?? '')
        || clean(node.getAttribute('title') ?? '');
      if (text) blocks.push({ type: 'button', text });
      return;
    }
    if (tag === 'pre' || tag === 'code') {
      const raw = verbatim(node);
      const text = tag === 'pre' ? codeText(raw) : clean(raw);
      // A pre is its own line, which is what BLOCKY gave it before this branch
      // started claiming it first. Inline code belongs to the sentence around
      // it, so it carries the parent and the edge spacing a text node would and
      // merges back into that sentence the same way.
      const own = tag === 'pre';
      if (own) blocks.push({ type: 'break' });
      if (text) {
        blocks.push({ type: 'text', text, host: node.parentNode, pre: /^\s/.test(raw), post: /\s$/.test(raw) });
      }
      if (own) blocks.push({ type: 'break' });
      return;
    }
    if (BLOCKY.has(tag)) {
      blocks.push({ type: 'break' });
      for (const child of node.childNodes) walk(child);
      blocks.push({ type: 'break' });
      return;
    }
    for (const child of node.childNodes) walk(child);
  };

  const body = bodyOf(document);
  const main = body ? mainOf(document, body) : null;
  if (main) {
    // Content first, everything else after it. The budget in render.js is
    // spent top down, so whatever leads the list is what an agent gets for
    // its first 500 tokens, and on most pages the top of the document is
    // menus. Nothing is dropped: the chrome carries links `oc do` needs, it
    // just stops being the thing that gets read.
    walk(main);
    done = main;
    const contentBlocks = blocks.length;
    if (body) walk(body);
    if (blocks.length > contentBlocks) {
      blocks.splice(contentBlocks, 0, { type: 'divider', text: '--- rest of page: navigation, sidebar, footer ---' });
    }
  } else if (body) {
    walk(body);
  }
  return {
    url,
    title,
    blocks: number(mergeText(dropRepeats(blocks))),
    ...(base !== url ? { base } : {}),
  };
}

/**
 * Document base URL from the first <base href>, resolved against the page
 * URL. Relative links on the page are relative to this, not to the request
 * URL: a mirror, a CDN, and many docs generators put one in the head.
 * Head is dropped as chrome, so the href is read here and carried on the
 * page for sessionFromPage, which is what `oc do` resolves against. An
 * unusable href leaves the page URL in charge.
 * @param {any} document
 * @param {string} url
 * @returns {string}
 */
function documentBase(document, url) {
  const href = clean(document.querySelector('base[href]')?.getAttribute('href') ?? '');
  if (!href) return url;
  try {
    return new URL(href, url || undefined).href;
  } catch {
    return url;
  }
}

/**
 * Remove link labels that repeat down the page. They are the per-item controls
 * a template stamps onto every row, and on a long thread they outweigh the
 * content. What went is stated in place, because a view that quietly drops
 * things is a view an agent cannot trust.
 * @param {Block[]} blocks
 * @returns {Block[]}
 */
function dropRepeats(blocks) {
  const controls = (b) => b.type === 'link' || b.type === 'button';
  /** @type {Map<string, {n: number, limit: number}>} */
  const counts = new Map();
  for (const b of blocks) {
    if (!controls(b) || b.text.length > REPEAT_MAX_LEN) continue;
    const key = b.text.toLowerCase();
    const limit = b.type === 'button' ? REPEAT_LIMIT_BUTTON : REPEAT_LIMIT;
    const seen = counts.get(key);
    // A label worn by both a link and a button keeps the more patient limit.
    counts.set(key, { n: (seen?.n ?? 0) + 1, limit: Math.max(seen?.limit ?? 0, limit) });
  }
  const repeated = new Set([...counts].filter(([, c]) => c.n >= c.limit).map(([k]) => k));
  if (!repeated.size) return blocks;
  const kept = blocks.filter((b) => !(controls(b) && repeated.has(b.text.toLowerCase())));
  const gone = blocks.length - kept.length;
  const names = [...repeated].slice(0, 3).join(', ');
  const note = { type: 'divider', text: `--- ${gone} repeated controls hidden (${names}), 'oc raw' has them ---` };
  // The note belongs with the content it was cut from, not after the chrome.
  const boundary = kept.findIndex((b) => b.type === 'divider');
  kept.splice(boundary === -1 ? kept.length : boundary, 0, note);
  return kept;
}

/**
 * Find the element holding the page's main content, or null when the page is
 * too small or too flat for the question to have an answer.
 * @param {any} document
 * @param {any} body
 * @returns {any}
 */
function mainOf(document, body) {
  if (clean(body.textContent ?? '').length < MIN_PAGE) return null;
  const total = prose(body);
  for (const selector of MAIN_SELECTORS) {
    const found = [...document.querySelectorAll(selector)];
    if (found.length !== 1) continue;
    const el = found[0];
    if (el === body || prose(el) < total * MIN_SHARE) continue;
    // Material for MkDocs puts both sidebars, the page nav and the table of
    // contents, inside <main>, so a docs page led with fifty nav links. A
    // main that holds navigation and exactly one article holding most of its
    // prose leads with the article; the rest still follows. Walking down to
    // the densest column instead cut pkg.go.dev to its biggest type.
    const articles = el.querySelector('nav') ? el.querySelectorAll('article') : [];
    return articles.length === 1 && prose(articles[0]) >= prose(el) * KEEP_SHARE ? articles[0] : el;
  }
  return densest(body, total);
}

/**
 * Walk down the tree while one child holds most of the prose of the element
 * above it. That is what separates a content column from the page around it
 * without knowing anything about the site.
 * @param {any} body
 * @param {number} total
 * @returns {any}
 */
function densest(body, total) {
  let node = body;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    let best = null;
    let bestProse = 0;
    for (const child of node.children ?? []) {
      if (FURNITURE.has(child.localName) || DROP.has(child.localName)) continue;
      const len = prose(child);
      if (len > bestProse) {
        best = child;
        bestProse = len;
      }
    }
    if (!best || bestProse < prose(node) * DESCEND_SHARE || bestProse < total * KEEP_SHARE) break;
    node = best;
  }
  return node === body ? null : node;
}

/**
 * Text length minus the text of controls, which is what a page is steered by
 * rather than what it says.
 * @param {any} el
 * @returns {number}
 */
function prose(el) {
  const text = clean(el.textContent ?? '').length;
  let controls = 0;
  // Link text is what navigation is made of. Option text is worse: a country
  // dropdown is hundreds of characters that no link subtraction touches, and
  // on a search results page it outscores results that are themselves links.
  for (const node of el.querySelectorAll?.('a, select, button') ?? []) {
    controls += clean(node.textContent ?? '').length;
  }
  return text - controls;
}

/**
 * Assign handles in document order. Interactive elements get one because they
 * can be acted on, headings and long text blocks because they can be read:
 * a text block over the cap is printed cut, and its number is what makes the
 * rest of it reachable with `oc read <n>` instead of a second whole-page fetch.
 * @param {Block[]} blocks
 * @returns {Block[]}
 */
function number(blocks) {
  let handle = 0;
  for (const block of blocks) {
    if (block.type === 'divider') continue;
    if (block.type !== 'text' || block.text.length > TEXT_CAP) block.n = ++handle;
  }
  return blocks;
}

/**
 * linkedom's document.body getter comes back empty on some real pages (Bing)
 * while querySelector finds the populated element, so always resolve the body
 * this way.
 * @returns {any}
 */
const bodyOf = (document) => document.querySelector('body') ?? document.documentElement;

/**
 * HTML attribute names are ASCII case-insensitive, but linkedom keeps them as
 * written, so `<A HREF>` had no href, `<INPUT TYPE="hidden">` no type and
 * `<P STYLE="display:none">` no style. Lowercase them once after parsing so
 * every lookup below sees what a browser sees. As in a browser, the first of
 * two spellings of one attribute wins.
 * @param {Document} document
 */
function lowerAttributeNames(document) {
  for (const el of document.querySelectorAll('*')) {
    const attributes = [...el.attributes];
    if (attributes.every(({ name }) => name === name.toLowerCase())) continue;
    const first = new Map();
    for (const { name, value } of attributes) {
      const lower = name.toLowerCase();
      if (!first.has(lower)) first.set(lower, value);
    }
    for (const { name } of attributes) el.removeAttribute(name);
    for (const [name, value] of first) el.setAttribute(name, value);
  }
}

/**
 * Shared cleanup for the raw modes: parse, then delete the same noise
 * distill() skips, so neither raw output ever leaks scripts, styles, or
 * hidden content.
 * @param {string} html
 * @param {string} [url]
 * @param {string} [type] - the declared Content-Type
 */
function cleanDocument(html, url = '', type = '') {
  // Raw is the mode an agent reaches for when the compact view left something
  // out, so it is the one place a JSON response keeps every field.
  const { document } = parseHTML(asHTML(html, url, { full: true, type }));
  lowerAttributeNames(document);
  // Read the title before the sweep below removes the head with it.
  const title = clean(document.querySelector('title')?.textContent ?? '');
  for (const tag of DROP) {
    for (const el of [...document.querySelectorAll(tag)]) el.remove();
  }
  for (const el of [...document.querySelectorAll('[hidden], [aria-hidden="true"]')]) el.remove();
  for (const el of [...document.querySelectorAll('input')]) {
    if ((el.getAttribute('type') ?? '').toLowerCase() === 'hidden') el.remove();
  }
  for (const el of [...document.querySelectorAll('[style]')]) {
    if (/display:\s*none/.test(el.getAttribute('style') ?? '')) el.remove();
  }
  return { document, title };
}

/**
 * Whole-page markdown for `oc raw`, produced by turndown so lists, emphasis,
 * links, and code blocks come out as real markdown instead of flat lines.
 * @param {string} html
 * @param {string} url - only read when the body turns out to be JSON, whose
 *   title has to come from the endpoint because the payload has none
 * @param {{type?: string}} [opts] - the declared Content-Type
 * @returns {string}
 */
export function toMarkdown(html, url = '', { type = '' } = {}) {
  const { document, title } = cleanDocument(html, url, type);
  // A plain text file is already the markdown of itself. Run through the
  // converter it came back with every `#` and backtick escaped.
  const file = document.querySelector('main[data-text] > pre');
  if (file) return file.textContent;
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  const el = bodyOf(document);
  const body = el ? turndown.turndown(el.innerHTML).trim() : '';
  return title && !body.startsWith(`# ${title}`) ? `# ${title}\n\n${body}` : body;
}

/**
 * Whole-page cleaned HTML for `oc raw --html`, for agents that would rather
 * work with markup than markdown. Same noise removal, no other rewriting.
 * @param {string} html
 * @param {string} url - see toMarkdown
 * @param {{type?: string}} [opts] - see toMarkdown
 * @returns {string}
 */
export function toHTML(html, url = '', { type = '' } = {}) {
  const { document } = cleanDocument(html, url, type);
  const el = bodyOf(document);
  return el ? el.innerHTML.trim() : '';
}

/**
 * Sites behind hard bot challenges often leave their Atom or RSS feeds open:
 * Stack Overflow challenges every HTML page but publishes full question and
 * answer bodies under /feeds. A feed is XML with the real content escaped
 * inside each entry, so this converts one into a plain HTML document and
 * everything downstream stays unchanged. Returns null for non-feed input.
 * @param {string} text
 * @returns {string | null}
 */
export function feedToHTML(text) {
  const head = text.slice(0, 2000);
  if (!/<(feed|rss)[\s>]/i.test(head) || /<(html|body)[\s>]/i.test(head)) return null;
  // RSS wraps bodies in CDATA, which an HTML parser reads as a comment and
  // drops. Escaping the section turns it into ordinary text, the same shape
  // Atom feeds already use.
  const xml = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) =>
    inner.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  const { document } = parseHTML(xml);
  const root = document.querySelector('feed, rss');
  if (!root) return null;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Feed elements are unknown to the HTML parser, so self-closed ones like
  // <category /> stay open and swallow their siblings. Descendant queries
  // still land, because a closing </entry> or </item> pops the whole pile.
  const field = (el, sel) => clean(el.querySelector(sel)?.textContent ?? '');
  // HTML treats <link> as void, so an RSS 2.0 URL written as the element's
  // text is not in textContent: the parser closes the tag immediately and the
  // URL sits in the following text node. Skipping that node made `do` on a
  // WordPress or HN item follow the guid instead, which is often an internal
  // id, or follow nothing when the item has no guid at all.
  const rssLink = (entry) => {
    const link = entry.querySelector('link');
    if (!link || link.getAttribute('href')) return '';
    let n = link.nextSibling;
    while (n && n.nodeType === 3 && !/\S/.test(n.textContent ?? '')) n = n.nextSibling;
    const text = n?.nodeType === 3 ? clean(n.textContent ?? '') : '';
    return text && !/\s/.test(text) ? text : '';
  };
  const feedTitle = field(root, 'title');
  const parts = [];
  for (const entry of root.querySelectorAll('entry, item')) {
    const title = field(entry, 'title');
    // Atom puts the URL on link href. RSS 2.0 writes it as <link> text, which
    // rssLink reads. guid is only a permalink when it says so (the default),
    // and isPermaLink="false" means the value is an id, not a URL.
    const guid = entry.querySelector('guid');
    const guidIsPermalink = !guid
      || (guid.getAttribute('ispermalink') ?? 'true').toLowerCase() !== 'false';
    const href = entry.querySelector('link[rel="alternate"]')?.getAttribute('href')
      || entry.querySelector('link[href]')?.getAttribute('href')
      || rssLink(entry)
      || (guidIsPermalink ? field(entry, 'guid') : '');
    const author = field(entry, 'author name') || field(entry, 'author');
    const date = feedDate(field(entry, 'updated') || field(entry, 'published') || field(entry, 'pubdate'));
    const byline = [author && `by ${author}`, date].filter(Boolean).join(', ');
    // Atom escapes the entry body, so textContent of content/summary is the
    // HTML itself, ready to be embedded and parsed like any page.
    // RSS 2.0 keeps the full post in content:encoded and the excerpt in
    // description, so the encoded body has to win or a feed is only ledes.
    const body = (entry.querySelector('content\\:encoded')
      ?? entry.querySelector('content')
      ?? entry.querySelector('summary')
      ?? entry.querySelector('description'))?.textContent ?? '';
    parts.push('<article>');
    // The title is the link. It used to sit beside the byline as an anchor
    // labelled "open", the same label on every entry, and the repeated-controls
    // filter hid the lot as chrome, so nothing in a subreddit feed led to a
    // post: `do <n>` on one read its heading instead of following it (#59). A
    // heading that is exactly one anchor becomes a followable heading in the
    // walk, so the number the agent already sees is the one that opens it.
    if (title) parts.push(`<h2>${href ? `<a href="${esc(href)}">${esc(title)}</a>` : esc(title)}</h2>`);
    if (byline || (href && !title)) {
      parts.push(`<p>${esc(byline)}${href && !title ? ` <a href="${esc(href)}">open</a>` : ''}</p>`);
    }
    parts.push(body, '</article>');
  }
  // A full skeleton, because linkedom treats the first element of a bare
  // multi-rooted fragment as the whole document and drops its siblings.
  return `<html><head><title>${esc(feedTitle)}</title></head><body>\n${parts.join('\n')}\n</body></html>`;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const RFC822_DATE = /^(?:[a-z]{3},\s*)?(\d{1,2})\s+([a-z]{3})\s+(\d{4})\b/i;

/**
 * An entry's date as YYYY-MM-DD. Atom writes ISO 8601, so the day is its
 * first ten characters. RSS 2.0 writes RFC 822 ('Mon, 17 Aug 2026 00:00:00
 * GMT'), and ten characters of that are 'Mon, 17 Au'. Its day, month, and
 * year are read as written rather than through Date, which would move a late
 * evening post to the next day in UTC; the Atom slice keeps the feed's own
 * day too. Anything else is printed as the feed wrote it, not cut.
 * @param {string} s
 * @returns {string}
 */
function feedDate(s) {
  if (/^\d{4}-\d\d-\d\d/.test(s)) return s.slice(0, 10);
  const m = s.match(RFC822_DATE);
  const month = m ? MONTHS.indexOf(m[2].toLowerCase()) + 1 : 0;
  if (!month) return s;
  return `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

const escHTML = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Pull one embedded JSON object out of a page by its variable name, scanning
 * forward from the first `{` and tracking string/escape state so a brace
 * inside a quoted value never ends the object early. A regex can't do this
 * safely because the JSON itself contains braces.
 * @param {string} text
 * @param {string} marker
 * @returns {any}
 */
function extractJSON(text, marker) {
  const at = text.indexOf(marker);
  if (at === -1) return null;
  const start = text.indexOf('{', at);
  if (start === -1) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * A YouTube watch page needs client JS to become interactive, but the initial
 * HTML response already carries the title, description, view count, and
 * caption tracks inline as `ytInitialPlayerResponse`, so none of that has to
 * wait on the v0.3 headless fallback. Each caption track becomes a link to
 * its timedtext URL, which `oc do` follows and transcriptToHTML turns into
 * readable text. Returns null for anything that isn't a watch page.
 * @param {string} text
 * @returns {string | null}
 */
export function youtubeToHTML(text) {
  const data = extractJSON(text, 'ytInitialPlayerResponse');
  const details = data?.videoDetails;
  if (!details?.title) return null;
  const micro = data.microformat?.playerMicroformatRenderer;
  const tracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const views = details.viewCount ? `${Number(details.viewCount).toLocaleString('en-US')} views` : '';
  const byline = [details.author && `by ${details.author}`, views, micro?.publishDate].filter(Boolean).join(', ');
  const channelHref = details.channelId ? `https://www.youtube.com/channel/${details.channelId}` : '';
  const parts = [`<h1>${escHTML(details.title)}</h1>`];
  if (byline || channelHref) {
    parts.push(`<p>${escHTML(byline)}${channelHref ? ` <a href="${escHTML(channelHref)}">channel</a>` : ''}</p>`);
  }
  const description = details.shortDescription ?? micro?.description?.simpleText ?? '';
  for (const para of description.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    parts.push(`<p>${escHTML(para)}</p>`);
  }
  for (const track of tracks) {
    const label = track.name?.simpleText || track.languageCode || 'transcript';
    const kind = track.kind === 'asr' ? ' (auto-generated)' : '';
    parts.push(`<p><a href="${escHTML(track.baseUrl)}">transcript: ${escHTML(label)}${kind}</a></p>`);
  }
  return `<html><head><title>${escHTML(details.title)}</title></head><body>\n${parts.join('\n')}\n</body></html>`;
}

/**
 * YouTube's timedtext endpoint answers plain XML, one `<text>` cue per
 * caption line. Concatenated into a single block rather than one paragraph
 * per cue, so a whole transcript pages through `oc next`/`oc read` like any
 * other long document instead of costing one numbered block per few words.
 * Consecutive duplicate cues (auto captions repeat words across overlapping
 * segments) are dropped. Returns null for anything that isn't a transcript.
 * @param {string} text
 * @returns {string | null}
 */
export function transcriptToHTML(text) {
  if (!/<transcript[\s>]/i.test(text.slice(0, 200))) return null;
  const { document } = parseHTML(text);
  const cues = [...document.querySelectorAll('text')];
  if (!cues.length) return null;
  const lines = [];
  for (const cue of cues) {
    const line = clean(cue.textContent ?? '');
    if (line && line !== lines[lines.length - 1]) lines.push(line);
  }
  if (!lines.length) return null;
  return `<html><head><title>Transcript</title></head><body>\n<p>${escHTML(lines.join(' '))}</p>\n</body></html>`;
}

// Keys an API is likely to give the human-readable name of an item, in the
// order they win when an item carries several of them.
const TITLE_KEYS = [
  'title', 'name', 'headline', 'subject', 'label', 'display_name',
  'full_name', 'summary', 'question', 'message',
];

// Keys an API is likely to put its list of results under. A response using one
// of these is a list whatever else it carries, so the name settles it before
// shape does: a sideloaded `included` array can outnumber the `items` the
// request was for without being what the request was for.
const CONTAINER_KEYS = [
  'items', 'data', 'results', 'hits', 'records', 'rows', 'entries',
  'nodes', 'edges', 'docs', 'list', 'children', 'values',
];

// Keys holding the item's own page. A URL under any other name is still found,
// by looking at values rather than names, but these win when several qualify.
const LINK_KEYS = ['link', 'url', 'html_url', 'web_url', 'permalink', 'href'];

// A title has to fit on a line to be one. Anything longer is a body that
// happens to live under a title-ish key, and belongs in a block of its own.
const TITLE_MAX = 300;

// How many constant fields the footer names before it stops counting them out.
const CONST_LISTED = 8;

// Characters of field text an item may spend in the compact view. A response
// carries far more fields than an agent asked for: one Stack Exchange result
// brings eight about the asker alone, which is the whole budget spent on who
// rather than what. Thirty items make this thirty times over, so it buys two
// or three fields, not a record. `oc raw` still has all of them.
const FIELD_BUDGET = 60;

// What a field from a flattened sub-object scores against one of the item's
// own. `owner.user_id` varies perfectly and costs little, which is enough to
// win on width and variance alone, but it identifies somebody attached to the
// result rather than the result, and no agent searched for it.
const NESTED_PENALTY = 0.25;

// How many names the footer lists when it says which fields it left out.
const DROPPED_LISTED = 5;

// Characters of markup a field may carry before the compact view stops
// treating it as a document and starts treating it as somewhere to go. A
// question body arrives well under this and is worth rendering in place, links
// and code and all. A package readme arrives at four figures and distils into
// more blocks than the resource it is attached to has fields, which buries the
// resource the response was fetched for. `oc raw` renders either one in full.
const BODY_CAP = 4000;

// Seconds and milliseconds since the epoch, bounded either side so an ordinary
// count (a score, a byte size) is never mistaken for a date.
const EPOCH_S = [1e9, 4e9];
const EPOCH_MS = [1e12, 4e12];
const DATE_KEY = /(^|_)(date|at|time|timestamp|created|updated|published|modified)$/i;
const ISO_DATE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:?\d\d)$/;

// Named entities worth knowing without a table: the five XML ones plus the
// space. Everything else arrives numeric.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * Undo one layer of HTML escaping in a string value. APIs that back an HTML
 * site tend to escape the text they return: Stack Exchange answers with
 * `Is &quot;==&quot; slower`, and re-escaping that on the way into a document
 * would print the entity instead of the quote it stands for.
 * @param {string} s
 * @returns {string}
 */
const decodeEntities = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : Number(body.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isURL = (v) => typeof v === 'string' && /^https?:\/\/\S+$/.test(v);
const looksHTML = (v) => typeof v === 'string' && /<\/?(p|div|pre|code|br|ul|ol|li|h[1-6]|blockquote|table|img|a|em|strong)\b[^>]*>/i.test(v);
// Markup as one line of prose, for a body the compact view is pointing at
// rather than rendering. The distiller is what reads markup properly; this
// only has to make a line an agent can tell one body from another by.
const stripTags = (v) => clean(decodeEntities(String(v).replace(/<[^>]*>/g, ' ')));

/**
 * One level of flattening, so `owner: {display_name}` becomes an
 * `owner.display_name` field. Deeper than that an object stops being a set of
 * fields and starts being a document, which no line-per-item view can hold.
 * @param {Record<string, any>} item
 * @returns {Map<string, any>}
 */
function flattenItem(item) {
  /** @type {Map<string, any>} */
  const out = new Map();
  for (const [key, value] of Object.entries(item)) {
    if (!isPlain(value)) {
      out.set(key, value);
      continue;
    }
    for (const [inner, deep] of Object.entries(value)) {
      if (deep !== null && typeof deep === 'object') continue;
      out.set(`${key}.${inner}`, deep);
    }
  }
  return out;
}

/**
 * One field as one string. Epoch integers under a date-ish key become ISO
 * dates, because an agent that has to convert one pays a turn for it. Arrays
 * of scalars (tags, labels) join; arrays of objects are counted, since
 * spelling them out is what the flattening above already refused to do.
 * @param {string} key
 * @param {any} value
 * @returns {string}
 */
function renderValue(key, value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    if (!value.length) return '';
    if (value.every((v) => v === null || typeof v !== 'object')) return value.join(', ');
    return `[${value.length} items]`;
  }
  if (typeof value === 'object') return '';
  if (typeof value === 'number' && Number.isInteger(value) && DATE_KEY.test(key)) {
    const ms = value >= EPOCH_S[0] && value < EPOCH_S[1] ? value * 1000
      : value >= EPOCH_MS[0] && value < EPOCH_MS[1] ? value
      : null;
    if (ms !== null) return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  }
  // An ISO timestamp under the same keys reads the same way: the fraction
  // and zone suffix are a third of its characters and never the point.
  if (typeof value === 'string' && DATE_KEY.test(key) && ISO_DATE.test(value)) {
    return value.slice(0, 19).replace('T', ' ');
  }
  return typeof value === 'string' ? decodeEntities(value) : String(value);
}

/**
 * Order fields by how much they say per character, and keep taking them while
 * an item can still afford one. Variance is what carries the information: a
 * field reading the same on every row has already been lifted out as a
 * constant, and one reading differently every time is why the response was
 * fetched. Dividing by width is what stops a long field (a profile image URL,
 * a licence string) from crowding out three short ones that matter more.
 * @param {Array<Map<string, string>|null>} rows
 * @param {Set<string>} skip - fields already spoken for as title, link, or constant
 * @returns {{kept: Set<string>, dropped: string[]}}
 */
function chooseFields(rows, skip) {
  const present = rows.filter(Boolean);
  const keys = [];
  for (const row of present) {
    for (const key of row.keys()) if (!skip.has(key) && !keys.includes(key)) keys.push(key);
  }
  const scored = [];
  for (const key of keys) {
    const values = present.map((row) => row.get(key) ?? '').filter((v) => v !== '');
    if (!values.length) continue;
    const width = values.reduce((sum, v) => sum + v.length + key.length + 3, 0) / values.length;
    const variance = new Set(values).size / values.length;
    const penalty = key.includes('.') ? NESTED_PENALTY : 1;
    scored.push({ key, width, score: (variance / width) * penalty });
  }
  scored.sort((a, b) => b.score - a.score);
  const kept = new Set();
  let spent = 0;
  for (const field of scored) {
    // The first field is taken whatever it costs, so an item of one long field
    // still renders something rather than nothing.
    if (spent + field.width > FIELD_BUDGET && kept.size) continue;
    kept.add(field.key);
    spent += field.width;
  }
  return { kept, dropped: scored.filter((f) => !kept.has(f.key)).map((f) => f.key) };
}

/**
 * Pick what the response is actually about: the root when it is an array or a
 * single resource, otherwise the array of objects at the top level that holds
 * the results. Everything beside it is metadata about the request rather than
 * content.
 * @param {any} data
 * @returns {{items: any[], meta: Record<string, any>}}
 */
function mainArray(data) {
  if (Array.isArray(data)) return { items: data, meta: {} };
  /** @type {Map<string, any[]>} */
  const arrays = new Map();
  for (const [k, v] of Object.entries(data)) {
    if (!Array.isArray(v) || !v.length) continue;
    if (!v.some(isPlain)) continue;
    arrays.set(k, v);
  }
  let key = CONTAINER_KEYS.find((k) => arrays.has(k)) ?? '';
  // A root carrying its own name is the resource, and an array hanging off it
  // describes that resource rather than being the subject in its place. Taking
  // the longest array regardless titled the npm registry's package endpoint
  // after its two maintainers and demoted the package to the metadata line,
  // where a 9KB readme then cost more than the rest of the page put together.
  const named = TITLE_KEYS.some((k) => typeof data[k] === 'string' && data[k].trim() !== '');
  if (!key && !named) {
    for (const [k, v] of arrays) {
      if (!key || v.length > (arrays.get(key)?.length ?? 0)) key = k;
    }
  }
  // A response with no results array of its own is a single resource, which
  // renders as one item rather than as a special case.
  if (!key) return { items: [data], meta: {} };
  const meta = { ...data };
  delete meta[key];
  return { items: arrays.get(key) ?? [data], meta };
}

/**
 * Fields whose rendered value is the same on every item. In a list of thirty
 * results they are thirty copies of one fact, so they come out of the rows and
 * get stated once at the foot of the page: the saving is the point of the
 * exercise, and dropping them silently would be a lie about what the API said.
 * @param {Array<Map<string, string>|null>} rows
 * @returns {Map<string, string>}
 */
function constantFields(rows) {
  const present = rows.filter(Boolean);
  /** @type {Map<string, string>} */
  const out = new Map();
  if (present.length < 2) return out;
  for (const [key, value] of present[0]) {
    if (present.every((row) => row.get(key) === value)) out.set(key, value);
  }
  return out;
}

/**
 * A JSON body is not a page, so nothing downstream can read one: the HTML
 * parser turns it into a single unreadable text node and the budget truncates
 * the blob. This turns a response into the same shape feedToHTML produces, one
 * article per item, so numbering, the budget, `oc do`, and raw markdown all
 * work on an API exactly as they do on a page.
 *
 * The view is a line per item rather than a table: two or three fields carry
 * the signal in most responses, and turndown cannot write a markdown table
 * without the GFM plugin, which is a dependency this project does not want.
 * Returns null for anything that is not JSON.
 * @param {string} text
 * @param {string} url
 * @param {{full?: boolean, view?: View|null}} [opts] - full keeps every
 *   field, which is what the raw modes are for; the compact view keeps the
 *   ones that earn their tokens, or the ones a site shortcut's view names
 * @returns {string | null}
 */
export function jsonToHTML(text, url = '', { full = false, view = null } = {}) {
  if (!/^\s*[[{]/.test(text.slice(0, 200))) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;

  // A shortcut that names its fields knows the response better than the
  // scoring below can guess, so its choice wins, except in the raw modes,
  // which exist to show what a choice left out.
  if (!full && view?.keep?.length) {
    const chosen = chosenToHTML(data, url, view);
    if (chosen) return chosen;
  }

  const { items, meta } = mainArray(data);
  const flats = items.map((item) => (isPlain(item) ? flattenItem(item) : null));
  const rows = flats.map((flat) => {
    if (!flat) return null;
    /** @type {Map<string, string>} */
    const row = new Map();
    for (const [key, value] of flat) row.set(key, renderValue(key, value));
    return row;
  });

  // One item's field names stand for all of them: a ragged response still gets
  // a consistent title and link column, and a field missing from an item is
  // simply absent from its line.
  const sample = flats.find(Boolean) ?? new Map();
  const titled = (k) => {
    const v = sample.get(k);
    return typeof v === 'string' && v.trim() && v.length <= TITLE_MAX && !isURL(v) && !looksHTML(v);
  };
  const titleKey = TITLE_KEYS.find(titled) ?? [...sample.keys()].find(titled);
  const linkKey = LINK_KEYS.find((k) => isURL(sample.get(k))) ?? [...sample.keys()].find((k) => isURL(sample.get(k)));

  const constants = constantFields(rows);
  const spoken = new Set([titleKey, linkKey, ...constants.keys()].filter(Boolean));
  const { kept, dropped } = full
    ? { kept: null, dropped: [] }
    : chooseFields(rows, spoken);
  const parts = [];

  for (let i = 0; i < items.length; i++) {
    const flat = flats[i];
    if (!flat) {
      const line = renderValue('', items[i]);
      if (line) parts.push(`<p>${escHTML(line)}</p>`);
      continue;
    }
    const row = rows[i];
    const title = titleKey ? row.get(titleKey) : '';
    const link = linkKey && isURL(flat.get(linkKey)) ? flat.get(linkKey) : '';
    const inline = [];
    const long = [];
    const bodies = [];
    for (const [key, value] of flat) {
      if (spoken.has(key)) continue;
      // A field carrying markup is a document, and is kept whatever it scored:
      // it renders as its own block, so it never competes for the field line.
      if (kept && !kept.has(key) && !looksHTML(value)) continue;
      // A field carrying HTML is a page in itself: `filter=withbody` on the
      // Stack Exchange API puts a whole question in one. It goes through the
      // distiller like any other markup instead of into a cell, unless it is
      // longer than the compact view can afford, in which case it becomes one
      // numbered line rather than a dozen blocks that bury the item it hangs
      // off. `oc read <n>` opens it at a budget that fits it, `oc raw` always.
      if (looksHTML(value)) {
        if (full || String(value).length <= BODY_CAP) {
          bodies.push(String(value));
          continue;
        }
        long.push(`<p>${escHTML(`${key}: ${stripTags(value)}`)}</p>`);
        continue;
      }
      const rendered = row.get(key);
      if (!rendered) continue;
      if (rendered.length > TEXT_CAP) long.push(`<p>${escHTML(`${key}: ${rendered}`)}</p>`);
      else inline.push(`${key}: ${rendered}`);
    }

    parts.push('<article>');
    if (title && link) parts.push(`<p><a href="${escHTML(link)}">${escHTML(title)}</a></p>`);
    else if (title) parts.push(`<p>${escHTML(title)}</p>`);
    else if (link) parts.push(`<p><a href="${escHTML(link)}">open</a></p>`);
    if (inline.length) parts.push(`<p>${escHTML(inline.join(' | '))}</p>`);
    parts.push(...long);
    for (const body of bodies) parts.push(`<div>${body}</div>`);
    parts.push('</article>');
  }

  // What the rows no longer carry, said once. Empty-everywhere fields are
  // named but not valued, because their value is the fact that there isn't one.
  const shown = [...constants].filter(([, v]) => v !== '');
  const empty = [...constants].filter(([, v]) => v === '').map(([k]) => k);
  const clipped = (list, render) => {
    const head = list.slice(0, CONST_LISTED).map(render).join(', ');
    return list.length > CONST_LISTED ? `${head}, +${list.length - CONST_LISTED} more` : head;
  };
  if (shown.length) {
    parts.push(`<p>same on every item: ${escHTML(clipped(shown, ([k, v]) => `${k}=${v.length > 60 ? `${v.slice(0, 60)}...` : v}`))}</p>`);
  }
  if (empty.length) parts.push(`<p>empty on every item: ${escHTML(clipped(empty, (k) => k))}</p>`);
  if (dropped.length) {
    const names = dropped.slice(0, DROPPED_LISTED).join(', ');
    const more = dropped.length > DROPPED_LISTED ? `, +${dropped.length - DROPPED_LISTED} more` : '';
    parts.push(`<p>${dropped.length} fields per item not shown (${escHTML(names + more)}), 'oc raw' has them</p>`);
  }

  const metaBits = [];
  const metaLong = [];
  for (const [key, value] of Object.entries(meta)) {
    if (value === null || typeof value === 'object') continue;
    const rendered = renderValue(key, value);
    if (!rendered) continue;
    // A summary line has to stay a line. One long scalar at the root, a
    // package readme or an endpoint description, would otherwise spend the
    // whole page budget here, so it becomes a block of its own instead. The
    // block is numbered, so `oc read <n>` opens it when it fits that budget
    // and `oc raw` has it whatever its size.
    if (rendered.length > TEXT_CAP) metaLong.push(`<p>${escHTML(`${key}: ${rendered}`)}</p>`);
    else metaBits.push(`${key}=${rendered}`);
  }
  if (metaBits.length) parts.push(`<p>response: ${escHTML(metaBits.join(', '))}</p>`);
  parts.push(...metaLong);

  const count = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;
  return `<html><head><title>${escHTML(jsonTitle(url, count))}</title></head><body>\n${parts.join('\n')}\n</body></html>`;
}

/**
 * Read a dot path out of a response ('info.version', 'versions.0.license').
 * The empty path is the response itself, for an API whose answer is the
 * bare list.
 * @param {any} obj
 * @param {string} path
 * @returns {any}
 */
export const pick = (obj, path) =>
  path === '' ? obj : String(path).split('.').reduce((o, key) => (o == null ? undefined : o[key]), obj);

const SLOT = /\{([^{}]+)\}/g;

/**
 * One chosen field as a string. Booleans read as flags: a true one prints the
 * field's own name and a false one nothing, so a dependency row reads
 * `bytes ^1 normal optional` instead of repeating `optional: false` on every
 * line. An object of scalars (npm's `dependencies`, PyPI's `project_urls`)
 * prints as `key=value` pairs, since naming the field was the request to see
 * inside it.
 * @param {string} path
 * @param {any} value
 * @returns {string}
 */
function renderField(path, value) {
  const key = path.split('.').pop() ?? path;
  if (typeof value === 'boolean') return value ? key : '';
  if (isPlain(value)) {
    return Object.entries(value)
      .filter(([, v]) => v !== null && typeof v !== 'object')
      .map(([k, v]) => `${k}=${renderValue(k, v)}`)
      .join(', ');
  }
  return renderValue(key, value);
}

/**
 * Fill the `{path}` slots of a template from one item. A template whose
 * every slot came up empty is empty itself rather than its own literal text,
 * so a changed API reads as missing fields and not as a page of bare
 * punctuation.
 * @param {string} template
 * @param {any} item
 * @returns {string}
 */
export function fillTemplate(template, item) {
  let filled = 0;
  const text = template.replace(SLOT, (_, path) => {
    const value = renderField(path, pick(item, path));
    if (value) filled++;
    return value;
  });
  return filled ? clean(text) : '';
}

/**
 * The absolute URL a filled template names, when the template itself starts
 * as one: a site path ("/raw/{id}") or an https URL. Only the template's own
 * prefix counts, so a field value can never turn plain text into a link or
 * point one at another host.
 * @param {string} template
 * @param {string} text - the filled template
 * @param {string} base - the endpoint URL, to resolve a site path
 * @returns {string}
 */
function templateLink(template, text, base) {
  if (!/^(\/[^/{]|https:\/\/[^/{])/.test(template) || /\s/.test(text)) return '';
  try {
    const href = new URL(text, base);
    return href.protocol === 'https:' || href.protocol === 'http:' ? href.href : '';
  } catch {
    return '';
  }
}

/**
 * The view a site shortcut asked for: exactly the fields it named, in the
 * order it named them, for the one object the response is or for each item
 * of the list it points at. This exists because the generic view below has
 * to guess, and on registry data it guesses wrong: PyPI's package endpoint
 * rendered the wheel files and their hashes instead of the version, and a
 * crates.io dependency list showed row ids and dropped the field that says
 * whether a dependency is dev-only.
 *
 * A field holding a URL becomes a link of its own, so `oc do` follows it. A
 * name-like first field is the item's title and drops its label. Short
 * fields that follow each other share a line, the way the generic view
 * joins them. Returns null when no item held any of the named fields (an
 * error body, an API that changed shape), so the response renders untouched
 * and the real reason stays visible.
 * @param {any} data
 * @param {string} url
 * @param {View} view
 * @returns {string | null}
 */
function chosenToHTML(data, url, view) {
  const list = view.list == null ? (Array.isArray(data) ? data : [data]) : pick(data, view.list);
  if (!Array.isArray(list)) return null;
  const parts = [];
  for (const item of list) {
    if (!isPlain(item)) continue;
    /** @type {Array<{text: string, label?: string, link?: string}>} */
    const entries = [];
    for (const field of view.keep) {
      if (field.includes('{')) {
        const text = fillTemplate(field, item);
        // A template that is a URL on the site ("/raw/{id}") is the item's
        // link: a forum's topic list names no URL of its own to follow.
        const link = text && templateLink(field, text, url);
        if (link) entries.push({ text: link, link });
        else if (text) entries.push({ text });
        continue;
      }
      const value = pick(item, field);
      const text = renderField(field, value);
      if (!text) continue;
      const label = field.split('.').pop() ?? field;
      if (isURL(text)) entries.push({ text, label, link: text });
      else entries.push({ text, label: typeof value === 'boolean' ? undefined : label });
    }
    if (!entries.length) continue;
    parts.push('<article>');
    const [first, ...rest] = entries;
    // A name-like first field is the item's title: bare, on a line of its own.
    const titled = first.label && !first.link && TITLE_KEYS.includes(first.label) && first.text.length <= TITLE_MAX;
    if (titled) parts.push(`<p>${escHTML(first.text)}</p>`);
    const inline = [];
    let width = 0;
    const flush = () => {
      if (inline.length) parts.push(`<p>${escHTML(inline.join(' | '))}</p>`);
      inline.length = 0;
      width = 0;
    };
    for (const entry of titled ? rest : entries) {
      const line = entry.label ? `${entry.label}: ${entry.text}` : entry.text;
      if (entry.link) {
        flush();
        parts.push(`<p><a href="${escHTML(entry.link)}">${escHTML(line)}</a></p>`);
      } else if (line.length > TEXT_CAP) {
        flush();
        parts.push(`<p>${escHTML(line)}</p>`);
      } else {
        // A shared line that outgrew the cap would be cut, and these fields
        // were asked for by name, so the line wraps instead.
        if (inline.length && width + line.length + 3 > TEXT_CAP) flush();
        width = inline.length ? width + line.length + 3 : line.length;
        inline.push(line);
      }
    }
    flush();
    parts.push('</article>');
  }
  if (!parts.length) return null;
  const count = `${list.length} ${list.length === 1 ? 'item' : 'items'}`;
  return `<html><head><title>${escHTML(jsonTitle(url, count))}</title></head><body>\n${parts.join('\n')}\n</body></html>`;
}

/**
 * An API response has no title of its own, so the endpoint becomes one. The
 * query parameter is worth the tokens it costs: it is the only part of a
 * search URL that says what the page is, and without it every search a session
 * runs is titled the same.
 * @param {string} url
 * @param {string} count
 * @returns {string}
 */
function jsonTitle(url, count) {
  try {
    const u = new URL(url);
    const query = ['q', 'query', 'search', 'terms', 'keywords', 'text']
      .map((k) => u.searchParams.get(k))
      .find((v) => v);
    const base = `${u.host}${u.pathname}`.replace(/\/+$/, '');
    return query ? `${base}: "${query}" (${count})` : `${base} (${count})`;
  } catch {
    return `JSON (${count})`;
  }
}

/**
 * Adjacent text nodes arrive fragmented (one per inline element boundary).
 * Merging them is what turns DOM noise into readable lines.
 * @param {Block[]} blocks
 * @returns {Block[]}
 */
function mergeText(blocks) {
  /** @type {Block[]} */
  const out = [];
  for (const b of blocks) {
    if (b.type === 'break') {
      // A boundary only has to stop the merge, and it does that by being the
      // last thing in the list when the next text block arrives.
      if (out[out.length - 1]?.type === 'text') out.push(b);
      continue;
    }
    const prev = out[out.length - 1];
    if (b.type === 'text' && prev?.type === 'text') {
      // Two fragments of one element with no whitespace between them were one
      // word before the parser split them. Anything else was separated on the
      // page and stays separated here.
      const glued = prev.host && prev.host === b.host && !prev.post && !b.pre;
      prev.text = glued ? `${prev.text}${b.text}` : `${prev.text} ${b.text}`;
      prev.post = b.post;
    } else {
      out.push(b);
    }
  }
  // Single stray characters (list bullets, separators) cost tokens and say
  // nothing. A single letter or digit is a value, though: a table cell holds
  // one as a block of its own, and an infobox read "Children" with no number.
  return out
    .filter((b) => b.type !== 'break')
    .filter((b) => b.type !== 'text' || b.text.length > 1 || /[\p{L}\p{N}]/u.test(b.text))
    .map(({ host, pre, post, ...block }) => block);
}
