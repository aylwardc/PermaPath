// Can records have an empty body, so the resolver can verify signatures from
// GraphQL fields alone (no extra download)? Uploads one, then checks each
// endpoint until it appears and verifies it there.
import { generateKeyText, loadKey, createDataItem, upload, verifyDataItem } from '../editor/arweave.js';

const ENDPOINTS = ['https://frostor.xyz/graphql', 'https://arweave.net/graphql', 'https://arweave-search.goldsky.com/graphql', 'https://permagate.io/graphql'];
const key = await loadKey(generateKeyText());
const tags = [
  { name: 'App-Name', value: 'PermaPath-Spike' },
  { name: 'Type', value: 'empty-body' },
  { name: 'Destination', value: 'https://example.com/ünïcode?a=1&b=😀' },
  { name: 'Seq', value: String(Date.now()) },
];
let item, body = '';
try {
  item = await createDataItem(key, tags, '');
  await upload(item);
  console.log('Turbo accepted a 0-byte body:', item.id);
} catch (e) {
  console.log('0-byte body rejected:', e.message.slice(0, 150));
  body = '-';
  item = await createDataItem(key, tags, body);
  await upload(item);
  console.log('Turbo accepted a 1-byte body:', item.id);
}
const t0 = Date.now();
const pending = new Set(ENDPOINTS);
while (pending.size && Date.now() - t0 < 25 * 60000) {
  for (const ep of [...pending]) {
    const q = `{ transactions(ids:["${item.id}"]){ edges{ node{ id signature owner{ key } data{ size } tags{ name value } } } } }`;
    try {
      const r = await (await fetch(ep, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) })).json();
      const n = r.data?.transactions?.edges?.[0]?.node;
      if (!n) continue;
      const ok = await verifyDataItem({ id: n.id, signature: n.signature, ownerKey: n.owner.key, tags: n.tags, data: body });
      console.log(`${Math.round((Date.now() - t0) / 1000)}s ${new URL(ep).host}: size ${n.data.size}, verifies from GraphQL alone: ${ok}`);
      pending.delete(ep);
    } catch (e) { /* retry */ }
  }
  if (pending.size) await new Promise((r) => setTimeout(r, 15000));
}
if (pending.size) console.log('not seen:', [...pending].join(', '));
