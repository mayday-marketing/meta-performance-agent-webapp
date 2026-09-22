const crypto = require('crypto');
const { getAccessToken: googleAccessToken, captureOidcToken, getClientConfig, okDriveFile } = require('./_config');
const { getDesignSystem } = require('./_designsystem');

const SECRET = process.env.AUTH_SECRET;
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

// Eén tokenimplementatie voor de hele app (zie _config.js): federatie waar het
// kan, de service-account-sleutel als terugval. Dit bestand leest Drive én
// schrijft in Sheets, vandaar allebei de scopes.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets';
const getAccessToken = () => googleAccessToken(DRIVE_SCOPE);

// Mapnamen vergelijken zonder leestekens: '01_MERK-STRATEGIE' en '01_MERKSTRATEGIE'
// zijn dezelfde map. Zonder deze stap mist een klantmap met een koppelteken meer
// of minder stilzwijgend zijn merkcontext.
const normFolder = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function findFolderByPath(accessToken, rootId, segments) {
  let currentId = rootId;
  for (const seg of segments) {
    const q = encodeURIComponent(`'${currentId}' in parents and mimeType='application/vnd.google-apps.folder' and name contains '${seg}' and trashed=false`);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await res.json();
    if (data.files?.length) { currentId = data.files[0].id; continue; }

    // Geen letterlijke treffer: dan op genormaliseerde naam zoeken.
    const all = await listFolders(accessToken, currentId);
    const want = normFolder(seg);
    const hit = all.find(f => normFolder(f.name) === want)
             || all.find(f => normFolder(f.name).startsWith(want) || want.startsWith(normFolder(f.name)));
    if (!hit) return null;
    currentId = hit.id;
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

// Contextmappen zijn per klant anders ingedeeld: bij de een liggen de bestanden
// los in 00_AI-CONTEXT, bij de ander in submappen ('0.1_Merk-Brief/brief.md').
// Daarom één niveau dieper kijken en de mapnaam vóór de bestandsnaam plakken —
// het nummer waarop we matchen staat namelijk op de map, niet op het bestand.
async function listFilesDeep(accessToken, folderId) {
  const out = [];
  for (const f of await listFiles(accessToken, folderId)) {
    if (f.mimeType !== 'application/vnd.google-apps.folder') { out.push(f); continue; }
    for (const kid of await listFiles(accessToken, f.id)) {
      if (kid.mimeType === 'application/vnd.google-apps.folder') continue;
      out.push({ ...kid, name: `${f.name}/${kid.name}` });
    }
  }
  return out;
}

async function listFolders(accessToken, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
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

const MONTH_MAP = {
  jan:'01', feb:'02', mar:'03', mrt:'03', apr:'04', mei:'05', may:'05',
  jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', okt:'10', nov:'11', dec:'12'
};

function detectPeriod(filename) {
  const f = filename.toLowerCase();

  // YYYY-MM exact
  let m = f.match(/(\d{4})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}`;

  // feb26 / feb2026 / feb-26 / feb-2026
  m = f.match(/([a-z]{3})[\-_]?(20\d{2}|\d{2})(?!\d)/);
  if (m && MONTH_MAP[m[1]]) {
    const year = m[2].length === 2 ? '20' + m[2] : m[2];
    return `${year}-${MONTH_MAP[m[1]]}`;
  }

  // Feb-1-2026-tot-Feb-28-2026 style — take first month+year found
  m = f.match(/([a-z]{3})[\-_](\d{1,2})[\-_](20\d{2})/);
  if (m && MONTH_MAP[m[1]]) return `${m[3]}-${MONTH_MAP[m[1]]}`;

  // 2026 only — group by year
  m = f.match(/(20\d{2})/);
  if (m) return m[1];

  return null;
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
  captureOidcToken(req);   // OIDC-token uit de request-header (zie _config.js)
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { clientId, token, action, period } = req.query || {};

  if (!verifyToken(token, clientId)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let clients;
  try { clients = JSON.parse(process.env.CLIENTS || '{}'); }
  catch { return res.status(500).json({ error: 'Serverconfiguratie fout.' }); }

  const client = clients[clientId.toLowerCase()];
  if (!client?.driveFolderId) {
    return res.status(200).json({ available: false, reason: 'Geen Drive map geconfigureerd voor deze klant.' });
  }

  const rootId = client.driveFolderId;

  try {
    // ── ACTION: design-system ──────────────────────────────────────
    // Kleuren en letters van het presentatie-design-system van deze klant, voor
    // de Rapport-tab. De mapnaam komt uit de Config-tab en wordt alleen BINNEN
    // de Drive-map van de klant gezocht: het request wijst niets aan, en een
    // naam kan nooit buiten de eigen map reiken (in tegenstelling tot een id).
    if (action === 'design-system') {
      let wantName = null;
      try {
        // getClientConfig geeft { config, warnings } terug, niet de config zelf.
        // Zonder die ene stap bleef wantName altijd null en werd het veld
        // 'Design system' uit de Config-tab stil genegeerd.
        const cfg = await getClientConfig(clientId);
        wantName = cfg?.config?.designSystem || null;
      } catch { /* geen Config-tab is geen fout: dan zoeken we op patroon */ }
      const ds = await getDesignSystem(clientId, rootId, wantName, req.query.force === '1');
      return res.status(200).json(ds);
    }

    // ── ACTION: report-template ────────────────────────────────────
    // Het rapportsjabloon van deze klant: een markdown in Drive die beschrijft
    // hoe zijn rapport eruitziet — eigen secties, eigen definities, eigen toon.
    // De Rapport-tab geeft hem mee aan de Report Agent.
    //
    // De link komt uit 'Rapportlink' in de Config-tab. Die tab wordt server-side
    // opgehaald met CLIENTS[clientId].sheetId en geldt daarmee als vertrouwde
    // bron — anders dan een id uit het request, dat nooit gevolgd wordt.
    if (action === 'report-template') {
      let link = null;
      try {
        const cfg = await getClientConfig(clientId);
        link = cfg?.links?.report || null;
      } catch (e) {
        return res.status(200).json({ found: false, reason: `Config-tab niet leesbaar: ${e.message}` });
      }
      if (!link) {
        return res.status(200).json({ found: false, reason: "Geen 'Rapportlink' in de Config-tab van deze klant." });
      }
      const fileId = okDriveFile(link);
      if (!fileId) {
        // Bijvoorbeeld een claude.ai-artifact: een verwijzing voor mensen, geen
        // bestand dat de server kan lezen. Dat expliciet zeggen is beter dan een
        // lege respons waarin het op 'niet gevonden' lijkt.
        return res.status(200).json({ found: false, reason: 'De Rapportlink wijst niet naar een Drive-bestand, dus de server kan hem niet lezen.' });
      }

      const accessTokenTpl = await getAccessToken();
      const meta = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,modifiedTime`,
        { headers: { Authorization: `Bearer ${accessTokenTpl}` } });
      if (!meta.ok) {
        return res.status(200).json({ found: false, reason: `Bestand niet leesbaar (${meta.status}). Staat het gedeeld met het service-account?` });
      }
      const info = await meta.json();
      const text = await downloadText(accessTokenTpl, fileId, info.mimeType);
      if (!text || !text.trim()) {
        return res.status(200).json({ found: false, reason: `'${info.name}' is leeg of niet als tekst te lezen.` });
      }
      // Ruim, maar begrensd: het sjabloon gaat mee in de prompt en een heel
      // deck aan tekst zou de cijfers verdringen.
      const MAX = 24000;
      return res.status(200).json({
        found: true,
        name: info.name,
        modified: info.modifiedTime,
        truncated: text.length > MAX,
        template: text.slice(0, MAX),
      });
    }

    const accessToken = await getAccessToken();

    // ── ACTION: load-all ───────────────────────────────────────────
    // Load ALL CSV files from Drive (no period filter) for dashboard
    if (action === 'load-all') {
      const allData = { files: [], contextFiles: [] };

      const ruweDataRoot = await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.4_Ruwe-Data'])
                        || await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.4_Ruwe-data'])
                        || await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.4_Ruwe_Data']);

      if (ruweDataRoot) {
        const foldersToLoad = [ruweDataRoot];
        const subfolders = await listFolders(accessToken, ruweDataRoot);
        for (const sub of subfolders) foldersToLoad.push(sub.id);

        const seenIds = new Set();
        for (const folderId of foldersToLoad) {
          const files = await listFiles(accessToken, folderId);
          for (const file of files) {
            if (seenIds.has(file.id)) continue;
            const type = classifyFile(file.name);
            if (!type || type === 'analytics_pdf') continue; // skip PDFs for dashboard
            seenIds.add(file.id);
            const text = await downloadText(accessToken, file.id, file.mimeType);
            if (text) allData.files.push({ name: file.name, type, data: text });
          }
        }
      }

      // Load context files
      const ctxFolder  = await findFolderByPath(accessToken, rootId, ['00_AI-CONTEXT']);
      const sFolder    = await findFolderByPath(accessToken, rootId, ['03_MARKETING-STRATEGIE']);
      const mFolder    = await findFolderByPath(accessToken, rootId, ['01_MERK-STRATEGIE']);
      const contextMap = { '0.1': 'Merk-Brief', '0.2': "Do's & Don'ts", '3.3': 'Content Pijlers', '1.3': 'Concurrentieanalyse' };
      for (const folderId of [ctxFolder, sFolder, mFolder]) {
        if (!folderId) continue;
        const files = await listFilesDeep(accessToken, folderId);
        for (const file of files) {
          for (const [key, label] of Object.entries(contextMap)) {
            if (file.name.includes(key) && !allData.contextFiles.find(c => c.label === label)) {
              const text = await downloadText(accessToken, file.id, file.mimeType);
              if (text) allData.contextFiles.push({ label, content: text.slice(0, 3000) });
            }
          }
        }
      }

      return res.status(200).json(allData);
    }

    // ── ACTION: load-period ─────────────────────────────────────────
    // Download all data files for a period server-side, return full content
    if (action === 'load-period' && period) {
      const result = { period, files: [] };

      // Find data folders — scan root + all subfolders of 6.4_Ruwe-Data
      const analyticsFolder = await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.3_Rapporten', 'Organische-Rapporten', 'Instagram']);
      const ruweDataRoot    = await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.4_Ruwe-Data'])
                           || await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.4_Ruwe-data'])
                           || await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.4_Ruwe_Data']);

      const foldersToLoad = [];
      if (analyticsFolder) foldersToLoad.push(analyticsFolder);
      if (ruweDataRoot) {
        foldersToLoad.push(ruweDataRoot);
        const subfolders = await listFolders(accessToken, ruweDataRoot);
        for (const sub of subfolders) foldersToLoad.push(sub.id);
      }

      const seenIds = new Set();
      for (const folderId of foldersToLoad) {
        const files = await listFiles(accessToken, folderId);
        for (const file of files) {
          if (seenIds.has(file.id)) continue;

          const filePeriod = detectPeriod(file.name);
          if (filePeriod && filePeriod !== period) continue;

          const type = classifyFile(file.name);
          if (!type) continue;
          seenIds.add(file.id);

          if (type === 'analytics_pdf') {
            const base64 = await downloadPdfAsBase64(accessToken, file.id);
            if (base64) result.files.push({ name: file.name, type, contentType: 'pdf_base64', data: base64 });
          } else {
            const text = await downloadText(accessToken, file.id, file.mimeType);
            if (text) result.files.push({ name: file.name, type, contentType: 'csv_text', data: text });
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
        const files = await listFilesDeep(accessToken, folderId);
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

    // ── ACTION: analysis-benchmarks ─────────────────────────────────
    // Leest de eigen klant-benchmarks/targets uit 06_PERFORMANTIE/6.2_Benchmarks.
    // Vrije tekst (Google Docs / .txt / .md / .csv). Voedt de Analysis-agent als
    // klantspecifieke referentie. Niet gevonden → { found: false } → standaardanalyse.
    if (action === 'analysis-benchmarks') {
      const benchFolder = await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.2_Benchmarks'])
                       || await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.2_benchmarks'])
                       || await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.2_Benchmark']);
      if (!benchFolder) return res.status(200).json({ found: false, reason: 'Geen 6.2_Benchmarks map gevonden.' });

      const files = await listFiles(accessToken, benchFolder);
      const parts = [];
      const used = [];
      for (const file of files) {
        const isDoc = file.mimeType === 'application/vnd.google-apps.document';
        const isText = /\.(txt|md|csv)$/i.test(file.name);
        if (!isDoc && !isText) continue; // sla niet-tekst (xlsx/pdf/afbeeldingen) over
        const text = await downloadText(accessToken, file.id, file.mimeType);
        if (text && text.trim()) {
          parts.push(`### ${file.name}\n${text.trim()}`);
          used.push(file.name);
        }
      }
      if (!parts.length) return res.status(200).json({ found: false, reason: 'Map leeg of geen leesbare tekstbestanden.' });

      // Cap op ~8000 tekens zodat de prompt beheersbaar blijft.
      const content = parts.join('\n\n').slice(0, 8000);
      return res.status(200).json({ found: true, files: used, content });
    }

    // ── ACTION: context ─────────────────────────────────────────────
    // Lichtgewicht: enkel de merk-/strategie-contextbestanden (géén ruwe data-CSV's).
    // Voedt de chat-agent met merk-brief, tone/do's & don'ts, pijlers en concurrentie,
    // zodat antwoorden op de merkstem en pijlers zijn afgestemd.
    if (action === 'context') {
      const contextFiles = [];
      const ctxFolder = await findFolderByPath(accessToken, rootId, ['00_AI-CONTEXT']);
      const sFolder   = await findFolderByPath(accessToken, rootId, ['03_MARKETING-STRATEGIE']);
      const mFolder   = await findFolderByPath(accessToken, rootId, ['01_MERK-STRATEGIE']);
      const contextMap = {
        '0.1': 'Merk-Brief', '0.2': "Do's & Don'ts", '0.3': 'Woordenlijst',
        '3.3': 'Content Pijlers', '1.3': 'Concurrentieanalyse',
      };
      for (const folderId of [ctxFolder, sFolder, mFolder]) {
        if (!folderId) continue;
        const files = await listFilesDeep(accessToken, folderId);
        for (const file of files) {
          for (const [key, label] of Object.entries(contextMap)) {
            if (file.name.includes(key) && !contextFiles.find(c => c.label === label)) {
              const text = await downloadText(accessToken, file.id, file.mimeType);
              if (text) contextFiles.push({ label, content: text.slice(0, 4000) });
            }
          }
        }
      }
      return res.status(200).json({ contextFiles });
    }

    // ── ACTION: scan ─────────────────────────────────────────────────
    // Scan folder structure and return available periods + file list
    const scanResult = { available: true, periods: {}, contextFiles: {} };

    const analyticsFolder = await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.3_Rapporten', 'Organische-Rapporten', 'Instagram']);
    const rapportFolder    = await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.3_Rapporten']);

    // Find 6.4_Ruwe-Data root (try multiple casings)
    const ruweDataRoot = await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.4_Ruwe-Data'])
                      || await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.4_Ruwe-data'])
                      || await findFolderByPath(accessToken, rootId, ['06_PERFORMANTIE', '6.4_Ruwe_Data']);

    // Collect all folders to scan: analytics PDF folder + ruwe-data root + all its subfolders
    const foldersToScan = [];
    if (analyticsFolder) foldersToScan.push(analyticsFolder);
    if (ruweDataRoot) {
      foldersToScan.push(ruweDataRoot); // scan root directly (files placed here)
      // Also scan all subfolders (Organisch, Organsich, Advertenties, etc.)
      const subfolders = await listFolders(accessToken, ruweDataRoot);
      for (const sub of subfolders) foldersToScan.push(sub.id);
    }

    for (const folderId of foldersToScan) {
      const files = await listFiles(accessToken, folderId);
      for (const file of files) {
        const type = classifyFile(file.name);
        if (!type) continue;
        const p = detectPeriod(file.name) || 'onbekend';
        if (!scanResult.periods[p]) scanResult.periods[p] = [];
        // Avoid duplicates
        if (!scanResult.periods[p].find(x => x.id === file.id)) {
          scanResult.periods[p].push({ id: file.id, name: file.name, type, mimeType: file.mimeType });
        }
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
      const f = await listFilesDeep(accessToken, ctxFolder);
      scanResult.contextFiles.merkBrief   = f.some(x => x.name.includes('0.1') || x.name.toLowerCase().includes('merk-brief'));
      scanResult.contextFiles.woordenlijst = f.some(x => x.name.includes('0.3'));
    }
    if (sFolder) {
      const f = await listFilesDeep(accessToken, sFolder);
      scanResult.contextFiles.pillars     = f.some(x => x.name.includes('3.3') || x.name.toLowerCase().includes('content-pijlers'));
    }
    if (mFolder) {
      const f = await listFilesDeep(accessToken, mFolder);
      scanResult.contextFiles.concurrentie = f.some(x => x.name.includes('1.3') || x.name.toLowerCase().includes('concurrentie'));
    }

    return res.status(200).json(scanResult);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
