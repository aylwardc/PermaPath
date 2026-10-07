// The MCP server, against the fake Arweave, and over real stdio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createFakeArweave } from './fake-arweave.mjs';
import { createServer } from '../mcp/server.mjs';
import { generateKey, loadKey } from '../lib/permapath.js';

const call = async (server, name, args = {}) => (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;

test('without a key: read-only tools only', async () => {
  const server = createServer();
  const init = await server.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['get_link', 'get_scans', 'get_qr_svg']);
  const r = await call(server, 'create_link', { destination: 'https://example.com/' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /needs a PermaPath key/);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 3, method: 'nope' })).error.code, -32601);
});

test('with a key: create, look up, change, list, QR', async () => {
  const fake = createFakeArweave();
  const restore = fake.installNode();
  try {
    const server = createServer({ key: await loadKey(generateKey()) });
    assert.ok(server.tools.includes('create_link'));
    let r = await call(server, 'create_link', { destination: 'example.com/menu', name: 'Menu' });
    assert.ok(!r.isError, r.content[0].text);
    const { id, url } = r.structuredContent;
    assert.match(url, /\?l=[A-Za-z0-9_-]{43}$/);

    r = await call(server, 'get_link', { link_id: id });
    assert.equal(r.structuredContent.destination, 'https://example.com/menu');
    assert.equal(r.structuredContent.counting_scans, true);

    r = await call(server, 'update_link', { link_id: id, destination: 'https://example.com/menu-v2', off_at: '2030-01-01T00:00:00Z', message: 'Closed' });
    assert.ok(!r.isError, r.content[0].text);
    r = await call(server, 'get_link', { link_id: id });
    assert.equal(r.structuredContent.destination, 'https://example.com/menu-v2');
    assert.equal(r.structuredContent.turns_off_at, '2030-01-01T00:00:00.000Z');
    assert.equal(r.structuredContent.history.length, 2);

    r = await call(server, 'update_link', { link_id: id, on: false });
    assert.equal((await call(server, 'get_link', { link_id: id })).structuredContent.status, 'off');

    r = await call(server, 'list_links');
    assert.deepEqual(r.structuredContent.links.map((l) => l.name), ['Menu']);
    r = await call(server, 'get_qr_svg', { link_id: id });
    assert.match(r.content[0].text, /^<svg /);
    r = await call(server, 'get_scans', { link_id: id });
    assert.equal(r.structuredContent.total, 0);
    r = await call(server, 'create_page', { title: 'If you found this bike', text: 'Call 555-0100.' });
    assert.ok(!r.isError && r.structuredContent.pageUrl, r.content[0].text);
    r = await call(server, 'get_link', { link_id: 'x' });
    assert.equal(r.isError, true);
    assert.equal(fake.passedThrough.size, 0, [...fake.passedThrough].join());
  } finally {
    restore();
  }
});

test('speaks newline-delimited JSON-RPC over stdio', async () => {
  const child = spawn(process.execPath, ['mcp/bin.mjs'], { env: { ...process.env, PERMAPATH_KEY: '' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  for (let i = 0; i < 50 && lines.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  child.stdin.end();
  assert.equal(lines[0].result.serverInfo.name, 'permapath');
  assert.equal(lines[1].id, 2);
  assert.ok(lines[1].result.tools.length >= 3);
});
