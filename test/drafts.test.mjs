import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDraft, draftUrl, draftOptions } from '../editor/drafts.js';

test('draft links round-trip and ignore what they should', () => {
  assert.equal(parseDraft(''), null);
  assert.equal(parseDraft('?edit=short'), null, 'edit needs a real link ID');
  const d = { mode: 'new', type: 'event', event_name: 'Bike swap', start: '2026-11-01T10:00', location: '12 Main St', count: false,
    ios: 'https://apps.apple.com/x', qr: { label: 'Scan me', frame: 'bar', icon: 'calendar' } };
  const url = draftUrl(d);
  assert.match(url, /^https:\/\/permapath\.link\/\?new&type=event&/);
  assert.deepEqual(parseDraft(new URL(url).search), d);
  const e = parseDraft(`?edit=${'A'.repeat(43)}&dest=example.com/v2&rules=${encodeURIComponent('[{"days":"12345","from":"11:00","to":"https://x.example/"}]')}&type=nope`);
  assert.equal(e.mode, 'edit');
  assert.equal(e.linkId, 'A'.repeat(43));
  assert.equal(e.type, undefined, 'unknown types are dropped');
  assert.equal(e.rules.length, 1);
  assert.equal(parseDraft('?new&rules=notjson').rules, undefined);
});

test('draft options become More options state', () => {
  assert.deepEqual(draftOptions({ count: true, off_at: '2030-01-01T00:00:00Z', message: 'Bye', ios: 'https://a.example/', rules: [{ to: 'https://b.example/', from: '09:00' }] }), {
    count: true, offAt: Date.parse('2030-01-01T00:00:00Z'), message: 'Bye',
    routes: [{ os: 'ios', to: 'https://a.example/' }, { to: 'https://b.example/', from: '09:00' }],
  });
  assert.deepEqual(draftOptions({ off_at: 'whenever' }), {});
});
