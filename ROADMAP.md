# Roadmap

Ideas discussed on 2026-10-03, not yet built.

## Shipped 2026-10-05

- **Recovery phrase** (instead of backup keys and co-editors): the key as 24 words for a paper backup, a printable recovery sheet, and sign-in with the words.
- **Resolver v3:** scan counts (on by default for new links, public daily totals per link, kept by the Worker), turning off on a date with a message, and different destinations by device (iPhone/iPad, Android) or by days, times and dates. Older codes get these by forwarding to v3 (`Resolver` tag) when their owner uses one.
- **Your own stats:** `https://permapath.link/api/scans/summary` (total scans and links counted, per day).

## Editor-only (no resolver change)

- **File destinations:** upload a PDF (manual, menu, flyer) to Arweave as the destination. Free under 100 KiB; larger files need paid upload credits.
- **QR design options:** frame text ("Scan for menu"), colors, a center logo with high error correction, and an outdoor/permanent toggle.
- **Key per batch:** create a batch with its own key and export the key with the CSV, so pre-printed codes can be handed to someone else.

## Needs a new resolver (bundle these; only new codes get them, or old ones via the `Resolver` handoff tag)

- **Backup key and co-editors** (set aside 2026-10-05: too much complexity for the benefit; the recovery phrase covers lost keys): a link names a recovery key or extra keys allowed to update it. It would make agent access safer: give an AI agent its own key with edit rights instead of the main key.
- **Agent access for code-running agents** (Claude Code, Codex, Cursor), paired with co-editors:
  - Shipped: single-file CLI at permapath.link/cli.mjs, with `llms.txt` instructions to use a key the user provides (preferably a separate one).
  - Optional: also publish as an npm package (`npx permapath …`).
  - Optionally add a *local* MCP server (`npx permapath-mcp`) for Claude Desktop/Code and Cursor, with the key kept on the user's machine. Avoid a remote MCP connector that receives keys; read-only remote tools (link history) are fine.
  - Already shipped: `llms.txt` plus CSV import, so any chatbot can draft links that the user imports in the browser.
- **Smart routing:** device, schedule and auto-off shipped in v3. Not done: by language.
- **Last-known destination:** if every lookup fails, send a repeat visitor to the destination their phone saw last time.

## Deliberately not planned

- **Detailed scan analytics** (locations, devices, referrers): tracks people. v3 counts scans per day only, and the count is a side ping, so scans still work if PermaPath disappears.
- **Automatic web snapshots:** an earlier server-side snapshot experiment struggled with paywalls, animation and bot detection. File destinations cover most of the need.
- **Payments:** only worth it if large files ever matter.


## Known issues

- **Scan counts share the Workers free plan** (100,000 requests a day for the whole account, counting the editor and the CLI relay; Durable Objects have their own free allowance). If PermaPath gets popular, move to Workers Paid ($5/month) before the limit starts failing requests.

- **History page on iOS opens scrolled past the title** (Chrome on iPhone). Three small fixes didn't help (16px fields, no scroll restoration or anchoring, container padding). Next step: reproduce in the Xcode iOS Simulator instead of guessing.
- **frostor.xyz returns a broken signature (`"<not-found>"`) for older records.** Handled: the editor, CLI and resolver v2 (`baTff…`) only trust copies whose signatures verify, per copy. Codes made with the old resolver (`G81f…`) can still show "Link not found" in the rare case frostor's broken copy is checked first. Worth reporting to frostor's operator.

## Watch list (promising, not ready to depend on)

- **Shorter QR codes via byte offsets.** arweave.net can serve data by its position in the weave (e.g. `https://12345678kb.arweave.net/`), which could shrink codes from ~110 to ~50 characters. It's new (HyperBEAM `~name@1.0`, March 2026), offsets only exist once a bundle is confirmed, and fewer gateways support it. Revisit once proven.
- **Arweave-as-database (arlmdb)** as a possible replacement for GraphQL search services: indexes stored on Arweave and read by byte offset. Unclear how it stays fresh enough for live updates. Revisit once other apps depend on it.
- **Turbo's free tier.** Uploads already fall back to `up.arweave.net` automatically; scanning never depends on either. If both ever stopped being free, PermaPath could pay for users' tiny uploads (around 1 KB each).
