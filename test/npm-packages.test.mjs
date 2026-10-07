// The npm packages build into runnable, dependency-free bundles.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { buildNpm, VERSION } from '../scripts/build-npm.mjs';
import { SERVER_INFO } from '../mcp/server.mjs';

test('permapath and permapath-mcp build and run', async () => {
  await buildNpm();
  assert.equal(SERVER_INFO.version, VERSION, 'the MCP server reports the package version');
  for (const [name, bin] of [['permapath', 'cli.mjs'], ['permapath-mcp', 'server.mjs']]) {
    const dir = new URL(`../dist/npm/${name}/`, import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(new URL('package.json', dir), 'utf8'));
    assert.equal(pkg.name, name);
    assert.equal(pkg.version, VERSION);
    assert.equal(pkg.dependencies, undefined, 'no runtime dependencies');
    const code = fs.readFileSync(new URL(bin, dir), 'utf8');
    assert.equal(code.match(/^#!/gm)?.length, 1, 'exactly one shebang');
    assert.doesNotMatch(code, /PERMAPATH_KEY=['"][1-9A-HJ-NP-Za-km-z]{40,}/, 'no keys baked in');
  }
  assert.match(execFileSync(process.execPath, [new URL('../dist/npm/permapath/cli.mjs', import.meta.url).pathname, 'help'], { encoding: 'utf8' }), /Usage: permapath/);
});
