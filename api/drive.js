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
    scope: 'https://www.googleapis.com/auth/drive.readonly',
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

// Recursively search for a folder by path segments
async function findFolderByPath(accessToken, rootFolderId, pathSegments) {
  let currentId = rootFolderId;
  for (const segment of pathSegments) {
    const query = encodeURIComponent(
      `'${currentId}' in parents and mimeType='application/vnd.google-apps.folder' and name contains '${segment}' and trashed=false`
    );
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json();
    if (!data.files || data.files.length === 0) return null;
    currentId = data.files[0].id;
  }
  return currentId;
}

// List files in a folder
async function listFiles(accessToken, folderId, mimeTypeFilter = null) {
  let query = `'${folderId}' in parents and trashed=false`;
  if (mimeTypeFilter) query += ` and mimeType='${mimeTypeFilter}'`;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,modifiedTime,size)&orderBy=modifiedTime desc`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  return data.files || [];
}

// Download file content
async function downloadFile(accessToken, fileId, mimeType) {
  let url;
  // Google Docs/Sheets need export
  if (mimeType === 'application/vnd.google-apps.document') {
    url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`;
  } else {
    url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  return res.text();
}

// Download file as base64 (for PDFs)
async function downloadFileBase64(accessToken, fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

// Detect period from filename: spotto_2026-02_analytics.pdf → 2026-02
function detectPeriod(filename) {
  const m = filename.match(/(\d{4}-\d{2})/);
  return m ? m[1] : null;
}

// Group files by period
function groupByPeriod(files) {
  const periods = {};
  for (const f of files) {
    const period = detectPeriod(f.name) || 'onbekend';
    if (!periods[period]) periods[period] = [];
    periods[period].push(f);
  }
  return periods;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET — scan Drive folder and return available files per period
  if (req.method === 'GET') {
    const { clientId, token, action, folderId, fileId, mimeType } = req.query || {};

    if (!verifyToken(token, clientId)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get client config
    let clients;
    try { clients = JSON.parse(process.env.CLIENTS || '{}'); }
    catch { return res.status(500).json({ error: 'Serverconfiguratie fout.' }); }

    const client = clients[clientId];
    if (!client?.driveFolderId) {
      return res.status(200).json({ available: false, reason: 'Geen Drive map geconfigureerd voor deze klant.' });
    }

    const rootFolderId = client.driveFolderId;

    try {
      const accessToken = await getAccessToken();

      // action=download — download a specific file
      if (action === 'download' && fileId) {
        if (mimeType === 'application/pdf') {
          const base64 = await downloadFileBase64(accessToken, fileId);
          return res.status(200).json({ base64 });
        } else {
          const text = await downloadFile(accessToken, fileId, mimeType);
          return res.status(200).json({ text });
        }
      }

      // action=context — load text context files (Merk-Brief, pillars, etc.)
      if (action === 'context') {
        const contextFolder = await findFolderByPath(accessToken, rootFolderId, ['00_AI-CONTEXT']);
        const stratFolder = await findFolderByPath(accessToken, rootFolderId, ['03_MARKETING-STRATEGIE']);
        const merkFolder = await findFolderByPath(accessToken, rootFolderId, ['01_MERK-STRATEGIE']);

        const contextFiles = [];
        const labels = {
          '0.1_Merk-Brief': 'Merk-Brief',
          '0.2_Do-Donts': "Do's & Don'ts",
          '0.3_Woordenlijst': 'Woordenlijst',
          '3.3_Content-Pijlers': 'Content Pijlers',
          '1.3_Concurrentie': 'Concurrentieanalyse',
        };

        // Search context folder
        if (contextFolder) {
          const files = await listFiles(accessToken, contextFolder);
          for (const f of files) {
            for (const [key, label] of Object.entries(labels)) {
              if (f.name.includes(key) || f.name.toLowerCase().includes(key.toLowerCase())) {
                const text = await downloadFile(accessToken, f.id, f.mimeType);
                if (text) contextFiles.push({ label, content: text.slice(0, 3000) });
              }
            }
          }
        }
        // Search strategy folders
        for (const folder of [stratFolder, merkFolder]) {
          if (!folder) continue;
          const files = await listFiles(accessToken, folder);
          for (const f of files) {
            for (const [key, label] of Object.entries(labels)) {
              if ((f.name.includes(key) || f.name.toLowerCase().includes(key.toLowerCase()))
                && !contextFiles.find(c => c.label === label)) {
                const text = await downloadFile(accessToken, f.id, f.mimeType);
                if (text) contextFiles.push({ label, content: text.slice(0, 3000) });
              }
            }
          }
        }

        return res.status(200).json({ contextFiles });
      }

      // Default — scan for data files and return available periods
      const result = {
        available: true,
        rootFolderId,
        periods: {},
        contextFiles: { merkBrief: false, pillars: false, concurrentie: false },
      };

      // Find data folders
      const rapportFolder = await findFolderByPath(accessToken, rootFolderId, ['06_PERFORMANTIE', '6.3_Rapporten']);
      const organischFolder = await findFolderByPath(accessToken, rootFolderId, ['06_PERFORMANTIE', '6.3_Rapporten', 'Organische-Rapporten', 'Instagram']);
      const ruweDataOrg = await findFolderByPath(accessToken, rootFolderId, ['06_PERFORMANTIE', '6.4_Ruwe-Data', 'Organisch']);
      const ruweDataAds = await findFolderByPath(accessToken, rootFolderId, ['06_PERFORMANTIE', '6.4_Ruwe-Data', 'Advertenties']);

      // Collect all data files
      const allFiles = [];

      if (organischFolder) {
        const pdfs = await listFiles(accessToken, organischFolder, 'application/pdf');
        pdfs.forEach(f => allFiles.push({ ...f, type: 'analytics_pdf' }));
      }
      if (ruweDataOrg) {
        const csvs = await listFiles(accessToken, ruweDataOrg);
        csvs.filter(f => f.name.endsWith('.csv')).forEach(f => {
          const type = f.name.toLowerCase().includes('instagram') ? 'instagram_csv'
            : f.name.toLowerCase().includes('facebook') ? 'facebook_csv' : 'csv';
          allFiles.push({ ...f, type });
        });
      }
      if (ruweDataAds) {
        const csvs = await listFiles(accessToken, ruweDataAds);
        csvs.filter(f => f.name.endsWith('.csv')).forEach(f => allFiles.push({ ...f, type: 'ads_csv' }));
      }

      // Check template
      if (rapportFolder) {
        const templateFiles = await listFiles(accessToken, rapportFolder);
        const template = templateFiles.find(f => f.name.includes('TEMPLATE') && f.name.endsWith('.xlsx'));
        if (template) result.template = { id: template.id, name: template.name };
      }

      // Group by period
      result.periods = groupByPeriod(allFiles);

      // Check context files existence
      const contextFolder = await findFolderByPath(accessToken, rootFolderId, ['00_AI-CONTEXT']);
      if (contextFolder) {
        const ctxFiles = await listFiles(accessToken, contextFolder);
        result.contextFiles.merkBrief = ctxFiles.some(f => f.name.includes('0.1') || f.name.toLowerCase().includes('merk-brief'));
        result.contextFiles.woordenlijst = ctxFiles.some(f => f.name.includes('0.3') || f.name.toLowerCase().includes('woordenlijst'));
      }
      const stratFolder = await findFolderByPath(accessToken, rootFolderId, ['03_MARKETING-STRATEGIE']);
      if (stratFolder) {
        const stratFiles = await listFiles(accessToken, stratFolder);
        result.contextFiles.pillars = stratFiles.some(f => f.name.includes('3.3') || f.name.toLowerCase().includes('content-pijlers'));
      }
      const merkFolder = await findFolderByPath(accessToken, rootFolderId, ['01_MERK-STRATEGIE']);
      if (merkFolder) {
        const merkFiles = await listFiles(accessToken, merkFolder);
        result.contextFiles.concurrentie = merkFiles.some(f => f.name.includes('1.3') || f.name.toLowerCase().includes('concurrentie'));
      }

      return res.status(200).json(result);

    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
