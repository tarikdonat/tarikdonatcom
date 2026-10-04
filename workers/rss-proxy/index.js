// tarikdonat.com için RSS CORS ara katmanı (Cloudflare Worker).
// GET /?url=<kodlanmış RSS adresi> → ham RSS XML, CORS açık, 5 dk edge cache.
// Sadece aşağıdaki haber sitelerine izin verir; başka hiçbir adrese istek yapmaz.
// Secret/anahtar yok, repo public olabilir.

const ALLOWED_FEED_HOSTS = new Set([
  'www.trthaber.com',
  'www.aa.com.tr',
  'www.bloomberght.com',
]);

const ALLOWED_ORIGINS = new Set([
  'https://tarikdonat.com',
  'https://www.tarikdonat.com',
  'http://localhost:8778',
  'http://localhost:8783',
]);

const CACHE_SECONDS = 300;

function corsHeaders(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function fail(status, message, origin) {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== 'GET') return fail(405, 'Yalnızca GET', origin);
    // Tarayıcıdan gelen ama izinsiz origin'leri reddet (curl gibi Origin'siz istekler test için serbest).
    if (origin && !ALLOWED_ORIGINS.has(origin)) return fail(403, 'Origin izinli değil', origin);

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return fail(400, 'url parametresi gerekli', origin);

    let feed;
    try { feed = new URL(target); } catch { return fail(400, 'Geçersiz url', origin); }
    if (feed.protocol !== 'https:' || !ALLOWED_FEED_HOSTS.has(feed.hostname)) {
      return fail(403, 'Bu adres izinli değil', origin);
    }

    const cache = caches.default;
    const cacheKey = new Request(feed.toString(), { method: 'GET' });
    let upstream = await cache.match(cacheKey);

    if (!upstream) {
      let res;
      try {
        res = await fetch(feed.toString(), {
          headers: { 'User-Agent': 'tarikdonat-rss/1.0 (+https://tarikdonat.com)', Accept: 'application/rss+xml, application/xml, text/xml' },
          cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
        });
      } catch {
        return fail(502, 'Kaynağa ulaşılamadı', origin);
      }
      if (!res.ok) return fail(502, 'Kaynak hata döndü: ' + res.status, origin);
      const body = await res.text();
      upstream = new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'public, max-age=' + CACHE_SECONDS },
      });
      ctx.waitUntil(cache.put(cacheKey, upstream.clone()));
    }

    const headers = new Headers(upstream.headers);
    headers.set('Content-Type', 'text/xml; charset=utf-8');
    for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
    return new Response(upstream.body, { status: 200, headers });
  },
};
