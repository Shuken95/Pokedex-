/**
 * pokedex-avisos — Cloudflare Worker
 *
 * Endpoints que espera index.html de Mi Pokédex:
 *   GET  /push-key          → { key: VAPID_PUBLIC_KEY }
 *   POST /subscribe         → registra suscripción Web Push  (header x-sync-key)
 *   POST /unsubscribe       → borra suscripción
 *   POST /sync              → guarda alertas de precio + lanzamientos
 *   POST /test              → envía notificación de prueba
 *
 * Extra (imágenes compartidas de cartas manuales):
 *   POST /upload            → sube imagen a R2, devuelve URL pública
 *   GET  /img/:id           → sirve la imagen
 *   DELETE /img/:id         → borra (con x-sync-key)
 *
 * Cron (wrangler.toml): revisa precios TCGdex/Cardmarket y manda push
 * cuando una carta baja de tu objetivo, o el día de un lanzamiento.
 */

// OJO: la librería 'web-push' de npm NO funciona en Cloudflare Workers (usa https.request de Node,
// que aquí no existe). Usamos la misma librería WebCrypto que el Worker de intercambios.
import { buildPushPayload } from '@block65/webcrypto-web-push';

async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

function corsHeaders(origin, env) {
  const allowed = (env.CORS_ORIGINS || '*').split(',').map((s) => s.trim());
  const ok = allowed.includes('*') || (origin && allowed.includes(origin));
  return {
    'access-control-allow-origin': ok ? origin || '*' : allowed[0] || '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, x-sync-key, x-collection-token, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access',
    'access-control-max-age': '86400',
  };
}

function withCors(res, origin, env) {
  const h = corsHeaders(origin, env);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(h)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

function auth(req, env) {
  const key = req.headers.get('x-sync-key') || '';
  return !!(env.SYNC_SECRET && key && key === env.SYNC_SECRET);
}

function todayISO(tz = 'Europe/Madrid') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function vapidConfigured(env) {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}


const SUBS_KEY = 'subs:list';
const STATE_KEY = 'state:alerts';
const MAX_SUBS = 50;

async function loadSubs(env) {
  try {
    const raw = await env.STORE.get(SUBS_KEY, 'json');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function saveSubs(env, list) {
  await env.STORE.put(SUBS_KEY, JSON.stringify(list.slice(0, MAX_SUBS)));
}

async function loadState(env) {
  try {
    const raw = await env.STORE.get(STATE_KEY, 'json');
    return raw && typeof raw === 'object'
      ? {
          items: Array.isArray(raw.items) ? raw.items : [],
          releases: Array.isArray(raw.releases) ? raw.releases : [],
          alerted: raw.alerted && typeof raw.alerted === 'object' ? raw.alerted : {},
          released: raw.released && typeof raw.released === 'object' ? raw.released : {},
          prices: raw.prices && typeof raw.prices === 'object' ? raw.prices : {},
          changes: Array.isArray(raw.changes) ? raw.changes : [],
          portfolio: raw.portfolio && typeof raw.portfolio === 'object' ? raw.portfolio : null,
          lastPush: raw.lastPush && typeof raw.lastPush === 'object' ? raw.lastPush : null,
          summarySent: raw.summarySent || '',
          updatedAt: raw.updatedAt || 0,
        }
      : { items: [], releases: [], alerted: {}, released: {}, prices: {}, changes: [], portfolio: null, lastPush: null, summarySent: '', updatedAt: 0 };
  } catch {
    return { items: [], releases: [], alerted: {}, released: {}, prices: {}, changes: [], portfolio: null, lastPush: null, summarySent: '', updatedAt: 0 };
  }
}

async function saveState(env, state) {
  state.updatedAt = Date.now();
  await env.STORE.put(STATE_KEY, JSON.stringify(state));
}

async function sendPush(env, subscription, payload) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  const sub = {
    endpoint: subscription.endpoint,
    expirationTime: null,
    keys: { p256dh: subscription.keys && subscription.keys.p256dh, auth: subscription.keys && subscription.keys.auth },
  };
  try {
    const init = await buildPushPayload({ data, options: { ttl: 60 * 60 * 12, urgency: 'high' } }, sub, vapid);
    const res = await fetch(sub.endpoint, init);
    if (res.ok) return { ok: true, status: res.status };
    const text = (await res.text().catch(() => '')).slice(0, 200);
    if (res.status === 404 || res.status === 410) return { ok: false, dead: true, status: res.status };
    console.error('push fallo', res.status, text);
    return { ok: false, status: res.status, error: 'HTTP ' + res.status + (text ? ': ' + text : '') };
  } catch (err) {
    console.error('push error', err);
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

async function broadcast(env, payload) {
  if (!vapidConfigured(env)) return { sent: 0, dead: 0, errors: [] };
  const subs = await loadSubs(env);
  if (!subs.length) return { sent: 0, dead: 0, errors: [] };
  let sent = 0;
  const dead = [];
  const errors = [];
  await Promise.all(
    subs.map(async (sub) => {
      const r = await sendPush(env, sub, payload);
      if (r.ok) sent++;
      else if (r.dead) dead.push(sub.endpoint);
      else errors.push(r.error || 'error');
    })
  );
  if (dead.length) {
    await saveSubs(env, subs.filter((s) => !dead.includes(s.endpoint)));
  }
  return { sent, dead: dead.length, errors };
}

function pickPrice(cm) {
  if (!cm || typeof cm !== 'object') return null;
  const candidates = [cm.trend, cm.avg, cm.low, cm.averageSellPrice, cm.lowestPrice];
  for (const c of candidates) {
    const n = typeof c === 'number' ? c : parseFloat(String(c || '').replace(',', '.'));
    if (!isNaN(n) && n > 0) return Math.round(n * 100) / 100;
  }
  return null;
}

async function priceFromTcgdex(id) {
  if (!id || id.indexOf('custom-') === 0) return null;
  try {
    const res = await fetch('https://api.tcgdex.net/v2/en/cards/' + encodeURIComponent(id), {
      headers: { accept: 'application/json' },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!res.ok) return null;
    const data = await res.json();
    let price = pickPrice(data && data.pricing && data.pricing.cardmarket);
    if (price !== null) return price;
    const variants = Array.isArray(data && data.variants_detailed) ? data.variants_detailed : [];
    for (const v of variants) {
      price = pickPrice(v && v.pricing && v.pricing.cardmarket);
      if (typeof price === 'number' && price > 0) return price;
    }
    return null;
  } catch {
    return null;
  }
}

async function priceFromCardmarketUrl(url) {
  if (!url || url.indexOf('cardmarket.com') === -1) return null;
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; PokedexAvisos/1.0; +https://workers.dev)',
        accept: 'text/html',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const patterns = [
      /"price":\s*"?([\d]+[.,][\d]{2})"?/,
      /data-price="([\d]+[.,][\d]{2})"/,
      /itemprop="price"\s+content="([\d.]+)"/,
      /Average Price[^0-9]*([\d]+[.,][\d]{2})/i,
      /From[^0-9]*([\d]+[.,][\d]{2})\s*€/i,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m) {
        const n = parseFloat(m[1].replace(',', '.'));
        if (!isNaN(n) && n > 0) return Math.round(n * 100) / 100;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function resolvePrice(item) {
  if (item.url) {
    const p = await priceFromCardmarketUrl(item.url);
    if (p != null) return p;
  }
  return priceFromTcgdex(item.id);
}

async function runPriceCheck(env) {
  const state = await loadState(env);
  const items = state.items || [];
  if (!items.length && !(state.releases || []).length) {
    return { checked: 0, alerts: 0, releases: 0 };
  }

  let alerts = 0;
  const notifications = [];
  const now = Date.now();

  for (const it of items) {
    if (!it || !it.id) continue;
    const price = await resolvePrice(it);
    if (price == null) continue;

    // Seguimiento de precio de TODAS las cartas seguidas, tengan o no precio objetivo.
    // Antes solo se median las que tinham objetivo, asi que el resumen diario se quedaba
    // sin datos que enviar.
    const previousPrice = state.prices[it.id];
    if (typeof previousPrice === 'number' && Math.abs(price - previousPrice) >= 0.004) {
      state.changes.push({ id: it.id, name: it.name, from: previousPrice, to: price, at: now });
    }
    state.prices[it.id] = price;
    const hasTarget = typeof it.target === 'number' && it.target > 0;
    const prevAlert = state.alerted[it.id];
    if (hasTarget && price <= it.target) {
      if (prevAlert == null || price < prevAlert - 0.004) {
        state.alerted[it.id] = price;
        alerts++;
        notifications.push({
          title: 'Bajada de precio',
          body:
            it.name +
            ': ' +
            price.toFixed(2).replace('.', ',') +
            ' € (objetivo ≤ ' +
            Number(it.target).toFixed(2).replace('.', ',') +
            ' €)',
          tag: 'price-' + it.id,
          data: { type: 'price', id: it.id },
        });
      }
    } else if (hasTarget && prevAlert != null && price > it.target) {
      delete state.alerted[it.id];
    }
  }

  const today = todayISO();
  let releasesHit = 0;
  for (const r of state.releases || []) {
    if (!r || !r.d || !r.n) continue;
    if (r.d !== today) continue;
    const key = r.d + '|' + r.n;
    if (state.released[key]) continue;
    state.released[key] = Date.now();
    releasesHit++;
    notifications.push({
      title: 'Lanzamiento hoy',
      body: r.n,
      tag: 'release-' + key,
      data: { type: 'release', d: r.d, n: r.n },
    });
  }

  const changesCutoff = now - 24 * 60 * 60 * 1000;
  state.changes = (state.changes || []).filter((c) => c && c.at >= changesCutoff).slice(-500);
  const cutoff = Date.now() - 30 * 864e5;
  for (const k of Object.keys(state.released)) {
    if (state.released[k] < cutoff) delete state.released[k];
  }

  // Resumen diario a las 09:00 en hora de Madrid. El Cron corre a las 07:00 y 08:00 UTC:
  // uno de los dos coincide siempre con las 09:00 locales (cambio de hora incluido) y
  // el otro se descarta. Se envia siempre, aunque no haya cambios de precio.
  const localHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hour12: false }).format(new Date());
  const localDay = todayISO();
  if (localHour >= 9 && localHour < 20 && state.summarySent !== localDay) {
    const top = state.changes.slice().sort((a, b) => Math.abs((b.to - b.from) / b.from) - Math.abs((a.to - a.from) / a.from)).slice(0, 4);
    const parts = [];
    const pf = state.portfolio;
    if (pf && typeof pf.total === 'number') {
      let valueTxt = 'Tu colección vale ' + pf.total.toFixed(2).replace('.', ',') + ' €';
      if (typeof pf.prevTotal === 'number' && Math.abs(pf.total - pf.prevTotal) >= 0.01) {
        const diff = pf.total - pf.prevTotal;
        valueTxt += ' (' + (diff > 0 ? '+' : '') + diff.toFixed(2).replace('.', ',') + ' € desde el último día)';
      }
      parts.push(valueTxt);
    }
    if (top.length) {
      parts.push(top.map((c) => c.name + ': ' + c.from.toFixed(2).replace('.', ',') + ' → ' + c.to.toFixed(2).replace('.', ',') + ' €').join(' · '));
    } else {
      parts.push('Tus cartas seguidas no han tenido cambios de precio en las últimas 24 h.');
    }
    const upcoming = (state.releases || []).filter((r) => r && r.d && r.d >= localDay).sort((a, b) => (a.d < b.d ? -1 : 1)).slice(0, 2);
    if (upcoming.length) parts.push('Próximos lanzamientos: ' + upcoming.map((r) => r.n + ' (' + r.d + ')').join(' · '));
    notifications.unshift({ title: 'Tu día en la Pokédex', body: parts.join(' · ').slice(0, 240), tag: 'daily-price-summary-' + localDay, data: { type: 'daily-summary' } });
    state.summarySent = localDay;
  }

  await saveState(env, state);

  const pushResults = [];
  for (const n of notifications) {
    const r = await broadcast(env, {
      title: n.title,
      body: n.body,
      tag: n.tag,
      data: n.data || {},
    });
    pushResults.push({ title: n.title, body: n.body, tag: n.tag, sent: r.sent, dead: r.dead, errors: r.errors });
  }
  state.lastPush = { at: Date.now(), sent: pushResults.reduce((a, b) => a + (b.sent || 0), 0), results: pushResults.slice(-5) };
  await saveState(env, state);

  return { checked: items.length, alerts, releases: releasesHit, sent: notifications.length };
}

function safeImageId(id) {
  return String(id || '')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .slice(0, 80);
}

function contentTypeFromName(name, fallback) {
  const n = (name || '').toLowerCase();
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.webp')) return 'image/webp';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  return fallback || 'image/jpeg';
}

async function handleUpload(req, env) {
  if (!env.IMAGES) return json({ error: 'R2 no configurado (binding IMAGES)' }, 500);

  const ct = req.headers.get('content-type') || '';
  let bytes, mime, id;

  if (ct.includes('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('file') || form.get('image');
    if (!file || typeof file.arrayBuffer !== 'function') {
      return json({ error: 'Falta el archivo (campo file o image)' }, 400);
    }
    bytes = new Uint8Array(await file.arrayBuffer());
    mime = file.type || contentTypeFromName(file.name, 'image/jpeg');
    id = safeImageId(form.get('id') || crypto.randomUUID());
  } else if (ct.includes('application/json')) {
    const body = await req.json().catch(() => null);
    if (!body || !body.data) return json({ error: 'Falta data (base64)' }, 400);
    const b64 = String(body.data).replace(/^data:[^;]+;base64,/, '');
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    mime = body.mime || 'image/jpeg';
    id = safeImageId(body.id || crypto.randomUUID());
  } else {
    bytes = new Uint8Array(await req.arrayBuffer());
    mime = ct.split(';')[0] || 'image/jpeg';
    id = safeImageId(req.headers.get('x-image-id') || crypto.randomUUID());
  }

  if (!bytes.byteLength) return json({ error: 'Imagen vacía' }, 400);
  if (bytes.byteLength > 4 * 1024 * 1024) {
    return json({ error: 'Máximo 4 MB por imagen' }, 413);
  }
  if (!id) id = crypto.randomUUID();

  const key = 'cards/' + id;
  await env.IMAGES.put(key, bytes, {
    httpMetadata: {
      contentType: mime,
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: { uploadedAt: String(Date.now()) },
  });

  const base = new URL(req.url).origin;
  const url = base + '/img/' + encodeURIComponent(id);
  return json({ ok: true, id, url, bytes: bytes.byteLength });
}

async function handleGetImage(id, env) {
  if (!env.IMAGES) return new Response('R2 no configurado', { status: 500 });
  const key = 'cards/' + safeImageId(id);
  const obj = await env.IMAGES.get(key);
  if (!obj) return new Response('No encontrada', { status: 404 });
  const headers = new Headers();
  headers.set('content-type', obj.httpMetadata?.contentType || 'image/jpeg');
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('access-control-allow-origin', '*');
  return new Response(obj.body, { headers });
}

async function handleRequest(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const origin = req.headers.get('origin') || '';

  if (req.method === 'OPTIONS') {
    return withCors(new Response(null, { status: 204 }), origin, env);
  }

  if (path === '/' || path === '/health') {
    return withCors(
      json({
        ok: true,
        name: env.APP_NAME || 'pokedex-avisos',
        push: vapidConfigured(env),
        images: !!env.IMAGES,
      }),
      origin,
      env
    );
  }

  if (path === '/ai-models' && req.method === 'GET') {
    const groqKey = String(env.GROQ_API_KEY || '').trim().replace(/^['"]|['"]$/g, '');
    const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: 'Bearer ' + groqKey } });
    const d = await r.json().catch(() => ({}));
    return withCors(json({ status: r.status, models: Array.isArray(d.data) ? d.data.map((m) => m.id) : [], error: d.error || null }), origin, env);
  }

  if (path === '/ai' && req.method === 'POST') {
    if (!env.GROQ_API_KEY) return withCors(json({ error: 'IA no configurada' }, 503), origin, env);
    const body = await req.json().catch(() => null);
    if (!body || !Array.isArray(body.messages)) return withCors(json({ error: 'Faltan mensajes' }, 400), origin, env);

    const groqContent = (content) => {
      if (!Array.isArray(content)) return String(content || '');
      const parts = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && block.text) {
          parts.push({ type: 'text', text: String(block.text) });
        } else if (block.type === 'image') {
          const source = block.source || {};
          if (source.type === 'base64' && source.data) {
            const mime = /^image\/(jpeg|png|gif|webp)$/i.test(source.media_type || '') ? source.media_type : 'image/jpeg';
            parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${source.data}` } });
          } else if (source.type === 'url' && source.url) {
            parts.push({ type: 'image_url', image_url: { url: String(source.url) } });
          }
        }
      }
      if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
      return parts;
    };

    const messages = [];
    if (body.system) {
      const systemText = Array.isArray(body.system)
        ? body.system.filter((part) => part && part.type === 'text').map((part) => part.text).join('\n')
        : String(body.system);
      if (systemText) messages.push({ role: 'system', content: systemText });
    }
    for (const m of body.messages) {
      if (!m) continue;
      const content = groqContent(m.content);
      if ((typeof content === 'string' && content.trim()) || (Array.isArray(content) && content.length)) {
        messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
      }
    }
    if (!messages.length) return withCors(json({ error: 'Faltan mensajes' }, 400), origin, env);

    const hasImage = messages.some((m) => Array.isArray(m.content) && m.content.some((part) => part.type === 'image_url'));
    const wantsBrowserSearch = Array.isArray(body.tools) && body.tools.some((tool) =>
      tool && /web_search|browser_search/i.test(String(tool.type || '') + ' ' + String(tool.name || ''))
    );
    // Groq Qwen sirve las peticiones normales y con imagen; GPT-OSS añade búsqueda web cuando la app la solicita.
    const model = wantsBrowserSearch ? 'openai/gpt-oss-20b' : 'qwen/qwen3.8-27b';
    const payload = {
      model,
      messages,
      max_completion_tokens: Math.min(Number(body.max_tokens || body.max_completion_tokens) || 2048, 8192),
      temperature: 0.2,
      stream: false,
    };
    if (wantsBrowserSearch) {
      payload.tools = [{ type: 'browser_search' }];
      payload.tool_choice = 'required';
    }

    const groqKey = String(env.GROQ_API_KEY || '').trim().replace(/^['"]|['"]$/g, '');
    const groq = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + groqKey },
      body: JSON.stringify(payload),
    });
    const result = await groq.json().catch(() => ({}));
    if (!groq.ok) {
      const detail = result && result.error ? String(result.error.message || result.error.code || '') : '';
      return withCors(json({ error: 'Groq no disponible', status: groq.status, detail }, 502), origin, env);
    }
    const choice = result.choices && result.choices[0] || {};
    const answer = choice.message || {};
    const text = String(answer.content || answer.reasoning || '');
    return withCors(json({
      id: result.id || 'groq',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: choice.finish_reason === 'length' ? 'max_tokens' : choice.finish_reason || 'stop',
      model: result.model || model,
    }), origin, env);
  }

  if (path === '/summary' && req.method === 'GET') {
    if (!auth(req, env)) return withCors(json({ error: 'No autorizado' }, 401), origin, env);
    const state = await loadState(env);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const changes = (state.changes || []).filter((c) => c && c.at >= cutoff);
    const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 24 * 60 * 60 * 1000));
    const releaseDays = new Set([todayISO(), tomorrow]);
    const releases = (state.releases || []).filter((r) => r && r.d && r.n && releaseDays.has(r.d));
    return withCors(json({ changes, releases, portfolio: state.portfolio || null, updatedAt: state.updatedAt || 0 }), origin, env);
  }

  if (path === '/push-key' && req.method === 'GET') {
    if (!vapidConfigured(env)) {
      return withCors(json({ error: 'Push no configurado en el Worker' }, 503), origin, env);
    }
    return withCors(json({ key: env.VAPID_PUBLIC_KEY }), origin, env);
  }

  if (path.startsWith('/img/') && req.method === 'GET') {
    const id = decodeURIComponent(path.slice(5));
    return handleGetImage(id, env);
  }

  if (path.startsWith('/ptcg-img/') && req.method === 'GET') {
    if (!env.IMAGES) return new Response('R2 no configurado', { status: 500 });
    const id = safeImageId(decodeURIComponent(path.slice(10)));
    const obj = await env.IMAGES.get('ptcg/' + id);
    if (!obj) return new Response('No encontrada', { status: 404 });
    const headers = new Headers({ 'content-type': obj.httpMetadata?.contentType || 'image/webp', 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' });
    return new Response(obj.body, { headers });
  }

  // Imágenes corregidas por usuarios para cartas que TCGdex tiene catalogadas pero sin escaneo.
  // Se guardan como URLs públicas en KV, asociadas al ID estable de TCGdex.
  function sharedCardImageKey(id) { return 'card-image:' + safeImageId(id); }
  if (path === '/card-images' && req.method === 'GET') {
    const ids = (url.searchParams.get('ids') || '').split(',').map((id) => safeImageId(id)).filter(Boolean).slice(0, 100);
    const images = {};
    await Promise.all(ids.map(async (id) => {
      const value = await env.STORE.get(sharedCardImageKey(id), 'json').catch(() => null);
      if (value && value.url) images[id] = value.url;
    }));
    return withCors(json({ images }), origin, env);
  }

  // Fuente adicional opcional: catálogo japonés de PokémonTCGAPI. La clave vive solo
  // como secreto del Worker y las respuestas se cachean en KV para no gastar créditos
  // en cada apertura de la app.
  if (path === '/ptcg-images' && req.method === 'GET') {
    if (!env.PTCG_API_KEY) return withCors(json({ error: 'Fuente japonesa no configurada' }, 503), origin, env);
    const name = String(url.searchParams.get('name') || '').trim().slice(0, 80);
    if (!name) return withCors(json({ error: 'Falta el nombre' }, 400), origin, env);
    const cacheKey = 'ptcg-jp-v2:' + await sha256(name);
    const cached = await env.STORE.get(cacheKey, 'json').catch(() => null);
    if (cached && Array.isArray(cached.cards)) return withCors(json({ cards: cached.cards, cached: true }), origin, env);
    const api = 'https://api.pokemontcgapi.com/v1/cards?q=' + encodeURIComponent('name:' + name + ' set.region:JP') + '&limit=100&include=images';
    const res = await fetch(api, { headers: { 'X-Api-Key': env.PTCG_API_KEY } });
    if (!res.ok) return withCors(json({ error: 'Fuente japonesa no disponible', status: res.status }, 502), origin, env);
    const data = await res.json().catch(() => ({}));
    const cards = (data.data || []).map((c) => ({
      id: String(c.id || ''), number: String(c.number || ''), name: String(c.name || ''),
      set: String(c.set_name || ''), image: Array.isArray(c.images) && c.images[0] ? String(c.images[0].url || '') : ''
    })).filter((c) => c.id && c.image);
    if (env.IMAGES) {
      await Promise.all(cards.map(async (card) => {
        try {
          const imageRes = await fetch(card.image);
          if (!imageRes.ok) return;
          const bytes = await imageRes.arrayBuffer();
          const key = safeImageId(card.id);
          await env.IMAGES.put('ptcg/' + key, bytes, { httpMetadata: { contentType: imageRes.headers.get('content-type') || 'image/webp', cacheControl: 'public, max-age=31536000, immutable' } });
          card.image = new URL('/ptcg-img/' + encodeURIComponent(key), req.url).toString();
        } catch (_) {}
      }));
    }
    await env.STORE.put(cacheKey, JSON.stringify({ cards, at: Date.now() }), { expirationTtl: 2592000 });
    return withCors(json({ cards, cached: false }), origin, env);
  }

  // Sincronización cifrada de colecciones. El token es una capacidad secreta generada
  // por el navegador; el Worker solo almacena el blob cifrado y su versión.
  if (path === '/collection' && (req.method === 'GET' || req.method === 'PUT' || req.method === 'DELETE')) {
    const token = String(req.headers.get('x-collection-token') || '').trim();
    if (!/^[A-Za-z0-9_-]{40,80}$/.test(token)) return withCors(json({ error: 'Código de sincronización no válido' }, 401), origin, env);
    const key = 'collection:' + await sha256(token);
    if (req.method === 'GET') {
      const saved = await env.STORE.get(key, 'json').catch(() => null);
      return withCors(json(saved || { version: 0, payload: null, updatedAt: 0 }), origin, env);
    }
    if (req.method === 'DELETE') {
      await env.STORE.delete(key);
      return withCors(json({ ok: true }), origin, env);
    }
    const body = await req.json().catch(() => null);
    const version = Number(body && body.version);
    const baseVersion = Number(body && body.baseVersion || 0);
    const payload = body && typeof body.payload === 'string' ? body.payload : '';
    if (!Number.isSafeInteger(version) || version <= 0 || !payload || payload.length > 1800000) {
      return withCors(json({ error: 'Colección cifrada inválida o demasiado grande' }, 400), origin, env);
    }
    const current = await env.STORE.get(key, 'json').catch(() => null);
    if (current && Number(current.version || 0) !== baseVersion) {
      return withCors(json({ error: 'conflict', current: { version: current.version || 0, payload: current.payload || null, updatedAt: current.updatedAt || 0 } }, 409), origin, env);
    }
    const saved = { version, payload, updatedAt: Date.now() };
    await env.STORE.put(key, JSON.stringify(saved), { expirationTtl: 31536000 });
    return withCors(json({ ok: true, version, updatedAt: saved.updatedAt }), origin, env);
  }

  const needsAuth =
    ['/sync', '/upload', '/check', '/card-image'].includes(path) ||
    (path.startsWith('/img/') && req.method === 'DELETE');

  if (needsAuth && !auth(req, env)) {
    return withCors(
      json({ error: 'No autorizado. Revisa la clave (x-sync-key / SYNC_SECRET).' }, 401),
      origin,
      env
    );
  }

  if (path === '/card-image' && req.method === 'POST') {
    const body = await req.json().catch(() => null);
    const id = safeImageId(body && (body.id || body.cardId));
    const sourceUrl = String(body && (body.url || body.image) || '').trim();
    if (!id || !/^https:\/\//i.test(sourceUrl)) return withCors(json({ error: 'ID o URL de imagen no válidos' }, 400), origin, env);
    if (!env.IMAGES) return withCors(json({ error: 'R2 no está configurado' }, 503), origin, env);
    let imageRes;
    try {
      imageRes = await fetch(sourceUrl, { headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8' } });
    } catch (e) {
      return withCors(json({ error: 'No se pudo descargar la imagen de origen' }, 502), origin, env);
    }
    if (!imageRes.ok) return withCors(json({ error: 'La imagen de origen respondió HTTP ' + imageRes.status }, 502), origin, env);
    const contentType = (imageRes.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!contentType.startsWith('image/')) return withCors(json({ error: 'La URL no devuelve una imagen' }, 415), origin, env);
    const bytes = await imageRes.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > 4 * 1024 * 1024) return withCors(json({ error: 'La imagen debe ocupar entre 1 byte y 4 MB' }, 413), origin, env);
    const objectId = 'shared-' + id;
    await env.IMAGES.put('cards/' + objectId, bytes, {
      httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
      customMetadata: { sourceUrl: sourceUrl.slice(0, 600), downloadedAt: String(Date.now()) }
    });
    const storedUrl = new URL('/img/' + encodeURIComponent(objectId), req.url).toString();
    await env.STORE.put(sharedCardImageKey(id), JSON.stringify({ url: storedUrl, sourceUrl: sourceUrl.slice(0, 600), updatedAt: Date.now() }));
    return withCors(json({ ok: true, id, url: storedUrl, sourceUrl }), origin, env);
  }

  if (path === '/sync' && req.method === 'POST') {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return withCors(json({ error: 'JSON inválido' }, 400), origin, env);
    }
    const state = await loadState(env);
    const items = Array.isArray(body.items)
      ? body.items
          .filter((it) => it && it.id && (it.target == null || (typeof it.target === 'number' && it.target > 0)))
          .map((it) => ({
            id: String(it.id).slice(0, 80),
            name: String(it.name || it.id).slice(0, 120),
            target: it.target == null ? null : Math.round(Number(it.target) * 100) / 100,
            url:
              typeof it.url === 'string' && it.url.indexOf('cardmarket.com') !== -1
                ? it.url.slice(0, 400)
                : '',
          }))
          .slice(0, 200)
      : [];
    const releases = Array.isArray(body.releases)
      ? body.releases
          .filter((r) => r && r.d && r.n)
          .map((r) => ({ d: String(r.d).slice(0, 10), n: String(r.n).slice(0, 120) }))
          .slice(0, 100)
      : [];

    const keep = new Set(items.map((i) => i.id));
    for (const id of Object.keys(state.alerted)) {
      if (!keep.has(id)) delete state.alerted[id];
    }
    if (body.portfolio && typeof body.portfolio === 'object') {
      const total = Number(body.portfolio.total);
      const cards = Number(body.portfolio.cards);
      const prevTotal = body.portfolio.prevTotal == null ? null : Number(body.portfolio.prevTotal);
      state.portfolio = {
        total: isFinite(total) ? total : 0,
        cards: isFinite(cards) ? cards : 0,
        prevTotal: isFinite(prevTotal) ? prevTotal : null,
        at: Date.now(),
      };
    }
    state.items = items;
    state.releases = releases;
    await saveState(env, state);

    const subs = await loadSubs(env);
    return withCors(
      json({
        ok: true,
        items: items.length,
        releases: releases.length,
        push: subs.length,
      }),
      origin,
      env
    );
  }

  if (path === '/subscribe' && req.method === 'POST') {
    const body = await req.json().catch(() => null);
    const sub = body && body.subscription;
    if (!sub || !sub.endpoint || !sub.keys) {
      return withCors(json({ error: 'Falta subscription' }, 400), origin, env);
    }
    const list = await loadSubs(env);
    const next = list.filter((s) => s.endpoint !== sub.endpoint);
    next.push({
      endpoint: sub.endpoint,
      keys: sub.keys,
      expirationTime: sub.expirationTime || null,
    });
    await saveSubs(env, next);
    return withCors(json({ ok: true, push: next.length }), origin, env);
  }

  if (path === '/unsubscribe' && req.method === 'POST') {
    const body = await req.json().catch(() => null);
    const endpoint = body && body.endpoint;
    if (!endpoint) return withCors(json({ error: 'Falta endpoint' }, 400), origin, env);
    const list = await loadSubs(env);
    const next = list.filter((s) => s.endpoint !== endpoint);
    await saveSubs(env, next);
    return withCors(json({ ok: true, push: next.length }), origin, env);
  }

  if (path === '/test' && req.method === 'POST') {
    if (!vapidConfigured(env)) {
      return withCors(json({ error: 'Push no configurado (faltan secretos VAPID)' }, 503), origin, env);
    }
    const subs = await loadSubs(env);
    if (!subs.length) {
      return withCors(
        json(
          {
            error:
              'No hay ningún móvil suscrito. En la app: activa notificaciones y sincroniza el Worker.',
          },
          400
        ),
        origin,
        env
      );
    }
    const r = await broadcast(env, {
      title: env.APP_NAME || 'Mi Pokédex',
      body: 'Prueba de avisos: si ves esto, el Worker puede avisarte con la app cerrada.',
      tag: 'test',
      data: { type: 'test' },
    });
    const detail = r.sent > 0 ? undefined
      : r.dead ? 'La suscripción de este móvil había caducado y se ha borrado. Vuelve a activar las notificaciones push.'
      : (r.errors && r.errors[0]) || 'No se pudo entregar el aviso.';
    return withCors(json({ ok: r.sent > 0, sent: r.sent, dead: r.dead, errors: r.errors, error: detail }), origin, env);
  }

  if (path === '/check' && req.method === 'POST') {
    const result = await runPriceCheck(env);
    return withCors(json({ ok: true, ...result }), origin, env);
  }

  if (path === '/upload' && req.method === 'POST') {
    return withCors(await handleUpload(req, env), origin, env);
  }

  if (path.startsWith('/img/') && req.method === 'DELETE') {
    if (!env.IMAGES) return withCors(json({ error: 'R2 no configurado' }, 500), origin, env);
    const id = safeImageId(decodeURIComponent(path.slice(5)));
    await env.IMAGES.delete('cards/' + id);
    return withCors(json({ ok: true }), origin, env);
  }

  return withCors(json({ error: 'No encontrado' }, 404), origin, env);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      const origin = request.headers.get('origin') || '';
      return withCors(json({ error: String(err && err.message ? err.message : err) }, 500), origin, env);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runPriceCheck(env).catch((e) => {
        console.error('cron error', e);
      })
    );
  },
};
