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
    assert.deepEqual(stub.calls[0].init.cf, { cacheEverything: true, cacheTtl: 86400 });

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
    throw new Error('network down');
  });
  try {
    assert.equal((await worker.fetch(req('/missing'))).status, 404);
    const broken = await worker.fetch(req('/broken'));
    assert.equal(broken.status, 502);
    assert.match(await broken.text(), /arweave\.net 500, turbo-gateway\.com 500, ardrive\.net 500/);
    assert.equal((await worker.fetch(req('/down'))).status, 502);
    assert.equal((await worker.fetch(req('/', 'POST'))).status, 405);
    assert.equal(stub.calls.length, 9);
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
