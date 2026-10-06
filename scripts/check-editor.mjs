// Run before deploying the Worker: refuses unless a gateway the Worker can use
// already serves the editor named in worker/src/index.js. arweave.net blocks
// requests from Cloudflare Workers, so a check against arweave.net alone isn't
// enough (on 2026-10-05 that let permapath.link serve errors for a few minutes).
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');
const tx = src.match(/EDITOR_TX = '([^']+)'/)[1];
const gateways = JSON.parse(src.match(/const GATEWAYS = (\[[^\]]*\])/)[1].replace(/'/g, '"')).filter((g) => !g.includes('arweave.net'));
const files = ['', 'app.js', 'styles.css', 'config.js'];

for (const gateway of gateways) {
  const results = await Promise.all(files.map(async (f) => {
    try {
      return (await fetch(`${gateway}/${tx}/${f}`, { signal: AbortSignal.timeout(15_000) })).ok;
    } catch {
      return false;
    }
  }));
  if (results.every(Boolean)) {
    console.log(`editor ${tx} is served by ${new URL(gateway).host}; OK to deploy the Worker.`);
    process.exit(0);
  }
}
console.error(`editor ${tx} isn't served by ${gateways.map((g) => new URL(g).host).join(' or ')} yet. Wait a few minutes and try again.`);
process.exit(1);
