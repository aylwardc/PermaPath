// The permapath.link Worker, with fetch stubbed (offline).
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { EDITOR_TX } from '../worker/src/index.js';

function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url));
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const req = (path, method = 'GET') => new Request(`https://permapath.link${path}`, { method });

test('serves the editor index and files from the current editor TX', async () => {
  const stub = stubFetch(() => new Response('<html>', { headers: { 'content-type': 'text/html' } }));
  try {
    let res = await worker.fetch(req('/'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html');
    assert.equal(await res.text(), '<html>');
    assert.equal(stub.calls[0].url, `https://arweave.net/${EDITOR_TX}/`);
    assert.deepEqual(stub.calls[0].init.cf, { cacheEverything: true, cacheTtlByStatus: { '200-299': 86400, '300-599': 0 } }, 'errors are never cached');

    res = await worker.fetch(req('/vendor/qrcode.mjs'));
    assert.equal(stub.calls[1].url, `https://arweave.net/${EDITOR_TX}/vendor/qrcode.mjs`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    stub.restore();
  }
});

test('HEAD returns headers only', async () => {
  const stub = stubFetch(() => new Response('body', { headers: { 'content-type': 'text/css' } }));
  try {
    const res = await worker.fetch(req('/styles.css', 'HEAD'));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '');
  } finally {
    stub.restore();
  }
});

test('falls back to the next gateway when one refuses', async () => {
  const stub = stubFetch((url) => (url.startsWith('https://arweave.net/')
    ? new Response('blocked', { status: 403 })
    : new Response('ok', { headers: { 'content-type': 'text/html' } })));
  try {
    const res = await worker.fetch(req('/'));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
    assert.equal(stub.calls[1].url, `https://turbo-gateway.com/${EDITOR_TX}/`);
  } finally {
    stub.restore();
  }
});

test('maps upstream errors and rejects other methods', async () => {
  const stub = stubFetch((url) => {
    if (url.endsWith('/missing')) return new Response('', { status: 404 });
    if (url.endsWith('/broken')) return new Response('', { status: 500 });
    if (url.endsWith('/nope.html')) return new Response('', { status: url.startsWith('https://arweave.net/') ? 403 : 404 });
    if (url.endsWith('/half')) return new Response('', { status: url.startsWith('https://ardrive.net/') ? 500 : 404 });
    throw new Error('network down');
  });
  try {
    assert.equal((await worker.fetch(req('/missing'))).status, 404);
    const nope = await worker.fetch(req('/nope.html'));
    assert.equal(nope.status, 404, 'arweave.net blocks Workers with 403; the rest saying 404 means not found');
    assert.equal(nope.headers.get('cache-control'), 'no-store');
    assert.equal((await worker.fetch(req('/half'))).status, 502, 'a gateway error is not "not found"');
    const broken = await worker.fetch(req('/broken'));
    assert.equal(broken.status, 502);
    assert.match(await broken.text(), /arweave\.net 500, turbo-gateway\.com 500, ardrive\.net 500, arweave\.net 500/, 'tries every gateway twice');
    assert.equal((await worker.fetch(req('/down'))).status, 502);
    assert.equal((await worker.fetch(req('/', 'POST'))).status, 405);
    assert.equal(stub.calls.length, 30);
  } finally {
    stub.restore();
  }
});

test('health endpoint reports the editor TX without fetching', async () => {
  const stub = stubFetch(() => { throw new Error('should not fetch'); });
  try {
    const res = await worker.fetch(req('/health'));
    assert.deepEqual(await res.json(), { status: 'ok', editor: EDITOR_TX });
  } finally {
    stub.restore();
  }
});

test('api: relays GraphQL and uploads to fixed upstreams only', async () => {
  const stub = stubFetch((url) => new Response(`from ${url}`, { headers: { 'content-type': 'application/json' } }));
  try {
    const post = (path, body = '{}') => worker.fetch(new Request(`https://permapath.link${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } }));
    let res = await post('/api/graphql/goldsky', '{"query":"{x}"}');
    assert.equal(await res.text(), 'from https://arweave-search.goldsky.com/graphql');
    assert.equal(stub.calls[0].init.method, 'POST');
    res = await post('/api/upload', 'bytes');
    assert.equal(await res.text(), 'from https://upload.ardrive.io/v1/tx');
    assert.equal((await post('/api/graphql/evil')).status, 404);
    assert.equal((await post('/api/anything')).status, 404);
    assert.equal((await worker.fetch(req('/api/graphql/goldsky'))).status, 404, 'GET is not relayed');
    assert.equal((await post('/api/upload', 'x'.repeat(300 * 1024))).status, 413);
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test('api: raw data tries gateways in order', async () => {
  const stub = stubFetch((url) => (url.startsWith('https://arweave.net/') ? new Response('', { status: 403 }) : new Response('data')));
  try {
    const res = await worker.fetch(req(`/api/raw/${'A'.repeat(43)}`));
    assert.equal(await res.text(), 'data');
    assert.equal(stub.calls[1].url, `https://turbo-gateway.com/raw/${'A'.repeat(43)}`);
    assert.equal((await worker.fetch(req('/api/raw/short'))).status, 404);
  } finally {
    stub.restore();
  }
});

test('api: upload relay falls back to up.arweave.net on 402/5xx', async () => {
  const stub = stubFetch((url) => (url.startsWith('https://upload.ardrive.io')
    ? new Response('payment required', { status: 402 })
    : new Response('{"bundle-status":"complete"}', { headers: { 'content-type': 'application/json' } })));
  try {
    const res = await worker.fetch(new Request('https://permapath.link/api/upload', { method: 'POST', body: 'bytes' }));
    assert.equal(res.status, 200);
    assert.deepEqual(stub.calls.map((c) => c.url), ['https://upload.ardrive.io/v1/tx', 'https://up.arweave.net/tx']);
  } finally {
    stub.restore();
  }
});

// ---------- scan counts: the real ScanCounter on Node's SQLite ----------

const { DatabaseSync } = await import('node:sqlite');
const { ScanCounter } = await import('../worker/src/index.js');

// A Durable Object namespace with one in-memory object, shaped like Cloudflare's.
function fakeScans() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec: (query, ...params) => {
      const stmt = db.prepare(query);
      const rows = /^\s*select/i.test(query) ? stmt.all(...params) : (stmt.run(...params), []);
      return { toArray: () => rows };
    },
  };
  const counter = new ScanCounter({ storage: { sql } });
  return { idFromName: (n) => n, get: () => ({ fetch: (u) => counter.fetch(new Request(u)) }) };
}

test('api: counts scans per link and reports them', async () => {
  const env = { SCANS: fakeScans() };
  const A = 'A'.repeat(43), B = 'B'.repeat(43), C = 'C'.repeat(43);
  const scan = (l) => worker.fetch(new Request(`https://permapath.link/api/scan?l=${l}`, { method: 'POST' }), env);
  for (const l of [A, A, A, B]) assert.equal((await scan(l)).status, 204);
  assert.equal((await scan('short')).status, 400);
  assert.equal((await worker.fetch(req(`/api/scan?l=${A}`), env)).status, 405, 'scans are POSTs (sendBeacon)');

  let res = await worker.fetch(req(`/api/scans?l=${A},${B},${C}`), env);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await res.json(), { counts: { [A]: 3, [B]: 1, [C]: 0 } });
  assert.equal((await worker.fetch(req('/api/scans?l=nope'), env)).status, 400);
  assert.equal((await worker.fetch(req(`/api/scans?l=${Array(101).fill(A).map((x, i) => x.slice(0, 40) + String(i).padStart(3, '0')).join(',')}`), env)).status, 400);

  res = await (await worker.fetch(req(`/api/scans/${A}`), env)).json();
  assert.equal(res.total, 3);
  assert.deepEqual(res.days, [{ day: new Date().toISOString().slice(0, 10), n: 3 }]);
  assert.equal((await (await worker.fetch(req(`/api/scans/${C}`), env)).json()).total, 0);

  res = await (await worker.fetch(req('/api/scans/summary'), env)).json();
  assert.equal(res.scans, 4);
  assert.equal(res.links, 2);
  assert.equal(res.days[0].scans, 4);
});

test('api: scan endpoints say so when counting is not configured', async () => {
  assert.equal((await worker.fetch(new Request(`https://permapath.link/api/scan?l=${'A'.repeat(43)}`, { method: 'POST' }))).status, 503);
});

// ---------- feature suggestions ----------

const { SuggestionBox } = await import('../worker/src/index.js');
function fakeBox() {
  const db = new DatabaseSync(':memory:');
  const sql = { exec: (q, ...p) => { const st = db.prepare(q); const rows = /^\s*select/i.test(q) ? st.all(...p) : (st.run(...p), []); return { toArray: () => rows }; } };
  const box = new SuggestionBox({ storage: { sql } });
  return { idFromName: (n) => n, get: () => ({ fetch: (u, init) => box.fetch(new Request(u, init)) }) };
}

test('api: suggestions are accepted, rate limited, and only readable with the admin key', async () => {
  const env = { SUGGESTIONS: fakeBox(), SUGGEST_ADMIN_KEY: 'k'.repeat(32) };
  const suggest = (body, ip = '1.2.3.4') => worker.fetch(new Request('https://permapath.link/api/suggest', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
  }), env);
  let res = await suggest({ text: 'Please add NFC tags too', email: 'a@b.co', source: 'mcp' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal((await suggest({ text: 'hi' })).status, 400, 'too short');
  assert.equal((await suggest({ text: 'Fine idea', email: 'not-an-email' })).status, 400);
  assert.deepEqual(await (await suggest({ text: 'spam spam spam', website: 'x' })).json(), { ok: true }, 'honeypot pretends to accept');
  for (let i = 0; i < 4; i++) assert.equal((await suggest({ text: `idea number ${i}` })).status, 200);
  assert.equal((await suggest({ text: 'one more idea' })).status, 429, 'five per hour per sender');
  assert.equal((await suggest({ text: 'from someone else' }, '5.6.7.8')).status, 200);

  assert.equal((await worker.fetch(req('/api/suggestions'), env)).status, 404, 'hidden without the key');
  const list = async (after = 0) => (await (await worker.fetch(new Request(`https://permapath.link/api/suggestions?after=${after}`, { headers: { authorization: `Bearer ${'k'.repeat(32)}` } }), env)).json()).suggestions;
  const all = await list();
  assert.equal(all.length, 6);
  assert.deepEqual({ text: all[0].text, email: all[0].email, source: all[0].source }, { text: 'Please add NFC tags too', email: 'a@b.co', source: 'mcp' });
  assert.equal(all[0].who, undefined, 'the sender hash is never returned');
  assert.equal((await list(all[4].id)).length, 1);
});
