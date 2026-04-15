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

async function getAccessToken() {
  const keyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyRaw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY niet ingesteld.');
  const key = JSON.parse(keyRaw);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claimSet = Buffer.from(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets',
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

async function findFolderByPath(accessToken, rootId, segments) {
  let currentId = rootId;
  for (const seg of segments) {
    const q = encodeURIComponent(`'${currentId}' in parents and mimeType='application/vnd.google-apps.folder' and name contains '${seg}' and trashed=false`);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await res.json();
    if (!data.files?.length) return null;
    currentId = data.files[0].id;
  }
  return currentId;
}

async function listFiles(accessToken, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime)&orderBy=modifiedTime desc`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await res.json();
  return data.files || [];
}

async function downloadText(accessToken, fileId, mimeType) {
  let url;
  if (mimeType === 'application/vnd.google-apps.document') {
    url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`;
  } else {
    url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  return res.text();
}

async function downloadPdfAsBase64(accessToken, fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

function detectPeriod(filename) {
  const m = filename.match(/(\d{4}-\d{2})/);
  return m ? m[1] : null;
}

function classifyFile(name) {
  const n = name.toLowerCase();
  if (n.endsWith('.pdf')) return 'analytics_pdf';
  if (n.includes('instagram') && n.endsWith('.csv')) return 'instagram_csv';
  if (n.includes('facebook') && n.endsWith('.csv')) return 'facebook_csv';
  if ((n.includes('meta_ads') || n.includes('ads') || n.includes('advertentie')) && n.endsWith('.csv')) return 'ads_csv';
  if (n.endsWith('.csv')) return 'csv_other';
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { clientId, token, action, period } = req.query || {};

  if (!verifyToken(token, clientId)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let clients;
  try { clients = JSON.parse(process.env.CLIENTS || '{}'); }
  catch { return res.status(500).json({ error: 'Serverconfiguratie fout.' }); }

  const client = clients[clientId];
  if (!client?.driveFolderId) {
    return res.status(200).json({ available: false, reason: 'Geen Drive map geconfigureerd voor deze klant.' });
  }

  const rootId = client.driveFolderId;

  try {
    const accessToken = await getAccessToken();

    // ── ACTION: load-period ─────────────────────────────────────────
    // Download all data files for a period server-side, return full content
    if (action === 'load-period' && period) {
      const result = { period, files: [] };

      // Find data folders
      const organischFolder = await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.3_Rapporten', 'Organische-Rapporten', 'Instagram']);
      const ruweDataOrg    = await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.4_Ruwe-Data', 'Organisch']);
      const ruweDataAds    = await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.4_Ruwe-Data', 'Advertenties']);

      // Also try alternate path names (lowercase / different naming)
      const ruweDataOrg2   = ruweDataOrg || await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.4_Ruwe-data', 'Organisch']);
      const ruweDataAds2   = ruweDataAds || await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.4_Ruwe-data', 'Advertenties']);

      const allFolders = [
        { folderId: organischFolder,  label: 'Analytics PDF' },
        { folderId: ruweDataOrg2,     label: 'Organische data' },
        { folderId: ruweDataAds2,     label: 'Advertentiedata' },
      ];

      for (const { folderId } of allFolders) {
        if (!folderId) continue;
        const files = await listFiles(accessToken, folderId);

        for (const file of files) {
          // Match period in filename
          const filePeriod = detectPeriod(file.name);
          if (filePeriod && filePeriod !== period) continue;

          const type = classifyFile(file.name);
          if (!type) continue;

          // Download content
          if (type === 'analytics_pdf') {
            // Send PDF as base64 — Anthropic handles it natively
            const base64 = await downloadPdfAsBase64(accessToken, file.id);
            if (base64) {
              result.files.push({ name: file.name, type, contentType: 'pdf_base64', data: base64 });
            }
          } else {
            // CSV — full text, no truncation
            const text = await downloadText(accessToken, file.id, file.mimeType);
            if (text) {
              result.files.push({ name: file.name, type, contentType: 'csv_text', data: text });
            }
          }
        }
      }

      // Also load context files
      const contextFiles = [];
      const contextFolder = await findFolderByPath(accessToken, rootId, ['00_AI-CONTEXT']);
      const stratFolder   = await findFolderByPath(accessToken, rootId, ['03_MARKETING-STRATEGIE']);
      const merkFolder    = await findFolderByPath(accessToken, rootId, ['01_MERK-STRATEGIE']);

      const contextMap = {
        '0.1': 'Merk-Brief', '0.2': "Do's & Don'ts", '0.3': 'Woordenlijst',
        '3.3': 'Content Pijlers', '1.3': 'Concurrentieanalyse',
      };

      for (const folderId of [contextFolder, stratFolder, merkFolder]) {
        if (!folderId) continue;
        const files = await listFiles(accessToken, folderId);
        for (const file of files) {
          for (const [key, label] of Object.entries(contextMap)) {
            if (file.name.includes(key) && !contextFiles.find(c => c.label === label)) {
              const text = await downloadText(accessToken, file.id, file.mimeType);
              if (text) contextFiles.push({ label, content: text.slice(0, 4000) });
            }
          }
        }
      }

      result.contextFiles = contextFiles;
      return res.status(200).json(result);
    }

    // ── ACTION: scan ─────────────────────────────────────────────────
    // Scan folder structure and return available periods + file list
    const scanResult = { available: true, periods: {}, contextFiles: {} };

    const organischFolder = await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.3_Rapporten', 'Organische-Rapporten', 'Instagram']);
    const ruweDataOrg     = await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.4_Ruwe-Data', 'Organisch'])
                         || await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.4_Ruwe-data', 'Organisch']);
    const ruweDataAds     = await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.4_Ruwe-Data', 'Advertenties'])
                         || await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.4_Ruwe-data', 'Advertenties']);
    const rapportFolder   = await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.3_Rapporten']);

    for (const folderId of [organischFolder, ruweDataOrg, ruweDataAds]) {
      if (!folderId) continue;
      const files = await listFiles(accessToken, folderId);
      for (const file of files) {
        const type = classifyFile(file.name);
        if (!type) continue;
        const p = detectPeriod(file.name) || 'onbekend';
        if (!scanResult.periods[p]) scanResult.periods[p] = [];
        scanResult.periods[p].push({ id: file.id, name: file.name, type, mimeType: file.mimeType });
      }
    }

    if (rapportFolder) {
      const tplFiles = await listFiles(accessToken, rapportFolder);
      const tpl = tplFiles.find(f => f.name.includes('TEMPLATE') && f.name.endsWith('.xlsx'));
      if (tpl) scanResult.template = { id: tpl.id, name: tpl.name };
    }

    // Check context files
    const ctxFolder  = await findFolderByPath(accessToken, rootId, ['00_AI-CONTEXT']);
    const sFolder    = await findFolderByPath(accessToken, rootId, ['03_MARKETING-STRATEGIE']);
    const mFolder    = await findFolderByPath(accessToken, rootId, ['01_MERK-STRATEGIE']);

    if (ctxFolder) {
      const f = await listFiles(accessToken, ctxFolder);
      scanResult.contextFiles.merkBrief   = f.some(x => x.name.includes('0.1') || x.name.toLowerCase().includes('merk-brief'));
      scanResult.contextFiles.woordenlijst = f.some(x => x.name.includes('0.3'));
    }
    if (sFolder) {
      const f = await listFiles(accessToken, sFolder);
      scanResult.contextFiles.pillars     = f.some(x => x.name.includes('3.3') || x.name.toLowerCase().includes('content-pijlers'));
    }
    if (mFolder) {
      const f = await listFiles(accessToken, mFolder);
      scanResult.contextFiles.concurrentie = f.some(x => x.name.includes('1.3') || x.name.toLowerCase().includes('concurrentie'));
    }

    return res.status(200).json(scanResult);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
