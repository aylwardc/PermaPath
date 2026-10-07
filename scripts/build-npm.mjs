// Builds the two npm packages into dist/npm/ from the repo's sources, each a
// bundled, dependency-free file plus package.json, README and LICENSE:
//   permapath      the CLI (bin) and the library (import 'permapath')
//   permapath-mcp  the MCP server (bin)
// Publish (needs NPM_TOKEN in .env): npm run publish:npm
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '0.1.0'; // bump before each publish

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'dist/npm');
const NOTICE = '// Includes QR Code Generator for JavaScript, Copyright (c) 2009 Kazuhiko Arase, MIT license.';
const common = {
  name: undefined, version: VERSION, license: 'MIT', type: 'module', engines: { node: '>=22' },
  author: 'Christopher Aylward', homepage: 'https://permapath.link',
  repository: { type: 'git', url: 'git+https://github.com/aylwardc/PermaPath.git' },
  bugs: { url: 'https://github.com/aylwardc/PermaPath/issues' },
};

async function bundle(entry, file, banner) {
  await build({
    entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: true,
    banner: { js: `${banner}\n${NOTICE}` }, outfile: file,
  });
}

export async function buildNpm() {
  fs.rmSync(out, { recursive: true, force: true });
  const packages = {
    permapath: {
      description: 'Links that never die and QR codes you never have to reprint: create PermaPath links on Arweave and change where they point (CLI and library).',
      keywords: ['qr code', 'dynamic qr code', 'permanent link', 'arweave', 'permaweb', 'cli', 'ai agents'],
      bin: { permapath: 'cli.mjs' }, exports: { '.': './index.mjs' }, main: './index.mjs',
      files: ['cli.mjs', 'index.mjs', 'README.md', 'LICENSE'],
      async bundles(dir) {
        await bundle('cli/permapath.mjs', path.join(dir, 'cli.mjs'), '// PermaPath CLI. https://permapath.link');
        await bundle('lib/permapath.js', path.join(dir, 'index.mjs'), '// PermaPath library. https://permapath.link');
      },
    },
    'permapath-mcp': {
      description: 'MCP server for PermaPath: let Claude, ChatGPT, Cursor and other AI assistants look up and manage QR codes you never have to reprint.',
      keywords: ['mcp', 'model context protocol', 'qr code', 'arweave', 'claude', 'ai agents'],
      bin: { 'permapath-mcp': 'server.mjs' },
      files: ['server.mjs', 'README.md', 'LICENSE'],
      async bundles(dir) {
        await bundle('mcp/bin.mjs', path.join(dir, 'server.mjs'), '// PermaPath MCP server. https://permapath.link');
      },
    },
  };
  const sizes = {};
  for (const [name, { bundles, ...meta }] of Object.entries(packages)) {
    const dir = path.join(out, name);
    fs.mkdirSync(dir, { recursive: true });
    await bundles(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ ...common, name, ...meta }, null, 2)}\n`);
    fs.copyFileSync(path.join(root, 'packages', name, 'README.md'), path.join(dir, 'README.md'));
    fs.copyFileSync(path.join(root, 'LICENSE'), path.join(dir, 'LICENSE'));
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.mjs')) fs.chmodSync(path.join(dir, f), 0o755);
    sizes[name] = fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
  }
  return sizes;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [name, size] of Object.entries(await buildNpm())) console.log(`dist/npm/${name}: ${Math.round(size / 1024)} KiB (v${VERSION})`);
}
