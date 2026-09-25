/* ==========================================================
   _geodata.js — GEO-baseline uit Drive lezen en valideren
   ==========================================================
   Gedeelde module (underscore-prefix = geen Vercel-route). Wordt gebruikt door
   geo.js.

   WAAROM EEN JSON-BESTAND EN GEEN PARSER OP HET AUDIT-DOCUMENT
   De geo-visibility-audit levert een markdown-rapport. Twee echte audits naast
   elkaar (mayday 28-07-2026 en Just Jane 28-07-2026) hebben verschillende
   koppen, verschillende tabelkolommen ('Runs' vs 'Prompts', 'Top competitor by
   SoV' vs 'Top concurrent'), verschillende talen en bij Just Jane een extra
   'OFFICIËLE BASELINE'-tabel vóór de scorecard. Een parser daarop geeft geen
   foutmelding als hij ernaast zit — hij geeft een verkeerd cijfer. Dat is de
   ene ding dat een GEO-dashboard niet mag doen (zie de handover: 'geen audit =
   geen echte cijfers, nooit cijfers verzinnen').

   Daarom: wie de audit draait, schrijft het resultaat één keer weg als
   `geo-dashboard.json` volgens het schema in agents/GEO_Dashboard_Schema.md.
   Dat is hetzelfde werk als de HTML-template per klant invullen, maar dan één
   keer en machineleesbaar.

   ISOLATIE: de Drive-map komt uit CLIENTS[clientId].driveFolderId, server-side.
   Het request wijst nooit een map of bestand aan — de gedeelde service-account
   kan bij élke klantmap.

   GEEN PERCENTAGES IN HET BESTAND (schema v2). Het bestand bevat de ruwe
   runs per prompt × engine × pass; het dashboard rekent mention rates,
   blokken, deltas en share of voice daar zelf uit. Een hand-ingevuld
   percentage kan zo nooit afwijken van de matrix eronder.
   ========================================================== */

const { getAccessToken } = require('./_config');

// Dit bestand leest Drive, niet Sheets — dus een eigen scope op het token.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

// Waar we zoeken, in deze volgorde. De eerste map die bestaat wint; het bestand
// mag ook los in de klantmap staan.
const GEO_FOLDERS = ['GEO', '00_AI-CONTEXT'];
const FILE_RE = /geo[-_]?dashboard.*\.json$/i;

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

// Zoekt het nieuwste geo-dashboard*.json in de klantmap en in de bekende
// submappen. Geeft ook terug wáár is gekeken, zodat de UI kan zeggen waar het
// bestand verwacht wordt in plaats van alleen 'niet gevonden'.
async function findGeoFile(accessToken, rootId) {
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
  for (const name of GEO_FOLDERS) {
    const folder = await findChildFolder(accessToken, rootId, name);
    if (folder) await scan(folder.id, name);
  }

  // Nieuwste wint. Zo kan er naast de baseline een her-audit liggen zonder dat
  // iemand de oude hoeft weg te gooien.
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
   Leidend principe, net als bij de ROAS- en Website-tab: een ontbrekend of
   ongeldig veld is ONBEKEND, nooit nul. Het valt weg, er komt een warning bij,
   en de rest van het dashboard blijft staan. Nooit een 0% tonen omdat iemand
   'n.v.t.' heeft ingevuld. */

const str = (v, max = 400) => {
  if (v == null) return null;
  const s = String(v).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  return s ? s.slice(0, max) : null;
};

const int = (v, max = 1e9) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!isFinite(n) || n < 0 || n > max) return null;
  return Math.round(n);
};

const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : null);

const oneOf = (v, allowed) => {
  const s = String(v == null ? '' : v).toLowerCase().trim();
  return allowed.includes(s) ? s : null;
};

const arr = (v) => (Array.isArray(v) ? v : []);

/* Promptmatrix-cel.
   0 = niet genoemd · 1 = genoemd · 2 = genoemd maar fout beschreven
   null = NIET GEMETEN. Die vierde toestand staat niet in de template maar is
   wel nodig: bij Just Jane is Gemini op 7 van de 20 prompts gemeten en de rest
   niet. Zonder onderscheid zou 'niet gemeten' als 'niet genoemd' tellen en de
   mention rate structureel te laag uitvallen. */
function cell(v) {
  if (v === 0 || v === 1 || v === 2) return v;
  const s = String(v == null ? '' : v).toLowerCase().trim();
  if (s === '0' || s === 'nee' || s === 'absent') return 0;
  if (s === '1' || s === 'ja' || s === 'mentioned' || s === 'correct') return 1;
  if (s === '2' || s === 'fout' || s === 'wrong' || s === 'misdescribed') return 2;
  return null; // niet gemeten
}

/* ==========================================================
   SCHEMA v2 — het 2+3+1-model (zie agents/GEO_Dashboard_Schema.md)
   ==========================================================
   Het bestand bevat ALLE merkdata: merk, bevroren share-of-voice-set,
   promptset, acties en de metingen als historiek. De code bevat geen enkel
   merkgegeven. Het dashboard rekent zelf: mention rates, blokken, deltas en
   share of voice komen uit de ruwe runs, niet uit vrije tekst — zo kan een
   tegel nooit iets anders zeggen dan de matrix eronder. */

const PROMPT_TYPES = ['category', 'comparison', 'how-to', 'problem', 'brand'];
// Nederlandse en oude schrijfwijzen → canoniek type.
const TYPE_ALIAS = {
  categorie: 'category', category: 'category', vergelijking: 'comparison', comparison: 'comparison',
  'how-to': 'how-to', howto: 'how-to', probleem: 'problem', problem: 'problem', brand: 'brand', merk: 'brand',
};
const SPLIT_CLASSES = ['correct_entity', 'correct_entity_wrong_description', 'namesake', 'invented', 'generic_no_entity'];
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function normEngines(list, note) {
  const seen = new Set();
  return arr(list).map((e) => {
    const name = str(e?.name, 40);
    const id = slug(e?.id || name);
    return { id, name: name || id };
  }).filter((e) => {
    if (!e.id) { note('Engine zonder id of naam — overgeslagen.'); return false; }
    if (seen.has(e.id)) { note(`Engine '${e.id}' staat dubbel — tweede overgeslagen.`); return false; }
    seen.add(e.id);
    return true;
  });
}

function normPrompts(list, note) {
  const unknown = new Map(); // onbekend type → promptnummers (één waarschuwing per type)
  const out = arr(list).map((p, i) => {
    const rawType = String(p?.type ?? '').toLowerCase().trim();
    const type = TYPE_ALIAS[rawType] || null;
    const n = int(p?.n, 9999) ?? i + 1;
    if (!type) unknown.set(p?.type ?? '', [...(unknown.get(p?.type ?? '') || []), n]);
    return { n, text: str(p?.text, 300), type, priority: str(p?.priority, 20) };
  }).filter((p) => {
    if (!p.text) { note('Prompt zonder tekst — overgeslagen.'); return false; }
    return true;
  });
  for (const [t, ns] of unknown) {
    note(`Prompttype '${t}' is onbekend (${PROMPT_TYPES.join(' / ')}) bij ${ns.length === out.length ? 'alle prompts' : `prompt ${ns.join(', ')}`} — die tellen in geen enkel blok mee.`);
  }
  return out;
}

function normChecks(list) {
  return arr(list).map((c) => ({
    check: str(c?.check, 200),
    // 'unk' is de schrijfwijze van de HTML-template; hier heet het 'unknown'.
    status: oneOf(String(c?.status || '').replace(/^unk$/i, 'unknown'), ['pass', 'fail', 'unknown']) || 'unknown',
    note: str(c?.note, 300),
  })).filter((c) => c.check);
}

function normActions(list) {
  const prio = { p1: 'hoog', p2: 'middel', p3: 'laag' };
  const eff = { s: 'klein', m: 'middel', l: 'groot' };
  return arr(list).map((a) => {
    const p = str(a?.priority, 20);
    const e = str(a?.effort, 20);
    return {
      priority: p ? (prio[p.toLowerCase()] || p) : null,
      effort: e ? (eff[e.toLowerCase()] || e) : null,
      how: str(a?.how ?? a?.skill, 80),
      moves: arr(a?.moves).map((m) => str(m, 40)).filter(Boolean).slice(0, 6),
      title: str(a?.title, 200),
      text: str(a?.text ?? a?.why, 1200),
      done: str(a?.done, 600),
      ongoing: a?.ongoing === true,
    };
  }).filter((a) => a.title);
}

function normSources(s) {
  return s && typeof s === 'object' ? {
    keyword: str(s.keyword, 80),
    platform: oneOf(s.platform, ['chat_gpt', 'google']) || 'chat_gpt',
    location: str(s.location, 80),
    language: /^[a-z]{2}$/i.test(String(s.language || '')) ? String(s.language).toLowerCase() : null,
  } : null;
}

function normMeasurement(m, engines, prompts, competitors, brandName, note) {
  const date = isoDate(m?.date);
  const tag = date || '(zonder datum)';
  if (!date) note(`Meting zonder geldige 'date' (YYYY-MM-DD) — overgeslagen.`);
  const kind = oneOf(m?.kind, ['full', 'light']) || 'full';
  const engineIds = new Set(engines.map((e) => e.id));
  const promptNs = new Set(prompts.map((p) => p.n));

  // runs[engine][prompt] = één toestand per pass. Een pass die niet 0/1/2 is,
  // valt weg: niet gemeten, nooit stilzwijgend 'niet genoemd'.
  const runs = {};
  const rawRuns = m?.runs && typeof m.runs === 'object' ? m.runs : {};
  for (const [eRaw, perPrompt] of Object.entries(rawRuns)) {
    const e = slug(eRaw);
    if (!engineIds.has(e)) { note(`Meting ${tag}: engine '${eRaw}' staat niet in 'engines' — overgeslagen.`); continue; }
    for (const [nRaw, passes] of Object.entries(perPrompt && typeof perPrompt === 'object' ? perPrompt : {})) {
      const n = int(nRaw, 9999);
      if (n == null || !promptNs.has(n)) { note(`Meting ${tag}: prompt '${nRaw}' staat niet in 'prompts' — overgeslagen.`); continue; }
      const states = (Array.isArray(passes) ? passes : [passes]).map(cell).filter((v) => v != null);
      if (states.length) (runs[e] ||= {})[n] = states.slice(0, 10);
    }
  }

  // Share of voice: tellingen voor precies de bevroren set (+ het merk zelf).
  // Een merk buiten de set telt niet mee — anders is de noemer tussen metingen
  // niet dezelfde en is een delta geen delta.
  let brandCounts = null;
  if (m?.brandCounts && typeof m.brandCounts === 'object') {
    brandCounts = {};
    for (const b of [brandName, ...competitors].filter(Boolean)) {
      const v = int(m.brandCounts[b], 1e6);
      brandCounts[b] = v ?? 0;
    }
    const extra = Object.keys(m.brandCounts).filter((k) => k !== brandName && !competitors.includes(k));
    if (extra.length) note(`Meting ${tag}: ${extra.length} merk(en) in brandCounts buiten de share-of-voice-set genegeerd (${extra.slice(0, 3).join(', ')}).`);
  }

  const brandSplit = arr(m?.brandSplit).map((r) => ({
    engine: slug(r?.engine),
    prompt: int(r?.prompt, 9999),
    pass: int(r?.pass, 10),
    class: oneOf(r?.class, SPLIT_CLASSES),
    evidence: str(r?.evidence, 240),
  })).filter((r) => {
    if (!r.class) { note(`Meting ${tag}: brandSplit-rij zonder geldige class — overgeslagen.`); return false; }
    return engineIds.has(r.engine);
  });

  return {
    date, kind,
    label: str(m?.label, 80),
    note: str(m?.note, 80),
    calloutNote: str(m?.calloutNote, 400),
    matrixNote: str(m?.matrixNote, 300),
    checksNote: str(m?.checksNote, 300),
    runs,
    runCount: int(m?.runCount, 1e6),
    brandCounts,
    brandSplit,
    checks: normChecks(m?.checks),
    ownCitations: int(m?.ownCitations, 1e6),
    ownCitationsNote: str(m?.ownCitationsNote, 200),
    externalCitations: int(m?.externalCitations, 1e6),
  };
}

function normalizeV2(d, note) {
  const brand = {
    name: str(d.brand?.name, 60),
    domain: str(d.brand?.domain, 120) ? String(d.brand.domain).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') : null,
    descriptor: str(d.brand?.descriptor, 600),
  };
  if (!brand.name) note("Geen 'brand.name' — share of voice en de naamkaping-split tonen dan geen eigen merk.");
  const engines = normEngines(d.engines, note);
  const prompts = normPrompts(d.prompts, note);
  const competitors = [...new Set(arr(d.competitors).map((c) => str(typeof c === 'string' ? c : c?.name, 80)).filter(Boolean))].slice(0, 20);
  if (!competitors.length) note("Geen 'competitors' (bevroren share-of-voice-set) — share of voice wordt niet getoond.");
  const measurements = arr(d.measurements)
    .map((m) => normMeasurement(m, engines, prompts, competitors, brand.name, note))
    .filter((m) => m.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!measurements.some((m) => m.kind === 'full')) note('Geen volledige meting (kind "full") — de matrix en de blokken blijven leeg.');
  return {
    schemaVersion: 2,
    brand, engines, prompts, competitors, measurements,
    label: str(d.label, 80),
    method: str(d.method, 800),
    passNote: str(d.passNote, 300),
    actions: normActions(d.actions),
    sources: normSources(d.sources),
  };
}

/* Oud formaat (v1: kpis/phases/competitors-als-telling, één meting met cellen
   per enginenaam). Omgezet naar v2 zodat er één renderer is. Wat v1 niet
   meet (share of voice per merk, de naamkaping-split, passes) blijft leeg —
   nooit afgeleid uit de vrije-tekst-KPI's. */
function fromV1(d, note) {
  note('Oud auditformaat (v1): omgezet naar het 2+3+1-model. KPI-teksten, fases en de top-mention-telling worden niet meer getoond; share of voice en de naamkaping-split ontbreken tot het bestand als v2 is weggeschreven.');
  const engines = arr(d.engines).length
    ? arr(d.engines).map((e) => ({ id: slug(e?.name), name: str(e?.name, 40) }))
    : [...new Set(arr(d.prompts).flatMap((p) => Object.keys(p?.engines || {})))].map((n) => ({ id: slug(n), name: n }));
  const runs = {};
  for (const p of arr(d.prompts)) {
    for (const [name, v] of Object.entries(p?.engines || {})) {
      const c = cell(v);
      if (c != null) (runs[slug(name)] ||= {})[p?.n] = [c];
    }
  }
  return normalizeV2({
    brand: { name: d.brandName },
    engines,
    prompts: arr(d.prompts).map((p) => ({ n: p?.n, text: p?.text, type: p?.type, priority: p?.priority })),
    competitors: arr(d.competitors).map((c) => c?.name),
    label: d.label, method: d.method, passNote: d.passNote,
    actions: d.actions, sources: d.sources,
    measurements: [{
      date: d.auditDate, kind: 'full', note: d.label,
      calloutNote: d.status?.text,
      runs, checks: d.readiness,
    }],
  }, note);
}

function normalize(raw) {
  const warnings = [];
  const d = raw && typeof raw === 'object' ? raw : {};
  const note = (m) => warnings.push(m);
  const data = (Number(d.schemaVersion) >= 2 || Array.isArray(d.measurements)) ? normalizeV2(d, note) : fromV1(d, note);
  return { data, warnings };
}

/* ---------- Publieke functie ---------- */

/**
 * Baseline voor één klant. Faalt nooit hard: zonder map, zonder bestand of bij
 * ongeldige JSON komt er `data: null` terug plus een reden, zodat de tab kan
 * uitleggen wat er ontbreekt in plaats van leeg te blijven.
 */
async function getGeoBaseline(clientId, driveFolderId, force) {
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
    const { file, searched, count } = await findGeoFile(accessToken, driveFolderId);
    if (!file) {
      result = {
        data: null,
        reason: 'Geen geo-dashboard.json gevonden.',
        searched,
        warnings: [],
      };
    } else {
      const text = await downloadJson(accessToken, file.id);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        return {
          data: null,
          reason: `${file.name} is geen geldige JSON (${e.message}).`,
          searched, warnings: [],
        };
      }
      const { data, warnings } = normalize(parsed);
      result = {
        data,
        reason: null,
        searched,
        warnings,
        file: { name: file.name, folder: file.folder, modifiedTime: file.modifiedTime },
        otherFiles: count > 1 ? count - 1 : 0,
      };
    }
  } catch (e) {
    // Niet cachen: een tijdelijke Drive-storing mag niet vijf minuten blijven plakken.
    return { data: null, reason: e.message, searched: [], warnings: [] };
  }

  cache.set(key, { data: result, ts: Date.now() });
  return result;
}

module.exports = { getGeoBaseline, normalize };
