# Roadmap

Ideas discussed since 2026-10-03. Shipped work is listed first; everything after it is not built yet.

## Shipped 2026-10-05

- **Recovery phrase** (instead of backup keys and co-editors): the key as 24 words for a paper backup, a printable recovery sheet, and sign-in with the words.
- **Resolver v3:** scan counts (on by default for new links, public daily totals per link, kept by the Worker), turning off on a date with a message, and different destinations by device (iPhone/iPad, Android) or by days, times and dates. Older codes get these by forwarding to v3 (`Resolver` tag) when their owner uses one.
- **Your own stats:** `https://permapath.link/api/scans/summary` (total scans and links counted, per day).

## Shipped 2026-10-06

- **Contact cards:** a page with Call / Text / Email / Website / Directions and a Save contact vCard.
- **Printing tips page** with exact-size PDF test sheets (Letter and A4).
- **Your links as a table** with sortable columns; wider desktop layout; Printing tips in the signed-in header.
- **"Live" means scannable:** new links stay "New" until a scan would find them.
- **Fake Arweave for the editor tests** (LIVE=1 for real uploads); deploys pay with the deploy key's Turbo credits and report the cost.

## Shipped 2026-10-07

- **Slow-upload notice** when Turbo refuses an upload and it goes through up.arweave.net.
- **Usage stats:** `node scripts/stats.mjs`, emailed weekly (Mondays 9:10) by `~/python_scripts/permapath_weekly_stats.py`.
- **Event pages:** date, place, Add to calendar (.ics), Google Calendar, Directions.
- **QR design**, saved per link, in its own **Customize QR** pop-up: label, frame (square, rounded, label bar), colors (contrast-checked), squares or rounded (dots were dropped: they scanned worst), 21 built-in center icons (Tabler, MIT; including Payment) or your own logo with a size slider (16–32% of the code), extra-sturdy, transparent background. Every combination is decode-tested.
- **Type tags** on links (Web address, Page, Contact, Event); the table has separate Type and Destination columns.
- **Feature suggestions** from the website, AI assistants (pre-filled link), MCP and the CLI; kept privately and emailed to Chris within minutes.
- **npm:** `permapath` (CLI + library) and `permapath-mcp` (local MCP server); releases are staged for Chris's approval with 2FA.

## Next: editor-only (no resolver change)

- **Agent access** (no resolver change needed):
  - Shipped: single-file CLI at permapath.link/cli.mjs, with `llms.txt` instructions to use a key the user provides (preferably a separate one).
  - Shipped 2026-10-07 on npm: `permapath` (CLI + library) and `permapath-mcp` (a *local* MCP server, key kept on the user's machine); `llms.txt` points at both. Avoid a remote MCP connector that receives keys; read-only remote tools are fine.
  - Already shipped: `llms.txt` plus CSV import, so any chatbot can draft links that the user imports in the browser.
- **Payment links:** a "Payment" destination type that builds a Venmo, Cash App or PayPal link from a username and an optional amount and note (e.g. `https://venmo.com/USER?txn=pay&amount=10&note=…`). Works today by pasting such a link as a web address; this would only make it easier. Zelle has no public links.

## Planned: file links, the first paid feature (notes, not built)

Discussed 2026-10-08. A fifth link type, "A file": the user's key signs and owns the
upload; PermaPath's sponsor key pays Turbo for files over the free size.

**Decided**
- Payments: Stripe Checkout. $5 minimum deposit. Balance shown in dollars.
- No refunds: unused balance is forfeited.
- Sponsorship via Turbo credit sharing (proven 2026-10-07, `spike/FINDINGS.md`): a
  dedicated sponsor key in the Worker approves just one file's cost (plus a small buffer,
  ~15 min expiry) when the user presses Upload; the browser uploads with `x-paid-by`;
  the Worker deducts the dollar price and revokes what's left. Never the deploy key.
- The balance stays in exact dollars; only each upload's price follows Turbo's rate,
  quoted before upload ("This file costs $0.27").
- Small files (under ~100 KB) stay free through the user's own Turbo allowance, so
  people can try file links with no balance. No sponsored freebies (keys are free, so
  they'd be farmed).
- Rough costs at ~$90/GB: 300 KB PDF ~3¢, 3 MB ~27¢, 20 MB ~$1.80.

**Still to decide**
- Where dollar balances live: a small private store in the Worker (recommended; exact,
  instant, private; needed for per-upload approvals) vs. locking a rate per deposit and
  keeping the full amount approved in Turbo (no store, but our credits sit reserved).
- Markup over Turbo's cost. Stripe takes 2.9% + 30¢ (about 9% of a $5 deposit).
- Rounding and a minimum charge per file (e.g. round up to the cent, at least 1¢).
- Size limit (start ~50 MB) and allowed file types (PDF, images, audio, video?).
- Float: how much Turbo credit the sponsor key holds, who tops it up, low-balance alert.
- Terms of use and content policy (permanent, public, paid by us), and who handles reports.
- Business setup: whose Stripe account (personal or a company), sales tax (Stripe Tax),
  showing "no refunds" at checkout; chargebacks can still happen. Rules for keeping
  unused prepaid balances vary by place; worth a quick check.
- Do balances ever expire, or just never refund?
- Lost key = lost balance (the balance belongs to the key). Say so at checkout.
- Payment methods: cards and Apple/Google Pay; also USDC through Stripe (~1.5% fee)?
- Password-protected (encrypted) files in the first release, or later?
- Paid uploads from the CLI and MCP, or editor only at first?

**Build order (~5 days):** file link type with free small files; Stripe Add funds and
dollar balance; paid uploads (quote, reserve, upload, deduct, release); terms, report
link, limits, low-float alert.

## Needs a new resolver (bundle these; only new codes get them, or old ones via the `Resolver` handoff tag)

- **Backup key and co-editors** (set aside 2026-10-05: too much complexity for the benefit; the recovery phrase covers lost keys): a link names a recovery key or extra keys allowed to update it. It would make agent access safer: give an AI agent its own key with edit rights instead of the main key.
- **Ownership transfer:** the owner signs "this link now belongs to <public ID>"; the resolver follows the new owner from then on. Transfers must be ordered by when Arweave confirmed them, not by the owner-written Seq, or a previous owner could backdate a transfer back to themselves; so a transfer takes effect after confirmation (up to about an hour). About 2–3 days with the editor screen.

## Deliberately not planned

- **Detailed scan analytics** (locations, devices, referrers): tracks people. v3 counts scans per day only, and the count is a side ping, so scans still work if PermaPath disappears.
- **Automatic web snapshots:** an earlier server-side snapshot experiment struggled with paywalls, animation and bot detection. File links (planned above) cover most of the need.

## Known issues

- **Scan counts were reset to zero on 2026-10-07** (the Worker counts into a new Durable Object name), so totals start from real use.
- **Scan counts share the Workers free plan** (100,000 requests a day for the whole account, counting the editor and the CLI relay; Durable Objects have their own free allowance). If PermaPath gets popular, move to Workers Paid ($5/month) before the limit starts failing requests.
- **frostor.xyz returns a broken signature (`"<not-found>"`) for older records.** Handled: the editor, CLI and resolver v2 (`baTff…`) only trust copies whose signatures verify, per copy. Codes made with the old resolver (`G81f…`) can still show "Link not found" in the rare case frostor's broken copy is checked first. Worth reporting to frostor's operator.

## Watch list (promising, not ready to depend on)

- **Shorter QR codes via byte offsets.** arweave.net can serve data by its position in the weave (e.g. `https://12345678kb.arweave.net/`), which could shrink codes from ~110 to ~50 characters. It's new (HyperBEAM `~name@1.0`, March 2026), offsets only exist once a bundle is confirmed, and fewer gateways support it. Revisit once proven.
- **Arweave-as-database (arlmdb)** as a possible replacement for GraphQL search services: indexes stored on Arweave and read by byte offset. Unclear how it stays fresh enough for live updates. Revisit once other apps depend on it.
- **Turbo's free tier** is now capped: 10 MiB per key and 10 MiB per IP address, for life (seen 2026-10-06, when goodspeed's IP ran out). After that Turbo asks for payment (x402, USDC on Base), and uploads fall back to `up.arweave.net`: still free, but changes take minutes, not seconds, to go live. A link record is about 1 KB, so most people never hit it; heavy page editing can. The CLI relay (permapath.link/api/upload) uses Cloudflare's IPs. The deploy key has Turbo credits ($10 on 2026-10-06, about 280 editor deploys), and the editor browser tests use a fake Arweave unless LIVE=1. If this bites real users, options are Turbo credits for PermaPath to pay for small uploads, or showing "takes a few minutes" when the fallback was used.
