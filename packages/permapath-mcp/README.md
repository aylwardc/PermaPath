# permapath-mcp

An [MCP](https://modelcontextprotocol.io) server for [PermaPath](https://permapath.link):
QR codes you never have to reprint. It lets AI assistants that support MCP (Claude Desktop,
ChatGPT desktop, Cursor and others) look up and manage PermaPath links. It runs on your
own computer, so your key never leaves it. Node.js 22+, no dependencies.

## Set up

Add it to your assistant's MCP settings. For Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "permapath": {
      "command": "npx",
      "args": ["-y", "permapath-mcp"],
      "env": { "PERMAPATH_KEY": "a separate PermaPath key for AI use" }
    }
  }
}
```

Without `PERMAPATH_KEY`, only read-only tools are offered. Use a **separate key** for AI,
made at [permapath.link](https://permapath.link) ("Create a key"): anyone with a key
controls its links, permanently. `PERMAPATH_KEY_FILE` (a path) works too.

## Tools

| Tool | Needs a key | What it does |
|---|---|---|
| `get_link` | no | Where a link points, its status and full history |
| `get_scans` | no | Scan counts, total and per day |
| `get_qr_svg` | no | The link's QR code as SVG, with its saved design |
| `draft_link` | no | A pre-filled link the user opens to check and save with their own key |
| `list_links` | yes | The key's links |
| `create_link` | yes | A new link to a web address (optionally password protected) |
| `create_page` | yes | A new link to a simple page you write |
| `update_link` | yes | Repoint, rename, turn on/off, set an end date and message, scan counting |
| `suggest_feature` | no | Send a feature suggestion to the PermaPath team (asks you first) |

Everything written is permanent and public, except what a password protects. Source:
[github.com/aylwardc/PermaPath](https://github.com/aylwardc/PermaPath). MIT license.
