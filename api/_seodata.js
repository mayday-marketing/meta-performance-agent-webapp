/* ==========================================================
   _seodata.js — vastgelegde SEO-meting uit Drive lezen en valideren
   ==========================================================
   Gedeelde module (underscore-prefix = geen Vercel-route). Wordt gebruikt door
   seo.js. Tweelingbroer van _geodata.js: zelfde Drive-zoekpad, zelfde
   validatieprincipe, zelfde cache.

   WAAROM DIT BESTAAT
   De SEO-tab draait normaal live op DataForSEO. Dat is precies goed voor een
   echte klant, maar er zijn twee gevallen waarin het niet kan:

     1. een demo- of showcase-omgeving waar het domein niet bestaat — dan komen
        alle posities leeg terug en lijkt de tab stuk terwijl hij werkt;
     2. een klant zonder DataForSEO-koppeling, die wél een uitgevoerde
        keywordanalyse heeft liggen.

   In allebei de gevallen is er een MENSELIJK VASTGELEGDE meting: iemand heeft
   volumes en posities bepaald en weggeschreven. Dat is hetzelfde patroon als de
   GEO-baseline — een meting met een datum en een methode, niet iets wat de app
   verzint. Vandaar: `seo-dashboard.json` in de Drive-map van de klant.

   VOORRANG: staat het bestand er, dan wint het bestand en worden er GEEN
   DataForSEO-calls gedaan. Dat is bewust. Wie een vastgelegde meting neerlegt,
   zegt daarmee 'deze tab draait op dit bestand'; een tab die stilletjes
   afwisselt tussen twee bronnen is onverklaarbaar én kost per ongeluk geld.
   Het bestand weghalen zet de tab weer live.

   NOOIT VERZINNEN: keywords die niet in het bestand staan komen terug als een
   lege rij (volume null), precies zoals DataForSEO keywords zonder data weglaat
   en seo.js ze aanvult. Ontbrekend is onbekend, nooit nul.

   ISOLATIE: de Drive-map komt uit CLIENTS[clientId].driveFolderId, server-side.
   Het request wijst nooit een map of bestand aan.
   ========================================================== */

const { getAccessToken } = require('./_config');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

// Waar we zoeken, in deze volgorde. Het bestand mag ook los in de klantmap staan.
const SEO_FOLDERS = ['SEO', '00_AI-CONTEXT'];
const FILE_RE = /seo[-_]?dashboard.*\.json$/i;

const cache = new Map(); // clientId -> { data, ts }
const TTL_MS = 5 * 60 * 1000;

/* ---------- Drive ---------- */

async function driveList(accessToken, q, fields) {
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&orderBy=modifiedTime desc`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Drive ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.files || [];
}

async function findChildFolder(accessToken, parentId, name) {
  const files = await driveList(
    accessToken,
    `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`,
    'files(id,name)'
  );
  return files[0] || null;
}

async function findSeoFile(accessToken, rootId) {
  const searched = [];
  const candidates = [];

  const scan = async (folderId, label) => {
    searched.push(label);
    const files = await driveList(
      accessToken,
      `'${folderId}' in parents and trashed=false`,
      'files(id,name,mimeType,modifiedTime)'
    );
    for (const f of files) {
      if (FILE_RE.test(f.name)) candidates.push({ ...f, folder: label });
    }
  };

  await scan(rootId, '(klantmap)');
  for (const name of SEO_FOLDERS) {
    const folder = await findChildFolder(accessToken, rootId, name);
    if (folder) await scan(folder.id, name);
  }

  // Nieuwste wint, zodat een hermeting naast de vorige mag blijven staan.
  candidates.sort((a, b) => (a.modifiedTime < b.modifiedTime ? 1 : -1));
  return { file: candidates[0] || null, searched, count: candidates.length };
}

async function downloadJson(accessToken, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Drive download ${res.status}`);
  return res.text();
}

/* ---------- Validatie ----------
   Zelfde regel als overal in deze app: een ontbrekend of ongeldig veld is
   ONBEKEND. Het valt weg, er komt een warning bij, en de rest blijft staan. */

const str = (v, max = 400) => {
  if (v == null) return null;
  const s = String(v).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  return s ? s.slice(0, max) : null;
};

const num = (v, max) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  if (!isFinite(n) || n < 0 || n > max) return null;
  return n;
};

const int = (v, max) => {
  const n = num(v, max);
  return n == null ? null : Math.round(n);
};

const money = (v) => {
  const n = num(v, 1000);
  return n == null ? null : Math.round(n * 100) / 100;
};

const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : null);

const arr = (v) => (Array.isArray(v) ? v : []);

// Keyword net zo saneren als seo.js dat met de aanvraag doet, anders matcht een
// rij uit het bestand niet op de keywordlijst uit de Config-tab.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
function cleanKeyword(raw) {
  const k = String(raw == null ? '' : raw)
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return k && k.length <= 80 ? k : null;
}

const COMPETITION = ['HIGH', 'MEDIUM', 'LOW'];
function competition(v) {
  const s = String(v == null ? '' : v).toUpperCase().trim();
  return COMPETITION.includes(s) ? s : null;
}

/* Maandreeks. Twee schrijfwijzen toegestaan, omdat dit bestand met de hand
   bijgewerkt wordt: een array [{month, volume}] of een object {"2026-01": 1300}.
   Altijd oplopend gesorteerd terug, in de vorm die de frontend al kent. */
function monthly(v) {
  let rows = [];
  if (Array.isArray(v)) {
    rows = v.map((m) => [m?.month, m?.volume]);
  } else if (v && typeof v === 'object') {
    rows = Object.entries(v);
  }
  return rows
    .map(([month, volume]) => ({
      month: /^\d{4}-\d{2}$/.test(String(month || '').trim()) ? String(month).trim() : null,
      volume: int(volume, 1e9),
    }))
    .filter((m) => m.month)
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

/* Positie. Drie toestanden, net als in de promptmatrix van de GEO-tab:
     {pos: 7}      → gemeten, staat op 7
     {pos: null}   → gemeten, staat NIET in de top `depth`
     geen `rank`   → niet gemeten; het keyword valt uit de rank-respons weg en
                     de tabel toont een streepje in plaats van 'niet gevonden'. */
function rank(v, depth) {
  if (v == null) return undefined;
  if (typeof v === 'number' || typeof v === 'string') v = { pos: v };
  if (typeof v !== 'object') return undefined;
  if (!('pos' in v) && !('note' in v)) return undefined;
  const pos = int(v.pos, 1000);
  if (pos == null || pos < 1 || pos > depth) {
    return { pos: null, note: str(v.note, 200) || undefined };
  }
  const abs = int(v.abs, 1000);
  return {
    pos,
    abs: abs == null || abs < pos ? pos : abs,
    url: str(v.url, 500),
    title: str(v.title, 300),
  };
}

function normalize(raw) {
  const warnings = [];
  const d = raw && typeof raw === 'object' ? raw : {};
  const note = (m) => warnings.push(m);

  const depth = int(d.depth, 100) || 20;

  const items = [];
  const ranks = {};
  const seen = new Set();

  for (const row of arr(d.keywords)) {
    const kw = cleanKeyword(row?.keyword);
    if (!kw) { note('Rij zonder bruikbaar keyword — overgeslagen.'); continue; }
    if (seen.has(kw)) { note(`Keyword "${kw}" staat er dubbel in — de eerste rij telt.`); continue; }
    seen.add(kw);

    items.push({
      keyword: kw,
      volume: int(row?.volume, 1e9),
      competition: competition(row?.competition),
      competitionIndex: int(row?.competitionIndex, 100),
      cpc: money(row?.cpc),
      lowBid: money(row?.lowBid),
      highBid: money(row?.highBid),
      monthly: monthly(row?.monthly),
    });

    const r = rank(row?.rank, depth);
    if (r) ranks[kw] = r;
  }

  const measuredAt = isoDate(d.measuredAt) || isoDate(d.auditDate);
  if (!measuredAt) note("Geen geldige 'measuredAt' (YYYY-MM-DD) — de tab toont geen meetdatum.");
  if (!items.length) note('Geen keywords in het bestand.');

  return {
    data: {
      brandName: str(d.brandName, 60),
      domain: str(d.domain, 200),
      location: str(d.location, 80),
      language: /^[a-z]{2}$/i.test(String(d.language || '')) ? String(d.language).toLowerCase() : null,
      measuredAt,
      label: str(d.label, 80),
      method: str(d.method, 1200),
      depth,
      items,
      ranks,
    },
    warnings,
  };
}

/* ---------- Publieke functie ---------- */

/**
 * Vastgelegde SEO-meting voor één klant. Faalt nooit hard: zonder map, zonder
 * bestand of bij ongeldige JSON komt er `data: null` terug plus een reden, en
 * seo.js gaat gewoon live bij DataForSEO.
 */
async function getSeoBaseline(clientId, driveFolderId, force) {
  const key = String(clientId || '').toLowerCase();
  if (!force) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;
  }

  if (!driveFolderId) {
    return { data: null, reason: 'Geen Drive-map geconfigureerd voor deze klant.', searched: [], warnings: [] };
  }

  let result;
  try {
    const accessToken = await getAccessToken(DRIVE_SCOPE);
    const { file, searched, count } = await findSeoFile(accessToken, driveFolderId);
    if (!file) {
      result = { data: null, reason: 'Geen seo-dashboard.json gevonden.', searched, warnings: [] };
    } else {
      const text = await downloadJson(accessToken, file.id);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        // Niet cachen als 'geen bestand': een kapot bestand moet je zien, niet
        // vijf minuten lang stilzwijgend vervangen door live data.
        return { data: null, reason: `${file.name} is geen geldige JSON (${e.message}).`, searched, warnings: [] };
      }
      const { data, warnings } = normalize(parsed);
      result = {
        data: data.items.length ? data : null,
        reason: data.items.length ? null : 'Het bestand bevat geen keywords.',
        searched,
        warnings,
        file: { name: file.name, folder: file.folder, modifiedTime: file.modifiedTime },
        otherFiles: count > 1 ? count - 1 : 0,
      };
    }
  } catch (e) {
    // Niet cachen: een tijdelijke Drive-storing mag niet vijf minuten plakken.
    return { data: null, reason: e.message, searched: [], warnings: [] };
  }

  cache.set(key, { data: result, ts: Date.now() });
  return result;
}

module.exports = { getSeoBaseline, normalize };
