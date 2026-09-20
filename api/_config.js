/* ==========================================================
   _config.js — per-klant instellingen uit de Config-tab
   ==========================================================
   Gedeelde module (underscore-prefix = geen Vercel-route). Wordt gebruikt door
   sheets.js (action=config, voor de frontend) en windsor.js (account-scoping).

   De Config-tab staat in dezelfde klantsheet als Merkcontext en Analysehistoriek,
   met dezelfde veld/waarde-vorm (kolom A = veld, B = waarde). Template:
   CLIENTS/KLANTNAAM/06_PERFORMANTIE/Klant_Context_TEMPLATE.xlsx.

   ISOLATIE: de sheetId wordt hier server-side uit CLIENTS[clientId] gehaald en
   NOOIT uit een request. De gedeelde service-account kan bij élke klantsheet, dus
   een request-opgegeven sheetId = cross-tenant lezen.

   LET OP — Sheets kent geen rechten per tab. Deze tab is alleen afgeschermd zolang
   de spreadsheet zélf niet met de klant gedeeld is. Wachtwoorden en API-keys horen
   hier dus NIET: die blijven in de CLIENTS env var.
   ========================================================== */

const crypto = require('crypto');

const CONFIG_RANGE = 'Config!A1:B60';
const CONFIG_TTL_MS = 10 * 60 * 1000;

// Cache ALTIJD per clientId gekeyed — een gedeelde cache zonder klant in de sleutel
// was eerder al een cross-tenant lek (zie CLAUDE.md).
const configCache = new Map(); // clientId -> { data, ts }

// Hosts waarvan we een logo accepteren. Een vreemde host in een <img src> lekt het
// IP van de kijker; daarom een allowlist i.p.v. 'alles wat https is'.
const LOGO_HOSTS = (process.env.LOGO_HOSTS || 'drive.google.com,lh3.googleusercontent.com,mayday.marketing')
  .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);

const HEX_RE = /^#[0-9a-f]{6}$/i;
const ACCOUNT_RE = /^[A-Za-z0-9._-]{1,64}$/;

function resolveSheetId(clientId) {
  try {
    const clients = JSON.parse(process.env.CLIENTS || '{}');
    return clients[String(clientId).toLowerCase()]?.sheetId || null;
  } catch {
    return null;
  }
}

// Veldnamen normaliseren: hoofdletters, spaties, koppeltekens en accenten weg,
// zodat 'Meta ad-account' en 'META AD ACCOUNT' hetzelfde veld raken.
function normKey(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

function okHex(v) { return HEX_RE.test(v) ? v.toLowerCase() : null; }

function okAccount(v) {
  const s = String(v).replace(/^@/, '').trim();
  return ACCOUNT_RE.test(s) ? s : null;
}

// Percentages in de Config-tab mogen er uitzien zoals een mens ze schrijft:
// '45', '45%', '0,45' en '0.45' worden allemaal 0.45. Buiten 0–1 → ongeldig.
function okPercent(v) {
  const s = String(v).replace('%', '').replace(',', '.').trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  let n = parseFloat(s);
  if (!isFinite(n)) return null;
  if (n > 1) n = n / 100;        // 45 → 0.45
  if (n < 0 || n > 1) return null;
  return Math.round(n * 10000) / 10000;
}

// Een ROAS-doel als getal: '3,2' en '3.2' worden 3.2. Negatief/nul is geen doel.
function okRatio(v) {
  const s = String(v).replace(/[x×]/i, '').replace(',', '.').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  return n > 0 && n < 1000 ? Math.round(n * 100) / 100 : null;
}

// 'GA4', 'ga4-omzet', 'Platform', 'platform-omzet' → 'ga4' | 'platform'.
function okVerdictSource(v) {
  const s = String(v).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (s.startsWith('ga4') || s.startsWith('analytics')) return 'ga4';
  if (s.startsWith('platform') || s.startsWith('kanaal')) return 'platform';
  return null;
}

function okHttpsUrl(v, hosts) {
  try {
    const u = new URL(String(v).trim());
    if (u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    if (hosts && !hosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) return null;
    return u.toString();
  } catch { return null; }
}

// Bekende velden → pad in het configobject + validator. Alles wat hier niet in staat
// en op 'link' of 'url' eindigt komt in links{}; de rest wordt genegeerd (en gemeld).
// De account-sleutels zijn de Windsor-connector-slugs uit windsor.js.
const CONFIG_FIELDS = {
  merknaam:          { path: 'brandName',                  check: v => v.slice(0, 60) },
  accentkleur:       { path: 'accent',                     check: okHex },
  accenttekstkleur:  { path: 'accentText',                 check: okHex },
  logourl:           { path: 'logoUrl',                    check: v => okHttpsUrl(v, LOGO_HOSTS) },
  instagramaccount:  { path: 'accounts.instagram',         check: okAccount },
  facebookaccount:   { path: 'accounts.facebook_organic',  check: okAccount },
  metaadaccount:     { path: 'accounts.facebook',          check: okAccount },
  klaviyoaccount:    { path: 'accounts.klaviyo',           check: okAccount },
  mailerliteaccount: { path: 'accounts.mailerlite',        check: okAccount },
  convertkitaccount: { path: 'accounts.convertkit',        check: okAccount },

  // --- ROAS-tab: omzetbron + betaalde kanalen (zie _channels.js) ------------
  // Elk kanaal verschijnt in de ROAS-tab zodra hier een account-id staat. De
  // sleutel onder accounts.* is de Windsor-connector-slug.
  ga4property:         { path: 'accounts.googleanalytics4', check: okAccount },
  googleanalyticsid:   { path: 'accounts.googleanalytics4', check: okAccount },
  tiktokadaccount:     { path: 'accounts.tiktok',           check: okAccount },
  googleadsaccount:    { path: 'accounts.google_ads',       check: okAccount },
  bingadaccount:       { path: 'accounts.bing',             check: okAccount },
  microsoftadsaccount: { path: 'accounts.bing',             check: okAccount },
  linkedinadaccount:   { path: 'accounts.linkedin',         check: okAccount },
  pinterestadaccount:  { path: 'accounts.pinterest',        check: okAccount },
  snapchatadaccount:   { path: 'accounts.snapchat',         check: okAccount },
  amazonadsaccount:    { path: 'accounts.amazon_ads',       check: okAccount },

  // --- ROAS-tab: break-even-parameters -------------------------------------
  // Brutomarge + korting per wave bepalen de minimum-ROAS waaronder een kanaal
  // of campagne verlies draait. Zie roasTargets() hieronder voor de formule.
  brutomarge:    { path: 'roas.grossMargin', check: okPercent },
  kortingwave1:  { path: 'roas.wave1',       check: okPercent },
  kortingwave2:  { path: 'roas.wave2',       check: okPercent },
  kortingwave3:  { path: 'roas.wave3',       check: okPercent },
  kortingwave4:  { path: 'roas.wave4',       check: okPercent },
  actievewave:   { path: 'roas.activeWave',  check: v => /^(full|wave ?[1-4])$/i.test(String(v).trim()) ? String(v).trim().toLowerCase().replace(/\s+/g, '') : null },
  minimumroas:   { path: 'roas.minRoas',     check: okRatio },
  // Welke omzetdefinitie het oordeel (uitzetten/bijsturen/schalen) bepaalt.
  // Per klant instelbaar omdat het antwoord afhangt van de kwaliteit van de
  // tracking: met sluitende server-side tracking is GA4 betrouwbaar, zonder
  // consent-mode-dekking onderschat GA4 structureel en is platform realistischer.
  // De toggle in de ROAS-tab blijft altijd beschikbaar; dit zet alleen de default.
  oordeelop:     { path: 'roas.verdictSource', check: okVerdictSource },
};

/**
 * Break-even ROAS per kortingswave.
 *
 * Bij een brutomarge m op de volle prijs en een korting d geldt per €100 catalogus-
 * waarde: kostprijs goederen = 100·(1−m), verkoopprijs = 100·(1−d). De brutowinst
 * die overblijft om advertenties te betalen is dus (1−d) − (1−m) = m − d, op een
 * omzet van (1−d). Break-even = omzet / advertentiekosten =
 *
 *     ROAS_be = (1 − d) / (m − d)
 *
 * Bij d ≥ m is er geen marge meer over: elke euro advertising is dan per definitie
 * verlies (in de WOODY-sheet de '-10,0' bij wave 4). Dat geven we terug als null
 * met een expliciete reden, niet als een misleidend negatief getal.
 */
function roasTargets(roas) {
  const m = roas && typeof roas.grossMargin === 'number' ? roas.grossMargin : null;
  if (m == null) return null;

  const waves = [
    { key: 'full',  label: 'Full price', discount: 0 },
    { key: 'wave1', label: 'Wave 1',     discount: roas.wave1 },
    { key: 'wave2', label: 'Wave 2',     discount: roas.wave2 },
    { key: 'wave3', label: 'Wave 3',     discount: roas.wave3 },
    { key: 'wave4', label: 'Wave 4',     discount: roas.wave4 },
  ].filter(w => typeof w.discount === 'number');

  return {
    grossMargin: m,
    activeWave: roas.activeWave || 'full',
    waves: waves.map(w => {
      const margin = m - w.discount;
      return {
        key: w.key,
        label: w.label,
        discount: w.discount,
        // Netto marge per €100 catalogusprijs, vóór advertentiekosten.
        netMargin: Math.round((margin) * 10000) / 10000,
        breakEvenRoas: margin > 0 ? Math.round(((1 - w.discount) / margin) * 100) / 100 : null,
        loss: margin <= 0,
      };
    }),
  };
}

function emptyConfig() {
  return { brandName: null, accent: null, accentText: null, logoUrl: null, accounts: {}, links: {}, roas: {}, roasTargets: null };
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  let cur = obj;
  for (const p of parts) cur = (cur[p] = cur[p] || {});
  cur[last] = value;
}

// Rijen → getypeerd configobject. Een ongeldige waarde breekt niets: het veld valt weg
// en de reden gaat mee in warnings, zodat het dashboard blijft draaien op de defaults.
function parseConfigRows(rows) {
  const config = emptyConfig();
  const warnings = [];

  for (const row of (rows || [])) {
    const veld = (row[0] || '').trim();
    const waarde = (row[1] || '').trim();
    if (!veld || !waarde) continue;
    if (waarde.startsWith('[') || waarde === '—' || waarde === '-') continue; // placeholder
    if (normKey(veld) === 'veld') continue;                                   // kopregel

    const key = normKey(veld);
    const spec = CONFIG_FIELDS[key];

    if (spec) {
      const clean = spec.check(waarde);
      if (clean == null) { warnings.push(`Ongeldige waarde bij '${veld}' — genegeerd.`); continue; }
      setPath(config, spec.path, clean);
      continue;
    }

    if (key.endsWith('link') || key.endsWith('url')) {
      const clean = okHttpsUrl(waarde, null);
      if (clean == null) { warnings.push(`Ongeldige URL bij '${veld}' — genegeerd.`); continue; }
      config.links[veld] = clean;
      continue;
    }

    warnings.push(`Onbekend veld '${veld}' — genegeerd.`);
  }

  // Break-even-targets één keer server-side afleiden, zodat het dashboard, de
  // analyse-agent en de chat allemaal dezelfde drempels zien. De ROAS-tab mag ze
  // live overschrijven voor scenario's; dat blijft client-side en wordt niet bewaard.
  config.roasTargets = roasTargets(config.roas);

  return { config, warnings };
}

// Service-account JWT → access token (scope: alleen spreadsheets lezen/schrijven).
async function getAccessToken() {
  const keyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyRaw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY niet ingesteld.');

  const key = JSON.parse(keyRaw);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claimSet = Buffer.from(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url');

  const sigInput = `${header}.${claimSet}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(sigInput);
  const signature = sign.sign(key.private_key, 'base64url');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${sigInput}.${signature}`,
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Kon geen Google access token verkrijgen.');
  return tokenData.access_token;
}

async function readConfigTab(sheetId, accessToken) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(CONFIG_RANGE)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

  if (!res.ok) {
    // Ontbrekende tab geeft een 400 ('Unable to parse range') — dat is geen fout,
    // dat is een klant die nog niet gemigreerd is.
    const err = await res.json().catch(() => ({}));
    const msg = err.error?.message || String(res.status);
    if (res.status === 400 && /unable to parse range/i.test(msg)) {
      return { config: emptyConfig(), warnings: ['Geen Config-tab in deze sheet.'] };
    }
    throw new Error(`Sheets leesfout: ${msg}`);
  }

  const data = await res.json();
  return parseConfigRows(data.values || []);
}

/**
 * Config voor één klant, gecached per clientId. Faalt nooit hard: zonder sheet,
 * zonder tab of bij een leesfout komt er een lege config terug plus een warning,
 * zodat login en dashboard op de defaults blijven draaien.
 */
async function getClientConfig(clientId) {
  const cacheKey = String(clientId || '').toLowerCase();
  if (!cacheKey) return { config: emptyConfig(), warnings: ['Geen clientId.'] };

  const hit = configCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CONFIG_TTL_MS) return hit.data;

  const sheetId = resolveSheetId(cacheKey);
  if (!sheetId) {
    const result = { config: emptyConfig(), warnings: ['Geen sheet geconfigureerd voor deze klant.'] };
    configCache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  }

  try {
    const accessToken = await getAccessToken();
    const result = await readConfigTab(sheetId, accessToken);
    configCache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  } catch (e) {
    // Niet cachen: een tijdelijke Sheets-storing mag niet 10 minuten blijven plakken.
    return { config: emptyConfig(), warnings: [e.message] };
  }
}

module.exports = { getClientConfig, emptyConfig, parseConfigRows, normKey, roasTargets };
