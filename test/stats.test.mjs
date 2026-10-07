import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, report } from '../scripts/stats.mjs';

const now = Date.parse('2026-10-20T12:00:00Z');
const node = (ownerKey, tags) => ({ id: `${ownerKey}-${Math.random()}`, ownerKey, tags });
const ago = (days) => String(now - days * 864e5);

test('stats leave out test keys and count recent activity', () => {
  const links = [
    node('alice', { Destination: 'https://alice.example.net/menu', Seq: ago(2), Count: 'true' }),
    node('alice', { Destination: 'https://arweave.net/x', Kind: 'page', Seq: ago(40) }),
    node('bob', { Destination: 'https://bob.example.net/', Kind: 'locked', Seq: ago(10) }),
    node('tester', { Destination: 'https://example.com/?pp=1', Seq: ago(1) }),
    node('tester', { Destination: 'https://arweave.net/page', Kind: 'page', Seq: ago(1) }), // same test key: excluded too
  ];
  const updates = [node('alice', { Link: 'x', Seq: ago(1) }), node('tester', { Link: 'y', Seq: ago(1) })];
  const scans = { scans: 12, links: 2, days: [{ day: '2026-10-19', scans: 5 }, { day: '2026-09-01', scans: 7 }] };
  const s = summarize({ links, updates, scans, now });
  assert.deepEqual(s.links, { total: 3, last7: 1, last30: 2 });
  assert.deepEqual(s.changes, { total: 1, last7: 1, last30: 1 });
  assert.deepEqual(s.keys, { total: 2, active30: 2 });
  assert.deepEqual(s.tests, { links: 2, keys: 1 });
  assert.deepEqual(s.kinds, { 'web address': 1, page: 1, locked: 1 });
  assert.equal(s.countingScans, 1);
  assert.deepEqual(s.scans, { total: 12, linksScanned: 2, last7: 5 });
  assert.match(report(s, new Date(now)), /Links created: +3 total · 1 this week · 2 in 30 days/);
});
