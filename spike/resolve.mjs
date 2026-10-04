// Spike: run the resolver algorithm against several GraphQL endpoints until
// each link resolves to its owner's latest update. Logs time-to-visible.
import fs from 'node:fs';

const ENDPOINTS = ['https://arweave.net/graphql', 'https://arweave-search.goldsky.com/graphql'];
const results = JSON.parse(fs.readFileSync('results.json', 'utf8'));

async function gql(endpoint, query, variables) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data.transactions.edges.map((e) => e.node);
}

const tagsOf = (node) => Object.fromEntries(node.tags.map((t) => [t.name, t.value]));

// The resolver: genesis by id gives the owner; then only that owner's updates count.
async function resolve(endpoint, linkId) {
  const [genesis] = await gql(endpoint,
    `query($ids:[ID!]){ transactions(ids:$ids){ edges{ node{ id owner{address} tags{name value} } } } }`,
    { ids: [linkId] });
  if (!genesis) return { state: 'genesis-missing' };
  const owner = genesis.owner.address;
  const updates = await gql(endpoint,
    `query($link:[String!]!,$owner:[String!]){ transactions(first:100, owners:$owner,
       tags:[{name:"Link",values:$link}]){ edges{ node{ id owner{address} tags{name value} } } } }`,
    { link: [linkId], owner: [owner] });
  const candidates = [genesis, ...updates].map(tagsOf);
  const latest = candidates.reduce((a, b) => (Number(b.Seq) > Number(a.Seq) ? b : a));
  const unfiltered = await gql(endpoint,
    `query($link:[String!]!){ transactions(first:100, tags:[{name:"Link",values:$link}]){ edges{ node{ id } } } }`,
    { link: [linkId] });
  return { state: 'ok', owner, destination: latest.Destination, ownerUpdates: updates.length, allUpdates: unfiltered.length };
}

const pending = new Set();
for (const r of results) for (const ep of ENDPOINTS) pending.add(`${r.kind}|${ep}`);
const start = Date.now();
while (pending.size && Date.now() - start < 20 * 60_000) {
  for (const key of [...pending]) {
    const [kind, ep] = key.split('|');
    const r = results.find((x) => x.kind === kind);
    try {
      const out = await resolve(ep, r.genesis.id);
      const done = out.destination === 'https://example.com/v1' && out.allUpdates >= 2;
      const age = Math.round((Date.now() - r.postedAt) / 1000);
      console.log(`${age}s ${kind} ${new URL(ep).host} ${JSON.stringify(out)}${done ? ' DONE' : ''}`);
      if (done) pending.delete(key);
    } catch (e) {
      console.log(`${kind} ${new URL(ep).host} error ${e.message.slice(0, 200)}`);
    }
  }
  if (pending.size) await new Promise((r) => setTimeout(r, 20_000));
}
console.log(pending.size ? `TIMED OUT: ${[...pending].join(', ')}` : 'ALL RESOLVED');
