/**
 * Rendering is where the token budget is enforced. Everything printed here
 * gets read by a paying model, so the default view is dense, anything cut says
 * how much was cut, and the footer names the cheapest command that gets it.
 */

import { TEXT_CAP } from './distill.js';

/**
 * Rough but stable token estimate. Close enough for budgets; the point is
 * that it never changes between runs, not that it matches any one tokenizer.
 * @param {string} s
 * @returns {number}
 */
export const estimateTokens = (s) => Math.ceil(s.length / 4);

const num = (v) => v.toLocaleString('en-US');

// A page that distilled to nothing must not read like a page with nothing on
// it. JS-only pages, consent walls, and bot challenges all answer HTTP 200 with
// markup carrying no text, and "100% saved" is technically true of a render
// that saved every token by extracting none. From the output alone an agent
// cannot tell that from a genuinely empty page, so it never falls back to
// something heavier and an empty result travels on as evidence. oc has to fail
// loud and cheap there instead, per principle 5 in CONTRIBUTING.
//
// The numbers below are measured, not guessed. Against live pages, the thinnest
// render the README claims (an X profile) carries about 460 tokens of content,
// while a JS-only or gated one carries under 55 (reddit.com/r/*,
// instagram.com), so a threshold in between never has to be a close call.

// Text the page itself wrote, in tokens: prose and headings, plus link and
// button labels long enough to be content rather than furniture. Nav chrome is
// short by nature ("Help", "Log in") and a headline or a post title is not,
// which is what tells a link-list page (Hacker News, search results) from a
// page whose only links are its own menu.
const CONTENT_LABEL = 25;
// Below this a render is suspiciously thin, but thin is only a verdict when
// the page's own size says there should have been more. A terse page that
// arrived terse (a status endpoint, a one-line answer) distilled fine.
export const MIN_CONTENT = 25;
// Below this, with markup that large behind it, the fetch worked and the render
// did not: a real page of that weight always distills to more. A genuinely
// short page is exempt, because its HTML never reaches THIN_HTML.
const THIN_CONTENT = 100;
const THIN_HTML = 2500;

/**
 * How much of a distilled page is text the page itself wrote.
 * @param {import('./distill.js').Page} page
 * @returns {number}
 */
export const contentTokens = (page) =>
  page.blocks.reduce((sum, b) => {
    if (b.type === 'heading' || b.type === 'text') return sum + estimateTokens(b.text ?? '');
    const label = (b.type === 'link' || b.type === 'button') && (b.text ?? '').length > CONTENT_LABEL;
    return label ? sum + estimateTokens(b.text) : sum;
  }, 0);

/**
 * Why this render carries no content worth printing, as a phrase for the
 * failure line, or null when it does carry some. Both figures are token counts,
 * which is the unit the caller is paying in.
 * @param {number} content
 * @param {number} htmlTokens
 * @returns {string|null}
 */
export function contentFailure(content, htmlTokens) {
  // Nothing extracted is empty whatever the page weighed. Anything more is
  // only a failure with evidence: a small page that renders small is not
  // gated, it is small, and exit 2 on it would send an agent to a browser
  // for a page it was already holding.
  if (content === 0) return 'no text on the whole page';
  if (content < THIN_CONTENT && htmlTokens > THIN_HTML) {
    return `~${content} tokens of text out of ~${htmlTokens} of HTML`;
  }
  return null;
}

// How far past the budget a page may run and still be printed whole. Cutting a
// page that was nearly done costs the agent a second command, and a command is
// dear: measured inside Claude Code, one tool call is 23,000 to 33,000 tokens of
// session overhead no matter what it prints. Against that, break-even sits near
// fifty times the budget. The number is far lower than break-even because the
// saving is only collected when the agent would have paged at all, while the
// overspend is paid on every page that runs a little long, including the ones
// answered by their first few lines. Four caps that overspend near 1,500 tokens.
export const FINISH = 4;

/**
 * Budget-aware compact view of a distilled page. `from` is a position in the
 * collapsed block list, which is how `oc next` resumes a page where the last
 * render stopped.
 * @param {import('./distill.js').Page} page
 * @param {{budget?: number, from?: number}} [opts]
 * @returns {{text: string, stats: {tokens: number, blocks: number, rendered: number, next: number|null, left: number, leftTokens: number}}}
 */
export function render(page, { budget = 500, from = 0 } = {}) {
  const blocks = collapseRuns(page.blocks);
  const head = page.title ? [from > 0 ? `# ${truncate(page.title)} (continued)` : `# ${truncate(page.title)}`] : [];
  const lines = [...head];
  let spent = estimateTokens(lines.join('\n'));
  let hasLinks = false;
  let i = Math.max(0, from);

  // What the rest of the page would cost if it were all printed. When that is
  // within reach the budget stands aside, because stopping here would only
  // move those tokens into a second command and add a turn's overhead on top.
  const whole = blocks.slice(i).reduce((sum, b) => {
    const line = formatBlock(b);
    return line ? sum + estimateTokens(line) + 1 : sum;
  }, spent);
  const limit = whole <= budget * FINISH ? Infinity : budget;

  for (; i < blocks.length; i++) {
    const block = blocks[i];
    // Never print the same content twice. Pages often repeat the title as
    // their first heading.
    if (block.type === 'heading' && block.text === page.title) continue;
    const line = formatBlock(block);
    if (!line) continue;
    const cost = estimateTokens(line) + 1;
    // Stop at the first block that does not fit instead of skipping past it:
    // what is left has to stay one contiguous run for `oc next` to continue.
    // The exception is a first block bigger than the whole budget, which is
    // printed anyway so the cursor always moves.
    if (spent + cost > limit && lines.length > head.length) break;
    spent += cost;
    lines.push(line);
    if (block.type === 'link' || block.type === 'button') hasLinks = true;
  }

  const rest = blocks.slice(i);
  const leftTokens = rest.reduce((sum, b) => {
    const line = formatBlock(b);
    return line ? sum + estimateTokens(line) + 1 : sum;
  }, 0);
  if (rest.length) {
    lines.push(`... ${num(rest.length)} more blocks (~${num(leftTokens)} tokens): 'oc next' for the next ~${num(budget)}, 'oc raw' for all`);
  }
  // An input on the page adds no action. 'fill' and 'submit' are still stubs
  // that throw, and this footer is the line an agent trusts for what to run
  // next, so naming one of them costs a turn and returns nothing.
  //
  // 'find' comes before 'read' because it is the cheaper way to go deeper: one
  // command lands on the block that matters, where 'read' needs the right
  // number first and 'next' pages toward it. The entry costs about three
  // tokens on every render, and skipping one 'next' on a long page pays for
  // a hundred of them.
  const actions = [
    hasLinks && 'do <n>',
    'find <query>',
    'read <n>',
    rest.length && 'next',
    'raw',
  ].filter(Boolean);
  lines.push(`actions: ${actions.join(' | ')}`);

  const text = lines.join('\n');
  return {
    text,
    stats: {
      tokens: estimateTokens(text),
      blocks: blocks.length,
      rendered: i - Math.max(0, from),
      next: rest.length ? i : null,
      left: rest.length,
      leftTokens,
    },
  };
}

/**
 * Collapse repeated siblings. Long runs of short
 * links are almost always nav chrome (subreddit bars, tag clouds, footers)
 * and would otherwise eat the whole budget before the content starts. Handles
 * are assigned in distill, so the hidden links keep their numbers and the
 * marker names the range.
 * @param {import('./distill.js').Block[]} blocks
 * @returns {import('./distill.js').Block[]}
 */
function collapseRuns(blocks) {
  const SHORT = 20;
  const RUN = 8;
  const KEEP = 5;
  const out = [];
  let i = 0;
  while (i < blocks.length) {
    let j = i;
    while (j < blocks.length && blocks[j].type === 'link' && blocks[j].text.length <= SHORT) j++;
    const run = j - i;
    if (run > RUN) {
      out.push(...blocks.slice(i, i + KEEP));
      const first = blocks[i + KEEP];
      const last = blocks[j - 1];
      out.push({ type: 'text', text: `[${first.n}-${last.n}] ${run - KEEP} similar links, expand with oc raw` });
      i = j;
    } else {
      out.push(blocks[i]);
      i++;
    }
  }
  return out;
}

/**
 * One line per block. `full` keeps the whole text, which is what `oc read`
 * prints; the compact view cuts at TEXT_CAP and says how many characters went
 * with the cut, so the agent can price the rest before asking for it.
 * @param {import('./distill.js').Block} b
 * @param {{full?: boolean}} [opts]
 * @returns {string}
 */
export function formatBlock(b, { full = false } = {}) {
  const tag = b.n == null ? '' : `[${b.n}] `;
  switch (b.type) {
    case 'heading':
      return `${'#'.repeat(Math.min(b.level ?? 2, 3))} ${tag}${full ? b.text : truncate(b.text)}`;
    case 'link':
      return `${tag}${full ? b.text : truncate(b.text)}`;
    case 'button':
      return `${tag}button "${full ? b.text : truncate(b.text)}"`;
    case 'input':
      return `${tag}input ${truncate(b.name ?? '')} (${truncate(b.text ?? '')})`;
    case 'divider':
      return b.text;
    default:
      return full ? `${tag}${b.text}` : `${tag}${truncate(b.text)}`;
  }
}

// A cut inside a sentence makes the half that is shown untrustworthy. Asked
// for the first sentence of a page, an agent was given it in full, followed by
// a truncation marker, and spent a turn on `read` to find out whether the
// sentence carried on. Ending on the last sentence that finished inside the cap
// answers that in the view itself. The floor bounds what the courtesy costs: a
// block whose only sentence end is early keeps the plain cut instead of
// throwing away a third of the window.
const SENTENCE_END = /[.!?]["')\]]*(?=\s)/g;
const SENTENCE_FLOOR = 0.7;

const truncate = (s) => {
  if (s.length <= TEXT_CAP) return s;
  // A line is to code what a sentence is to prose, and a code block is the only
  // text that keeps its newlines, so the same courtesy applies: cut where a
  // line ended. A period in code ends nothing, which is why this returns
  // instead of falling through to the sentence rule below.
  const line = s.slice(0, TEXT_CAP).lastIndexOf('\n');
  if (line >= TEXT_CAP * SENTENCE_FLOOR) return `${s.slice(0, line)} ... +${num(s.length - line)} chars`;
  let cut = TEXT_CAP;
  for (const m of s.slice(0, TEXT_CAP).matchAll(SENTENCE_END)) {
    const end = (m.index ?? 0) + m[0].length;
    if (end >= TEXT_CAP * SENTENCE_FLOOR) cut = end;
  }
  return `${s.slice(0, cut).trimEnd()} ... +${num(s.length - cut)} chars`;
};
