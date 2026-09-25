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


// ── MERK-TAB ──────────────────────────────────────────────────────────────────
// Merkcontext (VELD | WAARDE) + een eigen tab 'Doelen' voor KPI's en OKR's.
// De veldnamen verschillen per klant (Spotto volgt de template, SENJA heeft een
// eigen indeling), dus we zoeken op een paar aliassen en zeggen per veld of het
// gevonden is. Een placeholder ('[Beschrijving]') telt als niet ingevuld.

const normKey = (v) => String(v || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

const BRAND_FIELDS = [
  { key: 'brandName',   label: 'Merknaam',        aliases: ['merknaam', 'merk', 'brand', 'brandname'] },
  { key: 'mission',     label: 'Missie',          aliases: ['missie', 'mission', 'purpose', 'missieengvisie', 'missievisie'] },
  { key: 'audiences',   label: 'Doelgroepen',     aliases: ['doelgroepen', 'doelgroep', 'primairedoelgroep', 'secundairedoelgroep', 'targetaudience'] },
  { key: 'offer',       label: 'Aanbod / niche',  aliases: ['aanbodniche', 'aanbod', 'niche', 'producten', 'diensten', 'productenendiensten', 'sector'] },
  { key: 'objectives',  label: 'Doelstellingen',  aliases: ['doelstellingen', 'doelstelling', 'businessdoelen', 'objectives', 'doelen'] },
];

async function readRange(sheetId, accessToken, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 400) return null;   // tab bestaat niet
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Sheets leesfout: ${err.error?.message || res.status}`);
  }
  return (await res.json()).values || [];
}

const filled = (v) => { const t = String(v || '').trim(); return t && !t.startsWith('[') ? t : ''; };

function parseBrand(rows) {
  const out = {};
  for (const f of BRAND_FIELDS) out[f.key] = { label: f.label, value: null, source: null };
  for (const row of rows || []) {
    const veld = String(row[0] || '').trim();
    const waarde = filled(row[1]);
    if (!veld || !waarde) continue;
    const k = normKey(veld);
    const f = BRAND_FIELDS.find(x => x.aliases.includes(k));
    if (!f) continue;
    const cur = out[f.key];
    // Meerdere doelgroeprijen (primair + secundair) samen tonen, niet de eerste winnen.
    if (cur.value && f.key === 'audiences') { cur.value += `\n${waarde}`; cur.source += ` + ${veld}`; }
    else if (!cur.value) { cur.value = waarde; cur.source = veld; }
  }
  return out;
}

// '500k', '€ 500.000', '3,5', '12%', '1.2M' → { value, unit }. null = geen getal.
function parseNum(v) {
  let t = String(v == null ? '' : v).trim();
  if (!t) return null;
  const unit = t.includes('%') ? '%' : (/€|eur/i.test(t) ? '€' : '');
  t = t.replace(/€|eur|%|\s/gi, '');
  let mult = 1;
  const m = t.match(/^(.*?)([kKmM])$/);
  if (m) { t = m[1]; mult = /k/i.test(m[2]) ? 1e3 : 1e6; }
  // NL-notatie: punt = duizendtal, komma = decimaal. Alleen een punt gevolgd door
  // precies drie cijfers is een duizendtal; '1.2' blijft 1,2.
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return isFinite(n) && t !== '' ? { value: n * mult, unit } : null;
}

const GOAL_COLS = {
  kind:   ['soort', 'type'],
  period: ['periode', 'period'],
  title:  ['doel', 'omschrijving', 'naam', 'kpi', 'goal'],
  target: ['streef', 'streefwaarde', 'target', 'doelwaarde'],
  actual: ['huidig', 'actueel', 'stand', 'actual', 'huidigewaarde'],
  source: ['meetbron', 'bron', 'metric'],
  note:   ['opmerking', 'toelichting', 'notitie'],
};

function parseGoals(rows) {
  if (!rows || !rows.length) return [];
  // Kopregel = de eerste rij met een 'Soort'- en een 'Doel'-kolom (er mag een
  // titel of uitleg boven staan).
  let hi = rows.findIndex(r => (r || []).some(c => GOAL_COLS.kind.includes(normKey(c)))
    && (r || []).some(c => GOAL_COLS.title.includes(normKey(c))));
  if (hi < 0) return [];
  const head = rows[hi].map(normKey);
  const col = {};
  for (const [k, names] of Object.entries(GOAL_COLS)) col[k] = head.findIndex(h => names.includes(h));
  const cell = (r, k) => (col[k] >= 0 ? filled(r[col[k]]) : '');

  const goals = [];
  let objective = null;
  for (const r of rows.slice(hi + 1)) {
    const soort = normKey(cell(r, 'kind'));
    const title = cell(r, 'title');
    if (!soort || !title) continue;
    const kind = soort === 'kpi' ? 'kpi'
      : (['o', 'okr', 'objective', 'doel'].includes(soort) ? 'objective'
      : (['kr', 'keyresult', 'resultaat'].includes(soort) ? 'kr' : null));
    if (!kind) continue;
    const g = {
      kind, title,
      period: cell(r, 'period') || null,
      target: parseNum(cell(r, 'target')), targetRaw: cell(r, 'target') || null,
      actual: parseNum(cell(r, 'actual')), actualRaw: cell(r, 'actual') || null,
      source: cell(r, 'source').toLowerCase() || null,
      note: cell(r, 'note') || null,
    };
    if (kind === 'objective') { g.keyResults = []; objective = g; goals.push(g); }
    else if (kind === 'kr') {
      // Een key result hoort bij het objective erboven. Zonder objective staat hij
      // los, in plaats van stil te verdwijnen.
      if (objective) { if (!g.period) g.period = objective.period; objective.keyResults.push(g); }
      else goals.push({ ...g, kind: 'kr' });
    } else { objective = null; goals.push(g); }
  }
  return goals;
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

    // action=brand — Merk-tab: vaste velden uit Merkcontext + de tab 'Doelen'.
    if (action === 'brand') {
      if (!sheetId) return res.status(200).json({ available: false, reason: 'Voor deze klant is geen klantsheet ingesteld.' });
      try {
        const accessToken = await getAccessToken();
        const [ctx, doelen] = await Promise.all([
          readRange(sheetId, accessToken, 'Merkcontext!A1:C80'),
          readRange(sheetId, accessToken, 'Doelen!A1:H150'),
        ]);
        return res.status(200).json({
          available: true,
          hasContextTab: ctx !== null,
          hasGoalsTab: doelen !== null,
          brand: parseBrand(ctx),
          goals: parseGoals(doelen),
        });
      } catch (e) {
        return res.status(200).json({ available: false, reason: e.message });
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
