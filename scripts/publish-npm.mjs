// Builds permapath and permapath-mcp and stages them on npm for Chris to
// approve (npmjs.com → Staged Packages, with his 2FA) before they go live.
//   npm run publish:npm            (reads NPM_STAGE_TOKEN, a stage-only token, from the untracked .env)
//   npm run publish:npm -- --dry   (build and show what would be published)
//   npm run publish:npm -- --direct  (publish directly with NPM_TOKEN; only needed for a brand-new
//                                    package, since staging needs the package to exist. Both were
//                                    first published directly on 2026-10-07.)
// The token goes into a temporary npmrc that's deleted afterwards; it is never
// printed or written into the repo. Staging needs npm 11.15+, so it runs the latest npm via npx.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildNpm, VERSION } from './build-npm.mjs';

const dry = process.argv.includes('--dry');
const direct = process.argv.includes('--direct');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
await buildNpm();
const token = direct ? process.env.NPM_TOKEN : process.env.NPM_STAGE_TOKEN;
if (!dry && !token) throw new Error(`${direct ? 'NPM_TOKEN' : 'NPM_STAGE_TOKEN'} is not set (add it to .env).`);
const npmrc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-npm-')), '.npmrc');
fs.writeFileSync(npmrc, token ? `//registry.npmjs.org/:_authToken=${token}\n` : '', { mode: 0o600 });
try {
  for (const name of ['permapath', 'permapath-mcp']) {
    const [cmd, args] = direct || dry
      ? ['npm', ['publish', '--access', 'public', ...(dry ? ['--dry-run'] : [])]]
      : ['npx', ['-y', 'npm@latest', 'stage', 'publish', '--access', 'public']];
    execFileSync(cmd, args, { cwd: path.join(root, 'dist/npm', name), stdio: 'inherit', env: { ...process.env, NPM_CONFIG_USERCONFIG: npmrc } });
    console.log(`${dry ? 'Would publish' : direct ? 'Published' : 'Staged'} ${name}@${VERSION}`);
  }
  if (!dry && !direct) {
    console.log('Approve them at https://www.npmjs.com → Staged Packages (needs your 2FA code); they go live once approved.');
  }
} finally {
  fs.rmSync(path.dirname(npmrc), { recursive: true, force: true });
}
