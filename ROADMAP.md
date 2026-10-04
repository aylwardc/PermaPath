# Roadmap

Ideas discussed on 2026-10-03, not yet built.

## Editor-only (no resolver change)

- **File destinations:** upload a PDF (manual, menu, flyer) to Arweave as the destination. Free under 100 KiB; larger files need paid upload credits.
- **QR design options:** frame text ("Scan for menu"), colors, a center logo with high error correction, and an outdoor/permanent toggle.
- **Key per batch:** create a batch with its own key and export the key with the CSV, so pre-printed codes can be handed to someone else.

## Needs a new resolver (bundle these; only new codes get them, or old ones via the `Resolver` handoff tag)

- **Backup key and co-editors:** a link names a recovery key or extra keys allowed to update it. This addresses "lose the key, codes freeze forever", and it is what makes agent access safe (below): give an AI agent its own key with edit rights instead of the main key.
- **Agent access for code-running agents** (Claude Code, Codex, Cursor), paired with co-editors:
  - Shipped: single-file CLI at permapath.link/cli.mjs, with `llms.txt` instructions to use a key the user provides (preferably a separate one).
  - Optional: also publish as an npm package (`npx permapath …`).
  - Optionally add a *local* MCP server (`npx permapath-mcp`) for Claude Desktop/Code and Cursor, with the key kept on the user's machine. Avoid a remote MCP connector that receives keys; read-only remote tools (link history) are fine.
  - Already shipped: `llms.txt` plus CSV import, so any chatbot can draft links that the user imports in the browser.
- **Smart routing:** by device (App Store vs Google Play), language, schedule (time of day, before or after a date), and auto-off dates.

## Deliberately not planned

- **Scan analytics:** needs a server in the scan path, which breaks "works even if PermaPath disappears" and tracks people. If ever added, make it opt-in per link.
- **Automatic web snapshots:** an earlier server-side snapshot experiment struggled with paywalls, animation and bot detection. File destinations cover most of the need.
- **Payments:** only worth it if large files ever matter.

