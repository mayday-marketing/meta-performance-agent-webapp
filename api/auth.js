const crypto = require('crypto');

const SECRET = process.env.AUTH_SECRET;

function signToken(clientId) {
  const ts = Date.now();
  const payload = `${clientId}:${ts}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { clientId, password } = req.body || {};

  if (!clientId || !password) {
    return res.status(400).json({ error: 'Vul beide velden in.' });
  }

  // Parse clients from env var
  // Format: { "merknaam": { "password": "abc", "sheetId": "1xyz...", "brandName": "Merknaam" } }
  let clients;
  try {
    clients = JSON.parse(process.env.CLIENTS || '{}');
  } catch {
    return res.status(500).json({ error: 'Serverconfiguratie fout.' });
  }

  const client = clients[clientId.toLowerCase()];
  if (!client || client.password !== password) {
    return res.status(401).json({ error: 'Ongeldige klantcode of wachtwoord.' });
  }

  const token = signToken(clientId.toLowerCase());

  res.status(200).json({
    token,
    clientId: clientId.toLowerCase(),
    brandName: client.brandName || clientId,
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
