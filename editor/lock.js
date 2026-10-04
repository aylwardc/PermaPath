// Password-protected links. The link points at a "locked page": one
// self-contained HTML file on Arweave holding encrypted content, either a web
// address to forward to or a full hosted page. Visitors type the password and
// the page decrypts in their browser; nothing is checked by a server.
//
// A random content key encrypts the content (AES-GCM). That key is wrapped
// twice: with a key derived from the password (PBKDF2, deliberately slow, to
// make guessing expensive) and with the owner's lock key (derived from their
// PermaPath key), so the owner's editor can always open and re-save it, and
// keep the current password without retyping it.
const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();
const ITERATIONS = 600_000;

const b64u = (bytes) => {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

async function seal(key, bytes) {
  const iv = random(12);
  return { iv: b64u(iv), ct: b64u(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes)) };
}
const open = (key, box) => subtle.decrypt({ name: 'AES-GCM', iv: unb64u(box.iv) }, key, unb64u(box.ct));
const aesKey = (raw, usages) => subtle.importKey('raw', raw, 'AES-GCM', false, usages);

async function passwordKey(password, kdf, usages) {
  const base = await subtle.importKey('raw', utf8.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64u(kdf.salt), iterations: kdf.iterations },
    base, { name: 'AES-GCM', length: 256 }, false, usages);
}

/** A rough, friendly strength hint (recommend, never enforce). */
export function passwordAdvice(password) {
  if (!password) return '';
  if (password.length < 8) return 'Short passwords can be guessed by a determined person. Longer is much safer.';
  if (password.length < 14) return 'Okay for casual use. For anything sensitive, use a longer one, like four random words.';
  return 'Strong.';
}

// ~1,000 is plenty for passphrases built from 4 random picks.
const WORDS = ('acorn amber anchor apple arrow aspen atlas autumn badge bagel bamboo banjo barley basil beacon beetle '
  + 'berry birch bison blanket blossom bonfire branch breeze brick bridge bronze bucket buffalo cabin cactus camel '
  + 'candle canoe canyon carbon carrot castle cedar cello chalk cherry chimney cider cinnamon citrus clover cobalt '
  + 'comet copper coral cotton cougar cove crane crater crayon cricket crystal cypress daisy dawn delta denim desert '
  + 'dolphin dragon drum dune eagle ember emerald falcon fern fiddle fig firefly flint forest fossil fountain fox '
  + 'galaxy garnet gecko geyser ginger glacier granite grape gravel harbor harvest hazel heron hickory honey horizon '
  + 'iris island ivory jasmine jungle juniper kayak kettle kiwi lagoon lantern lava lemon lilac lily linen lizard '
  + 'lotus lunar maple marble meadow melon meteor mint mosaic moss mountain mango nectar nutmeg oasis ocean olive '
  + 'onyx orbit orchid otter owl paddle panda papaya parrot pebble pepper pine planet plum pollen pond poppy prairie '
  + 'pumpkin quartz quill rabbit raccoon radish rain raven reef ribbon river robin rocket rose ruby saffron sage '
  + 'salmon sapphire satin sequoia shadow shell sierra silver sky sparrow spruce squash star stone storm sugar summit '
  + 'sunset swan tango thistle thunder tiger timber topaz tulip tundra turtle valley velvet violet volcano walnut '
  + 'walrus willow winter wolf yarrow zebra zephyr').split(' ');

/** A random passphrase like "copper-tunnel-violin-sunrise". */
export function suggestPassphrase(words = 4) {
  const picks = [];
  for (const n of globalThis.crypto.getRandomValues(new Uint32Array(words))) picks.push(WORDS[n % WORDS.length]);
  return picks.join('-');
}

/**
 * Builds a locked page. payload: { type: 'url', url } or { type: 'page', html }.
 * Pass `password` to set one, or `keep` (from openLocked) to reuse the current
 * password and content key without knowing the password. Returns HTML.
 */
export async function buildLockedHtml({ payload, password, keep, lockKey }) {
  if (!password && !keep) throw new Error('Enter a password.');
  let contentRaw, kdf, pw;
  if (password) {
    contentRaw = random(32);
    kdf = { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: b64u(random(16)) };
    pw = await seal(await passwordKey(password, kdf, ['encrypt']), contentRaw);
  } else {
    ({ contentRaw, kdf, pw } = keep);
  }
  const contentKey = await aesKey(contentRaw, ['encrypt']);
  const envelope = {
    v: 1,
    kdf,
    pw,
    owner: await seal(lockKey, contentRaw),
    data: await seal(contentKey, utf8.encode(JSON.stringify({ v: 1, ...payload }))),
  };
  return gateHtml(JSON.stringify(envelope));
}

/** Reads the envelope out of a locked page, or null if it isn't one. */
export function parseLockedHtml(html) {
  const m = html.match(/<script type="application\/json" id="permapath-locked">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const env = JSON.parse(m[1]);
    return env?.v === 1 && env.kdf && env.pw && env.owner && env.data ? env : null;
  } catch {
    return null;
  }
}

/** Owner-side open: returns { payload, keep } using the owner's lock key. */
export async function openLocked(envelope, lockKey) {
  const contentRaw = new Uint8Array(await open(lockKey, envelope.owner));
  const payload = JSON.parse(new TextDecoder().decode(await open(await aesKey(contentRaw, ['decrypt']), envelope.data)));
  return { payload, keep: { contentRaw, kdf: envelope.kdf, pw: envelope.pw } };
}

/** Visitor-side open (what the locked page's script does), for tests and tools. */
export async function unlockWithPassword(envelope, password) {
  const contentRaw = await open(await passwordKey(password, envelope.kdf, ['decrypt']), envelope.pw);
  return JSON.parse(new TextDecoder().decode(await open(await aesKey(contentRaw, ['decrypt']), envelope.data)));
}

// The locked page itself. Self-contained; its script mirrors unlockWithPassword.
function gateHtml(envelopeJson) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="generator" content="PermaPath">
<title>Password required</title>
<style>:root{--bg:#fff;--fg:#1a1a1a;--muted:#5f5f5f;--line:#d8d8d4;--accent:#0b6bcb;--accent-fg:#fff;--error:#c0362c}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#ededed;--muted:#a0a0a0;--line:#333;--accent:#5aa9f5;--accent-fg:#0b1a2a;--error:#f0776c}}
html{background:var(--bg)}body{margin:0;color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:24rem;margin:0 auto;padding:3rem 20px}h1{font-size:1.4rem;margin:0 0 .4rem}p{margin:0 0 1rem;color:var(--muted)}
input[type=password]{display:block;box-sizing:border-box;width:100%;padding:.65rem .75rem;font:inherit;font-size:16px;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;margin:0 0 .75rem}
label{display:flex;gap:.5rem;align-items:center;color:var(--muted);font-size:.9rem;margin:0 0 1rem}
button{width:100%;padding:.65rem;font:inherit;font-weight:600;border:0;border-radius:8px;background:var(--accent);color:var(--accent-fg);cursor:pointer}
button:disabled{opacity:.6}#msg{color:var(--error);margin-top:.75rem;min-height:1.5em}</style>
</head>
<body>
<main>
<h1>Password required</h1>
<p>Enter the password to open this link.</p>
<form id="f">
<input id="pw" type="password" autocomplete="off" aria-label="Password" required>
<label><input type="checkbox" id="remember"> Remember on this device</label>
<button id="go">Open</button>
<p id="msg" role="alert"></p>
</form>
</main>
<script type="application/json" id="permapath-locked">${envelopeJson.replace(/</g, '\\u003c')}</script>
<script>
(function () {
  var env = JSON.parse(document.getElementById('permapath-locked').textContent);
  var sub = window.crypto && crypto.subtle, enc = new TextEncoder(), STORE = 'permapath-password';
  function b(s) { var bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function msg(t) { document.getElementById('msg').textContent = t; }
  function unlock(pw) {
    return sub.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']).then(function (base) {
      return sub.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b(env.kdf.salt), iterations: env.kdf.iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    }).then(function (k) { return sub.decrypt({ name: 'AES-GCM', iv: b(env.pw.iv) }, k, b(env.pw.ct)); })
      .then(function (raw) { return sub.importKey('raw', raw, 'AES-GCM', false, ['decrypt']); })
      .then(function (ck) { return sub.decrypt({ name: 'AES-GCM', iv: b(env.data.iv) }, ck, b(env.data.ct)); })
      .then(function (buf) { return JSON.parse(new TextDecoder().decode(buf)); });
  }
  function show(p) {
    if (p.type === 'url') {
      var u; try { u = new URL(p.url); } catch (e) { u = null; }
      if (u && (u.protocol === 'https:' || u.protocol === 'http:')) { location.replace(u.href); return; }
      msg('This link’s destination is invalid.');
    } else if (p.type === 'page') {
      document.open(); document.write(p.html); document.close();
    }
  }
  if (!sub) { msg('This browser can’t open password-protected links.'); return; }
  var saved = null;
  try { saved = localStorage.getItem(STORE); } catch (e) {}
  if (saved) unlock(saved).then(show, function () { try { localStorage.removeItem(STORE); } catch (e) {} });
  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault();
    var pw = document.getElementById('pw').value, go = document.getElementById('go');
    go.disabled = true; msg(''); go.textContent = 'Unlocking…';
    unlock(pw).then(function (p) {
      if (document.getElementById('remember').checked) { try { localStorage.setItem(STORE, pw); } catch (e) {} }
      show(p);
    }, function () {
      go.disabled = false; go.textContent = 'Open'; msg('That password didn’t work.');
    });
  });
})();
</script>
</body>
</html>
`;
}
