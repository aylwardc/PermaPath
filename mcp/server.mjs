// PermaPath MCP server: lets AI assistants that speak MCP (Claude Desktop,
// ChatGPT desktop, Cursor and others) look up and manage PermaPath links.
// It runs on the user's own computer over stdio, so their key never leaves it.
//
// The key is optional: without one, only read-only tools are offered (look up
// any link, its scan count, its QR code). With PERMAPATH_KEY (a key or a
// 24-word recovery phrase), or PERMAPATH_KEY_FILE, it can also create and
// change links. Suggest a separate key for AI use: anyone with a key controls
// its links, permanently.
//
// Protocol: JSON-RPC 2.0 messages, one per line on stdin/stdout (MCP stdio).
import fs from 'node:fs';
import {
  loadKey, createLink, updateLink, listLinks, getLink, getScans, createPage, linkUrl, linkStatus, linkQrSvgDesigned, uploadStatus, suggestFeature,
} from '../lib/permapath.js';

export const SERVER_INFO = { name: 'permapath', version: '0.1.3' }; // keep in step with VERSION in scripts/build-npm.mjs
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const LINK_ID = { type: 'string', description: 'The 43-character link ID (the part after ?l= in a PermaPath QR link).', pattern: '^[A-Za-z0-9_-]{43}$' };
const PERMANENT = 'Everything written is permanent and public (except what a password protects); link names and history are always visible.';

const describeLink = (s) => ({
  destination: s.kind === 'locked' ? '(password protected)' : s.destination || '(not set up)',
  kind: s.kind || 'web address', status: linkStatus(s), name: s.name,
  ...(s.count ? { counting_scans: true } : {}), ...(s.offAt ? { turns_off_at: new Date(s.offAt).toISOString() } : {}),
  ...(s.routes?.length ? { rules: s.routes } : {}),
});

// name -> { description, inputSchema, needsKey, run(args, key) }
export const TOOLS = {
  get_link: {
    description: 'Where a PermaPath link points now, its status, and its full change history. Anyone can look up any link; no key needed.',
    inputSchema: { type: 'object', properties: { link_id: LINK_ID }, required: ['link_id'] },
    async run({ link_id }) {
      const link = await getLink(link_id);
      if (!link) return { error: 'No PermaPath link with that ID was found (new links can take a minute to appear).' };
      return {
        link_id, qr_url: linkUrl(link_id), ...describeLink(link.current), owner: link.owner,
        created: new Date(link.created).toISOString(),
        history: link.history.map((h) => ({ at: new Date(h.seq).toISOString(), ...describeLink(h) })),
      };
    },
  },
  get_scans: {
    description: 'How many times a link\'s QR code has been scanned (total and per day, UTC). Only links with scan counting on are counted.',
    inputSchema: { type: 'object', properties: { link_id: LINK_ID }, required: ['link_id'] },
    run: ({ link_id }) => getScans(link_id),
  },
  get_qr_svg: {
    description: 'The QR code for a link as SVG markup (print-ready, with the link\'s saved design). Save it to a .svg file to print or share.',
    inputSchema: { type: 'object', properties: { link_id: LINK_ID }, required: ['link_id'] },
    async run({ link_id }) { return { svg: await linkQrSvgDesigned(link_id) }; },
  },
  suggest_feature: {
    description: 'Send a feature suggestion to the PermaPath team when the user wants something PermaPath can\'t do. Ask the user first and show them the text you\'ll send; include their email only if they offer it (to be told when it\'s done). Private: never published.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What the user would like PermaPath to do, in plain words.' },
        email: { type: 'string', description: 'Optional, only if the user wants to be told when it\'s done.' },
      },
      required: ['text'],
    },
    async run({ text, email = '' }) {
      await suggestFeature({ text, email, source: 'mcp' });
      return { sent: true, note: 'Thanks the user: the PermaPath team reads every suggestion.' };
    },
  },
  list_links: {
    description: 'All links owned by the configured key, newest first.',
    inputSchema: { type: 'object', properties: {} },
    needsKey: true,
    async run(_, key) {
      return { links: (await listLinks(key)).map((l) => ({ link_id: l.id, qr_url: linkUrl(l.id), ...describeLink(l), created: new Date(l.created).toISOString() })) };
    },
  },
  create_link: {
    description: `Create a link (and QR code) that points at a web address and can be repointed later. Returns its ID and the QR URL to print. Scans are counted unless count_scans is false. ${PERMANENT}`,
    inputSchema: {
      type: 'object',
      properties: {
        destination: { type: 'string', description: 'Web address to send people to, e.g. https://example.com/menu' },
        name: { type: 'string', description: 'Optional name (public).' },
        password: { type: 'string', description: 'Optional password: people need it to see where the link goes. Suggest four or more random words, and tell the user.' },
        count_scans: { type: 'boolean', description: 'Count scans (default true).' },
      },
      required: ['destination'],
    },
    needsKey: true,
    async run({ destination, name = '', password = '', count_scans = true }, key) {
      return createLink(key, { destination, name, password, count: count_scans });
    },
  },
  create_page: {
    description: `Create a link to a simple page you write (title and text, no website needed), e.g. "If you found this bike, call…". Blank lines make paragraphs; web addresses become links. ${PERMANENT}`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        text: { type: 'string' },
        name: { type: 'string', description: 'Optional link name (defaults to the title).' },
        password: { type: 'string', description: 'Optional password to keep the page private.' },
      },
      required: ['title'],
    },
    needsKey: true,
    async run({ title, text = '', name = '', password = '' }, key) {
      const r = await createPage(key, { title, text, name, password });
      return { ...r, note: 'The page takes a few minutes to appear on Arweave; scans show it once it does.' };
    },
  },
  update_link: {
    description: 'Change one of the key\'s links: where it points, its name, turn it on or off, an automatic turn-off time with a message, or scan counting. Only the fields given change. The printed QR code stays the same.',
    inputSchema: {
      type: 'object',
      properties: {
        link_id: LINK_ID,
        destination: { type: 'string', description: 'New web address. Replaces a hosted page or password protection.' },
        name: { type: 'string' },
        on: { type: 'boolean', description: 'false turns the link off (scans show a "turned off" message); true turns it back on.' },
        off_at: { type: 'string', description: 'ISO 8601 date and time to turn off automatically, or "none" to clear.' },
        message: { type: 'string', description: 'Shown while the link is off ("" clears it).' },
        count_scans: { type: 'boolean' },
      },
      required: ['link_id'],
    },
    needsKey: true,
    async run({ link_id, destination, name, on, off_at, message, count_scans }, key) {
      const changes = {};
      if (destination !== undefined) changes.destination = destination;
      if (name !== undefined) changes.name = name;
      if (on !== undefined) changes.disabled = !on;
      if (off_at !== undefined) changes.offAt = off_at === 'none' ? 0 : off_at;
      if (message !== undefined) changes.message = message;
      if (count_scans !== undefined) changes.count = count_scans;
      if (!Object.keys(changes).length) return { error: 'Nothing to change.' };
      const r = await updateLink(key, link_id, changes);
      return { link_id, qr_url: linkUrl(link_id), ...describeLink(r), note: 'Changes usually go live within a minute.' };
    },
  },
};

export function createServer({ key = null } = {}) {
  const available = Object.entries(TOOLS).filter(([, t]) => key || !t.needsKey);
  const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
  const failure = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  // One JSON-RPC message in, one response out (null for notifications).
  async function handle(msg) {
    const { id, method, params = {} } = msg || {};
    const notification = id === undefined || id === null;
    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        return result(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: 'PermaPath links are permanent QR codes whose destination can be changed later. '
            + (key ? 'Tools can create and change links owned by the configured key. ' : 'No key is configured, so only read-only tools are available. ')
            + 'Give users the qr_url to print; it never changes.',
        });
      }
      case 'ping':
        return result(id, {});
      case 'tools/list':
        return result(id, { tools: available.map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
      case 'tools/call': {
        const tool = TOOLS[params.name];
        if (!tool) return failure(id, -32602, `Unknown tool: ${params.name}`);
        if (tool.needsKey && !key) return result(id, { isError: true, content: [{ type: 'text', text: 'This tool needs a PermaPath key: set PERMAPATH_KEY in the MCP server config.' }] });
        try {
          uploadStatus.slow = false;
          const out = await tool.run(params.arguments || {}, key);
          if (out?.error) return result(id, { isError: true, content: [{ type: 'text', text: out.error }] });
          const value = uploadStatus.slow ? { ...out, slow_upload: 'Went through the backup uploader; can take a few minutes to go live.' } : out;
          return result(id, { content: [{ type: 'text', text: out?.svg ?? JSON.stringify(value, null, 2) }], ...(out?.svg ? {} : { structuredContent: value }) });
        } catch (err) {
          return result(id, { isError: true, content: [{ type: 'text', text: err.message }] });
        }
      }
      default:
        if (notification) return null; // notifications/initialized, cancelled, etc.
        return failure(id, -32601, `Method not found: ${method}`);
    }
  }
  return { handle, tools: available.map(([name]) => name) };
}

async function keyFromEnv() {
  const text = process.env.PERMAPATH_KEY || (process.env.PERMAPATH_KEY_FILE ? fs.readFileSync(process.env.PERMAPATH_KEY_FILE, 'utf8') : '');
  return text.trim() ? loadKey(text) : null;
}

export async function main() {
  const server = createServer({ key: await keyFromEnv() });
  let buffer = '';
  const queue = [];
  let busy = false;
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  async function drain() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const line = queue.shift();
      let msg;
      try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      const res = await server.handle(msg);
      if (res) send(res);
    }
    busy = false;
  }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) queue.push(line);
    }
    drain();
  });
  process.stdin.on('end', () => process.exit(0));
}
