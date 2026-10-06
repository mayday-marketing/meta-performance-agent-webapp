/* ==========================================================
   _auth.js — dashboardtokens en de wachtwoordcontrole
   ==========================================================
   Gedeelde module (underscore-prefix = geen Vercel-route). auth.js gebruikt hem
   bij het inloggen; mcp.js om binnen hetzelfde proces een kortlevend token te
   maken voor de klant die een tool opvraagt, zodat elke bestaande handler zijn
   eigen verifyToken en isolatiecontrole gewoon blijft doen. oauth.js gebruikt
   dezelfde wachtwoordcontrole en dezelfde rem: er is één manier om in te loggen.

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

/* ---------- Rem op mislukte pogingen (per instantie) ----------
   Geen vervanging voor een Vercel Firewall-regel op /api/auth en
   /oauth/authorize: een koude instantie begint weer bij nul. Wel een rem op een
   script dat vanaf één adres wachtwoorden probeert. Telt alleen mislukte
   pogingen, per IP én per klantcode, zodat één aanvaller niet elke code apart
   tien kansen geeft en een klant niet buitengesloten wordt door één IP. */
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_MAX_PER_IP = 10;
const FAIL_MAX_PER_CLIENT = 20;
const fails = new Map();

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || String(req.headers['x-real-ip'] || '') || 'onbekend';
}

function recent(key) {
  const now = Date.now();
  const list = (fails.get(key) || []).filter(t => now - t < FAIL_WINDOW_MS);
  if (list.length) fails.set(key, list); else fails.delete(key);
  return list;
}

function loginBlocked(req, rawId) {
  const id = String(rawId || '').trim().toLowerCase().slice(0, 40);
  return recent(`ip:${clientIp(req)}`).length >= FAIL_MAX_PER_IP
    || (id && recent(`id:${id}`).length >= FAIL_MAX_PER_CLIENT);
}

function loginFailed(req, rawId) {
  const id = String(rawId || '').trim().toLowerCase().slice(0, 40);
  const now = Date.now();
  for (const k of [`ip:${clientIp(req)}`, id ? `id:${id}` : null].filter(Boolean)) {
    fails.set(k, recent(k).concat(now));
  }
  if (fails.size > 5000) fails.delete(fails.keys().next().value);
}

module.exports = { signToken, checkPassword, loginBlocked, loginFailed, clientIp };
