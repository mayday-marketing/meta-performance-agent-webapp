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

   PERCENTAGES: in dit bestand staan percentages als getal 0–100, niet als
   fractie. Een hand-geschreven '15' betekent 15%, en een validator die soms
   0,15 en soms 15 accepteert is een fout die je pas in het dashboard ziet.
   Velden heten daarom expliciet *Pct.
   ========================================================== */

const { getAccessToken } = require('./_config');

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

// Percentage 0–100. Accepteert '15', '15%', 15 en '15,5'. Buiten bereik → null.
const pct = (v) => {
  if (v == null || v === '') return null;
  const s = String(v).replace('%', '').replace(',', '.').trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  if (!isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 10) / 10;
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
  if (s === '1' || s === 'ja' || s === 'mentioned') return 1;
  if (s === '2' || s === 'fout' || s === 'wrong') return 2;
  return null; // niet gemeten
}

function normalize(raw) {
  const warnings = [];
  const d = raw && typeof raw === 'object' ? raw : {};
  const note = (m) => warnings.push(m);

  const engines = arr(d.engines).map((e) => ({
    name: str(e?.name, 40),
    runs: int(e?.runs, 100000),
    mentionRatePct: pct(e?.mentionRatePct),
    shareOfVoicePct: pct(e?.shareOfVoicePct),
    descriptorAccuracyPct: pct(e?.descriptorAccuracyPct),
    topCompetitor: str(e?.topCompetitor, 80),
    sourceType: str(e?.sourceType, 300),
    note: str(e?.note, 400),
  })).filter((e) => {
    if (!e.name) { note('Engine zonder naam — overgeslagen.'); return false; }
    return true;
  });

  const prompts = arr(d.prompts).map((p, i) => ({
    n: int(p?.n, 9999) ?? i + 1,
    text: str(p?.text, 300),
    type: str(p?.type, 30),
    priority: str(p?.priority, 20),
    // Per engine één cel. Engines die hier niet in staan zijn 'niet gemeten'.
    cells: Object.fromEntries(
      Object.entries(p?.engines && typeof p.engines === 'object' ? p.engines : {})
        .map(([k, v]) => [str(k, 40), cell(v)])
        .filter(([k]) => k)
    ),
  })).filter((p) => {
    if (!p.text) { note('Prompt zonder tekst — overgeslagen.'); return false; }
    return true;
  });

  const readiness = arr(d.readiness).map((c) => ({
    check: str(c?.check, 200),
    status: oneOf(c?.status, ['pass', 'fail', 'unknown']) || 'unknown',
    note: str(c?.note, 300),
  })).filter((c) => c.check);

  const actions = arr(d.actions).map((a) => ({
    priority: str(a?.priority, 10),
    effort: str(a?.effort, 10),
    skill: str(a?.skill, 80),
    title: str(a?.title, 200),
    text: str(a?.text, 1200),
    done: str(a?.done, 600),
  })).filter((a) => a.title);

  const kpis = arr(d.kpis).map((k) => ({
    label: str(k?.label, 60),
    value: str(k?.value, 30),
    tone: oneOf(k?.tone, ['good', 'bad', 'neutral']) || 'neutral',
    delta: str(k?.delta, 80),
    sub: str(k?.sub, 200),
  })).filter((k) => k.label && k.value);

  const byType = arr(d.byType).map((t) => ({
    type: str(t?.type, 40),
    ratePct: pct(t?.ratePct),
    note: str(t?.note, 120),
  })).filter((t) => t.type);

  const competitors = arr(d.competitors).map((c) => ({
    name: str(c?.name, 80),
    engines: int(c?.engines, 50),
    note: str(c?.note, 200),
  })).filter((c) => c.name);

  const phases = arr(d.phases).map((p) => ({
    n: str(p?.n, 8),
    title: str(p?.title, 40),
    gate: str(p?.gate, 120),
    here: p?.here === true,
  })).filter((p) => p.title);

  const status = d.status && typeof d.status === 'object' ? {
    level: oneOf(d.status.level, ['blocked', 'warn', 'ok']) || 'warn',
    title: str(d.status.title, 120),
    text: str(d.status.text, 800),
  } : null;

  const sources = d.sources && typeof d.sources === 'object' ? {
    keyword: str(d.sources.keyword, 80),
    platform: oneOf(d.sources.platform, ['chat_gpt', 'google']) || 'chat_gpt',
    location: str(d.sources.location, 80),
    language: /^[a-z]{2}$/i.test(String(d.sources.language || '')) ? String(d.sources.language).toLowerCase() : null,
  } : null;

  const auditDate = isoDate(d.auditDate);
  if (!auditDate) note("Geen geldige 'auditDate' (YYYY-MM-DD) — de tab toont geen meetdatum.");

  // Eén kale controle op consistentie: klopt het aantal prompts met wat de
  // scorecard claimt? Verschil is geen fout (deelmetingen bestaan), maar wel
  // iets wat je wil zien voordat je het aan een klant toont.
  const promptCount = int(d.promptCount, 9999);
  if (promptCount != null && prompts.length && promptCount !== prompts.length) {
    note(`promptCount zegt ${promptCount}, er staan ${prompts.length} prompts in de lijst.`);
  }

  return {
    data: {
      brandName: str(d.brandName, 60),
      auditDate,
      label: str(d.label, 80),
      promptCount: promptCount ?? (prompts.length || null),
      passNote: str(d.passNote, 300),
      method: str(d.method, 800),
      status, kpis, engines, byType, competitors, phases,
      prompts, readiness, actions, sources,
      // Vorige meting, alleen voor de delta-regel bij de KPI's. Bewust niet het
      // hele schema: een dashboard dat twee volledige audits naast elkaar zet is
      // een andere tab.
      previous: d.previous && typeof d.previous === 'object' ? {
        auditDate: isoDate(d.previous.auditDate),
        kpis: arr(d.previous.kpis).map((k) => ({ label: str(k?.label, 60), value: str(k?.value, 30) })).filter((k) => k.label),
      } : null,
    },
    warnings,
  };
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
    const accessToken = await getAccessToken();
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
