/* ==========================================================
   _designsystem.js — het presentatie-design-system van een klant uit Drive
   ==========================================================
   Gedeelde module (underscore-prefix = geen Vercel-route). Wordt gebruikt door
   drive.js, action 'design-system'.

   WAAROM TOKENS EN GEEN COMPONENTEN
   Twee echte systemen naast elkaar hebben niet hetzelfde formaat. Just Jane's
   map is uitgeklapt — tokens/colors.css, slides/ met negen slidetypes,
   _ds_bundle.js met React-componenten. BAJA's systeem is één .dc.html met een
   <x-dc>-element en support.js; daar komt het woord 'slide' niet in voor en er
   is geen bundle. Bouwen op een component als SlideFrame werkt dus bij één
   klant en doet bij de ander niets, zonder dat je het ziet.

   Wat beide wél hebben zijn CSS-custom-properties en @font-face-regels. Die
   leest deze module uit, in beide vormen. De slide-opbouw zelf (hairlines in
   plaats van kaders, radius 0, geen schaduw, mono eyebrow linksboven) staat als
   CSS in styles.css en draait op deze tokens.

   ISOLATIE: de map wordt gezocht BINNEN CLIENTS[clientId].driveFolderId. De
   Config-tab levert alleen een mapnáám, nooit een id — die tab staat in een
   sheet dat met de klant gedeeld kan worden, en een id daaruit accepteren zou
   een klant het design system van een andere klant laten inladen. Een naam kan
   alleen iets aanwijzen dat al in zijn eigen map staat.
   ========================================================== */

const { getAccessToken } = require('./_config');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

// Hoe een design-systemmap heet als de Config-tab niets zegt.
const DEFAULT_NAME_RE = /design\s*system/i;

// Tokenbestanden in de uitgeklapte vorm, in leesvolgorde. colors en typography
// dragen wat we nodig hebben; de rest mag ontbreken.
const TOKEN_FILES = ['colors.css', 'typography.css', 'fonts.css', 'layout.css', 'spacing.css'];

// Hoe diep een design-systemmap onder de klantmap mag zitten, en hoeveel
// gelijknamige mappen we hoogstens natrekken. Spotto zit op drie niveaus
// (02_MERKEXPRESSIE/2.3_Visuele-Expressie/…); zes hops is ruim genoeg en houdt
// het aantal Drive-calls begrensd.
const MAX_ANCESTOR_HOPS = 6;
const GLOBAL_HITS_MAX = 10;

const MAX_BYTES = 400 * 1024;   // een .dc.html van BAJA is ~58 KB
const cache = new Map();        // clientId -> { data, ts }
const TTL_MS = 10 * 60 * 1000;

/* ---------- Drive ---------- */

async function driveList(accessToken, q, fields) {
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`
    + `&fields=${encodeURIComponent(fields)}&orderBy=modifiedTime desc`
    + `&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).files || [];
}

// De ouders van één bestand. Alleen nodig voor de ouderketen-toets hieronder.
async function driveParents(accessToken, fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}`
    + `?fields=parents&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return [];
  return (await res.json()).parents || [];
}

async function downloadText(accessToken, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const text = await res.text();
  return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
}

const children = (accessToken, parentId) => driveList(
  accessToken, `'${parentId}' in parents and trashed=false`, 'files(id,name,mimeType,modifiedTime)');

// Hangt `folderId` ergens ónder `rootId`? We lopen de ouderketen omhoog in
// plaats van de boom omlaag: dat kost één call per niveau in plaats van één per
// map. Een map die niet binnen MAX_ANCESTOR_HOPS bij de klantmap uitkomt geldt
// als 'niet van deze klant' — fail closed.
async function isInside(accessToken, folderId, rootId) {
  let cur = folderId;
  for (let i = 0; i < MAX_ANCESTOR_HOPS && cur; i++) {
    if (cur === rootId) return true;
    const parents = await driveParents(accessToken, cur);
    cur = parents[0] || null;
  }
  return false;
}

// De mapnaam uit de Config-tab exact matchen, anders op patroon. Beide zoeken
// alleen binnen de klantmap, dus buiten die map valt niets aan te wijzen.
async function findSystemFolder(accessToken, rootId, wantName) {
  // 1. Direct onder de klantmap. De goedkoopste vorm — één call — en die van
  //    Just Jane.
  const kids = await children(accessToken, rootId);
  const folders = kids.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
  if (wantName) {
    const exact = folders.find(f => f.name.trim().toLowerCase() === wantName.trim().toLowerCase());
    if (exact) return exact;
  } else {
    const byPattern = folders.find(f => DEFAULT_NAME_RE.test(f.name));
    if (byPattern) return byPattern;
  }

  // 2. Dieper in de klantmap. Spotto's systeem staat in
  //    02_MERKEXPRESSIE/2.3_Visuele-Expressie — dat is de mapconventie, niet de
  //    uitzondering. De boom aflopen zou tientallen Drive-calls kosten, dus we
  //    zoeken op naam over alles wat het service-account ziet en TOETSEN daarna
  //    de ouderketen.
  //
  //    ISOLATIE: die toets is het hele punt. Het service-account kan bij élke
  //    klantmap, dus zonder isInside() zou een gelijknamige map van een andere
  //    klant hier binnenkomen. Alleen een map die écht onder driveFolderId hangt
  //    telt; de naam uit de Config-tab kan nooit iets buiten die map aanwijzen.
  const naam = String(wantName || '').replace(/['\\]/g, '').trim();
  const q = `mimeType = 'application/vnd.google-apps.folder' and trashed = false and `
    + (naam ? `name = '${naam}'` : `name contains 'design system'`);

  let hits;
  try { hits = await driveList(accessToken, q, 'files(id,name,mimeType,modifiedTime)'); }
  catch { return null; }

  for (const f of hits.slice(0, GLOBAL_HITS_MAX)) {
    if (await isInside(accessToken, f.id, rootId)) return f;
  }
  return null;
}

/* ---------- CSS-custom-properties ---------- */

// Alleen de declaraties binnen :root en binnen de omgekeerde grond. Die tweede
// is waar het om draait voor de titelslide: Just Jane's systeem definieert daar
// letterlijk 'merkvlak als achtergrond, negatieve tekst' — precies wat een
// titelslide nodig heeft, en het staat in hun eigen regels in plaats van dat
// wij het verzinnen.
const GROUND_RE = /\[data-ground\s*=\s*["']?dark["']?\]/i;

function parseBlocks(css) {
  const root = {}, dark = {};
  // Commentaar er eerst uit. De selector is alles sinds de vorige '}', dus een
  // kopcommentaar bóven het eerste :root-blok ging mee in de selector en liet de
  // test hieronder falen — Spotto's colors.css opent met vier regels uitleg en
  // leverde daardoor géén enkel kleurtoken op.
  css = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  // Naïef maar genoeg: custom properties staan nooit genest in deze bestanden.
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = blockRe.exec(css)) !== null) {
    const sel = m[1].trim();
    const body = m[2];
    const target = GROUND_RE.test(sel) ? dark : (/(^|,)\s*:root\s*(,|$)/.test(sel) ? root : null);
    if (!target) continue;
    const declRe = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
    let d;
    while ((d = declRe.exec(body)) !== null) target[d[1]] = d[2].trim();
  }
  return { root, dark };
}

// var(--x) doorvolgen. Een systeem stapelt aliassen (--surface-page → --cream),
// en wij hebben de eindwaarde nodig, niet de verwijzing.
function resolve(vars, value, depth = 0) {
  if (!value || depth > 6) return value || null;
  const m = /^var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,\s*([^)]+))?\)$/.exec(value.trim());
  if (!m) return value.trim();
  const next = vars[m[1]];
  if (next != null) return resolve(vars, next, depth + 1);
  return m[2] ? m[2].trim() : null;
}

// Semantische naam → kandidaten, van specifiek naar algemeen. Een systeem dat
// geen enkele kandidaat heeft levert null; de tab valt dan voor dát token terug
// op de dashboardkleur. Gedeeltelijk is een geldige uitkomst — beter één echt
// merkveld dan een compleet maar verzonnen palet.
const WANT = {
  surface:     ['--surface-page', '--surface', '--background', '--bg', '--page', '--cream'],
  // --text-ink vóór --text-body: in een systeem met een typografische schaal is
  // --text-body de lettergrootte en niet de kleur. Spotto zegt dat zelf in
  // colors.css; de volgorde hier maakt dat we de kleur pakken, de isColor-toets
  // hieronder vangt de gevallen waarin ook dat niet helpt.
  ink:         ['--text-ink', '--text-body', '--body', '--ink', '--fg', '--foreground', '--text'],
  head:        ['--text-head', '--heading', '--text-strong', '--primary', '--accent', '--brand'],
  muted:       ['--text-muted', '--muted', '--ink-60'],
  rule:        ['--rule', '--border', '--border-default', '--hairline', '--divider'],
  label:       ['--text-label', '--label'],
  fontDisplay: ['--font-display', '--font-heading', '--font-head', '--font-serif'],
  // --font-serif als laatste: bij Spotto is de serif de lopende tekst; een
  // systeem dat --font-body kent wordt daar niet door geraakt.
  fontBody:    ['--font-body', '--font-sans', '--font-text', '--font-serif'],
  fontLabel:   ['--font-label', '--font-mono', '--font-monospace'],
};

// Ziet dit eruit als een kleur? Een systeem mag dezelfde naam voor een maat en
// een kleur gebruiken (--text-label is bij Spotto 13px), en een '13px' in een
// kleurtoken levert geen foutmelding maar een onzichtbare slide.
const COLOR_RE = /^(#|rgb|hsl|hwb|lab|lch|oklab|oklch|color\(|[a-z]+$)/i;
const isColor = (v) => COLOR_RE.test(String(v).trim()) && !/\d(px|em|rem|%|ch|vh|vw)$/i.test(String(v).trim());

const FONT_KEYS = new Set(['fontDisplay', 'fontBody', 'fontLabel']);

function pick(vars, names, ok) {
  for (const n of names) {
    if (vars[n] != null) {
      const v = resolve(vars, vars[n]);
      if (v && (!ok || ok(v))) return v;
    }
  }
  return null;
}

function tokensFrom(css) {
  const { root, dark } = parseBlocks(css);
  const all = { ...root };                 // aliassen oplossen tegen :root
  const out = { light: {}, dark: {} };
  for (const [key, names] of Object.entries(WANT)) {
    const ok = FONT_KEYS.has(key) ? null : isColor;
    out.light[key] = pick(all, names, ok);
    // De donkere grond overschrijft alleen wat hij zelf noemt.
    const merged = { ...all, ...dark };
    const d = pick({ ...merged }, names, ok);
    out.dark[key] = dark && Object.keys(dark).length ? d : null;
  }
  // Lettertypefamilies die het systeem zelf laadt. De binaries staan in Drive en
  // zijn hier niet doorgegeven — de namen zijn dus alleen bruikbaar als de
  // letter op het apparaat staat. Meesturen zodat de UI dat kan zeggen in
  // plaats van stil een andere letter te tonen.
  const faces = [...css.matchAll(/@font-face\s*\{[^}]*font-family\s*:\s*["']?([^;"'}]+)["']?/gi)]
    .map(m => m[1].trim()).filter(Boolean);
  out.fontFaces = [...new Set(faces)].slice(0, 12);
  out.hasDarkGround = Object.keys(dark).length > 0;
  return out;
}

/* ---------- Ophalen ---------- */

async function readExploded(accessToken, folderId) {
  const kids = await children(accessToken, folderId);
  const tokensFolder = kids.find(f => f.mimeType === 'application/vnd.google-apps.folder'
    && /^tokens$/i.test(f.name));
  if (!tokensFolder) return null;
  const files = await children(accessToken, tokensFolder.id);
  let css = '';
  for (const name of TOKEN_FILES) {
    const f = files.find(x => x.name.toLowerCase() === name);
    if (!f) continue;
    const text = await downloadText(accessToken, f.id);
    if (text) css += '\n' + text;
  }
  return css.trim() ? { css, source: 'tokens/' } : null;
}

async function readSingleFile(accessToken, folderId) {
  const kids = await children(accessToken, folderId);
  // De .dc.html-vorm: één document dat zijn stijl inline draagt.
  const doc = kids.find(f => /\.dc\.html$/i.test(f.name))
    || kids.find(f => f.mimeType === 'text/html' && !/^thumbnail/i.test(f.name));
  if (!doc) return null;
  const html = await downloadText(accessToken, doc.id);
  if (!html) return null;
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
  return styles.trim() ? { css: styles, source: doc.name } : null;
}

async function getDesignSystem(clientId, driveFolderId, wantName, force) {
  const key = `${clientId}|${wantName || ''}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.ts < TTL_MS) return hit.data;

  const fail = (reason) => {
    const data = { found: false, reason };
    cache.set(key, { data, ts: Date.now() });
    return data;
  };

  if (!driveFolderId) return fail('Voor deze klant staat geen Drive-map ingesteld.');

  let accessToken;
  try { accessToken = await getAccessToken(DRIVE_SCOPE); }
  catch (e) { return { found: false, reason: `Drive niet bereikbaar: ${e.message}` }; }

  let folder;
  try { folder = await findSystemFolder(accessToken, driveFolderId, wantName); }
  catch (e) { return { found: false, reason: `Drive niet bereikbaar: ${e.message}` }; }
  if (!folder) {
    return fail(wantName
      ? `Geen map "${wantName}" in de Drive-map van deze klant.`
      : 'Geen map met "design system" in de naam in de Drive-map van deze klant.');
  }

  let read = null;
  try {
    read = await readExploded(accessToken, folder.id) || await readSingleFile(accessToken, folder.id);
  } catch (e) {
    return { found: false, reason: `Design system niet leesbaar: ${e.message}` };
  }
  if (!read) return fail(`Map "${folder.name}" gevonden, maar geen tokens/ of stijlbestand erin.`);

  const t = tokensFrom(read.css);
  const bruikbaar = Object.values(t.light).some(v => v != null);
  if (!bruikbaar) return fail(`Map "${folder.name}" gelezen, maar er zaten geen herkenbare kleur- of lettertokens in.`);

  // Zegt het systeem zelf niets over een omgekeerde grond, dan leiden we er één
  // af: merkkleur als vlak, paginakleur als tekst. Dat is dezelfde regel die
  // Just Jane expliciet opschrijft ('twee gronden, één accent'), toegepast op
  // een systeem dat hem niet uitschrijft — en het is de enige plek waar de
  // titelslide een vlak nodig heeft. Ontbreekt de merkkleur, dan blijft dark
  // leeg en valt de tab terug op het dashboardaccent.
  const dark = { ...t.dark };
  if (!t.hasDarkGround && t.light.head) {
    dark.surface = t.light.head;
    dark.ink = t.light.surface || '#ffffff';
    dark.head = dark.ink;
    dark.muted = dark.ink;
    dark.label = dark.ink;
    dark.rule = dark.ink;
  }
  for (const k of ['fontDisplay', 'fontBody', 'fontLabel']) {
    if (!dark[k]) dark[k] = t.light[k];
  }

  const data = {
    found: true,
    name: folder.name,
    source: read.source,
    tokens: t.light,
    dark,
    hasDarkGround: t.hasDarkGround,
    fontFaces: t.fontFaces,
  };
  cache.set(key, { data, ts: Date.now() });
  return data;
}

module.exports = { getDesignSystem, tokensFrom };
