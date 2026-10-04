// Creates real links on Arweave for the resolver browser test. IDs go to
// test/fixtures.json; keys are thrown away. Run once, then wait ~10 min.
import fs from 'node:fs';
import { APP_NAME, generateKeyText, loadKey, createDataItem, upload } from '../editor/arweave.js';

const base = (version = '1') => [{ name: 'App-Name', value: APP_NAME }, { name: 'App-Version', value: version }];
async function post(key, tags, version, body = '') {
  const item = await createDataItem(key, [...base(version), ...tags], body);
  await upload(item);
  return item.id;
}
const link = (key, dest, seq, body) => post(key, [
  { name: 'Type', value: 'link' }, { name: 'Destination', value: dest }, { name: 'Seq', value: String(seq) }, { name: 'Name', value: 'resolver test' },
], '1', body);
const update = (key, id, dest, seq, extra = [], version) => post(key, [
  { name: 'Type', value: 'update' }, { name: 'Link', value: id }, { name: 'Destination', value: dest }, { name: 'Seq', value: String(seq) }, ...extra,
], version);
export const HANDOFF_TX = 'H'.repeat(43);

const owner = await loadKey(generateKeyText());
const attacker = await loadKey(generateKeyText());
const t = Date.now();
const updated = await link(owner, 'https://example.com/?pp=v0', t);
await update(owner, updated, 'https://example.com/?pp=v1', t + 1);
await update(attacker, updated, 'https://example.org/?pp=forged', t + 999999);
const disabled = await link(owner, 'https://example.com/?pp=off', t + 2);
await update(owner, disabled, 'https://example.com/?pp=off', t + 3, [{ name: 'Disabled', value: 'true' }]);
const plain = await link(owner, 'https://example.com/?pp=plain', t + 4);
// Newest record hands off to another resolver page.
const handoff = await link(owner, 'https://example.com/?pp=handoff-v0', t + 5);
await update(owner, handoff, 'https://example.com/?pp=handoff-v0', t + 6, [{ name: 'Resolver', value: HANDOFF_TX }]);
// A future-format (App-Version 2) update must be ignored by this resolver.
const future = await link(owner, 'https://example.com/?pp=future-v1', t + 7);
await update(owner, future, 'https://example.org/?pp=future-v2', t + 8, [], '2');
// Old-style record with a body: the resolver must download it to check the signature.
const withBody = await link(owner, 'https://example.com/?pp=with-body', t + 9, '{"old":"style"}');
const fixtures = { createdAt: new Date().toISOString(), updated, disabled, plain, handoff, future, withBody };
fs.writeFileSync(new URL('./fixtures.json', import.meta.url), JSON.stringify(fixtures, null, 2) + '\n');
console.log(fixtures);
