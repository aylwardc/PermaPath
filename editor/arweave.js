// Minimal Arweave plumbing for PermaPath, no dependencies.
// Works in modern browsers and Node 22+ (both have WebCrypto Ed25519).
//
// Keys are Ed25519 seeds (32 bytes) written in base58: ~44 characters, small
// enough to live in a password manager. Data items are ANS-104 signature
// type 4 ("solana"), the same format Turbo's Solana signer produces.

export const APP_NAME = 'PermaPath';
export const UPLOAD_URL = 'https://upload.ardrive.io/v1/tx';
// Fallback if Turbo is down or stops free uploads: arweave.net's own bundler.
// Also free for small items, but changes take a few minutes (not seconds) to
// show up in search, since it has no instant feed like Turbo's.
export const FALLBACK_UPLOAD_URL = 'https://up.arweave.net/tx';
// Every record is signature-checked, so any endpoint is safe to use; more
// endpoints just means fresher results and fewer outages.
export const GRAPHQL_ENDPOINTS = [
  'https://arweave.net/graphql',
  'https://arweave-search.goldsky.com/graphql',
  'https://permagate.io/graphql',
  'https://frostor.xyz/graphql',
];
// Network settings. The editor uses these defaults; the CLI routes through
// permapath.link first (see lib/permapath.js) so agents only contact one domain.
let uploadUrls = [UPLOAD_URL, FALLBACK_UPLOAD_URL];
// Where to download a record's body when it has one (older records only).
let rawBase = 'https://arweave.net/raw';

export function configureNetwork({ upload, raw } = {}) {
  if (upload) uploadUrls = upload;
  if (raw) rawBase = raw;
}

const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();

// ---------- encodings ----------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => B58[d]).join('');
}

export function base58Decode(text) {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  const bytes = [];
  for (let i = zeros; i < text.length; i++) {
    let carry = B58.indexOf(text[i]);
    if (carry < 0) throw new Error('Invalid character in key');
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

export function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(text) {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function littleEndian(n, size) {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = n & 0xff;
    n = (n - out[i]) / 256;
  }
  return out;
}

// ---------- keys ----------

// PKCS#8 wrapper for a raw 32-byte Ed25519 seed.
const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export function generateKeyText() {
  return base58Encode(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

// Returns { privateKey, publicKey (32 bytes), owners: [addresses as gateways report them] }
export async function loadKey(keyText) {
  const seed = base58Decode(keyText.trim());
  if (seed.length !== 32) throw new Error('That doesn’t look like a PermaPath key.');
  const privateKey = await subtle.importKey('pkcs8', concat([PKCS8_PREFIX, seed]), { name: 'Ed25519' }, true, ['sign']);
  const jwk = await subtle.exportKey('jwk', privateKey);
  const publicKey = base64urlDecode(jwk.x);
  // A separate symmetric key derived from the seed, used to keep an owner's
  // copy of password-protected content (see lock.js). Never leaves the device.
  const hkdf = await subtle.importKey('raw', seed, 'HKDF', false, ['deriveKey']);
  const lockKey = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8.encode('permapath-lock-v1'), info: utf8.encode('owner content key wrap') },
    hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  return { privateKey, publicKey, lockKey, ownerKey: base64url(publicKey), owners: await ownerAddresses(publicKey) };
}

// Gateways disagree on how to print a type-4 owner: arweave.net uses the
// base58 public key, Goldsky uses base64url(sha256(publicKey)). Query with both.
export async function ownerAddresses(publicKey) {
  const digest = new Uint8Array(await subtle.digest('SHA-256', publicKey));
  return [base58Encode(publicKey), base64url(digest)];
}

// ---------- ANS-104 data items ----------

const SIG_TYPE = 4;
const SIG_LENGTH = 64;
const OWNER_LENGTH = 32;

const sha384 = async (bytes) => new Uint8Array(await subtle.digest('SHA-384', bytes));

async function deepHash(data) {
  if (Array.isArray(data)) {
    let acc = await sha384(utf8.encode(`list${data.length}`));
    for (const chunk of data) acc = await sha384(concat([acc, await deepHash(chunk)]));
    return acc;
  }
  const tagHash = await sha384(utf8.encode(`blob${data.length}`));
  return sha384(concat([tagHash, await sha384(data)]));
}

// Avro zig-zag varint, as used by ANS-104 tag encoding.
function avroLong(n) {
  let z = n * 2;
  const out = [];
  do {
    let byte = z % 128;
    z = Math.floor(z / 128);
    if (z > 0) byte |= 0x80;
    out.push(byte);
  } while (z > 0);
  return Uint8Array.from(out);
}

export function serializeTags(tags) {
  if (!tags.length) return new Uint8Array(0);
  const parts = [avroLong(tags.length)];
  for (const { name, value } of tags) {
    for (const s of [name, value]) {
      const b = utf8.encode(s);
      parts.push(avroLong(b.length), b);
    }
  }
  parts.push(avroLong(0));
  return concat(parts);
}

// Builds and signs a data item. Returns { id, bytes }.
export async function createDataItem(key, tags, data) {
  const rawTags = serializeTags(tags);
  if (rawTags.length > 4096) throw new Error('Tags too large');
  const rawData = typeof data === 'string' ? utf8.encode(data) : data;
  const empty = new Uint8Array(0);

  const signatureData = await deepHash([
    utf8.encode('dataitem'),
    utf8.encode('1'),
    utf8.encode(String(SIG_TYPE)),
    key.publicKey,
    empty, // target
    empty, // anchor
    rawTags,
    rawData,
  ]);
  // Type 4 signs the hex text of the deep hash (matches arbundles HexSolanaSigner).
  const signature = new Uint8Array(await subtle.sign('Ed25519', key.privateKey, utf8.encode(hex(signatureData))));

  const bytes = concat([
    littleEndian(SIG_TYPE, 2),
    signature,
    key.publicKey,
    Uint8Array.of(0), // no target
    Uint8Array.of(0), // no anchor
    littleEndian(tags.length, 8),
    littleEndian(rawTags.length, 8),
    rawTags,
    rawData,
  ]);
  if (signature.length !== SIG_LENGTH || key.publicKey.length !== OWNER_LENGTH) throw new Error('Bad key');
  const id = base64url(new Uint8Array(await subtle.digest('SHA-256', signature)));
  return { id, bytes };
}

// Checks a type-4 data item from its parts, e.g. as returned by GraphQL
// (id, signature, owner.key, tags) plus its body. True only if the owner key
// really signed exactly these tags and body, and the ID matches the signature.
export async function verifyDataItem({ id, signature, ownerKey, tags, data = new Uint8Array(0) }) {
  try {
    const sig = base64urlDecode(signature);
    const owner = base64urlDecode(ownerKey);
    if (sig.length !== SIG_LENGTH || owner.length !== OWNER_LENGTH) return false;
    if (base64url(new Uint8Array(await subtle.digest('SHA-256', sig))) !== id) return false;
    const empty = new Uint8Array(0);
    const signatureData = await deepHash([
      utf8.encode('dataitem'), utf8.encode('1'), utf8.encode(String(SIG_TYPE)),
      owner, empty, empty, serializeTags(tags), typeof data === 'string' ? utf8.encode(data) : data,
    ]);
    const key = await subtle.importKey('raw', owner, { name: 'Ed25519' }, false, ['verify']);
    return await subtle.verify('Ed25519', key, sig, utf8.encode(hex(signatureData)));
  } catch {
    return false;
  }
}

// Verifies a node returned by gqlAll. Records written by PermaPath have empty
// bodies, so this needs no download; older records with a body fetch it once.
export async function verifyNode(node) {
  let data = new Uint8Array(0);
  if (node.size !== 0) {
    try {
      const res = await fetch(`${rawBase}/${node.id}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return false;
      data = new Uint8Array(await res.arrayBuffer());
    } catch {
      return false;
    }
  }
  return verifyDataItem({ id: node.id, signature: node.signature, ownerKey: node.ownerKey, tags: node.tagList, data });
}

// Tries each upload URL in order. Moves on when one is unreachable, failing
// (5xx), rate limiting (429) or asking for payment (402, e.g. if a free tier
// ends); any other rejection means the item itself is bad, so it stops.
export async function upload(item) {
  let lastError;
  for (const url of uploadUrls) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: item.bytes,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      lastError = err;
      continue;
    }
    if (res.status >= 500 || res.status === 402 || res.status === 429) {
      lastError = new Error(`Upload failed (${res.status})`);
      continue;
    }
    if (!res.ok) throw new Error(`Upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    // Services reply in different shapes (up.arweave.net has no "id"). The ID
    // comes from our own signature, so it can't be changed; just reject a mismatch.
    let body = {};
    try { body = await res.json(); } catch { /* not JSON: fine */ }
    if (body.id && body.id !== item.id) throw new Error('Upload returned an unexpected ID');
    // slow: Turbo replies with the ID; up.arweave.net (the fallback, also behind
    // the permapath.link relay) doesn't, and its uploads take minutes to appear.
    return { ...body, id: item.id, slow: !body.id };
  }
  throw lastError || new Error('Upload failed');
}

// ---------- GraphQL ----------

export async function gql(endpoint, query, variables, timeoutMs = 10_000) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GraphQL ${res.status}`);
  const body = await res.json();
  if (body.errors) throw new Error(body.errors[0]?.message || 'GraphQL error');
  return body.data;
}

// Runs a paginated transactions query and returns all nodes as
// { id, owner, ownerKey, signature, size, confirmedAt (ms or null), tags: {name: value}, tagList: [{name, value}] }.
export async function gqlAll(endpoint, filter, variables, maxPages = 20) {
  const query = `query($after: String, ${filter.params}) {
    transactions(first: 100, after: $after, ${filter.args}) {
      pageInfo { hasNextPage }
      edges { cursor node { id signature owner { address key } data { size } block { timestamp } tags { name value } } }
    }
  }`;
  const nodes = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const { transactions } = await gql(endpoint, query, { ...variables, after });
    for (const e of transactions.edges) {
      nodes.push({
        id: e.node.id,
        owner: e.node.owner.address,
        ownerKey: e.node.owner.key,
        signature: e.node.signature,
        size: Number(e.node.data.size),
        confirmedAt: e.node.block?.timestamp ? e.node.block.timestamp * 1000 : null,
        tags: Object.fromEntries(e.node.tags.map((t) => [t.name, t.value])),
        tagList: e.node.tags,
      });
    }
    if (!transactions.pageInfo.hasNextPage || !transactions.edges.length) break;
    after = transactions.edges.at(-1).cursor;
  }
  return nodes;
}
