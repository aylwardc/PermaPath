// Run before deploying the Worker: refuses unless a gateway the Worker can use
// already serves the editor named in worker/src/index.js. arweave.net blocks
// requests from Cloudflare Workers, so a check against arweave.net alone isn't
// enough (on 2026-10-05 that let permapath.link serve errors for a few minutes).
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');
const tx = src.match(/EDITOR_TX = '([^']+)'/)[1];
const gateways = JSON.parse(src.match(/const GATEWAYS = (\[[^\]]*\])/)[1].replace(/'/g, '"')).filter((g) => !g.includes('arweave.net'));
const ok = async (url) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(15_000) })).ok;
  } catch {
    return false;
  }
};

// Every file in the editor's manifest must be served by at least one of the
// Worker's gateways (it tries them in order, per file).
let manifest = null;
for (const gateway of gateways) {
  try {
    const res = await fetch(`${gateway}/raw/${tx}`, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) { manifest = await res.json(); break; }
  } catch { /* next gateway */ }
}
// The gateways fail now and then even for old files, so retry before calling one missing.
async function served(f) {
  for (let round = 0; round < 3; round++) {
    for (const g of gateways) if (await ok(`${g}/${tx}/${f}`)) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}
const files = manifest ? ['', ...Object.keys(manifest.paths)] : null;
const missing = files
  ? (await Promise.all(files.map(async (f) => (await served(f) ? null : f || 'index')))).filter(Boolean)
  : ['the manifest'];
if (!missing.length) {
  console.log(`editor ${tx}: all ${files.length} files served; OK to deploy the Worker.`);
  process.exit(0);
}
console.error(`editor ${tx}: not served yet by ${gateways.map((g) => new URL(g).host).join(' or ')}: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}. Wait a few minutes and try again.`);
process.exit(1);
