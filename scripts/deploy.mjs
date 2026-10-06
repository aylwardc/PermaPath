// Deploys to Arweave via Turbo (free under 100 KiB per file).
//   node scripts/deploy.mjs resolver   → single HTML page; prints its TX and writes editor/config.js
//   node scripts/deploy.mjs editor     → every file in editor/, the bundled CLI (cli.mjs) and a path
//                                        manifest; writes worker/src/index.js
// Uploads are signed with .data/deploy-key (created on first run, gitignored).
// The signer doesn't matter to users; it just keeps deploys attributable.
import fs from 'node:fs';
import path from 'node:path';
import { APP_NAME, generateKeyText, loadKey, createDataItem, upload, configureNetwork, UPLOAD_URL, FALLBACK_UPLOAD_URL } from '../editor/arweave.js';

// Turbo's free tier is 10 MiB per IP address, ever, and this machine's is used
// up (2026-10-06). Uploads Turbo refuses go through permapath.link's relay next
// (Cloudflare's IP, still free and fast), and only then to up.arweave.net, which
// is free too but takes much longer to reach the gateways the Worker reads.
configureNetwork({ upload: [UPLOAD_URL, 'https://permapath.link/api/upload', FALLBACK_UPLOAD_URL] });
import { buildCli } from './build-cli.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TYPES = { '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.pdf': 'application/pdf' };
const MAX_FREE = 100 * 1024;

function deployKey() {
  const file = path.join(root, '.data/deploy-key');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, generateKeyText() + '\n', { mode: 0o600 });
  }
  return loadKey(fs.readFileSync(file, 'utf8'));
}

async function put(key, bytes, contentType, extraTags = []) {
  if (bytes.length > MAX_FREE) throw new Error(`File is ${bytes.length} bytes; over the 100 KiB free limit`);
  const item = await createDataItem(key, [
    { name: 'Content-Type', value: contentType },
    { name: 'App-Name', value: APP_NAME },
    ...extraTags,
  ], bytes);
  await upload(item);
  return item.id;
}

const what = process.argv[2];
const key = await deployKey();

if (what === 'resolver') {
  const html = fs.readFileSync(path.join(root, 'resolver/index.html'));
  const id = await put(key, html, 'text/html', [{ name: 'Type', value: 'resolver' }]);
  const configFile = path.join(root, 'editor/config.js');
  fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8').replace(/RESOLVER_TX = '[^']*'/, `RESOLVER_TX = '${id}'`));
  console.log(`resolver: https://arweave.net/${id}\neditor/config.js updated — redeploy the editor.`);
} else if (what === 'editor') {
  const dir = path.join(root, 'editor');
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  const config = fs.readFileSync(path.join(dir, 'config.js'), 'utf8');
  if (config.includes('NOT_DEPLOYED')) throw new Error('Deploy the resolver first.');
  const paths = {};
  for (const f of files) {
    const type = TYPES[path.extname(f)];
    if (!type) throw new Error(`Unknown file type: ${f}`);
    paths[f.split(path.sep).join('/')] = { id: await put(key, fs.readFileSync(path.join(dir, f)), type) };
    console.log(`  ${f} → ${paths[f.split(path.sep).join('/')].id}`);
  }
  // The bundled CLI for agents and scripts, served at /cli.mjs next to the editor.
  await buildCli();
  paths['cli.mjs'] = { id: await put(key, fs.readFileSync(path.join(root, 'dist/cli.mjs')), 'text/javascript') };
  console.log(`  cli.mjs (bundled) → ${paths['cli.mjs'].id}`);
  const manifest = { manifest: 'arweave/paths', version: '0.2.0', index: { path: 'index.html' }, paths };
  // Deploy-Time gives every deploy a new address, even with identical files
  // (signatures are deterministic), so a redeploy never reuses edge-cached URLs.
  const id = await put(key, new TextEncoder().encode(JSON.stringify(manifest)), 'application/x.arweave-manifest+json',
    [{ name: 'Type', value: 'editor' }, { name: 'Deploy-Time', value: String(Date.now()) }]);
  const workerFile = path.join(root, 'worker/src/index.js');
  fs.writeFileSync(workerFile, fs.readFileSync(workerFile, 'utf8').replace(/EDITOR_TX = '[^']*'/, `EDITOR_TX = '${id}'`));
  console.log(`editor: https://arweave.net/${id}/\nworker/src/index.js updated: run \`cd worker && npx wrangler deploy\` to serve it on permapath.link.`);
} else {
  console.error('usage: node scripts/deploy.mjs resolver|editor');
  process.exit(1);
}
