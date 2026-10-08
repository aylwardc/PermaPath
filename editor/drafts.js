// Draft links: an AI assistant (or anyone) hands the user a link that opens the
// editor with a new link, or a change to one of their links, already filled in.
// Nothing is saved until the user presses Create or Save, so their own key signs
// and the assistant never needs one.
//
//   https://permapath.link/?new&dest=https://example.com/menu&name=Menu
//   https://permapath.link/?edit=<link-id>&dest=https://example.com/menu-v2
//
// Parameters (all optional except as noted):
//   new | edit=<id>   create a link, or change one the user owns (one is required)
//   type              url (default) | page | contact | event
//   dest              web address (type url)
//   name              link name
//   title, text       page title and text; text is also a contact card's note or an event's details
//   contact_name, role, phone, email, website, address        (type contact)
//   event_name, start, end, location   (type event; start/end ISO 8601, e.g. 2026-11-01T19:00)
//   count             1 or 0: count scans (new links count by default)
//   off_at            ISO 8601 date and time to turn off; message: shown while off
//   ios, android      other destinations for iPhone/iPad and Android users
//   rules             JSON list of routing rules, as in the CLI's `rules` command
//   qr                JSON QR design, e.g. {"label":"Scan for the menu","frame":"bar","icon":"menu"}

const ID = /^[A-Za-z0-9_-]{43}$/;
const TYPES = ['url', 'page', 'contact', 'event'];
const TEXT_FIELDS = ['dest', 'name', 'title', 'text', 'contact_name', 'role', 'phone', 'email', 'website', 'address',
  'event_name', 'start', 'end', 'location', 'off_at', 'message', 'ios', 'android'];
const MAX = 20000;

function json(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

/** Reads a draft from a query string, or returns null if there isn't one. */
export function parseDraft(search) {
  const p = new URLSearchParams(search);
  const editId = p.get('edit');
  const mode = editId && ID.test(editId) ? 'edit' : p.has('new') ? 'new' : null;
  if (!mode) return null;
  const draft = { mode, ...(mode === 'edit' ? { linkId: editId } : {}) };
  const type = p.get('type');
  if (TYPES.includes(type)) draft.type = type;
  for (const f of TEXT_FIELDS) {
    const v = p.get(f);
    if (v != null && v !== '') draft[f] = v.slice(0, MAX);
  }
  if (p.get('count') === '0' || p.get('count') === '1') draft.count = p.get('count') === '1';
  const rules = json(p.get('rules'));
  if (Array.isArray(rules)) draft.rules = rules.slice(0, 10);
  const qr = json(p.get('qr'));
  if (qr && typeof qr === 'object' && !Array.isArray(qr)) draft.qr = qr;
  return draft;
}

/** Builds a draft link (for the CLI, the MCP server and assistants). */
export function draftUrl(draft, base = 'https://permapath.link/') {
  const p = new URLSearchParams();
  if (draft.mode === 'edit' || draft.linkId) p.set('edit', draft.linkId);
  else p.set('new', '');
  for (const [k, v] of Object.entries(draft)) {
    if (['mode', 'linkId'].includes(k) || v == null || v === '') continue;
    p.set(k, typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  return `${base}?${p.toString().replace(/^new=&/, 'new&').replace(/^new=$/, 'new')}`;
}

/** The More options state a draft asks for (merged over the link's current options). */
export function draftOptions(draft) {
  const out = {};
  if (draft.count !== undefined) out.count = draft.count;
  if (draft.off_at !== undefined) {
    const t = Date.parse(draft.off_at);
    if (!Number.isNaN(t)) out.offAt = t;
  }
  if (draft.message !== undefined) out.message = draft.message;
  const routes = [
    ...(draft.ios ? [{ os: 'ios', to: draft.ios }] : []),
    ...(draft.android ? [{ os: 'android', to: draft.android }] : []),
    ...(draft.rules || []),
  ];
  if (routes.length) out.routes = routes;
  return out;
}
