// The single-file CLI agents download (dist/cli.mjs, served at /cli.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildCli } from '../scripts/build-cli.mjs';

test('bundled CLI is small, self-contained and runs from any directory', async () => {
  const size = await buildCli();
  assert.ok(size < 90 * 1024, `bundle is ${size} bytes (free upload limit is ~100 KiB)`);
  // Copy it somewhere with no repo or node_modules, like an agent would.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cli-'));
  const cli = path.join(dir, 'permapath.mjs');
  fs.copyFileSync('dist/cli.mjs', cli);
  const run = (...args) => execFileSync('node', [cli, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, PERMAPATH_KEY: '' } });
  assert.match(run('help'), /Usage: permapath/);
  assert.match(run('keygen').trim(), /^[1-9A-HJ-NP-Za-km-z]{40,44}$/);
  assert.match(run('qr', 'X'.repeat(43)), /^<svg /);
  assert.ok(!fs.readFileSync(cli, 'utf8').includes('from"../'), 'no relative imports left');
  fs.rmSync(dir, { recursive: true });
});
