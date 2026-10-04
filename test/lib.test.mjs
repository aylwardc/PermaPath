// Library and CLI basics (offline).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKey, loadKey, createLink, createBatch, linkUrl, linkQrSvg } from '../lib/permapath.js';
import { RESOLVER_BASE } from '../editor/config.js';

test('linkUrl and QR SVG use the current resolver', () => {
  assert.equal(linkUrl('X'.repeat(43)), `${RESOLVER_BASE}?l=${'X'.repeat(43)}`);
  assert.match(linkQrSvg('X'.repeat(43)), /^<svg [^>]*viewBox="0 0 53 53"/);
});

test('createLink and createBatch validate input before touching the network', async () => {
  const key = await loadKey(generateKey());
  await assert.rejects(createLink(key, { destination: 'javascript:alert(1)' }), /http and https/);
  await assert.rejects(createBatch(key, { count: 0 }), /count must be/);
});

test('CLI prints help and fails clearly without a key', () => {
  assert.match(execFileSync('node', ['cli/permapath.mjs', 'help'], { encoding: 'utf8' }), /Usage: permapath/);
  assert.match(execFileSync('node', ['cli/permapath.mjs', 'keygen'], { encoding: 'utf8' }).trim(), /^[1-9A-HJ-NP-Za-km-z]{40,44}$/);
  assert.throws(() => execFileSync('node', ['cli/permapath.mjs', 'list'], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PERMAPATH_KEY: '' } }),
    (err) => /No key/.test(err.stderr));
});

test('CLI network: permapath.link only, falling back to direct services if it is down', async () => {
  const { listLinks } = await import('../lib/permapath.js');
  const key = await loadKey(generateKey());
  const empty = () => new Response(JSON.stringify({ data: { transactions: { pageInfo: { hasNextPage: false }, edges: [] } } }), { headers: { 'content-type': 'application/json' } });
  const original = globalThis.fetch;
  const hosts = [];
  try {
    globalThis.fetch = async (url) => { hosts.push(new URL(url).host); return empty(); };
    assert.deepEqual(await listLinks(key), []);
    assert.deepEqual([...new Set(hosts)], ['permapath.link']);

    hosts.length = 0;
    globalThis.fetch = async (url) => {
      hosts.push(new URL(url).host);
      if (new URL(url).host === 'permapath.link') throw new TypeError('fetch failed');
      return empty();
    };
    assert.deepEqual(await listLinks(key), []);
    assert.ok(hosts.includes('arweave.net'), 'fell back to direct endpoints');
  } finally {
    globalThis.fetch = original;
  }
});

test('password options validate before touching the network', async () => {
  const { lockLink } = await import('../lib/permapath.js');
  const key = await loadKey(generateKey());
  await assert.rejects(createLink(key, { password: 'x' }), /needs a destination/);
  await assert.rejects(lockLink(key, 'X'.repeat(43), {}), /password is required/);
});
