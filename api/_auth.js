/* ==========================================================
   _auth.js — dashboardtokens en de wachtwoordcontrole
   ==========================================================
   Gedeelde module (underscore-prefix = geen Vercel-route). auth.js gebruikt hem
   bij het inloggen; mcp.js om binnen hetzelfde proces een kortlevend token te
   maken voor de klant die een tool opvraagt, zodat elke bestaande handler zijn
   eigen verifyToken en isolatiecontrole gewoon blijft doen. oauth.js gebruikt
   dezelfde wachtwoordcontrole en dezelfde rem: er is één manier om in te loggen.
   loginBlocked/loginFailed zijn async (Runtime Cache), dus altijd awaiten.

   Vorm: base64("<clientId>:<ts>:<HMAC-SHA256(clientId:ts, AUTH_SECRET)>").
   AUTH_SECRET heeft bewust geen terugval: ontbreekt hij, dan gooit de HMAC en
   faalt alles gesloten (zie CLAUDE.md).
   ========================================================== */

const crypto = require('crypto');

function signToken(clientId) {
  const ts = Date.now();
  const payload = `${clientId}:${ts}`;
  const sig = crypto.createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64');
}

function parseClients() {
  try {
    const c = JSON.parse(process.env.CLIENTS || '{}');
    return (c && typeof c === 'object' && !Array.isArray(c)) ? c : null;
  } catch { return null; }
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

// Klantcode + wachtwoord tegen CLIENTS. Timing-veilig: beide kanten worden
// gehasht (vaste lengte, dus de lengte van het echte wachtwoord lekt niet), en
// ook bij een onbekende klantcode wordt er vergeleken, zodat het antwoord niet
// sneller komt voor een code die niet bestaat.
// Geeft { ok, clientId, client } of { ok:false, config:true } bij een kapotte CLIENTS.
function checkPassword(rawId, password) {
  const clients = parseClients();
  if (!clients) return { ok: false, config: true };
  const clientId = String(rawId || '').trim().toLowerCase();
  const known = Object.prototype.hasOwnProperty.call(clients, clientId);
  const client = known ? clients[clientId] : null;
  const expected = client && typeof client.password === 'string' && client.password ? client.password : null;
  const eq = crypto.timingSafeEqual(sha256(password || ''), sha256(expected == null ? crypto.randomBytes(16).toString('hex') : expected));
  return eq && expected != null ? { ok: true, clientId, client } : { ok: false };
}

/* ---------- Rem op mislukte pogingen ----------
   Twee lagen. De Map hieronder is per instantie en reageert meteen; de Vercel
   Runtime Cache (@vercel/functions, per regio, overleeft koude starts en wordt
   door alle instanties gedeeld) is het gedeelde geheugen. Zonder die tweede laag
   begon de teller bij elke koude instantie weer op nul — en de Firewall-regel
   'Login rate limit' grijpt op dit project niet in (zie docs/ROADMAP.md).

   De cache is geen database: get/set is niet atomair, dus twee gelijktijdige
   pogingen kunnen er één missen, en een entry kan vroeger weg zijn (LRU). Voor
   een rem is dat goed genoeg; het is geen boekhouding. Lokaal (vercel dev) of
   bij een cachefout valt alles stil terug op de Map.

   Telt alleen mislukte pogingen, per IP én per klantcode, zodat één aanvaller
   niet elke code apart tien kansen krijgt en een klant niet buitengesloten
   wordt door één IP. */
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_MAX_PER_IP = 10;
const FAIL_MAX_PER_CLIENT = 20;
const fails = new Map();

let runtimeCache = null;
function cache() {
  if (runtimeCache === null) {
    try { runtimeCache = require('@vercel/functions').getCache({ namespace: 'login' }); }
    catch { runtimeCache = false; }
  }
  return runtimeCache || null;
}

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || String(req.headers['x-real-ip'] || '') || 'onbekend';
}

// IP en klantcode niet in klare tekst als cachesleutel.
const keyOf = (kind, v) => `${kind}:${crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 32)}`;

function keysFor(req, rawId) {
  const id = String(rawId || '').trim().toLowerCase().slice(0, 40);
  return [[keyOf('ip', clientIp(req)), FAIL_MAX_PER_IP], id ? [keyOf('id', id), FAIL_MAX_PER_CLIENT] : null].filter(Boolean);
}

const prune = (list, now) => list.filter(t => now - t < FAIL_WINDOW_MS);

function localRecent(key, now) {
  const list = prune(fails.get(key) || [], now);
  if (list.length) fails.set(key, list); else fails.delete(key);
  return list;
}

async function sharedRecent(key, now) {
  const c = cache();
  if (!c) return null;
  try {
    const v = await c.get(key);
    return Array.isArray(v) ? prune(v, now) : [];
  } catch (e) {
    console.warn('[auth] runtime cache lezen mislukt:', e && e.message);
    return null;
  }
}

async function loginBlocked(req, rawId) {
  const now = Date.now();
  for (const [key, max] of keysFor(req, rawId)) {
    if (localRecent(key, now).length >= max) return true;
    const shared = await sharedRecent(key, now);
    if (shared && shared.length >= max) return true;
  }
  return false;
}

async function loginFailed(req, rawId) {
  const now = Date.now();
  const c = cache();
  for (const [key] of keysFor(req, rawId)) {
    fails.set(key, localRecent(key, now).concat(now));
    if (!c) continue;
    try {
      // Samenvoegen met wat er al staat, niet overschrijven: anders wist een
      // instantie met een lege Map de stand van de andere.
      // De langste lijst wint; geen Set, want gelijke timestamps vallen dan samen.
      const shared = (await sharedRecent(key, now)) || [];
      const mine = fails.get(key);
      const merged = (shared.length > mine.length ? shared : mine).slice(-50);
      await c.set(key, merged, { ttl: Math.ceil(FAIL_WINDOW_MS / 1000), name: 'login-rem' });
    } catch (e) {
      console.warn('[auth] runtime cache schrijven mislukt:', e && e.message);
    }
  }
  if (fails.size > 5000) fails.delete(fails.keys().next().value);
}

module.exports = { signToken, checkPassword, loginBlocked, loginFailed, clientIp };
