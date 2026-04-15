const crypto = require('crypto');

const SECRET = process.env.AUTH_SECRET || 'change-this-secret';
const TOKEN_MAX_AGE_MS = 10 * 60 * 60 * 1000;

function verifyToken(token, clientId) {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length < 3) return false;
    const sig = parts.pop();
    const [tClientId, ts] = parts;
    if (tClientId !== clientId.toLowerCase()) return false;
    const payload = `${tClientId}:${ts}`;
    const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    if (Date.now() - parseInt(ts, 10) > TOKEN_MAX_AGE_MS) return false;
    return true;
  } catch { return false; }
}

// Get Google OAuth2 access token using service account JWT
async function getAccessToken() {
  const keyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyRaw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY niet ingesteld.');

  const key = JSON.parse(keyRaw);

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claimSet = Buffer.from(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url');

  const sigInput = `${header}.${claimSet}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(sigInput);
  const signature = sign.sign(key.private_key, 'base64url');
  const jwt = `${sigInput}.${signature}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Kon geen Google access token verkrijgen.');
  return tokenData.access_token;
}

// Read Merkcontext tab from Google Sheet
async function readMerkcontext(sheetId, accessToken) {
  const range = encodeURIComponent('Merkcontext!A1:B20');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Sheets leesfout: ${err.error?.message || res.status}`);
  }

  const data = await res.json();
  const rows = data.values || [];

  // Format as key: value pairs, skip empty rows and header row
  const context = rows
    .filter(row => row[0] && row[1] && !row[1].startsWith('[') && row[0] !== 'Veld')
    .map(row => `${row[0]}: ${row[1]}`)
    .join('\n');

  return context;
}

// Append row to Analysehistoriek tab
async function appendAnalysisRow(sheetId, accessToken, summary) {
  const now = new Date().toISOString().split('T')[0];
  const periode = extractPeriode(summary);
  const topPerformers = extractField(summary, 'top performer', 60);
  const patronen = extractField(summary, 'pattern', 60);
  const spend = extractField(summary, 'spend', 20) || '—';
  const actiepunten = extractField(summary, 'action', 80) || extractField(summary, 'aanbev', 80);

  const row = [periode, topPerformers, patronen, spend, actiepunten, now];

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Analysehistoriek!A:F:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values: [row] }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Sheets schrijffout: ${err.error?.message || res.status}`);
  }

  return true;
}

function extractPeriode(text) {
  const m = text.match(/\b(jan|feb|mar|apr|mei|jun|jul|aug|sep|okt|nov|dec)[a-z]*[\s.]+202\d/i)
    || text.match(/202\d[-/](0[1-9]|1[0-2])/);
  return m ? m[0] : new Date().toISOString().slice(0, 7);
}

function extractField(text, keyword, maxLen) {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(keyword.toLowerCase());
  if (idx === -1) return '';
  const snippet = text.slice(idx, idx + maxLen + keyword.length).replace(/\n/g, ' ').trim();
  return snippet.length > maxLen ? snippet.slice(0, maxLen) + '…' : snippet;
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { method } = req;

  // GET — load client context
  if (method === 'GET') {
    const { clientId, sheetId, token } = req.query || {};

    if (!verifyToken(token, clientId)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!sheetId) {
      return res.status(200).json({ context: '' });
    }

    try {
      const accessToken = await getAccessToken();
      const context = await readMerkcontext(sheetId, accessToken);
      return res.status(200).json({ context });
    } catch (e) {
      // Return empty context rather than failing — analysis can still proceed
      return res.status(200).json({ context: '', warning: e.message });
    }
  }

  // POST — save analysis result
  if (method === 'POST') {
    const { clientId, sheetId, token, summary } = req.body || {};

    if (!verifyToken(token, clientId)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!sheetId || !summary) {
      return res.status(400).json({ error: 'sheetId en summary zijn verplicht.' });
    }

    try {
      const accessToken = await getAccessToken();
      await appendAnalysisRow(sheetId, accessToken, summary);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
