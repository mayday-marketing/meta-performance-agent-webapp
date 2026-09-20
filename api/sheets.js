const crypto = require('crypto');
const { getClientConfig, emptyConfig, getAccessToken: googleAccessToken, captureOidcToken } = require('./_config');

const SECRET = process.env.AUTH_SECRET;
const TOKEN_MAX_AGE_MS = 10 * 60 * 60 * 1000;

// Resolve the sheet this client is allowed to touch, server-side from CLIENTS.
// NOOIT de sheetId uit het request vertrouwen: de gedeelde service-account heeft
// toegang tot élke klant-sheet, dus een client-opgegeven sheetId = cross-tenant
// lezen/schrijven. De sheetId hoort bij de geauthenticeerde klant, punt.
function resolveSheetId(clientId) {
  try {
    const clients = JSON.parse(process.env.CLIENTS || '{}');
    return clients[String(clientId).toLowerCase()]?.sheetId || null;
  } catch {
    return null;
  }
}

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
// Zelfde tokenimplementatie als de rest van de app (zie _config.js). Schrijven
// in Analysehistoriek vergt de volledige spreadsheets-scope, niet de readonly.
const SHEETS_RW_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const getAccessToken = () => googleAccessToken(SHEETS_RW_SCOPE);

// Read Merkcontext tab from Google Sheet
async function readMerkcontext(sheetId, accessToken) {
  // B40 i.p.v. B20: de template loopt tot rij 23 en secties worden nog toegevoegd,
  // dus een krappe range slikte 'KPI follower groei/maand' en 'Opmerkingen' stilzwijgend in.
  const range = encodeURIComponent('Merkcontext!A1:B40');
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

  // Format as key: value pairs, skip empty rows and header row.
  // Let op: de kopregel staat in de template in kapitalen ('VELD'), dus hoofdletter-
  // ongevoelig vergelijken. Waarden trimmen: cellen bevatten regelmatig spaties, wat
  // anders de placeholder-check ('[...]') omzeilt.
  const context = rows
    .map(row => [(row[0] || '').trim(), (row[1] || '').trim()])
    .filter(([veld, waarde]) => veld && waarde && !waarde.startsWith('[') && veld.toLowerCase() !== 'veld')
    .map(([veld, waarde]) => `${veld}: ${waarde}`)
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
  captureOidcToken(req);   // OIDC-token uit de request-header (zie _config.js)

  const { method } = req;

  // GET — load client context (default) of ?action=config
  if (method === 'GET') {
    const { clientId, token, action } = req.query || {};

    if (!verifyToken(token, clientId)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // sheetId komt uit CLIENTS, nooit uit het request — zie resolveSheetId().
    const sheetId = resolveSheetId(clientId);

    // action=config — accent, logo, account-ids en links uit de Config-tab.
    // Faalt nooit hard: zonder config draait het dashboard op de defaults.
    if (action === 'config') {
      try {
        return res.status(200).json(await getClientConfig(clientId));
      } catch (e) {
        return res.status(200).json({ config: emptyConfig(), warnings: [e.message] });
      }
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
    const { clientId, token, summary } = req.body || {};

    if (!verifyToken(token, clientId)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const sheetId = resolveSheetId(clientId);
    if (!sheetId) {
      return res.status(400).json({ error: 'Geen sheet geconfigureerd voor deze klant.' });
    }
    if (!summary) {
      return res.status(400).json({ error: 'summary is verplicht.' });
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
