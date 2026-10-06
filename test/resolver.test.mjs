// The resolver's routing rules, run straight from resolver/index.html.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../resolver/index.html', import.meta.url), 'utf8');
const code = html.match(/<script>\s*(\/\/ Routing rules[\s\S]*?)<\/script>/)[1];
const { deviceOs, clock, pick, isOff } = new Function(`${code}; return PP_ROUTING;`)();

const at = (iso) => Date.parse(iso);
const record = (rules, extra = {}) => ({ Destination: 'https://default.example/', Routes: JSON.stringify(rules), ...extra });

test('detects iPhone, iPad (which reports a Mac) and Android', () => {
  assert.equal(deviceOs({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }), 'ios');
  assert.equal(deviceOs({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 }), 'ios');
  assert.equal(deviceOs({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 }), 'other');
  assert.equal(deviceOs({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)' }), 'android');
  assert.equal(deviceOs({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }), 'other');
});

test('device rules', () => {
  const r = record([{ os: 'ios', to: 'https://apps.apple.com/x' }, { os: 'android', to: 'https://play.google.com/x' }]);
  assert.equal(pick(r, { now: 0, os: 'ios' }), 'https://apps.apple.com/x');
  assert.equal(pick(r, { now: 0, os: 'android' }), 'https://play.google.com/x');
  assert.equal(pick(r, { now: 0, os: 'other' }), 'https://default.example/');
});

test('date rules: after is inclusive, before exclusive', () => {
  const r = record([{ after: at('2026-11-01T00:00:00Z'), to: 'https://recap.example/' }]);
  assert.equal(pick(r, { now: at('2026-10-31T23:59:59Z'), os: 'other' }), 'https://default.example/');
  assert.equal(pick(r, { now: at('2026-11-01T00:00:00Z'), os: 'other' }), 'https://recap.example/');
  const b = record([{ before: at('2026-11-01T00:00:00Z'), to: 'https://early.example/' }]);
  assert.equal(pick(b, { now: at('2026-11-01T00:00:00Z'), os: 'other' }), 'https://default.example/');
});

test('days and times use the owner’s time zone', () => {
  // Weekday lunch in New York: 11:00-15:00, Monday-Friday.
  const r = record([{ days: '12345', from: '11:00', until: '15:00', to: 'https://lunch.example/' }], { 'Time-Zone': 'America/New_York' });
  const lunch = (iso) => pick(r, { now: at(iso), os: 'other' });
  assert.equal(lunch('2026-10-07T15:30:00Z'), 'https://lunch.example/', 'Wed 11:30 EDT');
  assert.equal(lunch('2026-10-07T14:59:00Z'), 'https://default.example/', 'Wed 10:59 EDT');
  assert.equal(lunch('2026-10-07T19:00:00Z'), 'https://default.example/', 'Wed 15:00 EDT: until is exclusive');
  assert.equal(lunch('2026-10-10T15:30:00Z'), 'https://default.example/', 'Saturday');
  assert.equal(lunch('2026-12-02T16:30:00Z'), 'https://lunch.example/', 'Wed 11:30 EST (no daylight saving)');
});

test('time windows can span midnight; from == until is all day', () => {
  const late = record([{ from: '22:00', until: '02:00', to: 'https://late.example/' }], { 'Time-Zone': 'UTC' });
  for (const [iso, want] of [['T21:59', 'default'], ['T22:00', 'late'], ['T01:59', 'late'], ['T02:00', 'default']]) {
    assert.equal(pick(late, { now: at(`2026-10-07${iso}:00Z`), os: 'other' }), `https://${want}.example/`, iso);
  }
  const all = record([{ from: '09:00', until: '09:00', to: 'https://all.example/' }], { 'Time-Zone': 'UTC' });
  assert.equal(pick(all, { now: at('2026-10-07T03:00:00Z'), os: 'other' }), 'https://all.example/');
});

test('first matching rule wins; conditions combine', () => {
  const r = record([
    { os: 'ios', after: at('2026-11-01T00:00:00Z'), to: 'https://ios-later.example/' },
    { os: 'ios', to: 'https://ios.example/' },
  ]);
  assert.equal(pick(r, { now: at('2026-10-01T00:00:00Z'), os: 'ios' }), 'https://ios.example/');
  assert.equal(pick(r, { now: at('2026-12-01T00:00:00Z'), os: 'ios' }), 'https://ios-later.example/');
});

test('broken or unknown rules are skipped, never break the link', () => {
  const now = at('2026-10-07T12:00:00Z');
  for (const routes of ['not json', '{"to":"x"}', 'null', '[null, 3, "x", {"os":"ios"}]']) {
    assert.equal(pick({ Destination: 'https://default.example/', Routes: routes }, { now, os: 'ios' }), 'https://default.example/', routes);
  }
  assert.equal(pick(record([{ lang: 'fr', to: 'https://fr.example/' }]), { now, os: 'other' }), 'https://default.example/', 'unknown condition');
  assert.equal(pick(record([{ from: '25:00', to: 'https://bad.example/' }]), { now, os: 'other' }), 'https://default.example/', 'bad time');
  assert.equal(pick({ Destination: 'https://default.example/' }, { now, os: 'other' }), 'https://default.example/', 'no Routes');
  assert.deepEqual(clock(now, 'Not/A_Zone').day, new Date(now).getDay(), 'unknown zone falls back to the phone clock');
});

test('Off-At and Disabled turn the link off', () => {
  const now = at('2026-10-07T12:00:00Z');
  assert.equal(isOff({ Disabled: 'true' }, now), true);
  assert.equal(isOff({ 'Off-At': String(now) }, now), true);
  assert.equal(isOff({ 'Off-At': String(now + 1) }, now), false);
  assert.equal(isOff({ 'Off-At': 'soon' }, now), false);
  assert.equal(isOff({}, now), false);
});
