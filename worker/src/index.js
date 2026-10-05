// permapath.link: serves the current editor from Arweave under one stable
// origin. Each editor deploy is a new Arweave TX, i.e. a new origin when
// visited directly, which would stop password managers autofilling keys and
// drop the editor's local state. QR codes never point here.
// EDITOR_TX is set by `node scripts/deploy.mjs editor`.
export const EDITOR_TX = 'b11j9d_mJXU7Ku2wc7i5zSaC-vst7mZZxbyKtDw31H8';
// Tried in order. arweave.net may refuse requests from Cloudflare Workers, so
// fall back to other gateways that serve path manifests.
const GATEWAYS = ['https://arweave.net', 'https://turbo-gateway.com', 'https://ardrive.net'];
const GATEWAY_TIMEOUT_MS = 8000;

// /api/*: a pass-through so the CLI (and AI agents running it) only ever talk
// to permapath.link, instead of asking permission for five Arweave services.
// Fixed upstreams only. Records are signature-checked by the CLI and uploads
// are signed before they leave, so this can't forge or alter anything.
const GRAPHQL_UPSTREAMS = {
  arweave: 'https://arweave.net/graphql',
  goldsky: 'https://arweave-search.goldsky.com/graphql',
  permagate: 'https://permagate.io/graphql',
  frostor: 'https://frostor.xyz/graphql',
};
// Turbo first; arweave.net's bundler if Turbo is down, rate limiting or asks for payment.
const UPLOAD_UPSTREAMS = ['https://upload.ardrive.io/v1/tx', 'https://up.arweave.net/tx'];
const MAX_BODY = 200 * 1024; // free uploads are under 100 KiB; GraphQL queries are tiny

// Relays a POST to the first target that takes it; moves on only for
// unreachable, 5xx, 402 or 429 (same rule as the client's upload()).
async function relay(targets, request) {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY) return new Response('Too large', { status: 413 });
  let last = new Response('Upstream unreachable', { status: 502 });
  for (const target of [].concat(targets)) {
    try {
      const res = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') || 'application/octet-stream' },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      const out = new Response(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') || 'text/plain' } });
      if (res.status >= 500 || res.status === 402 || res.status === 429) { last = out; continue; }
      return out;
    } catch (err) {
      last = new Response(`Upstream unreachable: ${err.name || 'error'}`, { status: 502 });
    }
  }
  return last;
}

async function api(url, request) {
  const graphql = url.pathname.match(/^\/api\/graphql\/([a-z]+)$/);
  if (graphql && GRAPHQL_UPSTREAMS[graphql[1]] && request.method === 'POST') return relay(GRAPHQL_UPSTREAMS[graphql[1]], request);
  if (url.pathname === '/api/upload' && request.method === 'POST') return relay(UPLOAD_UPSTREAMS, request);
  const raw = url.pathname.match(/^\/api\/raw\/([A-Za-z0-9_-]{43})$/);
  if (raw && request.method === 'GET') {
    for (const gateway of GATEWAYS) {
      try {
        const res = await fetch(`${gateway}/raw/${raw[1]}`, { signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS) });
        if (res.ok) return new Response(res.body, { headers: { 'content-type': res.headers.get('content-type') || 'application/octet-stream' } });
      } catch { /* next gateway */ }
    }
    return new Response('Not found', { status: 404 });
  }
  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return api(url, request);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', editor: EDITOR_TX });
    }
    const path = url.pathname.replace(/^\/+/, '');
    if (path.split('/').includes('..')) return new Response('Not found', { status: 404 });

    // Content under a TX never changes, so let the edge cache it for a day.
    let upstream = null;
    const failures = [];
    for (const gateway of GATEWAYS) {
      try {
        const res = await fetch(`${gateway}/${EDITOR_TX}/${path}`, {
          cf: { cacheEverything: true, cacheTtl: 86400 },
          signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
        });
        if (res.ok) {
          upstream = res;
          break;
        }
        failures.push(`${new URL(gateway).host} ${res.status}`);
      } catch (err) {
        failures.push(`${new URL(gateway).host} ${err.name || 'error'}`);
      }
    }
    if (!upstream) {
      const notFound = failures.every((f) => f.endsWith(' 404'));
      return new Response(`${notFound ? 'Not found' : 'Arweave gateways failed'}: ${failures.join(', ')}`, { status: notFound ? 404 : 502 });
    }
    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
        // Short browser cache, so a new editor deploy shows up within minutes.
        'cache-control': 'public, max-age=300',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      },
    });
  },
};
