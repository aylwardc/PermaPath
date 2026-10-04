// Spike: Ed25519 key stored as a 32-byte seed (password-manager friendly).
// Times create → visible and update → visible on arweave.net GraphQL.
import { TurboFactory } from '@ardrive/turbo-sdk';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const GQL = 'https://arweave.net/graphql';
const seedText = bs58.encode(nacl.randomBytes(32));
const kp = nacl.sign.keyPair.fromSeed(bs58.decode(seedText));
const turbo = TurboFactory.authenticated({ privateKey: bs58.encode(kp.secretKey), token: 'solana' });
console.log(`seed (what the user would store): ${seedText.length} chars`);

const post = (tags) => turbo.upload({
  data: 'x',
  dataItemOpts: { tags: [{ name: 'App-Name', value: 'PermaPath-Spike' }, ...tags] },
});

async function count(query, variables) {
  const res = await fetch(GQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  return (await res.json()).data.transactions.edges.length;
}

async function waitFor(label, query, variables) {
  const t0 = Date.now();
  while (Date.now() - t0 < 10 * 60_000) {
    if ((await count(query, variables).catch(() => 0)) > 0) {
      console.log(`${label}: visible after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`${label}: NOT visible after 10 min`);
}

const genesis = await post([{ name: 'Type', value: 'link' }, { name: 'Destination', value: 'https://example.com/a' }, { name: 'Seq', value: '0' }]);
await waitFor('create', `query($ids:[ID!]){transactions(ids:$ids){edges{node{id}}}}`, { ids: [genesis.id] });
for (let seq = 1; seq <= 3; seq++) {
  await post([{ name: 'Type', value: 'update' }, { name: 'Link', value: genesis.id }, { name: 'Destination', value: `https://example.com/${seq}` }, { name: 'Seq', value: String(seq) }]);
  await waitFor(`update ${seq}`, `query($l:[String!]!){transactions(tags:[{name:"Link",values:$l},{name:"Seq",values:["${seq}"]}]){edges{node{id}}}}`, { l: [genesis.id] });
}
