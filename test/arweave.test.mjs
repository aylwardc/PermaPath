// Checks our hand-written ANS-104 items against the reference library (arbundles),
// and that keys round-trip. Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataItem } from '@dha-team/arbundles';
import { generateKeyText, loadKey, createDataItem, base58Decode, base58Encode, serializeTags } from '../editor/arweave.js';

test('base58 round-trips, including leading zeros', () => {
  for (const bytes of [new Uint8Array(32), Uint8Array.from([0, 0, 1, 2, 255]), crypto.getRandomValues(new Uint8Array(32))]) {
    assert.deepEqual(base58Decode(base58Encode(bytes)), bytes);
  }
});

test('generated key text is password-manager sized and loads', async () => {
  const text = generateKeyText();
  assert.ok(text.length >= 40 && text.length <= 44, `length ${text.length}`);
  const key = await loadKey(text);
  assert.equal(key.publicKey.length, 32);
  assert.equal(key.owners.length, 2);
});

test('rejects malformed keys', async () => {
  await assert.rejects(loadKey('not-a-key!'));
  await assert.rejects(loadKey('abc'));
});

test('data item verifies with arbundles and parses back', async () => {
  const key = await loadKey(generateKeyText());
  const tags = [
    { name: 'App-Name', value: 'PermaPath' },
    { name: 'Destination', value: 'https://example.com/ünïcode?' + 'x'.repeat(200) },
    { name: 'Seq', value: String(Date.now()) },
  ];
  const item = await createDataItem(key, tags, '{"hello":"world"}');
  const parsed = new DataItem(Buffer.from(item.bytes));
  assert.equal(parsed.signatureType, 4);
  assert.ok(await parsed.isValid(), 'arbundles says signature is invalid');
  assert.equal(parsed.id, item.id);
  assert.deepEqual(parsed.tags, tags);
  assert.equal(Buffer.from(parsed.rawData).toString(), '{"hello":"world"}');
  assert.equal(parsed.owner, Buffer.from(key.publicKey).toString('base64url'));
});

test('empty tag list serializes to zero bytes', () => {
  assert.equal(serializeTags([]).length, 0);
});

test('empty-body item verifies from its parts; tampering fails', async () => {
  const { verifyDataItem } = await import('../editor/arweave.js');
  const key = await loadKey(generateKeyText());
  const tags = [{ name: 'App-Name', value: 'PermaPath' }, { name: 'Destination', value: 'https://example.com/😀' }];
  const item = await createDataItem(key, tags, '');
  const parsed = new DataItem(Buffer.from(item.bytes));
  const parts = { id: item.id, signature: parsed.signature, ownerKey: key.ownerKey, tags };
  assert.equal(await verifyDataItem(parts), true);
  assert.equal(await verifyDataItem({ ...parts, tags: [tags[0], { ...tags[1], value: 'https://evil.example/' }] }), false);
  assert.equal(await verifyDataItem({ ...parts, tags: [...tags].reverse() }), false);
  assert.equal(await verifyDataItem({ ...parts, ownerKey: (await loadKey(generateKeyText())).ownerKey }), false);
  assert.equal(await verifyDataItem({ ...parts, data: 'x' }), false);
});

test('upload falls back to up.arweave.net when Turbo is down or wants payment, not on bad items', async () => {
  const { upload, UPLOAD_URL, FALLBACK_UPLOAD_URL } = await import('../editor/arweave.js');
  const key = await loadKey(generateKeyText());
  const item = await createDataItem(key, [{ name: 'App-Name', value: 'PermaPath' }], '');
  const original = globalThis.fetch;
  const run = async (turbo) => {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      if (url === UPLOAD_URL) return turbo();
      return new Response(JSON.stringify({ 'bundle-id': 'x', 'bundle-status': 'complete' }), { status: 200 });
    };
    try { return { result: await upload(item), calls }; } catch (err) { return { err, calls }; }
  };
  try {
    let r = await run(() => new Response('pay up', { status: 402 }));
    assert.equal(r.result.id, item.id);
    assert.deepEqual(r.calls, [UPLOAD_URL, FALLBACK_UPLOAD_URL]);
    r = await run(() => { throw new TypeError('fetch failed'); });
    assert.equal(r.result.id, item.id);
    r = await run(() => new Response('bad item', { status: 400 }));
    assert.match(r.err.message, /400/);
    assert.deepEqual(r.calls, [UPLOAD_URL], 'no fallback for a rejected item');
    r = await run(() => new Response(JSON.stringify({ id: 'someone-elses-id' }), { status: 200 }));
    assert.match(r.err.message, /unexpected ID/);
  } finally {
    globalThis.fetch = original;
  }
});
