#!/usr/bin/env node
// PermaPath command line. Run `node cli/permapath.mjs help`.
import fs from 'node:fs';
import {
  generateKey, loadKey, recoveryPhrase, createLink, createBatch, listLinks, getLink, updateLink, linkUrl, linkQrSvg, linkStatus,
  lockLink, unlockLink, revealLink, createPage, editPage, readPage,
} from '../lib/permapath.js';

const HELP = `PermaPath: QR codes you never have to reprint.

Usage: permapath <command> [options]

  keygen                         Print a new key (store it somewhere safe)
  phrase                         Print your key's 24-word recovery phrase (a paper
                                 backup; works anywhere the key does)
  create <url> [--name N] [--password P]
                                 Create a link (optionally password protected);
                                 prints its ID and QR URL
  page <title> [--text T | --text-file F] [--photo F] [--name N] [--password P]
                                 Create a link to a simple page you write
  edit-page <link-id> [--title T] [--text T | --text-file F] [--photo F | --no-photo]
                                 Change a page, keeping what you don't pass
  batch <count> [--prefix P]     Create "not set up" links (CSV to stdout)
  list                           List your links
  show <link-id>                 Current destination and full history (no key needed)
  set <link-id> <url>            Change where a link points
  rename <link-id> <name>        Change a link's name ("" to clear)
  off <link-id> | on <link-id>   Turn a link off or back on
  lock <link-id> --password P    Password-protect a link, or change its password
  unlock <link-id>               Remove password protection
  qr <link-id>                   Print the link's QR code as SVG

Options:
  --key-file <path>   Read the key (or recovery phrase) from a file (default: PERMAPATH_KEY env var)
  --json              Machine-readable output
  --force             With set: replace a password-protected link's destination (removes the protection)

Pages: text with blank lines makes paragraphs and web addresses become links.
Photos must be JPEG, PNG or WebP and small enough to fit (pages are up to 95 KB,
or about 66 KB when password protected); resize big photos first.

Everything you publish is permanent. Destinations are public unless password
protected; link names and history are always visible.`;

function parse(argv) {
  const args = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '--force' || a === '--no-photo') opts[a.slice(2)] = true;
    else if (a.startsWith('--')) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = argv[++i];
    } else args.push(a);
  }
  return { args, opts };
}

function keyText(opts) {
  const text = opts['key-file'] ? fs.readFileSync(opts['key-file'], 'utf8') : process.env.PERMAPATH_KEY;
  if (!text) throw new Error('No key: set PERMAPATH_KEY or pass --key-file <path>.');
  return text;
}
const key = (opts) => loadKey(keyText(opts));

// A photo file as a data URL, checked by its first bytes.
function photoDataUrl(file) {
  const bytes = fs.readFileSync(file);
  const type = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpeg'
    : bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'png'
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'webp' : null;
  if (!type) throw new Error(`${file} isn't a JPEG, PNG or WebP image.`);
  return `data:image/${type};base64,${bytes.toString('base64')}`;
}
const pageText = (opts) => (opts['text-file'] ? fs.readFileSync(opts['text-file'], 'utf8') : opts.text);

const csvCell = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const describe = (s) => {
  if (!s.destination) return '(not set up)';
  const where = s.kind === 'locked' ? '(password protected)' : s.destination;
  return s.disabled ? `(off) ${where}` : where;
};
const need = (v, what) => { if (!v) throw new Error(`Missing ${what}. Run "permapath help".`); return v; };

async function main() {
  const { args: [cmd, ...rest], opts } = parse(process.argv.slice(2));
  const out = (human, data) => console.log(opts.json ? JSON.stringify(data, null, 2) : human);

  switch (cmd) {
    case 'keygen': {
      const k = generateKey();
      return out(k, { key: k });
    }
    case 'phrase': {
      const phrase = await recoveryPhrase(keyText(opts));
      return out(phrase, { phrase });
    }
    case 'create': {
      const r = await createLink(await key(opts), { destination: need(rest[0], 'URL'), name: opts.name || '', password: opts.password || '' });
      return out(`${r.id}\n${r.url}`, r);
    }
    case 'page': {
      const title = need(rest[0], 'page title');
      const r = await createPage(await key(opts), {
        title, text: pageText(opts) || '', image: opts.photo ? photoDataUrl(opts.photo) : '', name: opts.name || '', password: opts.password || '',
      });
      return out(`${r.id}\n${r.url}\nThe page takes a few minutes to appear on Arweave; scans show it once it does.`, r);
    }
    case 'edit-page': {
      const k = await key(opts);
      const id = need(rest[0], 'link ID');
      const changes = { title: opts.title, text: pageText(opts), image: opts['no-photo'] ? '' : opts.photo ? photoDataUrl(opts.photo) : undefined };
      if (Object.values(changes).every((v) => v === undefined)) throw new Error('Nothing to change: pass --title, --text, --text-file, --photo or --no-photo.');
      const onWait = (s) => { if (!opts.json) process.stderr.write(`\rWaiting for Arweave to publish it (usually 1-5 minutes): ${s}s`); };
      const r = await editPage(k, id, changes, { onWait });
      if (!opts.json) process.stderr.write('\n');
      return out(`Updated the page for ${id}.`, r);
    }
    case 'batch': {
      const rows = await createBatch(await key(opts), { count: Number(need(rest[0], 'count')), prefix: opts.prefix || '' });
      if (opts.json) return out('', rows);
      console.log('name,qr_url,link_id');
      for (const r of rows) console.log([r.name, r.url, r.id].map(csvCell).join(','));
      return;
    }
    case 'list': {
      const links = await listLinks(await key(opts));
      return out(links.map((l) => `${l.id}  ${l.name || '(untitled)'}  ${describe(l)}`).join('\n') || 'No links yet.',
        links.map((l) => ({ ...l, url: linkUrl(l.id), status: linkStatus(l) })));
    }
    case 'show': {
      const link = await getLink(need(rest[0], 'link ID'));
      if (!link) throw new Error('Link not found (new links can take a moment to appear).');
      // With the owner's key, also show what a locked link unlocks to.
      let unlocks = null;
      if (link.current.kind === 'locked' && (process.env.PERMAPATH_KEY || opts['key-file'])) {
        const k = await key(opts);
        if (k.ownerKey === link.ownerKey) unlocks = await revealLink(k, link.id);
      }
      const unlocksText = unlocks && (unlocks.type === 'url' ? unlocks.url : 'a page (below)');
      const keyForPage = link.current.kind === 'locked' && unlocks?.type === 'page' ? await key(opts) : null;
      const page = link.current.kind === 'page' || keyForPage ? await readPage(link.id, keyForPage).catch(() => null) : null;
      const lines = [
        `${link.current.name || '(untitled)'}  [${linkStatus(link.current)}]`,
        `QR URL:  ${linkUrl(link.id)}`,
        `Now:     ${describe(link.current)}`,
        ...(unlocksText ? [`Unlocks: ${unlocksText}`] : []),
        ...(page ? [`Page:    "${page.title}"${page.image ? ' (with photo)' : ''}`, ...page.text.trim().split('\n').slice(0, 6).map((l) => `         ${l}`)] : []),
        `Owner:   ${link.owner}`,
        'History (newest first):',
        ...link.history.map((h) => `  ${new Date(h.seq).toISOString()}  ${describe(h)}${h.name ? `  "${h.name}"` : ''}`),
      ];
      return out(lines.join('\n'), { ...link, url: linkUrl(link.id), status: linkStatus(link.current), ...(unlocks ? { unlocks } : {}), ...(page ? { page: { title: page.title, text: page.text, hasPhoto: !!page.image } } : {}) });
    }
    case 'set': {
      const k = await key(opts);
      const current = await getLink(need(rest[0], 'link ID'));
      if (current?.current.kind === 'locked' && !opts.force) {
        throw new Error('That link is password protected. Setting a web address would remove the protection; add --force to do it anyway, or edit it at https://permapath.link.');
      }
      const r = await updateLink(k, rest[0], { destination: need(rest[1], 'URL') });
      return out(`Updated. ${rest[0]} now points to ${r.destination}`, r);
    }
    case 'rename': {
      if (rest[1] === undefined) throw new Error('Missing name. Run "permapath help".');
      const r = await updateLink(await key(opts), need(rest[0], 'link ID'), { name: rest[1] });
      return out(`Renamed ${rest[0]} to "${r.name}"`, r);
    }
    case 'off':
    case 'on': {
      const r = await updateLink(await key(opts), need(rest[0], 'link ID'), { disabled: cmd === 'off' });
      return out(`Turned ${cmd} ${rest[0]}`, r);
    }
    case 'lock':
    case 'unlock': {
      const k = await key(opts);
      const id = need(rest[0], 'link ID');
      const onWait = (s) => { if (!opts.json) process.stderr.write(`\rWaiting for Arweave to publish it (usually 1-5 minutes): ${s}s`); };
      const r = cmd === 'lock'
        ? await lockLink(k, id, { password: need(opts.password, '--password'), onWait })
        : await unlockLink(k, id, { onWait });
      if (!opts.json) process.stderr.write('\n');
      return out(cmd === 'lock' ? `Locked ${id}. People need the password to open it.` : `Unlocked ${id}. It now opens without a password.`, r);
    }
    case 'qr':
      return console.log(linkQrSvg(need(rest[0], 'link ID')));
    case undefined:
    case 'help':
    case '--help':
      return console.log(HELP);
    default:
      throw new Error(`Unknown command "${cmd}". Run "permapath help".`);
  }
}

main().catch((err) => {
  console.error(`permapath: ${err.message}`);
  process.exit(1);
});
