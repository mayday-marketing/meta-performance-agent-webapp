const crypto = require('crypto');

const SECRET = process.env.AUTH_SECRET || 'change-this-secret';

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
  // Format: { "spotto": { "password": "abc", "sheetId": "1xyz...", "brandName": "Spotto" } }
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
  });
};
