/* ==========================================================
   _throttle.js — rem per klant op calls die geld kosten
   ==========================================================
   Chat en rapportduiding lopen op de gedeelde Anthropic-sleutel, de SEO-rank-
   check en de GEO-bronnen op het gedeelde DataForSEO-saldo. Een geldig
   dashboardtoken (10 uur) mag die niet in een lus kunnen aanroepen. Deze rem
   telt per klant en per soort call, in een venster.

   Zelfde opzet als de login-rem in _auth.js: een Map per instantie als snelle
   laag, de Vercel Runtime Cache (per regio, overleeft koude starts) als gedeeld
   geheugen. Niet atomair, dus bij gelijktijdige calls kan er één doorglippen —
   voor een rem is dat prima. Lokaal of bij een cachefout: alleen de Map.

   Gebruik, pas ná verifyToken en pas na de eigen cache (een cache-hit kost
   niets en hoort niet te tellen):
     const t = await takeBudget('seo-rank', clientId, 6, 3600);
     if (!t.ok) return res.status(429).json({ error: t.message });
   ========================================================== */

const crypto = require('crypto');

const local = new Map();

let runtimeCache = null;
function cache() {
  if (runtimeCache === null) {
    try { runtimeCache = require('@vercel/functions').getCache({ namespace: 'throttle' }); }
    catch { runtimeCache = false; }
  }
  return runtimeCache || null;
}

const keyOf = (scope, clientId) =>
  `${scope}:${crypto.createHash('sha256').update(String(clientId).toLowerCase()).digest('hex').slice(0, 24)}`;

const prune = (list, now, windowMs) => (Array.isArray(list) ? list : []).filter(t => now - t < windowMs);

function minutesText(sec) {
  const m = Math.ceil(sec / 60);
  return m <= 1 ? 'een minuut' : `${m} minuten`;
}

/**
 * Probeert één eenheid uit het budget te nemen.
 * @returns {{ ok: true } | { ok: false, retryAfter: number, message: string }}
 */
async function takeBudget(scope, clientId, max, windowSec) {
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const key = keyOf(scope, clientId);
  const c = cache();

  let list = prune(local.get(key), now, windowMs);
  if (c) {
    try {
      // De langste lijst wint. Geen Set-samenvoeging: twee calls in dezelfde
      // milliseconde hebben dezelfde timestamp en zouden dan als één tellen.
      const shared = prune(await c.get(key), now, windowMs);
      if (shared.length > list.length) list = shared;
    } catch (e) {
      console.warn('[throttle] runtime cache lezen mislukt:', e && e.message);
    }
  }
  list.sort((a, b) => a - b);

  if (list.length >= max) {
    const retryAfter = Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000));
    return {
      ok: false,
      retryAfter,
      message: `Even geduld: dit mag ${max} keer per ${minutesText(windowSec)}. Probeer het over ${minutesText(retryAfter)} opnieuw.`,
    };
  }

  list = list.concat(now).slice(-Math.max(max, 1) * 2);
  local.set(key, list);
  if (local.size > 5000) local.delete(local.keys().next().value);
  if (c) {
    try { await c.set(key, list, { ttl: windowSec, name: `rem-${scope}` }); }
    catch (e) { console.warn('[throttle] runtime cache schrijven mislukt:', e && e.message); }
  }
  return { ok: true };
}

module.exports = { takeBudget };
