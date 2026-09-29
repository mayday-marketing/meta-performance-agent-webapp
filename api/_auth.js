/* ==========================================================
   _auth.js — het ondertekenen van dashboardtokens
   ==========================================================
   Gedeelde module (underscore-prefix = geen Vercel-route). auth.js gebruikt hem
   bij het inloggen; mcp.js om binnen hetzelfde proces een kortlevend token te
   maken voor de klant die een tool opvraagt, zodat elke bestaande handler zijn
   eigen verifyToken en isolatiecontrole gewoon blijft doen.

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

module.exports = { signToken };
