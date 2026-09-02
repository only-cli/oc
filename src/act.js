/**
 * Actions against a saved session: do, read, and next now, fill, submit, find,
 * and back still ahead. Errors here are read by agents, so every one of them
 * names the command to run next.
 *
 * Nothing in this file touches the network. The page an agent is working on is
 * already on disk from the last `oc open`, so continuing to read it costs one
 * file read and whatever tokens the caller asked for.
 */

import { DEFAULT_SESSION, handleFor, handleNumbers, loadSession, saveSession } from './session.js';
import { FINISH, estimateTokens, formatBlock, render } from './render.js';

export class NotImplemented extends Error {
  constructor(command) {
    super(`'oc ${command}' is not available yet. Until then use 'oc open' and 'oc raw'.`);
  }
}

/**
 * @param {string} session
 * @returns {any}
 */
function requireSession(session) {
  const state = loadSession(session);
  if (!state) {
    throw new Error("nothing open in this session yet, run 'oc open <url>' first");
  }
  return state;
}

/**
 * `read` and `next` work from the saved blocks, which older sessions do not
 * have. One `oc open` fixes it, so say that instead of failing blankly.
 * @param {string} session
 */
function requireBlocks(session) {
  const state = requireSession(session);
  if (!Array.isArray(state.blocks)) {
    throw new Error(`this session was saved by an older oc, run 'oc open ${state.url}' again`);
  }
  return state;
}

/**
 * Resolve a numbered handle from the last render into something to open.
 * Returns the target URL; the caller fetches and renders it exactly as
 * `oc open` would, so `do` and `open` always agree on what a page looks like.
 * When the number is text rather than a link it returns `{read}` instead, and
 * the caller reads it.
 * @param {number} n
 * @param {{session?: string}} [opts]
 * @returns {{url?: string, read?: number, text: string}}
 */
export function activate(n, { session = DEFAULT_SESSION } = {}) {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('usage: oc do <n>, where <n> is a number from the last page');
  }
  const state = requireSession(session);
  const handle = handleFor(state, n);
  if (!handle) {
    const nums = handleNumbers(state);
    const range = nums.length ? `1-${Math.max(...nums)}` : 'none';
    throw new Error(`no [${n}] on ${state.url} (handles ${range}), run 'oc open <url>' again to renumber`);
  }
  // A heading can be a link: on a search results page the result title is one,
  // and opening it is what `do` was asked for. Reading the title back instead
  // cost a turn, and then another to find the number that does navigate, so a
  // heading that has an href falls through to the link below.
  if ((handle.type === 'text' || handle.type === 'heading') && !handle.href) {
    // There is nothing to follow, but the agent asked to see what is at [n],
    // and that is what read prints. Refusing would spend a whole turn to name
    // the command that should have run, and a turn costs more than the page.
    return { read: n, text: handle.text };
  }
  if (handle.type === 'input') {
    throw new Error(`[${n}] is an input (${handle.name ?? 'text'}), typing needs 'oc fill', which is not available yet`);
  }
  if (handle.type === 'button' || !handle.href) {
    throw new Error(`[${n}] has no link to follow, it is a ${handle.type} the page handles itself`);
  }
  return { url: handle.href, text: handle.text };
}

// How many blocks of run-up `read` prints before the one it was asked for, so
// a comment or paragraph arrives with the byline that introduces it, and how
// many it prints after. The trailing window only applies when the target is
// not a heading: a heading owns its whole section, anything else is one thing
// the agent asked to see in full and a little of what follows it.
const LEAD = 2;
const TRAIL = 6;

/**
 * Full text of one region of the current page: the block at [n], the couple of
 * blocks that lead into it, and either the rest of its section when [n] is a
 * heading or a short run after it when it is not. This is the middle setting
 * between the 500 token view and the whole page.
 * @param {number} n
 * @param {{session?: string, budget?: number}} [opts]
 * @returns {string}
 */
export function read(n, { session = DEFAULT_SESSION, budget = 2000 } = {}) {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('usage: oc read <n>, where <n> is a number from the last page');
  }
  const state = requireBlocks(session);
  const blocks = state.blocks;
  const at = blocks.findIndex((b) => b.n === n);
  if (at < 0) {
    const nums = handleNumbers(state);
    const range = nums.length ? `1-${Math.max(...nums)}` : 'none';
    throw new Error(`no [${n}] on ${state.url} (handles ${range}), run 'oc open <url>' again to renumber`);
  }

  const isHeading = blocks[at].type === 'heading';
  let start = isHeading ? at : Math.max(0, at - LEAD);
  // Never open with the tail of the section before this one.
  for (let i = at - 1; i > start; i--) {
    if (blocks[i].type === 'heading') {
      start = i;
      break;
    }
  }
  // A heading owns everything down to the next heading of its level or above;
  // anything else runs to the next heading of any level.
  const stopLevel = blocks[start].type === 'heading' ? (blocks[start].level ?? 2) : 6;
  const end = isHeading ? blocks.length : Math.min(blocks.length, at + TRAIL + 1);

  const lines = [];
  let spent = 0;
  let i = start;
  for (; i < end; i++) {
    const block = blocks[i];
    if (i > start && block.type === 'heading' && (block.level ?? 2) <= stopLevel) break;
    const line = formatBlock(block, { full: true });
    if (!line) continue;
    const cost = estimateTokens(line) + 1;
    if (spent + cost > budget && lines.length) break;
    // The first line always prints so read never answers with nothing, but
    // its text is the page's to write and so has no natural size. Alone over
    // budget it still gets cut: 'up to N tokens' is a promise the page must
    // not be able to break.
    if (!lines.length && cost > budget) {
      lines.push(`${line.slice(0, budget * 4)} ... cut at ~${budget} tokens, raise --budget for the rest`);
      spent += budget;
      continue;
    }
    spent += cost;
    lines.push(line);
  }

  const stoppedEarly = i < end && !(blocks[i].type === 'heading' && (blocks[i].level ?? 2) <= stopLevel);
  if (stoppedEarly) {
    const resume = blocks.slice(i).find((b) => b.n != null)?.n;
    const how = resume ? `continue with 'oc read ${resume}'` : "use 'oc raw' for the rest";
    lines.push(`... region cut at ~${budget} tokens, ${how} or raise --budget`);
  }
  return lines.join('\n');
}

/**
 * The next budget worth of the page the session already holds. `oc open` says
 * how many blocks it left behind; this is how an agent takes them a screenful
 * at a time instead of paying for the whole page to get one more paragraph.
 * @param {{session?: string, budget?: number}} [opts]
 * @returns {string}
 */
export function next({ session = DEFAULT_SESSION, budget = 500 } = {}) {
  const state = requireBlocks(session);
  const from = state.cursor;
  if (from == null) {
    return `end of ${state.url}, nothing left to render. 'oc open <url>' to reload it, 'oc raw' for the whole page.`;
  }
  const page = { url: state.url, title: state.title, blocks: state.blocks };
  const { text, stats } = render(page, { budget, from });
  try {
    saveSession(session, { ...state, cursor: stats.next });
  } catch {}
  return text;
}

/** @param {number} n @param {string} text */
export function fill(n, text) {
  throw new NotImplemented('fill');
}

/** @param {number} [n] */
export function submit(n) {
  throw new NotImplemented('submit');
}

// How much of a matching block to print around the hit. Wide enough to judge
// whether the match is the one you wanted, narrow enough that twenty hits
// still fit in a screenful.
const BEFORE = 60;
const SNIPPET = 200;

/**
 * Where a string appears on the current page. This is the answer to "the page
 * is long and I only care about one thing in it": one command, no fetch, and
 * a number to read the region it landed in.
 * @param {string} query
 * @param {{session?: string, budget?: number}} [opts]
 * @returns {string}
 */
export function find(query, { session = DEFAULT_SESSION, budget = 500 } = {}) {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) throw new Error('usage: oc find <query>, searching the page already open');
  const state = requireBlocks(session);
  const blocks = state.blocks;

  let hits = search(blocks, [q]);
  // A phrase that matches nothing is usually word order, not absence, so try
  // the words separately rather than making the agent guess again.
  const terms = q.split(/\s+/);
  const loose = !hits.length && terms.length > 1;
  if (loose) hits = search(blocks, terms);

  if (!hits.length) {
    const tried = terms.length > 1 ? ', as a phrase or as separate words' : '';
    return `no match for "${query}"${tried} in ${blocks.length} blocks on ${state.url}, try fewer words or 'oc raw' for the full text`;
  }

  const separately = loose ? ', matching the words separately' : '';

  // One match is not an index, it is the answer. Naming the number and
  // stopping spends a turn to say where to look, and the agent's next command
  // is always the `read` that looks, so find does the reading. Measured on an
  // AWS CLI reference page, `find "Example 7"` printed a 24 token heading and
  // the example it names was in the block after it.
  if (hits.length === 1 && hits[0].n != null) {
    const only = hits[0];
    const follow = only.type === 'link' ? 'do <n> | ' : '';
    return [
      `1 match for "${query}"${separately}, region [${only.n}]`,
      read(only.n, { session, budget: budget * FINISH }),
      `actions: ${follow}find <query> | read <n> | next | raw`,
    ].join('\n');
  }

  const lines = [`${hits.length} ${hits.length === 1 ? 'match' : 'matches'} for "${query}"${separately}`];
  // A snippet is short because many matches have to share one screen. When
  // every match would fit whole inside the allowance a page already gets for
  // finishing (render's FINISH), showing them whole makes this command the
  // answer instead of an index into a `read <n>` that has to run next. The
  // trade is the same one FINISH documents, and it is not close: a few
  // hundred tokens against a turn.
  const label = (hit, text) => `[${hit.n ?? '?'}] ${text}`;
  const whole = hits.reduce((n, h) => n + estimateTokens(label(h, h.text)) + 1, estimateTokens(lines[0]));
  const full = whole <= budget * FINISH;
  const cap = full ? budget * FINISH : budget;
  let spent = estimateTokens(lines[0]);
  let shown = 0;
  let hasLinks = false;
  for (const hit of hits) {
    const line = label(hit, full ? hit.text : hit.snippet);
    const cost = estimateTokens(line) + 1;
    if (spent + cost > cap && shown) break;
    spent += cost;
    shown++;
    if (hit.type === 'link') hasLinks = true;
    lines.push(line);
  }
  if (shown < hits.length) {
    lines.push(`... ${hits.length - shown} more matches, narrow the query or raise --budget`);
  }
  // Offering find on its own output is what makes "narrow the query" above an
  // action rather than advice.
  lines.push(`actions: ${[hasLinks && 'do <n>', 'find <query>', 'read <n>', 'next', 'raw'].filter(Boolean).join(' | ')}`);
  return lines.join('\n');
}

/**
 * Blocks containing every term, each with the piece of text around the first
 * one and a number to read it with. A phrase search is the same thing with a
 * single term. Short blocks carry no handle of their own, so they borrow the
 * nearest one above them, which is what `oc read` needs to put the match back
 * in context.
 * @param {import('./distill.js').Block[]} blocks
 * @param {string[]} terms - lower case, all of them must appear
 */
function search(blocks, terms) {
  const out = [];
  let anchor = null;
  for (const block of blocks) {
    if (block.n != null) anchor = block.n;
    const text = block.text.toLowerCase();
    const found = terms.map((t) => text.indexOf(t));
    if (found.some((i) => i < 0)) continue;
    const n = block.n ?? anchor;
    // One number, one line: a run of short blocks under the same handle would
    // otherwise report the same place several times.
    if (out.length && out.at(-1).n === n) continue;
    const start = Math.max(0, Math.min(...found) - BEFORE);
    const end = Math.min(block.text.length, start + SNIPPET);
    // One line per match is the promise the list makes, and a code block is the
    // one kind of block that carries lines of its own. They survive where they
    // are read rather than indexed: the whole-match mode above, and `read`.
    const window = block.text.slice(start, end).replace(/\n/g, ' ');
    const snippet = `${start > 0 ? '... ' : ''}${window}${end < block.text.length ? ' ...' : ''}`;
    out.push({ n, type: block.type, snippet, text: block.text });
  }
  return out;
}

export function back() {
  throw new NotImplemented('back');
}
