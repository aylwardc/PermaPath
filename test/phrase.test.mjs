import test from 'node:test';
import assert from 'node:assert/strict';
import { keyToPhrase, phraseToKey, looksLikePhrase } from '../editor/phrase.js';
import { base58Encode, generateKeyText, loadKey } from '../editor/arweave.js';

const keyOf = (byte) => base58Encode(new Uint8Array(32).fill(byte));

test('matches the BIP39 test vectors', async () => {
  assert.equal(await keyToPhrase(keyOf(0x00)), `${'abandon '.repeat(23)}art`);
  assert.equal(await keyToPhrase(keyOf(0x7f)),
    'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title');
  assert.equal(await keyToPhrase(keyOf(0xff)), `${'zoo '.repeat(23)}vote`);
});

test('round-trips random keys to the same signing key', async () => {
  for (let i = 0; i < 20; i++) {
    const key = generateKeyText();
    const phrase = await keyToPhrase(key);
    assert.equal(phrase.split(' ').length, 24);
    assert.equal(await phraseToKey(phrase), key);
  }
  const key = generateKeyText();
  const back = await phraseToKey(await keyToPhrase(key));
  assert.equal((await loadKey(back)).ownerKey, (await loadKey(key)).ownerKey);
});

test('forgiving input: case, numbering, line breaks, 4-letter abbreviations', async () => {
  const key = generateKeyText();
  const words = (await keyToPhrase(key)).split(' ');
  assert.equal(await phraseToKey(words.map((w, i) => `${i + 1}. ${w.toUpperCase()}`).join('\n')), key);
  assert.equal(await phraseToKey(words.map((w) => w.slice(0, 4)).join(' ')), key);
  assert.equal(await phraseToKey(`  ${words.join(',  ')}  `), key);
});

test('catches typos, wrong length and swapped words', async () => {
  const words = (await keyToPhrase(generateKeyText())).split(' ');
  await assert.rejects(phraseToKey(words.slice(0, 23).join(' ')), /24 words; this has 23/);
  await assert.rejects(phraseToKey(['qqqq', ...words.slice(1)].join(' ')), /Word 1 \(“qqqq”\)/);
  await assert.rejects(phraseToKey([words[0].slice(0, 2), ...words.slice(1)].join(' ')), /Word 1/);
  // Swapping two different words almost always breaks the checksum; find a pair that does.
  const i = words.findIndex((w, n) => n > 0 && w !== words[0]);
  const swapped = [...words];
  [swapped[0], swapped[i]] = [swapped[i], swapped[0]];
  try {
    const k = await phraseToKey(swapped.join(' '));
    assert.notEqual(k, await phraseToKey(words.join(' '))); // 1-in-256 chance the checksum still matches
  } catch (err) {
    assert.match(err.message, /don’t add up/);
  }
});

test('looksLikePhrase tells phrases from keys', async () => {
  assert.equal(looksLikePhrase(generateKeyText()), false);
  assert.equal(looksLikePhrase(`  ${generateKeyText()}\n`), false);
  assert.equal(looksLikePhrase(await keyToPhrase(generateKeyText())), true);
});
