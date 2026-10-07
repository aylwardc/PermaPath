# PermaPath

Print a QR code once, change where it goes forever.

The QR code points at a permanent page on Arweave. That page looks up the newest
update signed by the link's owner and redirects there. No AO, no server, no
registry: just Arweave data items and gateway GraphQL.

## Live

- **Editor:** https://permapath.link/ once the Worker is deployed (see Deploy);
  directly: https://arweave.net/7RwtdPxMvZhXgGw1MAziVhE_fIoQ2_91YIkY3eRrvMc/
- **Resolver:** v3, https://arweave.net/u3gO3Oo3P-loxIOdLUlnUgflSqEovH6YIkrJBLLRfhE
  (`RESOLVER_TX` in `editor/config.js`). Older codes use v2 (`baTff…`) or v1 (`G81f…`)
  and forward to v3 when their owner uses a v3 feature.

## How it works

- **QR codes** encode `https://arweave.net/<RESOLVER_TX>?l=<LINK_ID>`.
- **Create:** upload a data item tagged `App-Name: PermaPath`, `Type: link`,
  `Destination`, `Seq`, optional `Name`. Its ID is the `LINK_ID`; its signer owns
  the link.
- **Hosted pages:** the editor can also publish a simple page (title, text, photo) as one
  self-contained HTML file on Arweave (under 95 KiB, free) and use `https://arweave.net/<page>`
  as the destination. Link records carry `Kind: page` as an editor hint. **Contact cards** are
  hosted pages with Call / Text / Email / Website / Directions buttons and a "Save contact"
  vCard, uploaded separately as `text/vcard` (or embedded as a data URL when locked);
  `Kind: contact`. Edits publish a new
  page version and wait until arweave.net serves it before repointing the link.
- **Password protection:** the editor can put any destination (web address or page) behind a
  "locked page": one self-contained HTML file on Arweave whose content is AES-GCM encrypted
  with a random key, wrapped by a PBKDF2 (600k) password key and by an owner key derived from
  the PermaPath key (so the owner can always edit and keep the password). Visitors decrypt in
  the browser; no server is involved. Link records carry `Kind: locked`. Strong passwords are
  recommended, not enforced.
- **Not set up:** a link can be created with no `Destination` and `Disabled: true`
  (batch creation for pre-printed codes); scans show "turned off" until an update
  sets a destination.
- **Update:** upload a data item tagged `Type: update`, `Link: <LINK_ID>`, plus the
  full new state (`Destination`, `Seq`, optional `Name`, optional `Disabled: true`).
- **Resolve:** look up the link by ID to learn its owner, then query updates with
  `owners: [owner]`. Highest numeric `Seq` wins. `Seq` is a Unix-ms timestamp, so
  no prior state is needed to write. Only `App-Version: 1` records count.
- **Signatures are checked, so no endpoint is trusted.** Records have an empty
  body, so the resolver can verify each one's Ed25519 signature from GraphQL fields
  alone (`signature`, `owner.key`, tags), then take the newest valid record from
  any endpoint. Older records with a body are verified by downloading it. A bad
  endpoint can at most hide the newest update; it can't invent one.
- **Endpoints:** the serving gateway, arweave.net, Goldsky, permagate.io and
  frostor.xyz, queried in parallel. Browsers without WebCrypto Ed25519 (pre-2023
  Safari, pre-mid-2025 Chrome) fall back to trusting them in that priority order.
- **Upgrades:** if a link's newest record has `Resolver: <TX>`, the resolver
  forwards the scan to that newer resolver page (max 3 hops), unless it names the
  resolver itself. Only the link's owner can set it; the editor carries it forward
  on later edits, and sets it to the current resolver whenever a record uses a v3 tag.
- **v3 tags** (resolver v3; older resolvers ignore them, hence the `Resolver` tag):
  `Count: true` makes the resolver ping `permapath.link/api/scan?l=<id>` with
  `sendBeacon` after the lookup (never delaying the redirect); `Off-At: <unix ms>`
  turns the link off from then on; `Message` is shown while it's off; `Routes` is a
  JSON list of rules, first match wins, else `Destination`: `{ "to": URL }` plus any of
  `os` (`ios`/`android`), `after`/`before` (unix ms), `days` (`"12345"`, 0 = Sunday)
  and `from`/`until` (`"HH:MM"`, in the `Time-Zone` tag's IANA zone). A rule with an
  unknown condition is skipped. The editor and CLI turn scan counting on for new links.
- **QR design** (editor-only, resolvers ignore it): a `Design` tag with JSON `{ fg, bg,
  transparent, style: square|rounded, label, frame: square|rounded|bar, icon: <built-in name>, logo: https://arweave.net/<image>, sturdy }`.
  A logo, icon or `sturdy` uses error correction H (denser: 57 vs 45 modules). The rounded style
  draws the finder and alignment patterns solid; every style is decode-tested.
- **Center icons:** 21 outline icons from Tabler Icons (MIT), vendored in `editor/vendor/icons.mjs`.
- **Feature suggestions:** `suggest.html` (also pre-filled by AI assistants via
  `?source=ai&text=…`), `permapath suggest` and the MCP `suggest_feature` tool post to
  `/api/suggest`. The Worker keeps them privately in a `SuggestionBox` Durable Object (salted
  IP hash for a 5-per-hour limit, a honeypot field, 200 a day overall); goodspeed fetches new ones
  with the `SUGGEST_ADMIN_KEY` Worker secret and emails each to Chris.
- **Scan counts:** the Worker keeps a daily total per link (UTC days) in one
  SQLite-backed Durable Object: no IPs, no cookies. Public, unauthenticated, so
  approximate: `GET /api/scans?l=<id>,<id>` (totals, up to 100),
  `/api/scans/<id>` (per day), `/api/scans/summary` (all links).
- **Keys:** Ed25519 seeds, base58-encoded (~44 chars), kept in the user's password
  manager, with an optional 24-word recovery phrase (the same seed in BIP39 words, plus a
  checksum) as a paper backup; `editor/phrase.js`. Data items use ANS-104 signature type 4 (Turbo's "solana" format).
  Uploads go to Turbo directly from the browser and are free under 100 KiB. If Turbo is
  unreachable, failing, rate limiting or asks for payment, uploads fall back to
  `up.arweave.net` (also free for small items; changes then take a few minutes to appear).
- **Latency:** new links and edits usually go live within seconds, because
  frostor.xyz indexes Turbo uploads almost immediately. If frostor is down,
  expect ~5–20 min while the other endpoints catch up. See `spike/FINDINGS.md`.

## Layout

| Path | What |
|---|---|
| `resolver/index.html` | The page every QR code points at. Single file, no dependencies. |
| `editor/` | Static site for creating/editing links, plus `history.html?l=<id>` (public, verified change history of any link) and `llms.txt` (instructions for AI assistants: draft a CSV for the user's **Import CSV**). `arweave.js` = keys, ANS-104, upload, GraphQL; `links.js` = protocol; `app.js` = UI. |
| `scripts/deploy.mjs` | Uploads the resolver or editor to Arweave (signs with `.data/deploy-key`, gitignored). |
| `worker/` | Cloudflare Worker for permapath.link: serves the current editor from Arweave under one stable origin, so password managers keep autofilling keys across editor deploys; relays `/api` for the CLI; keeps scan counts. |
| `test/` | Unit tests (`npm test`) and live browser tests (`node test/browser.mjs`). |
| `spike/` | The original proof-of-concept and its findings. |

## Scripts and command line

`lib/permapath.js` is the same protocol code as the editor, packaged for Node 22+, and
`cli/permapath.mjs` wraps it. Each editor deploy also publishes a single-file bundle at
https://permapath.link/cli.mjs (`npm run build:cli` builds `dist/cli.mjs`), which AI agents
download per the instructions in `llms.txt`. Use them to update links automatically, for example
pointing a code on a product box at the latest manual on each release.

```bash
export PERMAPATH_KEY=...                  # or --key-file path/to/key
node cli/permapath.mjs create https://example.com/menu --name "Menu"
node cli/permapath.mjs set <link-id> https://example.com/menu-v2
node cli/permapath.mjs show <link-id>     # current destination and history, no key needed
node cli/permapath.mjs scans <link-id>    # scan count per day
node cli/permapath.mjs help               # also: keygen, phrase, batch, list, rename, off, on, off-at, message, rules, count, page, edit-page, lock, unlock, qr, --json
```

```js
import { loadKey, createLink, updateLink, getLink } from './lib/permapath.js';
const key = await loadKey(process.env.PERMAPATH_KEY);
const { id, url } = await createLink(key, { destination: 'https://example.com', name: 'Demo' });
await updateLink(key, id, { destination: 'https://example.com/v2' });
```

### npm packages and MCP server

`npm run build:npm` bundles two dependency-free packages into `dist/npm/`:
**`permapath`** (the CLI as `npx permapath …`, and the library as `import … from 'permapath'`)
and **`permapath-mcp`** (`mcp/server.mjs`, a local MCP server for Claude Desktop, ChatGPT
desktop, Cursor and others; read-only tools without a key, create/update tools with
`PERMAPATH_KEY`). Package READMEs live in `packages/`. Published on npm since 2026-10-07.
`npm run publish:npm` stages both for approval on npmjs.com (needs a stage-only `NPM_STAGE_TOKEN`
in `.env`; `-- --dry` to check); bump `VERSION` in `scripts/build-npm.mjs` and `SERVER_INFO` in
`mcp/server.mjs` first.

## Develop

```bash
npm ci
npm test                         # unit tests, offline
node test/make-fixtures.mjs      # once: real links for the resolver test (wait ~10 min)
node test/browser.mjs            # browser tests; editor tests use a fake Arweave (test/fake-arweave.mjs)
LIVE=1 node test/browser.mjs editor     # editor tests against the real network (before a release)
WORKER=1 node test/browser.mjs editor   # editor tests served through the Worker
BROWSER=webkit node test/browser.mjs    # same tests on WebKit (Safari's engine)
cd editor && python3 -m http.server 8090   # run the editor locally
node scripts/make-print-test.mjs  # rebuild editor/print-test-*.pdf (the printable size test)
node scripts/stats.mjs          # usage stats from public data (emailed weekly from ~/python_scripts)
```

## Deploy

```bash
npm run deploy:editor    # uploads the editor, writes its TX into worker/src/index.js
npm run deploy:worker    # serves it on permapath.link (reads CLOUDFLARE_API_TOKEN from untracked .env)
                         # first checks turbo-gateway.com or ardrive.net already serve the editor
                         # (arweave.net blocks Workers); if not, wait a few minutes and rerun
```

Commit the updated `worker/src/index.js` and the "Live" URL above after each editor deploy.

**Don't redeploy the resolver once QR codes are printed.** Every printed code
embeds its TX. `npm run deploy:resolver` creates a *new* resolver and
points the editor at it. Old codes keep using the old one, which still works
because Arweave is permanent, but any fix you make won't reach them.

## License

[MIT](LICENSE).
