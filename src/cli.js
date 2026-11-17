#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fetchPage } from './fetch.js';
import { distill, toMarkdown, toHTML } from './distill.js';
import { render, estimateTokens, contentTokens, contentFailure, MIN_CONTENT } from './render.js';
import { resolveSite, listSites } from './sites.js';
import { sphinxSearch } from './sphinx.js';
import { nodeSearch } from './nodedocs.js';
import { rdocSearch } from './rdoc.js';
import { mkdocsSearch } from './mkdocs.js';
import { apiSearch } from './apisearch.js';
import * as act from './act.js';
import { DEFAULT_SESSION, assertSafeName, clearSession, listSessions, loadSession, saveSession, sessionFromPage } from './session.js';
import { authFailure, sessionExpiredMessage } from './auth.js';
import {
  loadCookieJar,
  saveCookieJar,
  clearCookieJar,
  createJarHandle,
  loginCookieJar,
  parseExpires,
  withheldForScheme,
  DEFAULT_EXPIRES_MS,
  JAR_EXPIRED,
} from './cookies.js';

const HELP = `only-cli: the web as a compact terminal, built for AI agents.

usage: oc <command> [args] [flags]

  open <url>          fetch and render a page with numbered actions
  <site> <verb> ...   site shortcut: 'oc hn top', 'oc reddit sub ClaudeAI'
  sites               the site shortcuts that ship with oc
  find <query>        where a string appears on the page already open, or
                      the region itself when only one place matches
  next                the next budget worth of the page already open
  read <n>            full text of the region at [n], up to 2000 tokens
  raw [url]           distilled markdown of the whole page
  do <n>              follow the numbered link [n], or read [n] if it is text
  fill <n> <text>     type into a numbered input               (planned)
  submit [n]          submit a form                            (planned)
  back                return to the previous page              (planned)
  login               seed cookies for a session (--cookie, --domain)
  logout [session]    forget a session: its cookies and its saved page
  session ls|rm [name]  list saved sessions, or forget one (page + cookies)

flags:
  --budget <tokens>   tighten or loosen the render budget (default 500,
                      2000 for read). It is a target, not a ceiling: a page
                      that would finish within about four times it is printed
                      whole rather than costing you a second command
  --json              machine-stable JSON output
  --html              raw only: cleaned HTML instead of markdown
  --verbose, -v       metrics on stderr: tokens saved vs the page HTML, HTTP
                      status and client identity, timing, transfer size, and
                      memory. --stats is an alias; OC_VERBOSE=1 turns it on
                      globally. Off by default because metrics cost tokens too.
  --session <name>    keep separate page state under a name (default: default)
  --cookie <header>   login only: the Cookie header to seed. '-' reads it from
                      stdin, which is the form to prefer: an argv secret is
                      visible in ps and kept in shell history
  --domain <host>     login only: the hostname those cookies belong to
  --expires <dur>     login only: how long the session lasts (default 1h)
  --allow-http        login only: let these cookies travel over plain http
  --version, -V       print the installed version and exit

Authenticated pages: run 'printf %s "session=..." | oc login --cookie - --domain
example.com' to seed cookies for a session (default lifetime 1h, override with
--expires 2h). Cookies live in a separate file from page state and are sent on
every fetch for that session. They are marked secure, so they go over https
only and a redirect down to http drops them; pass --allow-http at login if a
site really is http-only. 'oc logout' forgets the session early: cookies and
saved page both.

A page that comes back with no readable text (JavaScript-only, a consent wall,
a bot challenge) says so in one line on stderr and exits 2, so a caller can
tell an empty page from a page oc could not read and fall back to a browser.

'oc open' remembers the page it printed, so 'oc do 3' follows link [3] without
you ever handling its URL, and 'oc next' or 'oc read 12' picks up what the
budget left behind without fetching it again. 'oc do' on a search result title
opens the result, because that title is a link. State lives in ~/.only-cli
(override with OC_HOME).`;

// A rendered page has to be remembered or its [3] means nothing to the next
// command. Saving state must never break a render, so a home directory that
// cannot be written costs the agent `do`, `read`, and `next`, and nothing
// else, but silently: a sandbox that blocks the write leaves `do` resolving
// against whatever session last saved successfully, possibly from an
// unrelated page, with no sign anything is wrong. So the failure still prints,
// on stderr where it costs nothing until something breaks.
const remember = (page, name, cursor) => {
  try {
    saveSession(name, sessionFromPage(page, loadSession(name), { cursor }));
  } catch (err) {
    console.error(`oc: warning: could not save session '${name}' (${err.message}), 'do'/'read'/'next' may act on stale state`);
  }
};

// What browsing costs without this tool is the raw page HTML in context.
const savings = (out, raw) =>
  `~${out} tokens vs ~${raw} for the page HTML (${Math.max(0, 100 - Math.round((out / Math.max(raw, 1)) * 100))}% saved)`;

// Nonzero, and distinct from the exit 1 that every other failure uses, so a
// caller can branch on 'oc could not read this' without parsing prose.
const NO_CONTENT_EXIT = 2;

const noContent = (url, detail, hint = "; 'oc raw' has the page's markdown if there is any, otherwise this one needs a browser") => {
  console.error(`oc: no readable content at ${url} (${detail}), so it is JavaScript-only, gated, or challenged${hint}`);
  // Not process.exit: stdout may still be draining, and whatever did render is
  // worth printing even when the render failed.
  process.exitCode = NO_CONTENT_EXIT;
};

/**
 * Forget everything saved under a name, for `oc logout` and `oc session rm`.
 * The page saved under a name can be the distilled text of a page only the
 * cookies could reach, so the two go together: after either command nothing
 * of that login remains. Cookies go first so a failure on the page file never
 * leaves the credential behind.
 * @param {string} name
 * @returns {boolean} whether anything was on disk to forget
 */
function forgetSession(name) {
  const hadJar = clearCookieJar(name);
  const hadPage = clearSession(name);
  return hadJar || hadPage;
}

const LOGIN_USAGE = 'usage: printf %s "session=..." | oc login --cookie - --domain example.com'
  + ' [--expires 1h] [--session name] [--allow-http]';

const stripCookiePrefix = (value) => String(value).trim().replace(/^cookie\s*:\s*/i, '');

// The Cookie header a browser hands over is a live credential, and an argv
// secret is readable in ps for as long as oc runs and kept in shell history
// afterwards, so '-' reads it from stdin instead. The flag form stays, because
// it is what an agent already has in hand, but the docs lead with the pipe.
// Devtools' "copy as cURL"-style output carries the header name, and a strict
// cookie-name check would only report that as a puzzling parse error, so a
// leading 'Cookie:' is dropped here rather than refused.
const cookieHeaderArg = (value) => {
  if (value !== '-') return stripCookiePrefix(value);
  if (process.stdin.isTTY) throw new Error(`--cookie - reads the header from stdin, ${LOGIN_USAGE}`);
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch (err) {
    throw new Error(`could not read the cookie header from stdin (${err.message})`);
  }
  const header = stripCookiePrefix(raw);
  if (!header) throw new Error(`nothing on stdin to read a cookie header from, ${LOGIN_USAGE}`);
  return header;
};

// Anything else in the first position is tried as a site shortcut before it is
// called unknown, so a new clis/ definition needs no change here.
const COMMANDS = new Set([
  'open', 'do', 'raw', 'read', 'next', 'find', 'fill', 'submit', 'back', 'login', 'logout', 'session', 'sites',
]);

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      html: { type: 'boolean', default: false },
      stats: { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      budget: { type: 'string' },
      session: { type: 'string' },
      cookie: { type: 'string' },
      domain: { type: 'string' },
      expires: { type: 'string' },
      'allow-http': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'V', default: false },
    },
  });

  // Read at call time rather than baked in, so the number can never drift from
  // the package that npm actually installed.
  if (values.version) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(pkg.version);
    return;
  }

  // Metrics cost tokens too, so they are opt-in: agents pass --verbose only
  // when their own verbose mode is on, or the user exports OC_VERBOSE=1.
  const verbose = values.stats || values.verbose || process.env.OC_VERBOSE === '1';

  let [command, ...args] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return;
  }

  // A first word that is not a command may still be a site oc ships a
  // definition for, and a shortcut is only ever a URL, so it resolves to one
  // here and the rest of this function never learns it was not typed.
  let search = null;
  // The fields a shortcut chose to show of a JSON response, if it chose any.
  // A view is a deliberate cut, so a thin render of a heavy response is the
  // choice working, not a gated page: the thin-content verdict stays out of
  // it, and only a render with no text at all still fails.
  let view = null;
  if (!COMMANDS.has(command)) {
    const site = resolveSite(command, args);
    if (!site) throw new Error(`unknown command '${command}', run oc --help`);
    // Only a search shape resolves with a query; a URL shape never has one.
    if (site.query != null) {
      search = site;
      command = 'search';
    } else {
      args = [site.url];
      view = site.view ?? null;
      command = 'open';
    }
  }

  const sessionName = assertSafeName(values.session || DEFAULT_SESSION);
  // Zero means "whatever this command's default is", which differs: the
  // compact view targets 500 tokens, read targets 2000.
  const asked = values.budget ? Number(values.budget) : 0;
  if (values.budget && (!Number.isFinite(asked) || asked <= 0)) {
    throw new Error('--budget must be a positive number');
  }

  if (command === 'login') {
    if (!values.cookie) throw new Error(LOGIN_USAGE);
    if (!values.domain) throw new Error('--domain is required (the site hostname your cookies belong to)');
    const expiresMs = values.expires ? parseExpires(values.expires) : DEFAULT_EXPIRES_MS;
    loginCookieJar(sessionName, cookieHeaderArg(values.cookie), values.domain, {
      expiresMs,
      allowHttp: values['allow-http'],
    });
    return;
  }

  if (command === 'logout') {
    forgetSession(args[0] ? assertSafeName(args[0]) : sessionName);
    return;
  }

  switch (command) {
    case 'open':
    case 'do':
    case 'raw': {
      // `do` is `open` with the URL looked up from the last render instead of
      // typed, so both commands share one fetch, render, and save path. `raw`
      // with no URL means the page already open, which is what the compact
      // view's footer offers when it has cut something.
      let url;
      if (command === 'do') {
        const target = act.activate(args[0], { session: sessionName });
        // A number that points at text has no page behind it, so `do` reads it
        // rather than making the agent pay for a second command to be told.
        if (target.read != null) {
          return console.log(act.read(target.read, { session: sessionName, budget: asked || 2000 }));
        }
        url = target.url;
      } else {
        url = args[0] ?? (command === 'raw' ? loadSession(sessionName)?.url : undefined);
      }
      if (!url) throw new Error(`usage: oc ${command} <url>`);
      const budget = asked || 500;
      const jarData = loadCookieJar(sessionName);
      // Clock-expired jars are wiped on load; say so in the same voice as a
      // login-page redirect rather than fetching with no cookies and guessing.
      if (jarData === JAR_EXPIRED) {
        noContent(url, sessionExpiredMessage(url));
        return;
      }
      const hadAuth = jarData != null;
      // Secure cookies are withheld from a plain-http request. Say so, or the
      // fetch comes back a login page and nothing explains why.
      if (jarData && withheldForScheme(jarData, url)) {
        console.error(`oc: warning: session '${sessionName}' holds https-only cookies, so they are not sent to ${url}`
          + '; seed them with --allow-http if this site really is http-only');
      }
      const jar = jarData ? createJarHandle(sessionName, jarData) : null;
      const t0 = performance.now();
      const { url: finalUrl, html, status, via, type } = await fetchPage(url, { jar: jar ?? undefined });
      if (jar) saveCookieJar(sessionName, jar.toJSON());
      const fetchMs = performance.now() - t0;
      const resources = () => {
        const processMs = performance.now() - t0 - fetchMs;
        const rss = process.memoryUsage().rss;
        return `HTTP ${status} via ${via}, fetch ${Math.round(fetchMs)}ms, process ${Math.round(processMs)}ms, `
          + `${Math.round(Buffer.byteLength(html) / 1024)}KB transferred, ${Math.round(rss / 1048576)}MB memory`;
      };
      const htmlTokens = estimateTokens(html);
      if (values.json) {
        const page = distill(html, finalUrl, { view, type });
        const auth = authFailure(page, finalUrl, { hadAuth });
        const failure = auth ?? contentFailure(contentTokens(page), view ? 0 : htmlTokens);
        // Always present, so a caller can branch on the field rather than on
        // whether a field it was hoping for turned up.
        console.log(JSON.stringify({ ...page, empty: failure != null }));
        if (verbose) console.error(resources());
        if (auth) {
          if (jar) clearCookieJar(sessionName);
          noContent(finalUrl, auth);
          return;
        }
        remember(page, sessionName);
        if (failure) noContent(finalUrl, failure);
        return;
      }
      if (command === 'raw') {
        const page = distill(html, finalUrl, { type });
        const auth = authFailure(page, finalUrl, { hadAuth });
        if (auth) {
          if (jar) clearCookieJar(sessionName);
          noContent(finalUrl, auth);
          return;
        }
        const out = values.html ? toHTML(html, finalUrl, { type }) : toMarkdown(html, finalUrl, { type });
        const outTokens = estimateTokens(out);
        console.log(out);
        if (verbose) {
          const cost = outTokens < MIN_CONTENT
            ? `nothing distilled out of ~${htmlTokens} tokens of page HTML`
            : savings(outTokens, htmlTokens);
          console.error(`${cost}; ${resources()}`);
        }
        // Only the blank case here. `raw` is the fallback the compact view's
        // failure line names, so it must not fail on the same pages: a page
        // whose only text is its menu still has markup, and printing it is the
        // whole point of `raw`. And a short page that arrived short is not
        // blank, so the verdict needs the same evidence the compact view asks
        // for: near-nothing distilled out of markup that promised more.
        if (outTokens < MIN_CONTENT && contentFailure(outTokens, htmlTokens)) {
          noContent(finalUrl, `~${outTokens} tokens of markdown`, '');
        }
        return;
      }
      const page = distill(html, finalUrl, { view, type });
      const auth = authFailure(page, finalUrl, { hadAuth });
      const failure = auth ?? contentFailure(contentTokens(page), view ? 0 : htmlTokens);
      if (auth) {
        if (jar) clearCookieJar(sessionName);
        noContent(finalUrl, auth);
        return;
      }
      const { text, stats } = render(page, { budget });
      remember(page, sessionName, stats.next);
      console.log(text);
      if (verbose) {
        // Reporting '100% saved' of a render that extracted nothing is the one
        // place this line lies, and it lies in the tool's own favour.
        const cost = failure
          ? `no content distilled out of ~${htmlTokens} tokens of page HTML`
          : savings(stats.tokens, htmlTokens);
        console.error(`~${stats.tokens} tokens, ${stats.rendered}/${stats.blocks} blocks rendered, ${cost}; ${resources()}`);
      }
      if (failure) noContent(finalUrl, failure);
      return;
    }
    case 'search': {
      // A search oc runs itself: a site's static index or docs corpus is
      // fetched (or read back from its day cache) and ranked here, a JSON
      // search API is asked directly. Either way the result list rides the
      // exact `open` path: distilled, rendered, remembered, so `do <n>`
      // follows a result. Only the list is ever printed; the index, corpus,
      // and response stay out of context.
      const t0 = performance.now();
      const local = { sphinx: sphinxSearch, nodedoc: nodeSearch, rdoc: rdocSearch, mkdocs: mkdocsSearch };
      const kind = Object.keys(local).find((k) => search[k]);
      const { url, html, via } = kind
        ? await local[kind](search[kind], search.query)
        : await apiSearch(search.api, search.query);
      const page = distill(html, url);
      if (values.json) {
        remember(page, sessionName);
        console.log(JSON.stringify({ ...page, empty: false }));
        return;
      }
      const { text, stats } = render(page, { budget: asked || 500 });
      remember(page, sessionName, stats.next);
      console.log(text);
      if (verbose) {
        console.error(`~${stats.tokens} tokens, results via ${via}, ${Math.round(performance.now() - t0)}ms`);
      }
      return;
    }
    case 'read': return console.log(act.read(args[0], { session: sessionName, budget: asked || 2000 }));
    case 'next': return console.log(act.next({ session: sessionName, budget: asked || 500 }));
    case 'find': return console.log(act.find(args.join(' '), { session: sessionName, budget: asked || 500 }));
    case 'fill': return act.fill(Number(args[0]), args.slice(1).join(' '));
    case 'submit': return act.submit(args[0] ? Number(args[0]) : undefined);
    case 'back': return act.back();
    case 'sites': return console.log(listSites());
    case 'session': {
      // Saved sessions accumulate on disk (one JSON per page kept for
      // do/read/next), so agents can inspect and drop them without guessing
      // paths under ~/.only-cli. With no name, rm targets --session.
      const [sub, target] = args;
      if (sub === 'ls') {
        const list = listSessions();
        if (values.json) return console.log(JSON.stringify(list));
        if (!list.length) return console.log('no saved sessions');
        for (const s of list) {
          console.log(`${s.name}${s.url ? `  ${s.url}` : ''}${s.title ? `  (${s.title})` : ''}${s.cookies ? '  [cookies]' : ''}`);
        }
        return;
      }
      if (sub === 'rm') {
        const name = target ? assertSafeName(target) : sessionName;
        // A name nothing was saved under is most likely a typo, and an agent
        // that reads "forgot session" would move on believing the login is
        // gone, so rm fails loud instead of succeeding at nothing.
        if (!forgetSession(name)) throw new Error(`no such session '${name}', run oc session ls`);
        if (values.json) return console.log(JSON.stringify({ forgotten: name }));
        return console.log(`forgot session '${name}'`);
      }
      throw new Error(`usage: oc session ls|rm [name]`);
    }
    default:
      throw new Error(`unknown command '${command}', run oc --help`);
  }
}

main().catch((err) => {
  console.error(`oc: ${err.message}`);
  process.exit(1);
});
