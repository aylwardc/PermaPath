import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLockedHtml, parseLockedHtml, openLocked, unlockWithPassword, passwordAdvice, suggestPassphrase } from '../editor/lock.js';
import { generateKeyText, loadKey } from '../editor/arweave.js';
import { buildPageHtml } from '../editor/page.js';

test('locked web address: right password and owner key open it; wrong ones don’t', async () => {
  const owner = await loadKey(generateKeyText());
  const html = await buildLockedHtml({ payload: { type: 'url', url: 'https://secret.example/plan' }, password: 'correct horse', lockKey: owner.lockKey });
  assert.ok(!html.includes('secret.example'), 'destination is not visible in the page');
  const env = parseLockedHtml(html);
  assert.equal((await unlockWithPassword(env, 'correct horse')).url, 'https://secret.example/plan');
  await assert.rejects(unlockWithPassword(env, 'wrong'));
  assert.equal((await openLocked(env, owner.lockKey)).payload.url, 'https://secret.example/plan');
  const stranger = await loadKey(generateKeyText());
  await assert.rejects(openLocked(env, stranger.lockKey));
});

test('owner can re-save with new content but keep the current password', async () => {
  const owner = await loadKey(generateKeyText());
  const env1 = parseLockedHtml(await buildLockedHtml({ payload: { type: 'url', url: 'https://a.example/' }, password: 'pw-one', lockKey: owner.lockKey }));
  const { keep } = await openLocked(env1, owner.lockKey);
  const page = buildPageHtml({ title: 'Family info', text: 'Call Alex' });
  const env2 = parseLockedHtml(await buildLockedHtml({ payload: { type: 'page', html: page }, keep, lockKey: owner.lockKey }));
  const opened = await unlockWithPassword(env2, 'pw-one');
  assert.equal(opened.type, 'page');
  assert.match(opened.html, /Family info/);
  await assert.rejects(buildLockedHtml({ payload: { type: 'url', url: 'https://a.example/' }, lockKey: owner.lockKey }), /password/);
});

test('locked page cannot break out of its JSON script; helpers behave', async () => {
  const owner = await loadKey(generateKeyText());
  const html = await buildLockedHtml({ payload: { type: 'url', url: 'https://x.example/</script><script>alert(1)</script>' }, password: 'p', lockKey: owner.lockKey });
  assert.equal((html.match(/<\/script>/g) || []).length, 2);
  assert.equal(parseLockedHtml('<html></html>'), null);
  assert.match(suggestPassphrase(), /^[a-z]+(-[a-z]+){3}$/);
  assert.match(passwordAdvice('abc'), /Short/);
  assert.equal(passwordAdvice('a much longer passphrase'), 'Strong.');
});
