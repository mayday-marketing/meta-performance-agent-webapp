#!/usr/bin/env node
/* ==========================================================
   add-config-tab.js — zet de Config-tab in elke klantsheet
   ==========================================================
   Leest CLIENTS + GOOGLE_SERVICE_ACCOUNT_KEY uit .env.local (of uit de omgeving),
   en maakt in elke klantsheet een tab `Config` met dezelfde veld/waarde-vorm als
   Klant_Context_TEMPLATE.xlsx. Bestaat de tab al, dan slaat hij die klant over —
   het script overschrijft nooit iets.

   Gebruik:
     node scripts/add-config-tab.js              # droogloop: toont alleen wat er zou gebeuren
     node scripts/add-config-tab.js --apply      # voert het echt uit
     node scripts/add-config-tab.js --apply --only spotto

   De service-account moet bewerkrechten op de sheet hebben. Heeft hij alleen
   leesrechten, dan meldt het script dat per klant en gaat door met de rest.
   ========================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APPLY = process.argv.includes('--apply');
const DEBUG = process.argv.includes('--debug');
const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx !== -1 ? (process.argv[onlyIdx + 1] || '').toLowerCase() : null;
// Ander env-bestand dan .env.local, bv. om productie te controleren:
//   vercel env pull --environment=production .env.production.local
//   node scripts/add-config-tab.js --env .env.production.local
const envIdx = process.argv.indexOf('--env');
const ENV_FILE = envIdx !== -1 ? process.argv[envIdx + 1] : null;
// --identify <url|id> …  → zegt per sheet hoe hij heet, waar hij staat en bij
// welke klant hij hoort. Leest alleen, schrijft nooit.
// --folders  → per klant: waar wijst driveFolderId naartoe?
// --ancestors <id>  → de mappenketen boven een bestand, mét map-ids.
const FOLDERS = process.argv.includes('--folders');
const ancIdx = process.argv.indexOf('--ancestors');
const ANCESTORS = ancIdx !== -1 ? (process.argv[ancIdx + 1] || '').replace(/.*\/d\/([A-Za-z0-9_-]+).*/, '$1') : null;
// --sheet <id>  → werk op deze sheet i.p.v. te zoeken. Alleen samen met --only,
// zodat je nooit per ongeluk één sheet aan alle klanten hangt.
const sheetIdx = process.argv.indexOf('--sheet');
const SHEET_OVERRIDE = sheetIdx !== -1
  ? (process.argv[sheetIdx + 1] || '').replace(/.*\/d\/([A-Za-z0-9_-]+).*/, '$1')
  : null;
// --verify  → leest de Config-tab terug en haalt hem door DEZELFDE parser als de
// app (api/_config.js), zodat je ziet wat het dashboard straks werkelijk krijgt.
const VERIFY = process.argv.includes('--verify');
// --dump <sheetId>   → toont de Config-tab letterlijk, cel voor cel.
// --scan <folderId>  → zoekt spreadsheets in een map (om duplicaten te vinden).
const dumpIdx = process.argv.indexOf('--dump');
const DUMP = dumpIdx !== -1 ? (process.argv[dumpIdx + 1] || '').replace(/.*\/d\/([A-Za-z0-9_-]+).*/, '$1') : null;
const scanIdx = process.argv.indexOf('--scan');
const SCAN = scanIdx !== -1 ? (process.argv[scanIdx + 1] || '') : null;
// --accounts → toont per klant de windsor_accounts uit CLIENTS, zodat je die
// naar de Config-tab kunt overzetten. Account-ids zijn geen geheimen.
const ACCOUNTS = process.argv.includes('--accounts');
// --set "Veld=Waarde"  (herhaalbaar) → vult kolom B van de Config-tab.
// Matcht op de veldnaam in kolom A, hoofdletter- en spatie-ongevoelig. Schrijft
// alleen met --apply; zonder --apply zie je wat er zou veranderen.
const SETS = [];
process.argv.forEach((a, i) => {
  if (a === '--set' && process.argv[i + 1]) {
    const raw = process.argv[i + 1];
    const eq = raw.indexOf('=');
    if (eq > 0) SETS.push({ field: raw.slice(0, eq).trim(), value: raw.slice(eq + 1).trim() });
  }
});
const idIdx = process.argv.indexOf('--identify');
const IDENTIFY = idIdx !== -1
  ? process.argv.slice(idIdx + 1).filter(a => !a.startsWith('--')).map(a => {
      const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(a);
      return m ? m[1] : a;
    })
  : null;

/* ---------- .env.local inlezen (waarden worden nooit geprint) ----------
   Een .env-waarde kan er op drie manieren in staan:
     KEY={"a":1}            onquoted JSON
     KEY='{"a":1}'          enkel gequoteerd, geen escaping
     KEY="{\"a\":1}"        dubbel gequoteerd met escaped quotes (vercel env pull)
   We halen de ruwe waarde eruit en proberen daarna een paar interpretaties tot
   er één geldig JSON oplevert. Zo werkt het script ongeacht hoe het bestand
   is ontstaan. */

function rawAfterKey(raw, key) {
  const re = new RegExp('^[ \\t]*(?:export[ \\t]+)?' + key + '=', 'm');
  const m = re.exec(raw);
  return m ? raw.slice(m.index + m[0].length) : null;
}

// Geeft { quote, body }: de tekst tussen de quotes (escapes blijven staan), of
// bij een onquoted waarde het gebalanceerde JSON-object / de eerste regel.
function extractValue(s) {
  s = s.replace(/^[ \t]+/, '');
  const q = (s[0] === '"' || s[0] === "'") ? s[0] : null;

  if (q) {
    let body = '', esc = false;
    for (let k = 1; k < s.length; k++) {
      const ch = s[k];
      if (esc) { body += '\\' + ch; esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === q) break;
      body += ch;
    }
    return { quote: q, body };
  }

  if (s[0] === '{') {
    let depth = 0, inStr = false, esc = false;
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) return { quote: null, body: s.slice(0, k + 1) };
    }
  }
  return { quote: null, body: s.split(/\r?\n/)[0].trim() };
}

// Kandidaat-interpretaties, in volgorde van waarschijnlijkheid.
function candidates(v) {
  if (!v) return [];
  const list = [v.body];
  if (v.quote === '"') {
    // Laat JSON zelf de escapes wegwerken: "…\"a\"…" → …"a"…
    try { list.unshift(JSON.parse('"' + v.body + '"')); } catch {}
    // Alléén de quotes ontdubbelen. Nodig voor de service-account-sleutel: daar
    // moet \n ESCAPED blijven, want een echte newline in een JSON-string is
    // ongeldig — die zou de sleutel juist onparsebaar maken.
    list.push(v.body.replace(/\\"/g, '"'));
  }
  // Laatste redmiddel: alles ontdubbelen.
  list.push(v.body.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\'));
  return list;
}

// Pakt het JSON-object door accolades te balanceren, ongeacht omringende quotes.
// Nodig wanneer de waarde als "{"a":1}" in het bestand staat: de buitenste quotes
// zijn dan decoratie en de binnenste quotes zijn NIET geëscaped.
function braceSlice(s) {
  const from = s.indexOf('{');
  if (from === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let k = from; k < s.length; k++) {
    const ch = s[k];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return s.slice(from, k + 1);
  }
  return null;
}

// Echte regeleindes/tabs binnen een JSON-string zijn ongeldig. Een service-account-
// sleutel die met opgemaakte newlines in .env.local staat ('-----BEGIN…' over meerdere
// regels) breekt daardoor JSON.parse. Hier escapen we ze terug naar \n / \r / \t,
// zodat de sleutel na parsing weer echte newlines bevat — precies wat OpenSSL wil.
function repairControlChars(s) {
  let out = '', inStr = false, esc = false;
  for (const ch of s) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr) {
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
    }
    out += ch;
  }
  return out;
}

// Redactie: letters → a, cijfers → 9, leestekens blijven staan. Zo is de STRUCTUUR
// van de waarde te zien (waar de quotes, dubbele punten en accolades staan) zonder
// dat er sleutelmateriaal of wachtwoorden in de output verschijnen.
function redact(s) {
  return s.replace(/[A-Za-z]/g, 'a').replace(/[0-9]/g, '9');
}

// Spiegelbeeld van repairControlChars. Sommige .env.local-bestanden bevatten de
// opmaak van pretty-printed JSON als letterlijke \n-reeksen BUITEN de strings:
//     {\n  "type": "service_account",\n  "private_key": "…\n…"\n}
// Buiten een string is \n ongeldig JSON, dus daar maken we een spatie van. Binnen
// een string blijft \n staan — dáár is het juist de correcte notatie voor het
// regeleinde in de private key.
function unescapeWsOutsideStrings(s) {
  let out = '', inStr = false, esc = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (inStr) {
      out += ch;
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === '\\' && 'ntr'.indexOf(s[k + 1]) !== -1) { out += ' '; k++; continue; }
    out += ch;
  }
  return out;
}

function parseJsonValue(raw, key) {
  const after = rawAfterKey(raw, key) || '';
  const v = extractValue(after);
  const all = candidates(v);
  const bs = braceSlice(after);
  if (bs) all.push(bs);            // quotes negeren, puur op accolades
  // Tweede ronde: dezelfde kandidaten met geëscapete controletekens, en met
  // \n-reeksen die buiten de strings staan omgezet naar echte witruimte.
  for (const c of all.slice()) {
    all.push(repairControlChars(c));
    all.push(unescapeWsOutsideStrings(c));
    all.push(unescapeWsOutsideStrings(repairControlChars(c)));
  }
  const errors = [];
  for (const c of all) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (e) { errors.push({ len: c.length, msg: e.message, text: c }); }
  }

  if (DEBUG) {
    console.log(`\n--- debug ${key} (geredigeerd: letters→a, cijfers→9) ---`);
    errors.forEach((er, i) => {
      console.log(` kandidaat ${i + 1} (${er.len} tekens): ${er.msg}`);
      const m = /position (\d+)/.exec(er.msg);
      const at = m ? parseInt(m[1], 10) : 0;
      const from = Math.max(0, at - 40);
      console.log(`   rond positie ${at}: …${redact(er.text.slice(from, at + 40))}…`);
      console.log(`   begin:          ${redact(er.text.slice(0, 80))}`);
    });
    console.log('--- einde debug ---\n');
  }
  // Diagnose zonder de inhoud te tonen.
  const diag = `lengte=${v.body.length} quote=${v.quote || 'geen'} bevat_escaped_quotes=${/\\"/.test(v.body)} accolade_slice=${bs ? bs.length : 'geen'} ruwe_newlines=${bs ? /\n/.test(bs) : false}`;
  throw new Error(`${key} kon niet als JSON gelezen worden (${diag})`);
}

function loadEnv() {
  const file = ENV_FILE
    ? path.resolve(process.cwd(), ENV_FILE)
    : path.join(__dirname, '..', '.env.local');
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  const clients = (!ENV_FILE && process.env.CLIENTS)
    ? JSON.parse(process.env.CLIENTS)
    : (raw ? parseJsonValue(raw, 'CLIENTS') : null);

  let saKey = (!ENV_FILE && process.env.GOOGLE_SERVICE_ACCOUNT_KEY) || null;
  if (!saKey && raw) saKey = JSON.stringify(parseJsonValue(raw, 'GOOGLE_SERVICE_ACCOUNT_KEY'));

  return { clients, saKey };
}

/* ---------- Google auth ---------- */

async function getAccessToken(keyRaw) {
  const key = JSON.parse(keyRaw);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claimSet = Buffer.from(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url');
  const sigInput = `${header}.${claimSet}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(sigInput);
  const jwt = `${sigInput}.${sign.sign(key.private_key, 'base64url')}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Geen access token: ' + JSON.stringify(data).slice(0, 200));
  return { token: data.access_token, email: key.client_email };
}

async function api(url, token, method, body) {
  const res = await fetch(url, {
    method: method || 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json;
}

/* ---------- Sheet zoeken in de Drive-map van de klant ----------
   Elke klant heeft een eigen map (driveFolderId in CLIENTS), maar de sheet staat
   niet overal op dezelfde plek. We lopen de mapboom af en verzamelen elk
   spreadsheet-bestand. 06_PERFORMANTIE krijgt voorrang, want dat is de plek uit
   de mapconventie (zie CLAUDE.md en Klant_Context_TEMPLATE.xlsx).

   ISOLATIE: we starten altijd bij de driveFolderId van déze klant, dus we kunnen
   per definitie niet in de map van een andere klant terechtkomen. */

const GSHEET = 'application/vnd.google-apps.spreadsheet';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FOLDER = 'application/vnd.google-apps.folder';

async function listChildren(folderId, token) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}`
            + `&fields=files(id,name,mimeType)&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const res = await api(url, token);
  return res.files || [];
}

// Doorzoekt de map tot MAX_DEPTH niveaus diep en geeft elk gevonden spreadsheet
// terug met het pad waar het stond.
async function findSheets(rootId, token, maxDepth = 4) {
  const found = [];
  const queue = [{ id: rootId, path: '', depth: 0 }];

  while (queue.length) {
    const node = queue.shift();
    let children;
    try { children = await listChildren(node.id, token); }
    catch (e) { found.push({ error: `${node.path || '/'}: ${e.message}` }); continue; }

    for (const f of children) {
      const here = node.path ? `${node.path}/${f.name}` : f.name;
      if (f.mimeType === FOLDER) {
        if (node.depth < maxDepth) queue.push({ id: f.id, path: here, depth: node.depth + 1 });
      } else if (f.mimeType === GSHEET || f.mimeType === XLSX) {
        found.push({ id: f.id, name: f.name, path: here, office: f.mimeType === XLSX });
      }
    }
  }

  // 06_PERFORMANTIE eerst, daarna native Sheets vóór .xlsx, daarna op naam.
  const score = (f) => (/06_PERFORMANTIE/i.test(f.path) ? 0 : 10)
                     + (/klant.?context/i.test(f.name) ? 0 : 2)
                     + (f.office ? 1 : 0);
  return found.filter(f => !f.error).sort((a, b) => score(a) - score(b) || a.path.localeCompare(b.path));
}

// Loopt via parents omhoog en bouwt het pad, tot we een map raken die als
// driveFolderId van een klant in CLIENTS staat.
async function locate(fileId, token, clientFolders) {
  const f = await api(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,parents,trashed,owners(emailAddress)&supportsAllDrives=true`,
    token
  );
  const segments = [];
  let owner = null;
  let cur = f.parents && f.parents[0];
  for (let depth = 0; cur && depth < 12; depth++) {
    if (clientFolders[cur]) { owner = clientFolders[cur]; break; }
    const p = await api(
      `https://www.googleapis.com/drive/v3/files/${cur}?fields=id,name,parents&supportsAllDrives=true`,
      token
    );
    segments.unshift(p.name);
    cur = p.parents && p.parents[0];
  }
  return { id: f.id, name: f.name, mimeType: f.mimeType, path: segments.join('/'), owner, trashed: f.trashed, owners: f.owners };
}

/* ---------- Inhoud van de Config-tab ---------- */

const ROWS = [
  ['KLANT_CONTEXT — CONFIG (DASHBOARD)', '', ''],
  ['Merkagnostisch. Vul per klant in; lege of [placeholder]-cellen worden genegeerd en vallen terug op de standaard. De dashboard-app leest Config!A1:B60.', '', ''],
  ['GEEN wachtwoorden of API-keys in deze tab. Die blijven in de CLIENTS env var. Deze tab is alleen afgeschermd zolang deze spreadsheet niet met de klant gedeeld is.', '', ''],
  ['VELD', 'WAARDE', 'TOELICHTING'],

  ['MERKIDENTITEIT', '', ''],
  ['Merknaam', '[Merknaam]', 'Zoals getoond in de dashboardheader'],
  ['Accent kleur', '[#RRGGBB]', 'Eén merkkleur, hex. Moet 4.5:1 halen op #FAF9F7'],
  ['Accent tekstkleur', '[#RRGGBB — leeg laten indien niet nodig]', 'Alleen invullen als het accent 4.5:1 niet haalt'],
  ['Logo URL', '[https://...]', 'SVG of PNG, max 28px hoog. Alleen https van een toegestane host'],

  ['ACCOUNT-IDS', '', ''],
  ['Instagram account', '[username]', 'Windsor-veld account_name, bv. spotto.be (zonder @)'],
  ['Facebook account', '[paginanaam of id]', 'Connector facebook_organic'],
  ['Meta ad account', '[act_...]', 'Connector facebook (Meta Ads)'],
  ['Klaviyo account', '[id]', 'Alleen invullen als Klaviyo gekoppeld is'],
  ['MailerLite account', '[id]', 'Alleen invullen als MailerLite gekoppeld is'],
  ['ConvertKit account', '[id]', 'Alleen invullen als ConvertKit gekoppeld is'],

  ['WEBSITE (GA4 + SEARCH CONSOLE)', '', ''],
  ['GA4 property', '[cijferreeks]', 'Property-id, bv. 491908260. Voedt de Website- en de ROAS-tab'],
  ['Search Console site', '[sc-domain:merk.be of https://www.merk.be/]', 'Exact zoals Google de property noemt. Zonder dit veld geen organisch-zoeken-blok'],
  ['Website type', '[webshop of leads]', 'Bepaalt of de tab de verkoopfunnel of de leadconversies toont. Leeg = afgeleid uit de data'],
  ['Conversiedoel', '[ga4_eventnaam]', 'GA4-event van het hoofddoel, bv. purchase of generate_lead. Zonder dit veld telt de tab álle key events samen'],
  ['Conversiedoel label', '[Contactaanvraag]', 'Hoe dat doel in het dashboard heet'],

  ['ROAS (BETAALDE KANALEN + BREAK-EVEN)', '', ''],
  ['TikTok ad account', '[id]', 'Een kanaal verschijnt in de ROAS-tab zodra hier een id staat'],
  ['Google Ads account', '[id]', ''],
  ['Bing ad account', '[id]', ''],
  ['Brutomarge', '[45%]', 'Marge op de volle prijs. Zonder dit veld is er geen break-even en dus geen oordeel'],
  ['Seizoenskorting', '[30%]', 'Korting die nu loopt. Break-even = (1 − korting) / (brutomarge − korting). Leeg = enkel volle prijs'],
  ['Minimum ROAS', '[leeg laten tenzij je de break-even wil overrulen]', 'Directe override van de drempel'],
  ['Oordeel op', '[GA4 of Platform]', 'Welke omzetdefinitie het oordeel bepaalt. Standaard GA4'],

  ['SEO (DATAFORSEO)', '', ''],
  ['SEO domein', '[merk.be]', 'Merk-domein voor de rank-check. Zonder dit veld geen posities, wel volumes. Subdomeinen tellen mee'],
  ['SEO markt', '[Belgium]', 'Locatienaam zoals DataForSEO hem kent, bv. Belgium of Netherlands. Leeg = Belgium'],
  ['SEO taal', '[nl]', 'Tweeletterige taalcode: nl, fr, en. Leeg = nl'],
  ['SEO keywords', '[keyword 1, keyword 2, keyword 3]', 'Startlijst, gescheiden door komma. In de tab zelf aan te vullen; max 60 hier'],

  ['DOCUMENTLINKS', '', ''],
  ['Merkbrief link', '[https://...]', "Elk veld dat op 'link' of 'url' eindigt wordt automatisch meegenomen"],
  ['Strategie link', '[https://...]', ''],
  ['Rapportage link', '[https://...]', ''],
];

// Titel, kopregel en de sectiekoppen. Afgeleid uit ROWS in plaats van met de
// hand genummerd: een sectiekop is een rij zonder waarde en zonder toelichting.
// De vaste lijst die hier stond liep bij elke nieuwe sectie uit de pas (de laatste
// kop bleef onopgemaakt en er stond een index die niet bestond).
const BOLD_ROWS = ROWS
  .map((r, i) => ({ r, i }))
  .filter(({ r, i }) => i === 0 || i === 3 || (i > 3 && r[1] === '' && r[2] === ''))
  .map(({ i }) => i);

/* ---------- Uitvoeren ---------- */

async function ensureConfigTab(sheetId, token) {
  const meta = await api(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=properties.title,sheets.properties(title,sheetId)`,
    token
  );
  const titles = (meta.sheets || []).map(s => s.properties.title);
  if (titles.includes('Config')) return { skipped: true, name: meta.properties.title, titles };
  if (!APPLY) return { dryRun: true, name: meta.properties.title, titles };

  const add = await api(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, token, 'POST', {
    requests: [{
      addSheet: {
        properties: {
          title: 'Config',
          gridProperties: { rowCount: 60, columnCount: 3, frozenRowCount: 4 },
        },
      },
    }],
  });
  const newId = add.replies[0].addSheet.properties.sheetId;

  await api(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent('Config!A1:C' + ROWS.length)}?valueInputOption=RAW`,
    token, 'PUT', { values: ROWS }
  );

  await api(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, token, 'POST', {
    requests: [
      { updateDimensionProperties: { range: { sheetId: newId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 220 }, fields: 'pixelSize' } },
      { updateDimensionProperties: { range: { sheetId: newId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 340 }, fields: 'pixelSize' } },
      { updateDimensionProperties: { range: { sheetId: newId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 380 }, fields: 'pixelSize' } },
      ...BOLD_ROWS.map(r => ({
        repeatCell: {
          range: { sheetId: newId, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: 0, endColumnIndex: 3 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      })),
    ],
  });

  return { created: true, name: meta.properties.title, titles };
}

(async () => {
  let clients, saKey;
  try {
    const env = loadEnv();
    clients = env.clients;
    saKey = env.saKey;
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (!clients) { console.error('CLIENTS niet gevonden in .env.local of omgeving.'); process.exit(1); }
  if (!saKey) { console.error('GOOGLE_SERVICE_ACCOUNT_KEY niet gevonden.'); process.exit(1); }
  console.log(`Klanten in CLIENTS: ${Object.keys(clients).length}`);

  const { token, email } = await getAccessToken(saKey);
  console.log(`Service-account: ${email}`);
  console.log(APPLY ? 'Modus: UITVOEREN\n' : 'Modus: DROOGLOOP (voeg --apply toe om echt te schrijven)\n');

  if (SETS.length) {
    const { normKey, parseConfigRows } = require('../api/_config.js');
    const target = SHEET_OVERRIDE || (ONLY && clients[ONLY] && clients[ONLY].sheetId);
    if (!target) { console.error('--set vereist --sheet <id>, of een klant met sheetId via --only.'); process.exit(1); }

    const cur = await api(`https://sheets.googleapis.com/v4/spreadsheets/${target}/values/${encodeURIComponent('Config!A1:B60')}`, token);
    const rows = cur.values || [];
    const rowOf = {};
    rows.forEach((r, i) => { const k = normKey(r[0] || ''); if (k) rowOf[k] = i + 1; });

    const updates = [];
    for (const st of SETS) {
      const row = rowOf[normKey(st.field)];
      if (!row) { console.log(`  ! veld '${st.field}' staat niet in de Config-tab — overgeslagen`); continue; }
      const oud = (rows[row - 1] && rows[row - 1][1]) || '';
      console.log(`  rij ${String(row).padStart(2)}  ${st.field.padEnd(20)} ${oud || '(leeg)'}  →  ${st.value}`);
      updates.push({ range: `Config!B${row}`, values: [[st.value]] });
    }

    if (!updates.length) { console.log('\nNiets te doen.'); return; }
    if (!APPLY) { console.log('\nDroogloop — voeg --apply toe om dit weg te schrijven.'); return; }

    await api(`https://sheets.googleapis.com/v4/spreadsheets/${target}/values:batchUpdate`, token, 'POST',
      { valueInputOption: 'RAW', data: updates });
    console.log(`\n✓ ${updates.length} cel(len) bijgewerkt.`);

    const after = await api(`https://sheets.googleapis.com/v4/spreadsheets/${target}/values/${encodeURIComponent('Config!A1:B60')}`, token);
    const { config, warnings } = parseConfigRows(after.values || []);
    console.log('\nZoals de app het nu leest:');
    console.log('  merknaam: ' + (config.brandName || '—'));
    console.log('  accent:   ' + (config.accent || '—') + (config.accentText ? ' / tekst ' + config.accentText : ''));
    console.log('  accounts: ' + (Object.entries(config.accounts).map(([k, v]) => k + '=' + v).join(', ') || '—'));
    console.log('  warnings: ' + (warnings.length ? warnings.join(' | ') : 'geen'));
    console.log('');
    return;
  }

  if (ACCOUNTS) {
    for (const [id, cfg] of Object.entries(clients)) {
      if (ONLY && id.toLowerCase() !== ONLY) continue;
      const wa = cfg.windsor_accounts || {};
      const keys = Object.keys(wa);
      console.log(`\n- ${id}  (email_connector: ${cfg.email_connector || '—'})`);
      if (!keys.length) { console.log('    geen windsor_accounts in CLIENTS'); continue; }
      for (const k of keys) console.log(`    ${k.padEnd(18)} ${wa[k]}`);
    }
    console.log('');
    return;
  }

  if (DUMP) {
    const r = await api(`https://sheets.googleapis.com/v4/spreadsheets/${DUMP}/values/${encodeURIComponent('Config!A1:C60')}`, token);
    (r.values || []).forEach((row, i) => {
      const a = (row[0] || '').slice(0, 34).padEnd(34);
      const b = (row[1] || '').slice(0, 40);
      if (row[0] || row[1]) console.log(String(i + 1).padStart(3) + '  ' + a + ' | ' + b);
    });
    console.log('');
    return;
  }

  if (SCAN) {
    const hits = await findSheets(SCAN, token);
    console.log(`\n${hits.length} spreadsheet(s):`);
    for (const h of hits) console.log(`  ${h.office ? '[.xlsx]' : '[Sheet]'} ${h.path}\n          id: ${h.id}`);
    console.log('');
    return;
  }

  if (VERIFY) {
    const { parseConfigRows } = require('../api/_config.js');
    for (const [id, cfg] of Object.entries(clients)) {
      if (ONLY && id.toLowerCase() !== ONLY) continue;
      const sid = SHEET_OVERRIDE || cfg.sheetId;
      if (!sid) { console.log(`- ${id.padEnd(12)} geen sheetId — overgeslagen`); continue; }
      try {
        const r = await api(`https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent('Config!A1:B60')}`, token);
        const { config, warnings } = parseConfigRows(r.values || []);
        console.log(`\n- ${id} (${sid})`);
        console.log(`  merknaam:   ${config.brandName || '—'}`);
        console.log(`  accent:     ${config.accent || '— (dashboard gebruikt de standaardkleur)'}`);
        console.log(`  logo:       ${config.logoUrl || '—'}`);
        const acc = Object.entries(config.accounts);
        console.log(`  accounts:   ${acc.length ? acc.map(([k, v]) => `${k}=${v}`).join(', ') : '— (geen scoping: alle accounts van de sleutel)'}`);
        const lnk = Object.keys(config.links);
        console.log(`  links:      ${lnk.length ? lnk.join(', ') : '—'}`);
        console.log(`  warnings:   ${warnings.length ? warnings.join(' | ') : 'geen'}`);
      } catch (e) {
        console.log(`\n- ${id} FOUT: ${e.message}`);
      }
    }
    console.log('');
    return;
  }

  if (FOLDERS) {
    for (const [id, cfg] of Object.entries(clients)) {
      if (!cfg.driveFolderId) { console.log(`- ${id.padEnd(12)} geen driveFolderId`); continue; }
      try {
        const f = await api(`https://www.googleapis.com/drive/v3/files/${cfg.driveFolderId}?fields=id,name,mimeType,parents&supportsAllDrives=true`, token);
        const segs = [];
        let cur = f.parents && f.parents[0];
        for (let d = 0; cur && d < 8; d++) {
          const par = await api(`https://www.googleapis.com/drive/v3/files/${cur}?fields=id,name,parents&supportsAllDrives=true`, token);
          segs.unshift(par.name);
          cur = par.parents && par.parents[0];
        }
        const kind = f.mimeType === FOLDER ? 'map' : `GEEN MAP (${f.mimeType})`;
        console.log(`- ${id.padEnd(12)} ${segs.join('/')}/${f.name}   [${kind}]`);
        console.log(`  ${' '.repeat(12)} geconfigureerde id: ${cfg.driveFolderId}`);
      } catch (e) {
        console.log(`- ${id.padEnd(12)} FOUT: ${e.message}`);
      }
    }
    console.log('');
    return;
  }

  if (ANCESTORS) {
    let cur = ANCESTORS;
    const chain = [];
    for (let d = 0; cur && d < 12; d++) {
      const f = await api(`https://www.googleapis.com/drive/v3/files/${cur}?fields=id,name,mimeType,parents&supportsAllDrives=true`, token);
      chain.unshift({ id: f.id, name: f.name, folder: f.mimeType === FOLDER });
      cur = f.parents && f.parents[0];
    }
    console.log('\nMappenketen (bovenaan begint de Drive):');
    chain.forEach((c, i) => console.log(`${'  '.repeat(i)}${c.folder ? '[map] ' : '[bestand] '}${c.name}\n${'  '.repeat(i)}      id: ${c.id}`));
    console.log('');
    return;
  }

  if (IDENTIFY) {
    const clientFolders = {};
    for (const [id, cfg] of Object.entries(clients)) if (cfg.driveFolderId) clientFolders[cfg.driveFolderId] = id;
    for (const fid of IDENTIFY) {
      try {
        const r = await locate(fid, token, clientFolders);
        const kind = r.mimeType === GSHEET ? 'Google Sheet' : (r.mimeType === XLSX ? '.xlsx (NIET bruikbaar)' : r.mimeType);
        console.log(`\n${r.name}`);
        console.log(`  id:     ${r.id}`);
        console.log(`  type:   ${kind}`);
        console.log(`  pad:    ${r.path || '(direct in de klantmap)'}`);
        console.log(`  status: ${r.trashed ? 'IN DE PRULLENBAK' : 'actief'}`);
        console.log(`  eigenaar: ${(r.owners || []).map(o => o.emailAddress).join(', ') || 'onbekend'}`);
        console.log(`  klant:  ${r.owner || 'GEEN match met een driveFolderId uit CLIENTS'}`);
        if (r.mimeType === GSHEET) {
          try {
            const meta = await api(`https://sheets.googleapis.com/v4/spreadsheets/${r.id}?fields=sheets.properties.title`, token);
            console.log(`  tabs:   ${(meta.sheets || []).map(x => x.properties.title).join(' | ')}`);
          } catch (e) { console.log(`  tabs:   niet leesbaar (${e.message})`); }
        }
      } catch (e) {
        console.log(`\n${fid}\n  FOUT: ${e.message}`);
      }
    }
    console.log('');
    return;
  }

  let created = 0, skipped = 0, failed = 0;
  const discovered = {};   // clientId -> sheetId, om achteraf in CLIENTS te zetten

  for (const [id, cfg] of Object.entries(clients)) {
      if (ONLY && id.toLowerCase() !== ONLY) continue;
    let sheetId = cfg.sheetId || null;

    // Expliciet opgegeven sheet wint — handig zolang CLIENTS nog niet gecorrigeerd is.
    if (!sheetId && SHEET_OVERRIDE) {
      sheetId = SHEET_OVERRIDE;
      console.log(`- ${id.padEnd(14)} sheet uit --sheet: ${sheetId}`);
    }

    // Geen sheetId in CLIENTS? Zoek de sheet in de Drive-map van déze klant.
    if (!sheetId) {
      if (!cfg.driveFolderId) {
        console.log(`- ${id.padEnd(14)} geen sheetId én geen driveFolderId — overgeslagen`);
        continue;
      }
      // Wijst driveFolderId wel naar een map? Zo niet, is dát het probleem.
      try {
        const probe = await api(`https://www.googleapis.com/drive/v3/files/${cfg.driveFolderId}?fields=id,name,mimeType&supportsAllDrives=true`, token);
        if (probe.mimeType !== FOLDER) {
          console.log(`- ${id.padEnd(14)} driveFolderId wijst naar "${probe.name}" — dat is GEEN map`);
          console.log(`  ${' '.repeat(14)} (${probe.mimeType})`);
          if (probe.mimeType === GSHEET) {
            console.log(`  ${' '.repeat(14)} → dit hoort in CLIENTS bij "sheetId", niet bij "driveFolderId";`);
            console.log(`  ${' '.repeat(14)}   zet in driveFolderId de id van de klantmap zelf.`);
            console.log(`  ${' '.repeat(14)} → of draai nu: --apply --only ${id} --sheet ${probe.id}`);
          }
          skipped++;
          continue;
        }
      } catch (e) {
        failed++;
        console.log(`- ${id.padEnd(14)} FOUT bij lezen van driveFolderId: ${e.message}`);
        continue;
      }

      let hits;
      try { hits = await findSheets(cfg.driveFolderId, token); }
      catch (e) { failed++; console.log(`- ${id.padEnd(14)} FOUT bij zoeken in Drive: ${e.message}`); continue; }

      if (!hits.length) {
        console.log(`- ${id.padEnd(14)} geen spreadsheet gevonden in de Drive-map — overgeslagen`);
        continue;
      }

      console.log(`- ${id.padEnd(14)} ${hits.length} spreadsheet(s) gevonden in Drive:`);
      hits.forEach((h, i) => {
        console.log(`    ${i === 0 ? '→' : ' '} ${h.office ? '[.xlsx]' : '[Sheet] '} ${h.path}`);
        console.log(`       id: ${h.id}`);
      });

      const best = hits[0];
      if (hits.length > 1 && APPLY) {
        console.log(`    ! meerdere kandidaten — zet zelf de juiste sheetId in CLIENTS en draai opnieuw`);
        skipped++;
        continue;
      }
      sheetId = best.id;
      discovered[id] = best.id;
    }

    try {
      const r = await ensureConfigTab(sheetId, token);
      if (r.skipped) { skipped++; console.log(`- ${id.padEnd(14)} "${r.name}" heeft al een Config-tab — overgeslagen`); }
      else if (r.dryRun) { console.log(`- ${id.padEnd(14)} "${r.name}" zou een Config-tab krijgen (tabs nu: ${r.titles.join(', ')})`); }
      else { created++; console.log(`- ${id.padEnd(14)} "${r.name}" ✓ Config-tab aangemaakt`); }
    } catch (e) {
      failed++;
      let hint = '';
      if (/must not be an Office file/i.test(e.message)) {
        // De Sheets API werkt alleen op native Google Sheets, niet op .xlsx in Drive.
        hint = '\n                 → dit is een .xlsx in Drive, geen Google Sheet. Open hem in Sheets,'
             + '\n                   kies Bestand > Opslaan als Google Spreadsheet, en zet de NIEUWE'
             + '\n                   sheetId (uit de URL) in de CLIENTS env var.';
      } else if (/permission|forbidden|403/i.test(e.message)) {
        hint = '  → geef de service-account bewerkrechten op deze sheet';
      } else if (/not found|404/i.test(e.message)) {
        hint = '  → sheetId bestaat niet of is niet gedeeld met de service-account';
      }
      console.log(`- ${id.padEnd(14)} FOUT: ${e.message}${hint}`);
    }
  }

  if (Object.keys(discovered).length) {
    console.log('\nGevonden sheetIds — zet deze in de CLIENTS env var (Vercel + .env.local),');
    console.log('dan hoeft er nooit meer in Drive gezocht te worden:');
    for (const [id, sid] of Object.entries(discovered)) {
      console.log(`  "${id}": { …, "sheetId": "${sid}" }`);
    }
  }

  console.log(`\nKlaar. Aangemaakt: ${created} · Overgeslagen: ${skipped} · Mislukt: ${failed}`);
  if (!APPLY) console.log('Dit was een droogloop — er is niets gewijzigd.');
})();
