# Changelog

Notable changes per release. Releases before 0.4.0 are listed at
[github.com/only-cli/oc/releases](https://github.com/only-cli/oc/releases).

## 0.5.3

### Changed

- Requests to reddit.com present the Firefox fingerprint first and fall back
  to Chrome, the reverse of every other site. Reddit's edge answers the Chrome
  fingerprint with a 403 or a 429 while letting Firefox through, and since it
  allows anonymous readers about ten requests a minute per address, the wasted
  Chrome attempt was costing a real share of that budget on every read (#52).

## 0.5.2

### Changed

- `oc reddit` reads the Atom feeds on www.reddit.com instead of old.reddit.com
  pages. Reddit has sent every logged-out old.reddit.com request to a login
  page since 30 June 2026, and the `.json` views on www.reddit.com have
  answered 403 to anything without an OAuth token since 30 May, whatever the
  User-Agent or TLS fingerprint. The feeds still answer, so `sub`, `post`,
  `user`, and `search` point at them, and `new <name>` and `top <name>` join
  the verbs. A subreddit renders in about 480 tokens and a thread with 22
  comments in about 1,000. The feeds carry no scores or comment counts, and
  anonymous reddit.com allows roughly ten requests a minute per address, so a
  burst of shortcuts ends in a 429 that takes minutes to clear. (#52)

## 0.5.1

### Added

- `find <query>` in every `actions:` footer, after `do <n>` and before
  `read <n>`, the order the skill's "going further, cheapest first" list
  already gives. One command lands on the block that matters, where `read`
  needs the right number first and `next` pages toward it. The entry costs 3
  or 4 tokens per render. (#46)

### Fixed

- `oc open` no longer dies with `Impersonating chrome150 is not supported` on
  machines where impers loads a system copy of libcurl-impersonate older than
  v2.1.0, which predates the fingerprint the `chrome` alias resolves to. A
  refused fingerprint now downgrades the same way a blocked response already
  did: chrome falls back to firefox, and when both identities are refused the
  plain fetch transport still gets the page. Any other impers failure
  propagates unchanged, and installs where impers works keep the newest chrome
  fingerprint. (#40)
- The `actions:` footer no longer offers `fill <n> <text>` and `submit` on
  pages with an input. Both are still planned, and following the footer's
  own suggestion always failed. A test now keeps every footer free of
  commands that are not available yet. (#44)

## 0.5.0

### Added

- Language documentation shortcuts: `py`, `mdn`, `node`, `ruby`, `go`, `rust`,
  `java`, `php`, `cpp`, and `ts`, plus a `dotnet` verb on `learn` for the .NET
  API browser. `search` on `py`, `node`, and `ruby` ranks the docs' own search
  index locally and on `mdn` asks the site's API; the sites that only render
  docs search client-side go through DuckDuckGo with a baked-in `site:` filter
  instead. (#25)
- Authenticated sessions: `oc login` seeds cookies for a session and every
  fetch in that session sends them; `oc logout` forgets a session early,
  cookies and saved page both. Cookies live in a per-session jar under
  `OC_HOME`, separate from page state, pinned to the exact host they were
  seeded for, and marked secure by default so they travel over https only
  (`--allow-http` at login opts a plain-http site in). A session lasts an hour
  unless `--expires` says otherwise. `--cookie -` reads the header from stdin,
  the form to prefer since an argv secret is visible in `ps` and kept in shell
  history. (#4)

### Fixed

- Response bodies are bounded at every transport, 25MB decoded, checked
  against `Content-Length` before the bytes arrive and counted as they land,
  so a hostile URL is no longer an unbounded allocation and a decompression
  bomb stops at the cap. (#27)
- Titles, headings, and input names are cut at the render boundary like every
  other block, so one hostile page-written scalar can no longer print
  unbounded output whatever the budget said. The distilled page keeps the
  full values and `--json` stays the machine-stable view. (#28)
- A short page is judged unreadable by evidence, not by length alone: nothing
  extracted is empty whatever the page weighed, and a short render only fails
  when the markup behind it was far too big to have carried only that. A
  status endpoint or a one-line answer now exits 0; script-only shells and
  consent walls still exit 2. (#29)

## 0.4.0

### Added

- Site shortcuts are dispatched, not just documented. `oc <site> <verb> [args]`
  resolves to a URL and then takes the same path `oc open` does, so it costs the
  same and reads the same. A site is named by short name, bare name, or domain
  (`oc hn`, `oc ycombinator`, `oc news.ycombinator.com`), the last argument
  absorbs every word after it so a query needs no quoting, and `oc sites` lists
  every site with its verbs. Shortcuts come from `clis/*.json`, so adding a site
  is a JSON file and no code. (#19)
- Wikipedia shortcuts: `oc wiki article <title>`, `oc wiki search <query>`, and
  `oc wiki lang <code> <title>` for the other language editions. Articles are
  read through `action=render`, which serves the article body without the site
  chrome, navigation, and edit controls that surround `/wiki/<Title>`. (#22)
- Outbound fetches honor `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`, including
  the lowercase forms, so oc works in a sandbox whose only route out is a proxy.
  HTTP and HTTPS proxies are supported and proxy credentials in the URL are
  sent as `Proxy-Authorization`. (#17)
- The MIT `LICENSE` file that the badge and `package.json` were already
  claiming. (#18)

### Changed

- A page that distills to no readable text now fails loud instead of printing an
  empty render and exiting 0. It writes one line to stderr and exits 2, which is
  distinct from the exit 1 every other failure uses, so a caller can tell "this
  page is empty" from "oc could not read this page" and fall back to a browser
  only when that is worth doing. `--json` carries the same verdict as an `empty`
  field. (#20)
- The SSRF guard runs before a proxy is chosen, so a proxied request cannot be
  used to reach an address the direct path would have refused. (#17)

### Fixed

- GitHub and Reddit shortcut URL templates corrected so their verbs reach the
  pages they name. (#19)
