/**
 * Site shortcuts. `clis/*.json` names the URLs on a site worth reaching
 * directly, so `oc hn item 4711` gets there without the agent knowing that
 * Hacker News spells it /item?id=. A shortcut is almost always a URL: it
 * resolves to one and hands off to the same fetch and render path `oc open`
 * uses, so nothing here can change what a page costs or how it reads, except
 * that a shortcut at a JSON endpoint may name the fields worth showing. The
 * other shapes are searches cli.js runs itself and renders like any other
 * page: `sphinx`, `rdoc`, and `mkdocs`, for docs sites whose search only exists as a
 * static index file, `nodedoc`, for the Node.js API docs, which ship their
 * reference the same way, and `api`, for a site whose search answers as
 * JSON.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../clis/', import.meta.url));

// Short names an agent is likely to reach for. The domain itself and its
// registrable label always resolve, so this only covers what those miss.
const ALIASES = {
  hn: 'news.ycombinator.com',
  gh: 'github.com',
  so: 'stackoverflow.com',
  ddg: 'duckduckgo.com',
  yt: 'youtube.com',
  finance: 'finance.yahoo.com',
  twitter: 'x.com',
  aws: 'docs.aws.amazon.com',
  py: 'docs.python.org',
  mdn: 'developer.mozilla.org',
  node: 'nodejs.org',
  rust: 'doc.rust-lang.org',
  java: 'docs.oracle.com',
  ruby: 'docs.ruby-lang.org',
  cpp: 'en.cppreference.com',
  ts: 'typescriptlang.org',
  gcp: 'cloud.google.com',
  learn: 'learn.microsoft.com',
  wiki: 'wikipedia.org',
  npm: 'npmjs.com',
  pip: 'pypi.org',
  cargo: 'crates.io',
  gem: 'rubygems.org',
  eol: 'endoflife.date',
  man: 'man7.org',
  rfc: 'rfc-editor.org',
  gl: 'gitlab.com',
  material: 'squidfunk.github.io',
  polars: 'docs.pola.rs',
  urlo: 'users.rust-lang.org',
};

/** @typedef {{open?: string, keep?: string[], list?: string, sphinx?: string, nodedoc?: string, rdoc?: string, mkdocs?: string, api?: string, page?: string, results?: string, fields?: Record<string, string>, total?: string, args?: string[]}} Shortcut */
/** @typedef {{domain: string, commands: Record<string, Shortcut>}} Site */

/** @type {Map<string, Site>|null} */
let cache = null;

/**
 * Every site definition that ships with oc, keyed by each name that resolves
 * to it. A definition that will not parse is skipped rather than fatal: a bad
 * file costs its own shortcuts and leaves every other command working.
 * @returns {Map<string, Site>}
 */
export function sites() {
  if (cache) return cache;
  cache = new Map();
  /** @type {string[]} */
  let files = [];
  try {
    files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return cache;
  }
  for (const file of files) {
    /** @type {Site} */
    let site;
    try {
      site = JSON.parse(readFileSync(DIR + file, 'utf8'));
    } catch {
      continue;
    }
    if (!site?.domain || !site.commands) continue;
    const labels = site.domain.split('.');
    for (const key of [site.domain, labels[labels.length - 2]]) {
      // First definition wins, in sorted filename order, so which site owns a
      // shared label never depends on how the directory happens to be read.
      if (key && !cache.has(key)) cache.set(key, site);
    }
  }
  for (const [alias, domain] of Object.entries(ALIASES)) {
    const site = cache.get(domain);
    if (site && !cache.has(alias)) cache.set(alias, site);
  }
  return cache;
}

const verbs = (site) =>
  Object.entries(site.commands)
    .map(([name, def]) => (def.args?.length ? `${name} <${def.args.join('> <')}>` : name))
    .join(' | ');

/**
 * Resolve `oc <site> <verb> [args]` to a URL, or null when the first word
 * names no site oc ships, which is the caller's cue to report an unknown
 * command. A site that exists with a verb that does not is an error here
 * instead, since the agent has the right site and only needs the verb list.
 * @param {string} name
 * @param {string[]} args
 * @returns {{url?: string, view?: {keep: string[], list?: string}, sphinx?: string, nodedoc?: string, rdoc?: string, mkdocs?: string, api?: Shortcut, query?: string, domain: string, command: string}|null}
 */
export function resolveSite(name, args) {
  const site = sites().get(name.toLowerCase());
  if (!site) return null;
  const [verb, ...rest] = args;
  if (!verb) throw new Error(`usage: oc ${name} <verb>, one of: ${verbs(site)}`);
  // commands comes from JSON.parse, so a plain lookup would also find
  // inherited Object members such as toString, which name no URL.
  const def = Object.hasOwn(site.commands, verb) ? site.commands[verb] : undefined;
  if (!def) throw new Error(`'${verb}' is not a ${site.domain} shortcut, try: ${verbs(site)}`);

  const need = def.args ?? [];
  if (rest.length < need.length) {
    throw new Error(`usage: oc ${name} ${verb} <${need.join('> <')}>`);
  }
  // The last argument soaks up everything left, so a query an agent typed as
  // separate words ('oc ddg search claude code cli') works unquoted.
  const values = need.map((_, i) =>
    i === need.length - 1 ? rest.slice(i).join(' ') : rest[i]);
  // A search oc runs itself has no page URL to build: the query is handed
  // back whole for cli.js to run against the site's own search. The local
  // backends need only their docs root; the API shape needs its whole
  // definition, since it names the endpoint and the response fields.
  for (const kind of ['sphinx', 'nodedoc', 'rdoc', 'mkdocs']) {
    if (def[kind]) {
      return { [kind]: def[kind], query: values[values.length - 1] ?? '', domain: site.domain, command: verb };
    }
  }
  if (def.api) {
    return { api: def, query: values[values.length - 1] ?? '', domain: site.domain, command: verb };
  }
  const url = need.reduce(
    (open, arg, i) => open.replaceAll(`{${arg}}`, encode(values[i], def.open, arg)),
    def.open);
  // A shortcut at a JSON endpoint may say which fields to show. The choice
  // rides along to the render and touches nothing else: the URL is fetched,
  // cached, and remembered exactly as `oc open` would.
  const view = def.keep?.length ? { keep: def.keep, list: def.list } : undefined;
  return { url, view, domain: site.domain, command: verb };
}

/**
 * Percent-encode one value for the slot it fills. A value in the query string
 * is encoded outright, but a docs path is often several segments deep, so
 * 'oc learn doc azure/aks/intro' has to keep its slashes: escaping them would
 * ask the site for one impossible segment instead of the page.
 * @param {string} value
 * @param {string} template
 * @param {string} arg
 * @returns {string}
 */
function encode(value, template, arg) {
  const query = template.includes('?') && template.indexOf(`{${arg}}`) > template.indexOf('?');
  // A path slot that starts with @ is a copied handle (@name, @channel).
  // encodeURIComponent would turn it into %40 and miss the user, and YouTube's
  // template already has the @ in the URL. Search queries keep it, so a
  // mention in a query is still the thing being searched for. A handle never
  // contains a slash, so @scope/name is a scoped npm package, not a handle:
  // stripping its @ asked the registry for a different package.
  const handle = !query && value.startsWith('@') && value.length > 1 && !value.includes('/');
  const encoded = encodeURIComponent(handle ? value.slice(1) : value);
  return query ? encoded : encoded.replaceAll('%2F', '/').replaceAll('%40', '@');
}

/**
 * One line per site for `oc sites`, shortest name first, since that is what an
 * agent will type. Discovery has to cost less than a wrong guess does, so this
 * stays one line each rather than a table.
 * @returns {string}
 */
export function listSites() {
  const byDomain = new Map();
  for (const [key, site] of sites()) {
    if (!byDomain.has(site.domain)) byDomain.set(site.domain, { site, keys: [] });
    byDomain.get(site.domain).keys.push(key);
  }
  const lines = [...byDomain.values()].map(({ site, keys }) => {
    const names = keys
      .filter((k) => k !== site.domain)
      .sort((a, b) => a.length - b.length || a.localeCompare(b));
    return `oc ${names[0] ?? site.domain} <verb> (${[...names.slice(1), site.domain].join(', ')}): ${verbs(site)}`;
  });
  return lines.length
    ? `${lines.join('\n')}\nany other site: oc open <url>`
    : 'no site definitions found; oc open <url> works on any site';
}
