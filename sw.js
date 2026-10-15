// Service worker: tiene l'app nel telefono, così si apre e funziona anche senza rete.
const VERSION = 'brainos-v5';
const SHELL = ['./', 'index.html', 'style.css', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/app.js', 'js/sync.js', 'js/drive.js', 'js/db.js', 'js/srs.js', 'js/viewer.js',
  'js/ai.js', 'js/engine.js', 'js/extract.js', 'js/ask.js', 'js/study.js', 'js/brainview.js'];
const CDN = ['https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js', 'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js',
  'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css', 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js',
  'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js',
  'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js',
  'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/controls/OrbitControls.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js',
  'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(SHELL);
    await Promise.all(CDN.map(u => c.add(new Request(u, { mode: 'cors' })).catch(() => {})));
    self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (/googleapis\.com|accounts\.google\.com|gstatic\.com|groq\.com/.test(url.hostname)) return;   // Google: sempre dalla rete
  if (url.hostname === 'cdn.jsdelivr.net') {          // librerie: una volta scaricate, restano
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    })());
    return;
  }
  if (url.origin === location.origin) {               // app: subito dalla memoria, aggiornata in background
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      const hit = await c.match(e.request, { ignoreSearch: true });
      const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
      return hit || (await net) || (e.request.mode === 'navigate' ? c.match('index.html') : Response.error());
    })());
  }
});
