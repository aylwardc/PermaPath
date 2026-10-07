// Builds and publishes permapath and permapath-mcp to npm.
//   npm run publish:npm            (reads NPM_TOKEN from the untracked .env)
//   npm run publish:npm -- --dry   (build and show what would be published)
// The token goes into a temporary npmrc that's deleted afterwards; it is never
// printed or written into the repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildNpm, VERSION } from './build-npm.mjs';

const dry = process.argv.includes('--dry');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
await buildNpm();
const token = process.env.NPM_TOKEN;
if (!dry && !token) throw new Error('NPM_TOKEN is not set (add it to .env).');
const npmrc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-npm-')), '.npmrc');
fs.writeFileSync(npmrc, token ? `//registry.npmjs.org/:_authToken=${token}\n` : '', { mode: 0o600 });
try {
  for (const name of ['permapath', 'permapath-mcp']) {
    const args = ['publish', '--access', 'public', ...(dry ? ['--dry-run'] : [])];
    execFileSync('npm', args, { cwd: path.join(root, 'dist/npm', name), stdio: 'inherit', env: { ...process.env, NPM_CONFIG_USERCONFIG: npmrc } });
    console.log(`${dry ? 'Would publish' : 'Published'} ${name}@${VERSION}`);
  }
} finally {
  fs.rmSync(path.dirname(npmrc), { recursive: true, force: true });
}
