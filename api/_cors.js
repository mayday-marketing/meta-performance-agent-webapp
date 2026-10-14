/* ==========================================================
   _cors.js — CORS alleen voor het dashboard zelf
   ==========================================================
   De dashboardroutes stonden op `Access-Control-Allow-Origin: *`. Het token
   staat in sessionStorage, niet in een cookie, dus dat was geen lek — maar het
   liet wél elke site het login-endpoint aansturen en een gelekt token vanaf
   elk domein gebruiken. De frontend draait op hetzelfde domein als de API, dus
   het enige origin dat een browser hoeft te mogen is het eigen host.

   Toegestaan: het origin waarvan de host gelijk is aan de host van dit verzoek
   (productie én elke preview-URL werken zo vanzelf), plus wat er in
   ALLOWED_ORIGINS staat (komma-gescheiden, voor een los ontwikkeldomein).
   Een ander origin krijgt géén ACAO-header: de browser weigert dan het
   antwoord te lezen. Verzoeken zonder Origin (curl, Node, de evals) blijven
   gewoon werken — CORS is een browserregel, geen authenticatie.

   Gebruik, bovenaan elke handler:
     if (cors(req, res, 'POST')) return;   // true = OPTIONS afgehandeld
   ========================================================== */

function allowedOrigin(req) {
  const origin = String(req.headers.origin || '');
  if (!origin) return null;
  let host;
  try { host = new URL(origin).host.toLowerCase(); } catch { return null; }
  const own = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  if (host && host === own) return origin;
  const extra = String(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return extra.includes(origin.toLowerCase()) ? origin : null;
}

function cors(req, res, methods = 'POST') {
  const origin = allowedOrigin(req);
  res.setHeader('Vary', 'Origin');
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', `${methods}, OPTIONS`);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

module.exports = { cors, allowedOrigin };
