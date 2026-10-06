// Hosted pages: a title, text and optional photo, stored on Arweave as one
// self-contained HTML file and used as a link's destination. The page embeds
// its own source (title + text as JSON, photo as a data URL) so the editor
// can load it back for editing. No DOM needed except compressImage().

// Turbo uploads are free under 100 KiB; leave room for the data item header.
export const PAGE_MAX_BYTES = 95 * 1024;
export const PAGE_TEXT_MAX = 20000;
// Locking adds about a third (encryption + encoding), so locked pages leave room for it.
export const LOCKED_PAGE_MAX = Math.floor((PAGE_MAX_BYTES - 7 * 1024) * 3 / 4);

const utf8 = new TextEncoder();

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Escaped text with http(s) URLs turned into links; blank lines separate paragraphs.
export function renderText(text) {
  const linkify = (line) => {
    let out = '', last = 0;
    for (const m of line.matchAll(/https?:\/\/[^\s<>"']+/g)) {
      let url = m[0];
      const trail = url.match(/[.,;:!?)\]]+$/);
      if (trail) url = url.slice(0, -trail[0].length);
      out += escapeHtml(line.slice(last, m.index)) + `<a href="${escapeHtml(url)}" rel="noopener">${escapeHtml(url)}</a>`;
      last = m.index + url.length;
    }
    return out + escapeHtml(line.slice(last));
  };
  return text.trim().split(/\n\s*\n/).filter(Boolean)
    .map((para) => `<p>${para.split('\n').map(linkify).join('<br>')}</p>`).join('\n');
}

const STYLE = `:root{--bg:#fff;--fg:#1a1a1a;--muted:#5f5f5f;--accent:#0b6bcb}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#ededed;--muted:#a0a0a0;--accent:#6cb4ff}}
html{background:var(--bg)}body{margin:0;color:var(--fg);font:17px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:40rem;margin:0 auto;padding:2rem 20px 3rem}
img{display:block;width:100%;height:auto;border-radius:10px;margin:0 0 1.5rem}
h1{font-size:1.7rem;line-height:1.25;margin:0 0 1rem}p{margin:0 0 1rem}a{color:var(--accent);word-break:break-word}`;

// ---------- contact cards ----------
// A page with Call / Text / Email / Website / Directions buttons and a "Save
// contact" vCard. Fields are all optional except the name.

export const CONTACT_FIELDS = ['name', 'role', 'phone', 'email', 'website', 'address'];

export function cleanContact(c = {}) {
  const out = Object.fromEntries(CONTACT_FIELDS.map((k) => [k, String(c[k] || '').trim().slice(0, 300)]));
  if (!out.name) throw new Error('Add a name for the contact card.');
  if (out.phone && !/^[+\d][\d\s().-]{2,30}$/.test(out.phone)) throw new Error('That phone number doesn’t look right. Use digits, spaces and + ( ) - only.');
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new Error('That email address doesn’t look right.');
  if (out.website && !/^[a-z][a-z0-9+.-]*:/i.test(out.website)) out.website = `https://${out.website}`;
  if (out.website && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(out.website)) throw new Error('That website doesn’t look right.');
  return out;
}

const telOf = (phone) => phone.replace(/[^\d+]/g, '');

// vCard 3.0 (what iPhone and Android contacts import most reliably).
export function buildVcard(contact, note = '') {
  const c = cleanContact(contact);
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (m) => `\\${m}`);
  const [first, ...rest] = c.name.split(/\s+/);
  const last = rest.pop() || '';
  return [
    'BEGIN:VCARD', 'VERSION:3.0',
    `FN:${esc(c.name)}`, `N:${esc(last)};${esc(rest.length ? `${first} ${rest.join(' ')}` : (last ? first : c.name))};;;`,
    ...(c.role ? [`TITLE:${esc(c.role)}`] : []),
    ...(c.phone ? [`TEL;TYPE=CELL:${telOf(c.phone)}`] : []),
    ...(c.email ? [`EMAIL:${esc(c.email)}`] : []),
    ...(c.website ? [`URL:${esc(c.website)}`] : []),
    ...(c.address ? [`ADR;TYPE=HOME:;;${esc(c.address)};;;;`] : []),
    ...(note.trim() ? [`NOTE:${esc(note.trim().slice(0, 1000))}`] : []),
    'END:VCARD', '',
  ].join('\r\n');
}

const CONTACT_STYLE = `.who{color:var(--muted);margin:-.6rem 0 1.4rem}
.actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.6rem;margin:0 0 1.6rem}
.actions a{display:block;text-align:center;padding:.8rem .6rem;border-radius:10px;border:1px solid var(--muted);color:var(--fg);text-decoration:none;font-weight:600}
.actions a.save{grid-column:1/-1;background:var(--accent);border-color:var(--accent);color:var(--bg)}
.details{color:var(--muted);font-size:.95rem;word-break:break-word}
img.round{width:9rem;height:9rem;object-fit:cover;border-radius:50%;margin:0 0 1.2rem}`;

// contact: { name, role, phone, email, website, address }; vcardUrl: where the
// "Save contact" file lives (a separate Arweave upload), or a data: URL.
function contactBody(contact, vcardUrl, image) {
  const c = cleanContact(contact);
  const a = (href, label, cls = '') => `<a href="${escapeHtml(href)}"${cls ? ` class="${cls}"` : ''} rel="noopener">${escapeHtml(label)}</a>`;
  const filename = `${c.name.replace(/[^\w\s-]+/g, '').trim().replace(/\s+/g, '-') || 'contact'}.vcf`;
  const actions = [
    vcardUrl ? `<a href="${escapeHtml(vcardUrl)}" class="save" download="${escapeHtml(filename)}" rel="noopener">Save contact</a>` : '',
    c.phone ? a(`tel:${telOf(c.phone)}`, 'Call') : '',
    c.phone ? a(`sms:${telOf(c.phone)}`, 'Text') : '',
    c.email ? a(`mailto:${c.email}`, 'Email') : '',
    c.website ? a(c.website, 'Website') : '',
    c.address ? a(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.address)}`, 'Directions') : '',
  ].filter(Boolean).join('\n');
  const details = [c.phone, c.email, c.website.replace(/^https?:\/\//, ''), c.address].filter(Boolean).map(escapeHtml).join('<br>');
  return `${image ? `<img id="pp-photo" class="round" src="${image}" alt="">\n` : ''}<h1>${escapeHtml(c.name)}</h1>
${c.role ? `<p class="who">${escapeHtml(c.role)}</p>\n` : ''}<div class="actions">
${actions}
</div>
${details ? `<p class="details">${details}</p>\n` : ''}`;
}

export function buildPageHtml({ title, text = '', image = '', contact = null, vcardUrl = '' }) {
  if (contact) title = cleanContact(contact).name;
  if (!title || !title.trim()) throw new Error('Give your page a title.');
  if (text.length > PAGE_TEXT_MAX) throw new Error(`Page text is too long (${PAGE_TEXT_MAX.toLocaleString()} characters max).`);
  if (image && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) throw new Error('Unsupported image.');
  if (vcardUrl && !/^(https:\/\/arweave\.net\/[A-Za-z0-9_-]{43}|data:text\/vcard;charset=utf-8,[^"<>]*)$/.test(vcardUrl)) throw new Error('Unsupported contact file.');
  const source = JSON.stringify({ v: 1, title: title.trim(), text, ...(contact ? { contact: cleanContact(contact), vcardUrl } : {}) }).replace(/</g, '\\u003c');
  const t = escapeHtml(title.trim());
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="PermaPath">
<title>${t}</title>
<style>${STYLE}${contact ? `\n${CONTACT_STYLE}` : ''}</style>
</head>
<body>
<main>
${contact ? contactBody(contact, vcardUrl, image) : `${image ? `<img id="pp-photo" src="${image}" alt="">\n` : ''}<h1>${t}</h1>\n`}${renderText(text)}
</main>
<script type="application/json" id="permapath-page">${source}</script>
</body>
</html>
`;
}

export const pageBytes = (html) => utf8.encode(html).length;

// Reads back { title, text, image } from a page built by buildPageHtml, or null.
export function parsePageHtml(html) {
  const json = html.match(/<script type="application\/json" id="permapath-page">([\s\S]*?)<\/script>/);
  if (!json) return null;
  let source;
  try {
    source = JSON.parse(json[1]);
  } catch {
    return null;
  }
  if (source?.v !== 1 || typeof source.title !== 'string') return null;
  const img = html.match(/<img id="pp-photo"(?: class="round")? src="(data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+)"/);
  const page = { title: source.title, text: typeof source.text === 'string' ? source.text : '', image: img ? img[1] : '' };
  if (source.contact && typeof source.contact === 'object') {
    page.contact = Object.fromEntries(CONTACT_FIELDS.map((k) => [k, typeof source.contact[k] === 'string' ? source.contact[k] : '']));
    page.vcardUrl = typeof source.vcardUrl === 'string' ? source.vcardUrl : '';
  }
  return page;
}

// Browser only: shrinks a photo to a JPEG data URL of at most maxBytes,
// lowering quality first, then dimensions.
export async function compressImage(file, maxBytes) {
  const bitmap = await createImageBitmap(file);
  let edge = Math.min(1600, Math.max(bitmap.width, bitmap.height));
  try {
    while (edge >= 200) {
      const scale = edge / Math.max(bitmap.width, bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * Math.min(1, scale)));
      canvas.height = Math.max(1, Math.round(bitmap.height * Math.min(1, scale)));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; // transparent PNGs become white, not black, as JPEG
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const q of [0.82, 0.7, 0.58, 0.46]) {
        const url = canvas.toDataURL('image/jpeg', q);
        if (url.length <= maxBytes) return url;
      }
      edge = Math.round(edge * 0.75);
    }
  } finally {
    bitmap.close();
  }
  throw new Error('That photo couldn’t be made small enough. Try a different one.');
}
