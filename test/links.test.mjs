import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDestination, linkTags, updateTags, buildLinks, overlayPending, linkStatus, linksToCsv } from '../editor/links.js';

const node = (id, tags) => ({ id, owner: 'o', tags: Object.fromEntries(tags.map((t) => [t.name, t.value])) });

test('normalizeDestination', () => {
  assert.equal(normalizeDestination('example.com/menu'), 'https://example.com/menu');
  assert.equal(normalizeDestination(' http://a.example/x?y=1 '), 'http://a.example/x?y=1');
  assert.throws(() => normalizeDestination('javascript:alert(1)'));
  assert.throws(() => normalizeDestination('not a url'));
  assert.throws(() => normalizeDestination('ftp://example.com'));
  assert.throws(() => normalizeDestination('https://example.com/' + 'x'.repeat(2000)));
});

test('buildLinks takes the highest Seq and keeps created time', () => {
  const links = buildLinks([
    node('L1', linkTags({ destination: 'https://a.example/0', name: 'One', seq: 100 })),
    node('u2', updateTags({ linkId: 'L1', destination: 'https://a.example/2', name: 'One', seq: 300 })),
    node('u1', updateTags({ linkId: 'L1', destination: 'https://a.example/1', name: 'One', seq: 200 })),
    node('L2', linkTags({ destination: 'https://b.example/', seq: 150 })),
    node('u3', updateTags({ linkId: 'L2', destination: 'https://b.example/', seq: 160, disabled: true })),
    node('orphan', updateTags({ linkId: 'nope', destination: 'https://c.example/', seq: 999 })),
    node('bad', [{ name: 'App-Name', value: 'PermaPath' }, { name: 'Type', value: 'link' }, { name: 'Seq', value: 'abc' }]),
  ]);
  assert.deepEqual(links.map((l) => l.id), ['L2', 'L1']);
  assert.equal(links[1].destination, 'https://a.example/2');
  assert.equal(links[1].created, 100);
  assert.equal(links[0].disabled, true);
  assert.equal(links[0].name, '');
});

test('buildLinks ignores other App-Versions and carries Resolver forward', () => {
  const v2 = updateTags({ linkId: 'L1', destination: 'https://evil.example/', seq: 500 })
    .map((t) => (t.name === 'App-Version' ? { ...t, value: '2' } : t));
  const links = buildLinks([
    node('L1', linkTags({ destination: 'https://a.example/', seq: 100 })),
    node('u1', updateTags({ linkId: 'L1', destination: 'https://a.example/', resolver: 'R'.repeat(43), seq: 200 })),
    node('u2', v2),
  ]);
  assert.equal(links[0].destination, 'https://a.example/');
  assert.equal(links[0].resolver, 'R'.repeat(43));
  assert.ok(updateTags({ linkId: 'L1', destination: 'https://a.example/', resolver: links[0].resolver, seq: 300 })
    .some((t) => t.name === 'Resolver'));
});

test('overlayPending shows unindexed writes and drops indexed ones', () => {
  const live = [{ id: 'L1', created: 1, seq: 5, destination: 'https://a.example/', name: '', disabled: false }];
  const pending = [
    { id: 'L1', created: 1, seq: 5, destination: 'https://a.example/', postedAt: 0 }, // indexed
    { id: 'L2', created: 9, seq: 9, destination: 'https://new.example/', postedAt: 0 }, // new link
  ];
  let r = overlayPending(live, pending);
  assert.deepEqual(r.outstanding.map((p) => p.id), ['L2']);
  assert.equal(r.links[0].id, 'L2');
  assert.ok(r.links[0].unindexed);
  assert.equal(r.links[1].pending, undefined);

  r = overlayPending(live, [{ id: 'L1', created: 1, seq: 7, destination: 'https://b.example/', postedAt: 0 }]);
  assert.equal(r.links[0].destination, 'https://a.example/');
  assert.equal(r.links[0].pending.destination, 'https://b.example/');
});

test('links without a destination are created turned off and read back as not set up', () => {
  const tags = linkTags({ name: 'Sticker 01', seq: 100 });
  assert.ok(!tags.some((t) => t.name === 'Destination'));
  assert.ok(tags.some((t) => t.name === 'Disabled' && t.value === 'true'));
  const [link] = buildLinks([node('L1', tags)]);
  assert.equal(link.destination, '');
  assert.equal(linkStatus(link), 'not set up');

  const set = buildLinks([node('L1', tags), node('u1', updateTags({ linkId: 'L1', destination: 'https://a.example/', name: 'Sticker 01', disabled: false, seq: 200 }))]);
  assert.equal(linkStatus(set[0]), 'live');
  assert.equal(linkStatus({ ...set[0], disabled: true }), 'off');
  assert.ok(updateTags({ linkId: 'L1', destination: '', seq: 300 }).some((t) => t.name === 'Disabled'));
});

test('linksToCsv quotes, guards formulas, and lists what to encode', () => {
  const url = (id) => `https://arweave.net/R?l=${id}`;
  const csv = linksToCsv([
    { id: 'A', name: 'Menu, "lunch"', destination: 'https://a.example/?x=1,2', disabled: false, created: 0 },
    { id: 'B', name: '=HYPERLINK("x")', destination: '', disabled: true, created: 1000 },
  ], url);
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[0], 'name,qr_url,link_id,destination,status,created');
  assert.equal(lines[1], '"Menu, ""lunch""",https://arweave.net/R?l=A,A,"https://a.example/?x=1,2",live,1970-01-01T00:00:00.000Z');
  assert.equal(lines[2], `"'=HYPERLINK(""x"")",https://arweave.net/R?l=B,B,,not set up,1970-01-01T00:00:01.000Z`);
});

test('Kind: page round-trips and is dropped when there is no destination', () => {
  const tags = linkTags({ destination: 'https://arweave.net/' + 'P'.repeat(43), name: 'Menu', kind: 'page', seq: 1 });
  assert.ok(tags.some((t) => t.name === 'Kind' && t.value === 'page'));
  assert.equal(buildLinks([node('L1', tags)])[0].kind, 'page');
  assert.ok(!linkTags({ name: 'x', kind: 'page', seq: 1 }).some((t) => t.name === 'Kind'));
  assert.ok(updateTags({ linkId: 'L1', destination: 'https://a.example/', kind: 'page', seq: 2 }).some((t) => t.name === 'Kind'));
});

test('a broken copy from one search service never hides a good copy from another', async () => {
  const { generateKeyText, loadKey, createDataItem, base64url } = await import('../editor/arweave.js');
  const { fetchLinks } = await import('../editor/links.js');
  const { DataItem } = await import('@dha-team/arbundles');
  const key = await loadKey(generateKeyText());
  const tags = linkTags({ destination: 'https://a.example/', name: 'Kept', seq: 5 });
  const item = await createDataItem(key, tags, '');
  const signature = base64url(new DataItem(Buffer.from(item.bytes)).rawSignature);
  const node = (sig) => ({ cursor: 'c', node: { id: item.id, signature: sig, owner: { address: key.owners[0], key: key.ownerKey }, data: { size: '0' }, block: null, tags } });
  const reply = (edges) => new Response(JSON.stringify({ data: { transactions: { pageInfo: { hasNextPage: false }, edges } } }));
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const isLinkQuery = JSON.parse(init.body).query.includes('"link"');
    if (!isLinkQuery) return reply([]);
    return url.includes('good') ? reply([node(signature)]) : reply([node('<not-found>')]);
  };
  try {
    // The broken service comes last, the order that used to hide the link.
    const links = await fetchLinks(key, ['https://good.example/graphql', 'https://broken.example/graphql']);
    assert.deepEqual(links.map((l) => l.name), ['Kept']);
  } finally {
    globalThis.fetch = original;
  }
});

test('v3 fields round-trip, and updates using them name the current resolver', async () => {
  const { RESOLVER_TX } = await import('../editor/config.js');
  const { checkRoutes, carry } = await import('../editor/links.js');
  const routes = checkRoutes([{ os: 'ios', to: 'apps.apple.com/x' }, { days: '51', from: '11:00', until: '15:00', to: 'example.com/lunch' }]);
  assert.deepEqual(routes, [{ to: 'https://apps.apple.com/x', os: 'ios' }, { to: 'https://example.com/lunch', days: '15', from: '11:00', until: '15:00' }]);
  const v3 = { count: true, message: 'See you next year', offAt: 1_900_000_000_000, routes, tz: 'America/New_York' };

  const created = linkTags({ destination: 'https://a.example/', seq: 1, ...v3 });
  assert.ok(!created.some((t) => t.name === 'Resolver'), 'new links embed the current resolver already');
  const update = updateTags({ linkId: 'L1', destination: 'https://a.example/', seq: 2, ...v3 });
  assert.equal(update.find((t) => t.name === 'Resolver').value, RESOLVER_TX);
  assert.equal(update.find((t) => t.name === 'Time-Zone').value, 'America/New_York');

  const [link] = buildLinks([node('L1', created), node('u1', update)]);
  assert.deepEqual(carry(link), { name: '', destination: 'https://a.example/', disabled: false, resolver: RESOLVER_TX, kind: '', ...v3, design: {} });

  // Turning everything off keeps the resolver (harmless) and drops the tags.
  const plain = updateTags({ linkId: 'L1', ...carry(link), count: false, message: '', offAt: 0, routes: [], seq: 3 });
  assert.deepEqual(plain.map((t) => t.name).filter((n) => ['Count', 'Message', 'Off-At', 'Routes', 'Time-Zone'].includes(n)), []);
  assert.ok(plain.some((t) => t.name === 'Resolver'));
  // Device-only rules need no time zone.
  assert.ok(!linkTags({ destination: 'https://a.example/', seq: 1, routes: [routes[0]], tz: 'UTC' }).some((t) => t.name === 'Time-Zone'));
});

test('Off-At in the past reads as off; bad rules are rejected with a reason', async () => {
  const { checkRoutes } = await import('../editor/links.js');
  assert.equal(linkStatus({ destination: 'https://a.example/', disabled: false, offAt: Date.now() - 1 }), 'off');
  assert.equal(linkStatus({ destination: 'https://a.example/', disabled: false, offAt: Date.now() + 60_000 }), 'live');
  assert.throws(() => checkRoutes([{ to: 'https://a.example/' }]), /needs a device/);
  assert.throws(() => checkRoutes([{ to: 'nope', os: 'ios' }]), /web address/);
  assert.throws(() => checkRoutes([{ to: 'a.example', from: '9am' }]), /09:00/);
  assert.throws(() => checkRoutes([{ to: 'a.example', after: 5, before: 5 }]), /end date/);
  assert.throws(() => checkRoutes(Array(11).fill({ to: 'a.example', os: 'ios' })), /Up to 10/);
  assert.throws(() => checkRoutes(Array(4).fill({ to: `a.example/${'x'.repeat(900)}`, os: 'ios' })), /too long/);
  assert.throws(() => linkTags({ destination: 'https://a.example/', seq: 1, message: 'x'.repeat(201) }), /longer than 200/);
  assert.throws(() => checkRoutes([{ to: 'a.example', days: '0123456' }]), /needs a device/, 'every day, all day is just the destination');
  assert.deepEqual(checkRoutes([{ to: 'a.example', days: '0123456', from: '09:00' }]), [{ to: 'https://a.example/', from: '09:00' }]);
});
