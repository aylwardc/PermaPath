# permapath

Links that never die, and QR codes you never have to reprint. A PermaPath QR code
points to a permanent page on [Arweave](https://arweave.org); you can change where it
sends people at any time, and the printed code stays the same. Free, no account:
your key is your account. Web app: [permapath.link](https://permapath.link).

This package is the command line tool and a JavaScript library (Node.js 22+, no
dependencies). It's what AI coding agents (Claude Code, Codex, Cursor, Gemini CLI) use to
create and update links for you.

## Command line

```bash
export PERMAPATH_KEY='your key or 24-word recovery phrase'   # or --key-file path
npx permapath create https://example.com/menu --name "Menu"  # prints the link ID and QR URL
npx permapath set <link-id> https://example.com/menu-v2       # repoint it; the QR code stays the same
npx permapath show <link-id>                                   # where it points and its history (no key needed)
npx permapath qr <link-id> > code.svg                          # print-ready QR code
npx permapath help                                             # everything else
```

Make a key at [permapath.link](https://permapath.link) ("Create a key") or with
`npx permapath keygen`, and keep it in your password manager. Give an AI agent a
**separate key**, not your main one: anyone with a key controls its links, permanently.

## Library

```js
import { loadKey, createLink, updateLink, getLink } from 'permapath';
const key = await loadKey(process.env.PERMAPATH_KEY);
const { id, url } = await createLink(key, { destination: 'https://example.com/menu', name: 'Menu' });
await updateLink(key, id, { destination: 'https://example.com/menu-v2' });
```

Everything written is permanent and public, except what a password protects. Source and
details: [github.com/aylwardc/PermaPath](https://github.com/aylwardc/PermaPath). MIT license.
