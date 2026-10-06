// Ondertekenen en de wachtwoordcontrole gebeuren op één plek (_auth.js); mcp.js
// en oauth.js gebruiken dezelfde functies.
const { signToken, checkPassword, loginBlocked, loginFailed } = require('./_auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { clientId, password } = req.body || {};
  if (typeof clientId !== 'string' || typeof password !== 'string' || !clientId || !password) {
    return res.status(400).json({ error: 'Vul beide velden in.' });
  }

  if (loginBlocked(req, clientId)) {
    res.setHeader('Retry-After', '900');
    return res.status(429).json({ error: 'Te veel mislukte pogingen. Probeer het over een kwartier opnieuw.' });
  }

  // CLIENTS-vorm: { "merknaam": { "password": "abc", "sheetId": "1xyz...", "brandName": "Merknaam" } }
  const check = checkPassword(clientId, password);
  if (check.config) return res.status(500).json({ error: 'Serverconfiguratie fout.' });
  if (!check.ok) {
    loginFailed(req, clientId);
    return res.status(401).json({ error: 'Ongeldige klantcode of wachtwoord.' });
  }
  const client = check.client;
  const id = check.clientId;

  const token = signToken(id);

  res.status(200).json({
    token,
    clientId: id,
    brandName: client.brandName || id,
    sheetId: client.sheetId || null,
    hasDrive: !!client.driveFolderId,
    hasMetricool: !!client.metricool_token,
    // 'hasWindsor' betekent voor de frontend: er is een bron achter het
    // windsor-endpoint. Dat is de API-sleutel óf de datasheet — zonder deze
    // tweede voorwaarde slaat de UI het ophalen over bij een klant die wél een
    // datasheet heeft, en blijven de tabs leeg terwijl de data er is.
    hasWindsor: !!(client.windsor_api_key || client.dataSheetId),
    // Waar die data vandaan komt, zodat de UI het verschil kan tonen.
    windsorSource: client.windsor_api_key ? 'api' : (client.dataSheetId ? 'sheet' : null),
    // Alleen of er een datasheet is, nooit de id zelf.
    hasDataSheet: !!client.dataSheetId,
  });
};
