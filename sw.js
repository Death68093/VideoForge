const SHELL_CACHE = 'axiom-editor-shell-v1';
const AI_CACHE = 'axiom-editor-ai-v1';
const AI_CACHE_MARKER = new URL('__axiom-ai-cache-enabled__', self.location.href).href;
const APP_FILES = [
  './',
  './index.html',
  './styles.css',
  './storage.js',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png'
];

function isApprovedAiHost(url) {
  return [
    'cdn.jsdelivr.net',
    'huggingface.co',
    'cdn-lfs.huggingface.co',
    'cas-bridge.xethub.hf.co'
  ].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(APP_FILES);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('axiom-editor-shell-') && name !== SHELL_CACHE).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  const reply = event.ports && event.ports[0];
  if (event.data?.type === 'ENABLE_AI_CACHE') {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(AI_CACHE);
        await cache.put(AI_CACHE_MARKER, new Response('enabled', { headers: { 'content-type': 'text/plain' } }));
        reply?.postMessage({ ok: true });
      } catch (error) {
        reply?.postMessage({ ok: false, error: error.message });
      }
    })());
  } else if (event.data?.type === 'CLEAR_AI_CACHE') {
    event.waitUntil((async () => {
      const removed = await caches.delete(AI_CACHE);
      reply?.postMessage({ ok: removed });
    })());
  }
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    // Remote scripts and model files are cached only after explicit AI opt-in.
    if (!isApprovedAiHost(url)) return;
    event.respondWith((async () => {
      const cache = await caches.open(AI_CACHE);
      const enabled = await cache.match(AI_CACHE_MARKER);
      if (!enabled) return fetch(request);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type !== 'opaque') {
        try { await cache.put(request, response.clone()); } catch (_) { /* Quota failures do not break the download. */ }
      }
      return response;
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(SHELL_CACHE);
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch (error) {
      if (request.mode === 'navigate') return (await caches.match('./index.html')) || Response.error();
      throw error;
    }
  })());
});
