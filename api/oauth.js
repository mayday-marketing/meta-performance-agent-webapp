/* ==========================================================
   oauth.js — OAuth 2.1 voor de MCP-koppeling (V2: per klant)
   ==========================================================
   Laat claude.ai en Cowork de MCP-koppeling gebruiken met een gewone
   klantlogin. Na het inloggen ziet de connector alleen dat ene merk.

   Eén functie, meerdere routes via rewrites in vercel.json (parameter `op`):
     as-meta    /.well-known/oauth-authorization-server   (RFC 8414)
     pr-meta    /.well-known/oauth-protected-resource/…   (RFC 9728)
     register   /oauth/register                           (RFC 7591)
     authorize  /oauth/authorize   GET = inlogscherm, POST = inloggen
     token      /oauth/token       authorization_code + refresh_token

   REGELS
     - PKCE met S256 is verplicht; `plain` en geen challenge worden geweigerd.
     - redirect_uri moet exact overeenkomen met een geregistreerde, en alleen
       https mag. Een ongeldige client_id of redirect_uri krijgt een foutpagina,
       nooit een redirect (anders wordt dit een open redirector).
     - Inloggen gebruikt dezelfde wachtwoordcontrole en dezelfde rem als
       /api/auth (_auth.js). Alleen klanten in MCP_OAUTH_CLIENTS komen erdoor.
     - Komt de aanvraag voor een klantadres (/api/mcp/<klant>), dan moet de
       login bij die klant horen.
     - Het inlogscherm mag nergens in een frame (X-Frame-Options + CSP).
   Alle blobs en sleutels: zie _oauth.js.
   ========================================================== */

const crypto = require('crypto');
const { checkPassword, loginBlocked, loginFailed } = require('./_auth');
const O = require('./_oauth');

const ID_RE = /^[a-z0-9_-]{1,40}$/;
const MAX_REDIRECTS = 5;

/* ---------- Hulpjes ---------- */

function origin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return null;
  const proto = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)
    ? String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
    : 'https';
  return `${proto}://${host}`;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function body(req) {
  const b = req.body;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string') {
    const t = b.trim();
    if (t.startsWith('{')) { try { return JSON.parse(t); } catch { return {}; } }
    return Object.fromEntries(new URLSearchParams(t));
  }
  return {};
}

const str = (v, max = 2048) => (typeof v === 'string' && v.length <= max ? v : '');

function json(res, status, obj) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).send(JSON.stringify(obj));
}

// Klantcode uit een resource-URL van deze server: …/api/mcp/<klant>. Een andere
// host of een ander pad = geen klant (dan kiest de login).
function tenantOf(resource, base) {
  if (!resource) return null;
  let u;
  try { u = new URL(resource); } catch { return null; }
  if (`${u.protocol}//${u.host}` !== base) return null;
  const m = /^\/api\/mcp\/([a-z0-9_-]{1,40})\/?$/.exec(u.pathname);
  return m ? m[1] : null;
}

function validRedirect(u) {
  if (typeof u !== 'string' || u.length > 500) return false;
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && !x.hash && !x.username && !x.password;
  } catch { return false; }
}

// De ondertekende registratie achter een client_id, of null.
function registration(clientId) {
  const reg = O.verify('reg', str(clientId, 4096));
  return reg && Array.isArray(reg.ru) ? reg : null;
}

/* ---------- Metadata ---------- */

function asMeta(req, res) {
  const base = origin(req);
  if (!base) return json(res, 400, { error: 'invalid_request' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  return json(res, 200, {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: ['mcp'],
  });
}

function prMeta(req, res) {
  const base = origin(req);
  if (!base) return json(res, 400, { error: 'invalid_request' });
  const path = str(req.query.path, 200).replace(/^\/+/, '');
  const m = /^api\/mcp(?:\/([a-z0-9_-]{1,40}))?\/?$/.exec(path);
  res.setHeader('Access-Control-Allow-Origin', '*');
  return json(res, 200, {
    resource: m && m[1] ? `${base}/api/mcp/${m[1]}` : `${base}/api/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
    resource_name: 'mayday marketing dashboard',
  });
}

/* ---------- Registratie (RFC 7591) ---------- */

function register(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'invalid_request' });
  const b = body(req);
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
  if (!uris.length || uris.length > MAX_REDIRECTS || !uris.every(validRedirect)) {
    return json(res, 400, { error: 'invalid_redirect_uri', error_description: 'Alleen https-redirect_uris, hooguit vijf.' });
  }
  const method = ['client_secret_post', 'client_secret_basic'].includes(b.token_endpoint_auth_method) ? b.token_endpoint_auth_method : 'none';
  const name = str(b.client_name, 100).replace(/[^\p{L}\p{N} ._()-]/gu, '').slice(0, 60) || 'MCP-client';
  const now = Date.now();
  const clientId = O.sign('reg', { ru: uris, n: name, am: method, iat: now });
  const out = {
    client_id: clientId,
    client_id_issued_at: Math.floor(now / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: method,
    scope: 'mcp',
  };
  if (method !== 'none') { out.client_secret = O.clientSecret(clientId); out.client_secret_expires_at = 0; }
  res.setHeader('Access-Control-Allow-Origin', '*');
  return json(res, 201, out);
}

/* ---------- Autorisatie (inlogscherm) ---------- */

// Controleert de parameters. Geeft { fatal } (foutpagina, geen redirect),
// { redirectError } (fout terug naar de client) of { p } (alles in orde).
function checkAuthorize(q, base) {
  const clientId = str(q.client_id, 4096);
  const reg = registration(clientId);
  if (!reg) return { fatal: 'Deze koppeling is niet (meer) geldig. Verwijder de connector in Claude en voeg hem opnieuw toe.' };
  const redirectUri = str(q.redirect_uri, 500);
  if (!reg.ru.includes(redirectUri)) return { fatal: 'Het terugkeeradres hoort niet bij deze koppeling.' };
  const state = str(q.state, 500);
  const fail = (error, desc) => ({ redirectError: { redirectUri, state, error, desc } });
  if (q.response_type !== 'code') return fail('unsupported_response_type', 'Alleen response_type=code.');
  const challenge = str(q.code_challenge, 128);
  if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    return fail('invalid_request', 'PKCE met S256 is verplicht.');
  }
  const resource = str(q.resource, 500);
  const tenant = tenantOf(resource, base);
  if (resource && !tenant && resource.replace(/\/$/, '') !== `${base}/api/mcp`) {
    return fail('invalid_target', 'Onbekende resource.');
  }
  return { p: { clientId, reg, redirectUri, state, challenge, resource, tenant } };
}

function redirectWith(res, uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Location', u.toString());
  return res.status(302).end();
}

function securityHeaders(res, redirectUri) {
  let formTarget = '';
  try { formTarget = ` ${new URL(redirectUri).origin}`; } catch {}
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // form-action ook voor het terugkeeradres: browsers passen het toe op de
  // redirect na het versturen van het formulier.
  res.setHeader('Content-Security-Policy',
    `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'${formTarget}; frame-ancestors 'none'; base-uri 'none'`);
}

function page(res, status, { title, intro, form, error }) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(status).send(`<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · mayday marketing</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f3ee; --card:#fff; --fg:#1a1a1a; --muted:#6b665e; --line:#e3ddd3; --accent:#1f5f3f; --neg:#b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#121212; --card:#1c1c1c; --fg:#f1eee9; --muted:#a8a29a; --line:#2e2e2e; --accent:#5fb98a; --neg:#f2b8b5; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg); font:16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding:16px; }
  main { width:100%; max-width:400px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; }
  h1 { font:600 22px/1.3 Georgia, serif; margin:0 0 8px; }
  p { margin:0 0 16px; color:var(--muted); font-size:14px; }
  label { display:block; font-size:13px; font-weight:600; margin:14px 0 6px; }
  input { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:transparent; color:var(--fg); font-size:16px; }
  input[readonly] { color:var(--muted); }
  button { margin-top:20px; width:100%; padding:11px; border:0; border-radius:8px; background:var(--accent); color:#fff; font-weight:600; font-size:15px; cursor:pointer; }
  .err { color:var(--neg); font-size:14px; margin:0 0 12px; }
  .foot { margin:18px 0 0; font-size:12px; }
</style></head>
<body><main>
  <h1>${esc(title)}</h1>
  ${intro ? `<p>${intro}</p>` : ''}
  ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
  ${form || ''}
</main></body></html>`);
}

function loginForm(res, p, { error, clientCode } = {}) {
  securityHeaders(res, p.redirectUri);
  const hidden = {
    response_type: 'code', client_id: p.clientId, redirect_uri: p.redirectUri, state: p.state,
    code_challenge: p.challenge, code_challenge_method: 'S256', resource: p.resource,
  };
  const fields = Object.entries(hidden).filter(([, v]) => v).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('');
  const code = p.tenant || clientCode || '';
  const form = `<form method="post" action="/oauth/authorize" autocomplete="on">
    ${fields}
    <label for="cid">Klantcode</label>
    <input id="cid" name="login_client" value="${esc(code)}" ${p.tenant ? 'readonly' : 'autofocus'} required autocapitalize="none" spellcheck="false" maxlength="40">
    <label for="pw">Wachtwoord</label>
    <input id="pw" name="login_password" type="password" required ${p.tenant ? 'autofocus' : ''} autocomplete="current-password">
    <button type="submit">Inloggen en koppelen</button>
    <p class="foot">Claude krijgt alleen-lezen toegang tot de dashboardcijfers van dit ene merk, 90 dagen lang of tot je de koppeling verwijdert. Andere merken blijven onzichtbaar.</p>
  </form>`;
  return page(res, error ? 401 : 200, {
    title: 'Claude koppelen aan je dashboard',
    intro: `<b>${esc(p.reg.n)}</b> vraagt toegang tot de cijfers in het mayday marketing dashboard. Log in met dezelfde klantcode en hetzelfde wachtwoord als op het dashboard.`,
    form, error,
  });
}

function fatalPage(res, msg) {
  securityHeaders(res, '');
  return page(res, 400, { title: 'Koppelen lukt niet', intro: esc(msg) });
}

function authorize(req, res) {
  const base = origin(req);
  if (!base) return fatalPage(res, 'Ongeldig adres.');
  if (!process.env.AUTH_SECRET) return fatalPage(res, 'De koppeling is niet geconfigureerd.');
  const isPost = req.method === 'POST';
  if (!isPost && req.method !== 'GET') return fatalPage(res, 'Ongeldige aanvraag.');
  const q = isPost ? body(req) : req.query;
  const c = checkAuthorize(q, base);
  if (c.fatal) return fatalPage(res, c.fatal);
  if (c.redirectError) {
    const e = c.redirectError;
    return redirectWith(res, e.redirectUri, { error: e.error, error_description: e.desc, state: e.state, iss: base });
  }
  const p = c.p;
  if (!isPost) return loginForm(res, p);

  const rawId = str(q.login_client, 40).trim().toLowerCase();
  const password = str(q.login_password, 200);
  if (!ID_RE.test(rawId) || !password) return loginForm(res, p, { error: 'Vul je klantcode en wachtwoord in.', clientCode: rawId });
  if (loginBlocked(req, rawId)) {
    res.setHeader('Retry-After', '900');
    return loginForm(res, p, { error: 'Te veel mislukte pogingen. Probeer het over een kwartier opnieuw.', clientCode: rawId });
  }
  const check = checkPassword(rawId, password);
  if (check.config) return fatalPage(res, 'Serverconfiguratie fout.');
  if (!check.ok) {
    loginFailed(req, rawId);
    return loginForm(res, p, { error: 'Ongeldige klantcode of wachtwoord.', clientCode: rawId });
  }
  // Pas ná een geldige login zeggen dat een klant geen toegang heeft, zodat het
  // scherm niet verraadt welke klantcodes bestaan of openstaan.
  if (p.tenant && p.tenant !== check.clientId) {
    return loginForm(res, p, { error: 'Deze koppeling hoort bij een ander merk. Voeg in Claude de connector van je eigen merk toe.' });
  }
  if (!O.oauthEnabled(check.clientId)) {
    return loginForm(res, p, { error: 'Koppelen met Claude staat voor dit merk nog niet open. Neem contact op met mayday marketing.' });
  }

  const now = Date.now();
  const code = O.sign('code', {
    sub: check.clientId, cid: O.sha256b64u(p.clientId), ru: p.redirectUri, cc: p.challenge,
    res: p.resource || null, iat: now, exp: now + O.TTL.code, jti: crypto.randomBytes(12).toString('base64url'),
  });
  console.log(JSON.stringify({ evt: 'oauth', step: 'authorize', clientId: check.clientId, app: p.reg.n }));
  return redirectWith(res, p.redirectUri, { code, state: p.state, iss: base });
}

/* ---------- Token ---------- */

// Clientauthenticatie: client_id (en eventueel het afgeleide geheim) uit de
// body of uit een Basic-header.
function tokenClient(req, b) {
  let id = str(b.client_id, 4096), secret = str(b.client_secret, 200);
  const m = /^Basic\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  if (m) {
    const dec = Buffer.from(m[1], 'base64').toString('utf8');
    const i = dec.indexOf(':');
    if (i > 0) { id = decodeURIComponent(dec.slice(0, i)); secret = decodeURIComponent(dec.slice(i + 1)); }
  }
  const reg = registration(id);
  if (!reg) return null;
  if (reg.am !== 'none') {
    const want = Buffer.from(O.clientSecret(id));
    const got = Buffer.from(secret || '');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  }
  return { id, reg };
}

function token(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); return res.status(204).end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'invalid_request' });
  if (!process.env.AUTH_SECRET) return json(res, 503, { error: 'temporarily_unavailable' });
  const b = body(req);
  const client = tokenClient(req, b);
  if (!client) return json(res, 401, { error: 'invalid_client' });
  const bad = (desc) => json(res, 400, { error: 'invalid_grant', error_description: desc });

  if (b.grant_type === 'authorization_code') {
    const c = O.verify('code', str(b.code, 4096));
    if (!c) return bad('Code ongeldig of verlopen.');
    if (c.cid !== O.sha256b64u(client.id)) return bad('Code hoort bij een andere client.');
    if (str(b.redirect_uri, 500) !== c.ru) return bad('redirect_uri komt niet overeen.');
    const verifier = str(b.code_verifier, 128);
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || O.sha256b64u(verifier) !== c.cc) return bad('PKCE-controle mislukt.');
    if (b.resource && c.res && str(b.resource, 500) !== c.res) return bad('resource komt niet overeen.');
    if (!O.oauthEnabled(c.sub) || O.revoked(c.sub, c.iat)) return bad('Toegang ingetrokken.');
    if (!O.markUsed(c.jti, c.exp)) return bad('Code al gebruikt.');
    console.log(JSON.stringify({ evt: 'oauth', step: 'token', clientId: c.sub }));
    return json(res, 200, O.issueTokens(c.sub, O.sha256b64u(client.id)));
  }

  if (b.grant_type === 'refresh_token') {
    const r = O.verify('rt', str(b.refresh_token, 4096));
    if (!r || r.aud !== 'mcp') return bad('Refresh token ongeldig of verlopen.');
    if (r.cid !== O.sha256b64u(client.id)) return bad('Refresh token hoort bij een andere client.');
    if (!O.oauthEnabled(r.sub) || O.revoked(r.sub, r.iat)) return bad('Toegang ingetrokken.');
    if (!O.markUsed(r.jti, r.exp)) return bad('Refresh token al gebruikt.');
    console.log(JSON.stringify({ evt: 'oauth', step: 'refresh', clientId: r.sub }));
    return json(res, 200, O.issueTokens(r.sub, r.cid));
  }

  return json(res, 400, { error: 'unsupported_grant_type' });
}

/* ---------- Router ---------- */

module.exports = async (req, res) => {
  if (process.env.MCP_DISABLED === '1') return json(res, 503, { error: 'temporarily_unavailable' });
  switch (req.query.op) {
    case 'as-meta': return asMeta(req, res);
    case 'pr-meta': return prMeta(req, res);
    case 'register': return register(req, res);
    case 'authorize': return authorize(req, res);
    case 'token': return token(req, res);
    default: return json(res, 404, { error: 'not_found' });
  }
};
