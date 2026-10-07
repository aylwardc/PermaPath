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
- **QR design:** label, colors (contrast-checked), squares / rounded / dots, center logo, extra-sturdy, transparent background; saved per link.

## Editor-only (no resolver change)

- **Key handoff** (replaces "key per batch"): create a set of links with a new key and print a sheet with that key and its recovery phrase for whoever takes them over. Full control passes immediately; the creator still has the key too. About half a day. A real ownership transfer needs a new resolver (below).
- **Agent access** (no resolver change needed):
  - Shipped: single-file CLI at permapath.link/cli.mjs, with `llms.txt` instructions to use a key the user provides (preferably a separate one).
  - Next: publish as an npm package (`npx permapath …`; the name is free).
  - Next: a *local* MCP server (`npx permapath-mcp`) for Claude Desktop, ChatGPT desktop and Cursor, with the key kept on the user's machine. Avoid a remote MCP connector that receives keys; read-only remote tools (link history) are fine.
  - Already shipped: `llms.txt` plus CSV import, so any chatbot can draft links that the user imports in the browser.
- **File destinations:** upload a PDF (manual, menu, flyer) to Arweave as the destination. Free under 100 KiB; larger files need paid upload credits.

## Needs a new resolver (bundle these; only new codes get them, or old ones via the `Resolver` handoff tag)

- **Backup key and co-editors** (set aside 2026-10-05: too much complexity for the benefit; the recovery phrase covers lost keys): a link names a recovery key or extra keys allowed to update it. It would make agent access safer: give an AI agent its own key with edit rights instead of the main key.
- **Ownership transfer:** the owner signs "this link now belongs to <public ID>"; the resolver follows the new owner from then on. Transfers must be ordered by when Arweave confirmed them, not by the owner-written Seq, or a previous owner could backdate a transfer back to themselves; so a transfer takes effect after confirmation (up to about an hour). About 2–3 days with the editor screen.

## Deliberately not planned

- **Detailed scan analytics** (locations, devices, referrers): tracks people. v3 counts scans per day only, and the count is a side ping, so scans still work if PermaPath disappears.
- **Automatic web snapshots:** an earlier server-side snapshot experiment struggled with paywalls, animation and bot detection. File destinations cover most of the need.
- **Payments:** only worth it if large files ever matter.


## Known issues

- **Scan counts were reset to zero on 2026-10-07** (the Worker counts into a new Durable Object name), so totals start from real use.

- **Scan counts share the Workers free plan** (100,000 requests a day for the whole account, counting the editor and the CLI relay; Durable Objects have their own free allowance). If PermaPath gets popular, move to Workers Paid ($5/month) before the limit starts failing requests.

- **frostor.xyz returns a broken signature (`"<not-found>"`) for older records.** Handled: the editor, CLI and resolver v2 (`baTff…`) only trust copies whose signatures verify, per copy. Codes made with the old resolver (`G81f…`) can still show "Link not found" in the rare case frostor's broken copy is checked first. Worth reporting to frostor's operator.

## Watch list (promising, not ready to depend on)

- **Shorter QR codes via byte offsets.** arweave.net can serve data by its position in the weave (e.g. `https://12345678kb.arweave.net/`), which could shrink codes from ~110 to ~50 characters. It's new (HyperBEAM `~name@1.0`, March 2026), offsets only exist once a bundle is confirmed, and fewer gateways support it. Revisit once proven.
- **Arweave-as-database (arlmdb)** as a possible replacement for GraphQL search services: indexes stored on Arweave and read by byte offset. Unclear how it stays fresh enough for live updates. Revisit once other apps depend on it.
- **Turbo's free tier** is now capped: 10 MiB per key and 10 MiB per IP address, for life (seen 2026-10-06, when goodspeed's IP ran out). After that Turbo asks for payment (x402, USDC on Base), and uploads fall back to `up.arweave.net`: still free, but changes take minutes, not seconds, to go live. A link record is about 1 KB, so most people never hit it; heavy page editing can. The CLI relay (permapath.link/api/upload) uses Cloudflare's IPs. The deploy key has Turbo credits ($10 on 2026-10-06, about 280 editor deploys), and the editor browser tests use a fake Arweave unless LIVE=1. If this bites real users, options are Turbo credits for PermaPath to pay for small uploads, or showing "takes a few minutes" when the fallback was used.
