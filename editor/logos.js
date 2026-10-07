// Center logos for designed QR codes: stored on Arweave, loaded once per page
// as a data URL (so SVG downloads embed it and canvases stay exportable) and a
// decoded image (so PNG drawing can stay synchronous).
const GATEWAYS = ['https://turbo-gateway.com', 'https://ardrive.net', 'https://arweave.net'];
const cache = new Map(); // url -> Promise<{ dataUrl, img } | null>

const toDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = reject;
  r.readAsDataURL(blob);
});

export function imageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// Resolves to { dataUrl, img }, or null if no gateway has it (yet).
export function loadLogo(url) {
  if (!cache.has(url)) {
    cache.set(url, (async () => {
      const id = url.split('/').pop();
      for (const gateway of GATEWAYS) {
        try {
          const res = await fetch(`${gateway}/${id}`, { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) continue;
          const dataUrl = await toDataUrl(await res.blob());
          return { dataUrl, img: await imageFromDataUrl(dataUrl) };
        } catch { /* next gateway */ }
      }
      cache.delete(url); // try again later
      return null;
    })());
  }
  return cache.get(url);
}

// Already loaded, or null (without waiting).
const ready = new Map();
export function loadedLogo(url) {
  if (!url) return null;
  if (!ready.has(url)) loadLogo(url).then((logo) => { if (logo) ready.set(url, logo); });
  return ready.get(url) || null;
}
export const remember = (url, logo) => { ready.set(url, logo); cache.set(url, Promise.resolve(logo)); };
