// permapath.link: serves the current editor from Arweave under one stable
// origin. Each editor deploy is a new Arweave TX, i.e. a new origin when
// visited directly, which would stop password managers autofilling keys and
// drop the editor's local state. QR codes never point here.
// EDITOR_TX is set by `node scripts/deploy.mjs editor`.
export const EDITOR_TX = 'IjFU6SHmAfrCd631XiOB5OsRQ1EafL6h-FSnmIDfX1o';
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

// ---------- scan counts ----------
// Resolver v3 pings POST /api/scan?l=<link> (fire-and-forget) when a link has
// Count: true. Scans never wait for this, so counting can stop without any code
// breaking. Only the link ID and the UTC day are stored: no IPs, no cookies.
// Counts are public, like everything else about a link, and unauthenticated:
// anyone could inflate one, so treat them as approximate.
const LINK_ID = /^[A-Za-z0-9_-]{43}$/;
const MAX_LINKS = 100;

// One SQLite-backed Durable Object holds every link's daily counts.
export class ScanCounter {
  constructor(ctx) {
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS scans (link TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (link, day))');
  }

  async fetch(request) {
    const url = new URL(request.url);
    const links = url.searchParams.getAll('l');
    switch (url.pathname) {
      case '/hit':
        this.sql.exec('INSERT INTO scans (link, day, n) VALUES (?, ?, 1) ON CONFLICT (link, day) DO UPDATE SET n = n + 1',
          links[0], new Date().toISOString().slice(0, 10));
        return new Response(null, { status: 204 });
      case '/totals': {
        const counts = Object.fromEntries(links.map((l) => [l, 0]));
        const rows = this.sql.exec(`SELECT link, SUM(n) AS n FROM scans WHERE link IN (${links.map(() => '?').join(',')}) GROUP BY link`, ...links).toArray();
        for (const r of rows) counts[r.link] = r.n;
        return Response.json({ counts });
      }
      case '/daily': {
        const days = this.sql.exec('SELECT day, n FROM scans WHERE link = ? ORDER BY day DESC LIMIT 400', links[0]).toArray();
        const [{ total }] = this.sql.exec('SELECT COALESCE(SUM(n), 0) AS total FROM scans WHERE link = ?', links[0]).toArray();
        return Response.json({ link: links[0], total, days });
      }
      case '/summary': {
        const [all] = this.sql.exec('SELECT COALESCE(SUM(n), 0) AS scans, COUNT(DISTINCT link) AS links FROM scans').toArray();
        const days = this.sql.exec('SELECT day, SUM(n) AS scans, COUNT(*) AS links FROM scans GROUP BY day ORDER BY day DESC LIMIT 90').toArray();
        return Response.json({ ...all, days });
      }
      default:
        return new Response('Not found', { status: 404 });
    }
  }
}

const PUBLIC_JSON = { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=30' };

async function scans(url, request, env) {
  if (!env?.SCANS) return new Response('Scan counting is not configured', { status: 503 });
  // A new name starts from zero; reset 2026-10-07 at Chris's request (the old
  // object, 'all', still holds the earlier test-period counts).
  const counter = env.SCANS.get(env.SCANS.idFromName('since-2026-10-07'));
  const ask = async (op, links) => {
    const q = new URLSearchParams(links.map((l) => ['l', l]));
    return counter.fetch(`https://scans/${op}?${q}`);
  };
  const json = async (res) => new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json', ...PUBLIC_JSON } });

  if (url.pathname === '/api/scan') {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
    const link = url.searchParams.get('l') || '';
    if (!LINK_ID.test(link)) return new Response('Bad link ID', { status: 400 });
    await ask('hit', [link]);
    return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*' } });
  }
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET' } });
  if (url.pathname === '/api/scans') {
    const links = [...new Set((url.searchParams.get('l') || '').split(',').filter(Boolean))];
    if (!links.length || links.length > MAX_LINKS || !links.every((l) => LINK_ID.test(l))) {
      return new Response(`Pass ?l= with 1 to ${MAX_LINKS} comma-separated link IDs`, { status: 400 });
    }
    return json(await ask('totals', links));
  }
  if (url.pathname === '/api/scans/summary') return json(await ask('summary', []));
  const one = url.pathname.match(/^\/api\/scans\/([A-Za-z0-9_-]{43})$/);
  if (one) return json(await ask('daily', [one[1]]));
  return new Response('Not found', { status: 404 });
}

// ---------- feature suggestions ----------
// POST /api/suggest { text, email?, source? } from the website form, AI
// assistants (pre-filled link, MCP tool) and the CLI. Kept privately in a
// Durable Object; goodspeed fetches new ones (GET /api/suggestions with the
// SUGGEST_ADMIN_KEY secret) and emails them to Chris. Never public.
const SUGGEST_MAX = 2000;
const SOURCES = new Set(['website', 'ai', 'mcp', 'cli']);
const PER_IP_PER_HOUR = 5;
const PER_DAY = 200;

export class SuggestionBox {
  constructor(ctx) {
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
      text TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, who TEXT NOT NULL)`);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/add') {
      const s = await request.json();
      const now = Date.now();
      const [{ mine }] = this.sql.exec('SELECT COUNT(*) AS mine FROM suggestions WHERE who = ? AND at > ?', s.who, now - 3600_000).toArray();
      const [{ all }] = this.sql.exec('SELECT COUNT(*) AS "all" FROM suggestions WHERE at > ?', now - 86400_000).toArray();
      if (mine >= PER_IP_PER_HOUR || all >= PER_DAY) return Response.json({ error: 'Too many suggestions right now. Please try again later.' }, { status: 429 });
      this.sql.exec('INSERT INTO suggestions (at, text, email, source, who) VALUES (?, ?, ?, ?, ?)', now, s.text, s.email, s.source, s.who);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/list') {
      const after = Number(url.searchParams.get('after')) || 0;
      return Response.json({ suggestions: this.sql.exec('SELECT id, at, text, email, source FROM suggestions WHERE id > ? ORDER BY id LIMIT 200', after).toArray() });
    }
    return new Response('Not found', { status: 404 });
  }
}

async function sha256Hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function suggestions(url, request, env) {
  if (!env?.SUGGESTIONS) return new Response('Suggestions are not configured', { status: 503 });
  const box = env.SUGGESTIONS.get(env.SUGGESTIONS.idFromName('all'));
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
  if (url.pathname === '/api/suggest') {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'POST' } });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
    let body;
    try { body = await request.json(); } catch { return Response.json({ error: 'Send JSON: { "text": "…" }' }, { status: 400, headers: cors }); }
    if (body.website) return Response.json({ ok: true }, { headers: cors }); // honeypot field: bots fill it, people never see it
    const text = String(body.text || '').trim();
    const email = String(body.email || '').trim().slice(0, 200);
    if (text.length < 5) return Response.json({ error: 'Tell us a little more (at least a few words).' }, { status: 400, headers: cors });
    if (text.length > SUGGEST_MAX) return Response.json({ error: `Please keep it under ${SUGGEST_MAX} characters.` }, { status: 400, headers: cors });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Response.json({ error: 'That email address doesn’t look right.' }, { status: 400, headers: cors });
    const source = SOURCES.has(body.source) ? body.source : 'website';
    // Only a salted hash of the IP is kept, to limit how often one sender can post.
    const who = await sha256Hex(`${env.SUGGEST_ADMIN_KEY || 'permapath'}|${request.headers.get('cf-connecting-ip') || ''}`);
    const res = await box.fetch('https://box/add', { method: 'POST', body: JSON.stringify({ text, email, source, who }) });
    return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json', ...cors } });
  }
  if (url.pathname === '/api/suggestions' && request.method === 'GET') {
    const auth = request.headers.get('authorization') || '';
    if (!env.SUGGEST_ADMIN_KEY || auth !== `Bearer ${env.SUGGEST_ADMIN_KEY}`) return new Response('Not found', { status: 404 });
    return box.fetch(`https://box/list?after=${Number(url.searchParams.get('after')) || 0}`);
  }
  return new Response('Not found', { status: 404 });
}

async function api(url, request, env) {
  if (url.pathname === '/api/scan' || url.pathname.startsWith('/api/scans')) return scans(url, request, env);
  if (url.pathname === '/api/suggest' || url.pathname === '/api/suggestions') return suggestions(url, request, env);
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
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return api(url, request, env);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', editor: EDITOR_TX });
    }
    const path = url.pathname.replace(/^\/+/, '');
    if (path.split('/').includes('..')) return new Response('Not found', { status: 404 });

    // Content under a TX never changes, so let the edge cache it for a day, but
    // only successes: a gateway's "not found" for a just-uploaded file must not
    // stick (on 2026-10-05 cached 404s kept a new editor broken after it was
    // served). Gateways also fail now and then, so go round them twice.
    let upstream = null;
    const failures = [];
    for (const gateway of [...GATEWAYS, ...GATEWAYS]) {
      try {
        const res = await fetch(`${gateway}/${EDITOR_TX}/${path}`, {
          cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 86400, '300-599': 0 } },
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
