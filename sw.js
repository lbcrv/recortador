// Service worker: guarda la app para usarla sin conexión y recibe fotos compartidas desde la galería.
const V = 'recortador-v1'; // versión de la app: 5
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V && k !== 'shared' && k.startsWith('recortador')).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // "Compartir con Recortador" desde la galería: la foto se guarda en la caché local, nunca sale del teléfono
  if (e.request.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/share')) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const file = form.get('image');
      if (file) {
        const c = await caches.open('shared');
        await c.put('shared-image', new Response(file, { headers: { 'content-type': file.type, 'x-name': encodeURIComponent(file.name || 'compartida') } }));
      }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }
  if (e.request.method !== 'GET') return;
  // Archivos de la app: primero red (para recibir mejoras), si no hay conexión, la copia guardada
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(V);
      try {
        // no-cache: siempre pregunta al servidor si hay versión nueva (evita esperar la caché de 10 min)
        // (se usa la URL y no e.request: una navegación no admite opciones extra)
        const r = await fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' });
        if (r.ok) c.put(e.request, r.clone());
        return r;
      } catch {
        return (await c.match(e.request, { ignoreSearch: true })) || Response.error();
      }
    })());
    return;
  }
  // Librería del CDN (URL con versión fija, no cambia): primero caché
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith((async () => {
      const c = await caches.open(V);
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    })());
  }
  // El modelo de Hugging Face lo guarda la propia librería en su caché.
});
