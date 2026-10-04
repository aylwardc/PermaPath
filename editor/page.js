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

export function buildPageHtml({ title, text = '', image = '' }) {
  if (!title || !title.trim()) throw new Error('Give your page a title.');
  if (text.length > PAGE_TEXT_MAX) throw new Error(`Page text is too long (${PAGE_TEXT_MAX.toLocaleString()} characters max).`);
  if (image && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) throw new Error('Unsupported image.');
  const source = JSON.stringify({ v: 1, title: title.trim(), text }).replace(/</g, '\\u003c');
  const t = escapeHtml(title.trim());
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="PermaPath">
<title>${t}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${image ? `<img id="pp-photo" src="${image}" alt="">\n` : ''}<h1>${t}</h1>
${renderText(text)}
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
  const img = html.match(/<img id="pp-photo" src="(data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+)"/);
  return { title: source.title, text: typeof source.text === 'string' ? source.text : '', image: img ? img[1] : '' };
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
