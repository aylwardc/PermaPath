// The test-only fake Arweave answers like the real services do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeArweave } from './fake-arweave.mjs';
import { generateKeyText, loadKey, createDataItem, verifyDataItem, upload, gqlAll } from '../editor/arweave.js';
import { linkTags } from '../editor/links.js';

test('uploads are searchable by ID, owner and tags, verifiable, and downloadable', async () => {
  const fake = createFakeArweave();
  const restore = fake.installNode();
  try {
    const key = await loadKey(generateKeyText());
    const item = await createDataItem(key, linkTags({ destination: 'https://example.com/', name: 'Fake', seq: 1 }), '');
    await upload(item);
    const page = await createDataItem(key, [{ name: 'Content-Type', value: 'text/html' }], '<h1>hi</h1>');
    await upload(page);

    const byId = await gqlAll('https://arweave.net/graphql', { params: '$ids: [ID!]', args: 'ids: $ids' }, { ids: [item.id] });
    assert.equal(byId.length, 1);
    assert.ok(await verifyDataItem({ ...byId[0], tags: byId[0].tagList }), 'signature checks out');
    for (const owners of [[key.owners[0]], [key.owners[1]]]) { // both gateway address styles
      const mine = await gqlAll('https://frostor.xyz/graphql', {
        params: '$owners: [String!], $app: [String!]!',
        args: 'owners: $owners, tags: [{ name: "App-Name", values: $app }, { name: "Type", values: ["link"] }]',
      }, { owners, app: ['PermaPath'] });
      assert.deepEqual(mine.map((n) => n.id), [item.id]);
    }
    const res = await fetch(`https://turbo-gateway.com/${page.id}?check=1`);
    assert.equal(res.headers.get('content-type'), 'text/html');
    assert.equal(await res.text(), '<h1>hi</h1>');
    assert.equal(fake.passedThrough.size, 0);
  } finally {
    restore();
  }
});
