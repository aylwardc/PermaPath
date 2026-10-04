// Bundles cli/permapath.mjs (and the editor modules it uses) into one file,
// dist/cli.mjs, published with the editor at /cli.mjs so agents can
// download and run it: curl -fsSL https://permapath.link/cli.mjs -o permapath.mjs
import { build } from 'esbuild';
import fs from 'node:fs';

export async function buildCli() {
  await build({
    entryPoints: ['cli/permapath.mjs'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: true,
    banner: { js: `// PermaPath CLI, bundled ${new Date().toISOString().slice(0, 10)}. Requires Node.js 22+. Run: node cli.mjs help\n// Includes QR Code Generator for JavaScript, Copyright (c) 2009 Kazuhiko Arase, MIT license.` },
    outfile: 'dist/cli.mjs',
  });
  return fs.statSync('dist/cli.mjs').size;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`dist/cli.mjs: ${(await buildCli()) / 1024 | 0} KiB`);
}
