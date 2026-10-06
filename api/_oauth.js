/* ==========================================================
   _oauth.js — ondertekende blobs voor MCP V2 (OAuth per klant)
   ==========================================================
   Stateless: er is geen database, dus alles wat OAuth normaal bewaart
   (geregistreerde clients, autorisatiecodes, tokens) is hier een ondertekende
   blob. De server herkent zijn eigen handtekening en hoeft niets op te zoeken.

   Vorm: <prefix>.<base64url(JSON)>.<base64url(HMAC-SHA256)>

   SLEUTELS — per soort blob een eigen sleutel, afgeleid met HKDF uit
   AUTH_SECRET. Zo kan een autorisatiecode nooit als access token gelden, een
   refresh token nooit als code, en geen van allen als dashboardtoken (dat heeft
   een andere vorm én een andere sleutel). AUTH_SECRET heeft geen terugval: zonder
   gooit `key()` en faalt alles gesloten.

   INTREKKEN — een token is geldig zolang zijn `iat` niet vóór een intrekmoment
   ligt: `MCP_MIN_TS` (env, ms, voor iedereen) of `mcp_min_ts` in CLIENTS[id]
   (één klant). Zet de waarde op Date.now() en elk eerder uitgegeven token van die
   klant, refresh tokens inbegrepen, is dood.

   BEKENDE GRENZEN VAN STATELESS — een code kan binnen zijn 60 s in theorie twee
   keer ingewisseld worden, en een geroteerd refresh token blijft tot zijn
   vervaldatum bruikbaar. PKCE dekt het eerste (de verifier zit alleen bij de
   client), de intrekregel het tweede. Een in-memory lijst per instantie vangt
   hergebruik binnen dezelfde instantie op.
   ========================================================== */

const crypto = require('crypto');

const PREFIX = { reg: 'mcpc', code: 'mcpcode', at: 'mcpat', rt: 'mcprt' };
const TTL = {
  code: 60 * 1000,
  at: 24 * 60 * 60 * 1000,
  rt: 90 * 24 * 60 * 60 * 1000,
};

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256b64u = (s) => crypto.createHash('sha256').update(String(s)).digest('base64url');

const keys = new Map();
function key(typ) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET ontbreekt');
  const k = `${typ}|${secret.length}`;
  if (!keys.has(k)) {
    keys.set(k, Buffer.from(crypto.hkdfSync('sha256', secret, 'mayday-mcp-oauth', `v1:${typ}`, 32)));
  }
  return keys.get(k);
}

function sign(typ, payload) {
  const body = b64u(JSON.stringify({ ...payload, typ }));
  const mac = crypto.createHmac('sha256', key(typ)).update(`${PREFIX[typ]}.${body}`).digest();
  return `${PREFIX[typ]}.${body}.${b64u(mac)}`;
}

// Geeft de payload terug, of null bij elke afwijking: andere soort, kapotte
// vorm, verkeerde handtekening, verlopen. Nooit een reden naar buiten.
function verify(typ, token) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX[typ]) return null;
  let expected;
  try { expected = crypto.createHmac('sha256', key(typ)).update(`${parts[0]}.${parts[1]}`).digest(); }
  catch { return null; }
  const got = Buffer.from(parts[2], 'base64url');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!p || p.typ !== typ) return null;
  if (p.exp != null && Date.now() > p.exp) return null;
  return p;
}

// Geheim voor een client die bij registratie client_secret_post/basic vraagt.
// Afgeleid uit de client_id zelf, dus ook niets om te bewaren.
function clientSecret(clientId) {
  return b64u(crypto.createHmac('sha256', key('secret')).update(String(clientId)).digest());
}

const isAccessToken = (t) => typeof t === 'string' && t.startsWith(`${PREFIX.at}.`);

/* ---------- Welke klanten mogen via Claude inloggen ----------
   Fail-closed: alleen klantcodes in MCP_OAUTH_CLIENTS (komma-gescheiden). Zo gaat
   V2 per klant open, te beginnen met de demoklant SENJA. Leeg = niemand. */
function oauthEnabled(clientId) {
  return String(process.env.MCP_OAUTH_CLIENTS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean).includes(clientId);
}

function parseClients() {
  try {
    const c = JSON.parse(process.env.CLIENTS || '{}');
    return (c && typeof c === 'object' && !Array.isArray(c)) ? c : {};
  } catch { return {}; }
}

// Ingetrokken? Een token van vóór het intrekmoment van de klant of van iedereen.
function revoked(clientId, iat) {
  const global = Number(process.env.MCP_MIN_TS || 0);
  const clients = parseClients();
  if (!Object.prototype.hasOwnProperty.call(clients, clientId)) return true;   // klant verwijderd
  const own = Number((clients[clientId] || {}).mcp_min_ts || 0);
  return !(iat >= global && iat >= own);
}

// Eenmalig gebruik binnen één instantie (codes en refresh tokens).
const used = new Map();
function markUsed(jti, exp) {
  const now = Date.now();
  if (used.has(jti)) return false;
  used.set(jti, exp || now + TTL.code);
  if (used.size > 5000) for (const [k, e] of used) { if (e < now) used.delete(k); if (used.size <= 4000) break; }
  return true;
}

// Access token → scope voor mcp.js, of null.
function verifyAccessToken(token) {
  const p = verify('at', token);
  if (!p || p.aud !== 'mcp' || typeof p.sub !== 'string') return null;
  if (!oauthEnabled(p.sub) || revoked(p.sub, p.iat)) return null;
  return { kind: 'client', clientId: p.sub, keyName: `oauth:${p.sub}` };
}

function issueTokens(clientId, oauthClient) {
  const now = Date.now();
  const access = sign('at', { sub: clientId, aud: 'mcp', cid: oauthClient, iat: now, exp: now + TTL.at });
  const refresh = sign('rt', { sub: clientId, aud: 'mcp', cid: oauthClient, iat: now, exp: now + TTL.rt, jti: crypto.randomBytes(12).toString('base64url') });
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: Math.floor(TTL.at / 1000),
    refresh_token: refresh,
    scope: 'mcp',
  };
}

module.exports = {
  sign, verify, TTL, sha256b64u, clientSecret, isAccessToken, verifyAccessToken, issueTokens,
  oauthEnabled, revoked, markUsed, parseClients,
};
