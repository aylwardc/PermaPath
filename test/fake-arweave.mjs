// An in-memory stand-in for Arweave, for the editor's browser tests: uploads
// are kept here, GraphQL searches and gateway downloads answer from here, and
// nothing reaches the network. Real uploads cost Turbo credits or wait minutes
// for the free fallback; run with LIVE=1 to test against the real thing.
//
// One store serves both the browser (installed with context.route) and Node
// (installed by wrapping globalThis.fetch), since tests check results from both.
import { base58Encode, base64url } from '../editor/arweave.js';

const ID = '[A-Za-z0-9_-]{43}';
const GATEWAY = /^https:\/\/(?:[a-z0-9]+\.)?(arweave\.net|turbo-gateway\.com|ardrive\.net)$/;
const UPLOAD = /^https:\/\/(upload\.ardrive\.io\/v1\/tx|upload\.services\.ar\.io\/v1\/tx|up\.arweave\.net\/tx|permapath\.link\/api\/upload)$/;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };

const le = (bytes, at, n) => { let v = 0; for (let i = n - 1; i >= 0; i--) v = v * 256 + bytes[at + i]; return v; };

// Avro zig-zag varint (ANS-104 tags); returns [value, next offset].
function avroLong(bytes, at) {
  let n = 0, mul = 1, b;
  do { b = bytes[at++]; n += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
  return [n % 2 ? -(n + 1) / 2 : n / 2, at];
}

function parseTags(bytes) {
  const dec = new TextDecoder();
  const tags = [];
  let at = 0;
  for (;;) {
    let count;
    [count, at] = avroLong(bytes, at);
    if (count === 0) return tags;
    if (count < 0) { count = -count; [, at] = avroLong(bytes, at); } // block byte size, unused
    for (let i = 0; i < count; i++) {
      const pair = [];
      for (let j = 0; j < 2; j++) {
        let len;
        [len, at] = avroLong(bytes, at);
        pair.push(dec.decode(bytes.subarray(at, at + len)));
        at += len;
      }
      tags.push({ name: pair[0], value: pair[1] });
    }
  }
}

// ANS-104 type 4 (Ed25519) data item → its parts, as an Arweave gateway would index them.
async function parseItem(bytes) {
  if (le(bytes, 0, 2) !== 4) throw new Error('fake arweave: only signature type 4');
  let at = 2;
  const signature = bytes.subarray(at, at += 64);
  const owner = bytes.subarray(at, at += 32);
  if (bytes[at++]) at += 32; // target
  if (bytes[at++]) at += 32; // anchor
  at += 8; // tag count (also in the tag bytes)
  const tagLength = le(bytes, at, 8);
  at += 8;
  const tags = parseTags(bytes.subarray(at, at + tagLength));
  const data = bytes.slice(at + tagLength);
  const sha = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
  return {
    id: base64url(await sha(signature)),
    signature: base64url(signature),
    ownerKey: base64url(owner),
    owners: [base58Encode(owner), base64url(await sha(owner))], // arweave.net style, Goldsky style
    tags,
    data,
  };
}

export function createFakeArweave() {
  const items = new Map();
  const passedThrough = new Set(); // non-local hosts it let through, to spot leaks

  function search({ query, variables = {} }) {
    const varOrList = (text) => (text.startsWith('$') ? variables[text.slice(1)] : JSON.parse(text));
    const ids = /\bids:\s*(\$\w+)/.exec(query);
    const owners = /\bowners:\s*(\$\w+)/.exec(query);
    const tagFilters = [...query.matchAll(/\{\s*name:\s*"([^"]+)",\s*values:\s*(\$\w+|\[[^\]]*\])\s*\}/g)]
      .map(([, name, values]) => [name, varOrList(values) || []]);
    const idList = ids && varOrList(ids[1]);
    const ownerList = owners && varOrList(owners[1]);
    const matches = [...items.values()].filter((it) => (!idList || idList.includes(it.id))
      && (!ownerList || ownerList.some((o) => it.owners.includes(o)))
      && tagFilters.every(([name, values]) => it.tags.some((t) => t.name === name && values.includes(t.value))));
    const first = Number(/first:\s*(\d+)/.exec(query)?.[1] || 100);
    const start = variables.after ? Number(variables.after) : 0;
    const page = matches.slice(start, start + first);
    return {
      data: {
        transactions: {
          pageInfo: { hasNextPage: start + first < matches.length },
          edges: page.map((it, i) => ({
            cursor: String(start + i + 1),
            node: {
              id: it.id, signature: it.signature, owner: { address: it.owners[0], key: it.ownerKey },
              data: { size: String(it.data.length) }, block: null, tags: it.tags,
            },
          })),
        },
      },
    };
  }

  const json = (body, status = 200) => ({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  // Returns { status, headers, body } for requests it handles, or null to let them through.
  async function handle(method, url, body) {
    const u = new URL(url);
    const origin = `${u.protocol}//${u.host}`;
    const target = `${u.host}${u.pathname}`;
    if (method === 'OPTIONS' && (UPLOAD.test(`https://${target}`) || u.pathname.endsWith('/graphql') || u.pathname.startsWith('/api/'))) {
      return { status: 204, headers: CORS, body: '' };
    }
    if (method === 'POST' && UPLOAD.test(`https://${target}`)) {
      const item = await parseItem(new Uint8Array(body));
      items.set(item.id, item);
      // up.arweave.net replies without an "id", which is how the editor knows it was slow.
      return json(u.host === 'up.arweave.net' ? { 'bundle-status': 'complete' } : { id: item.id, timestamp: Date.now() });
    }
    if (method === 'POST' && (u.pathname === '/graphql' || /^\/api\/graphql\/\w+$/.test(u.pathname))) {
      return json(search(JSON.parse(Buffer.from(body).toString('utf8'))));
    }
    if (u.host === 'permapath.link' && u.pathname === '/api/scan') return { status: 204, headers: CORS, body: '' };
    if (u.host === 'permapath.link' && u.pathname === '/api/scans') return json({ counts: Object.fromEntries((u.searchParams.get('l') || '').split(',').filter(Boolean).map((l) => [l, 0])) });
    if (u.host === 'permapath.link' && u.pathname.startsWith('/api/scans/')) return json({ link: u.pathname.split('/').pop(), total: 0, days: [] });
    const raw = new RegExp(`^/(?:raw/|api/raw/)?(${ID})$`).exec(u.pathname);
    if ((method === 'GET' || method === 'HEAD') && raw && (GATEWAY.test(origin) || u.host === 'permapath.link')) {
      const item = items.get(raw[1]);
      if (!item) return null; // not ours (e.g. the real resolver): let it through
      const type = item.tags.find((t) => t.name === 'Content-Type')?.value || 'application/octet-stream';
      return { status: 200, headers: { ...CORS, 'content-type': type }, body: Buffer.from(item.data) };
    }
    return null;
  }

  return {
    items,
    passedThrough,
    handle,
    // Browser side: every request in the context goes through the fake first.
    async install(context) {
      await context.route('**/*', async (route) => {
        const req = route.request();
        const res = await handle(req.method(), req.url(), req.postDataBuffer()).catch(() => null);
        if (res) return route.fulfill(res);
        const { host } = new URL(req.url());
        if (!/^(127\.0\.0\.1|localhost)(:|$)/.test(host)) passedThrough.add(`${req.method()} ${host}`);
        return route.fallback();
      });
    },
    // Node side: wraps fetch for the test process itself.
    installNode() {
      const real = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const req = input instanceof Request ? input : null;
        const url = String(req ? req.url : input);
        const method = (init.method || req?.method || 'GET').toUpperCase();
        const body = init.body ?? (req && method !== 'GET' ? await req.arrayBuffer() : null);
        const res = await handle(method, url, body == null ? null : typeof body === 'string' ? Buffer.from(body) : Buffer.from(body));
        if (!res) {
          const { host } = new URL(url);
          if (!/^(127\.0\.0\.1|localhost)(:|$)/.test(host)) passedThrough.add(`${method} ${host} (node)`);
          return real(input, init);
        }
        return new Response(method === 'HEAD' || res.status === 204 ? null : res.body, { status: res.status, headers: res.headers });
      };
      return () => { globalThis.fetch = real; };
    },
  };
}
