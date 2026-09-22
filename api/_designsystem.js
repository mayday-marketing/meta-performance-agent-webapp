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

const MAX_BYTES = 400 * 1024;   // een .dc.html van BAJA is ~58 KB
const cache = new Map();        // clientId -> { data, ts }
const TTL_MS = 10 * 60 * 1000;

/* ---------- Drive ---------- */

async function driveList(accessToken, q, fields) {
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`
    + `&fields=${encodeURIComponent(fields)}&orderBy=modifiedTime desc`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).files || [];
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

// De mapnaam uit de Config-tab exact matchen, anders op patroon. Beide zoeken
// alleen binnen de klantmap, dus buiten die map valt niets aan te wijzen.
async function findSystemFolder(accessToken, rootId, wantName) {
  const kids = await children(accessToken, rootId);
  const folders = kids.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
  if (wantName) {
    const exact = folders.find(f => f.name.trim().toLowerCase() === wantName.trim().toLowerCase());
    if (exact) return exact;
  }
  return folders.find(f => DEFAULT_NAME_RE.test(f.name)) || null;
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
  ink:         ['--text-body', '--body', '--ink', '--fg', '--foreground', '--text'],
  head:        ['--text-head', '--heading', '--primary', '--accent', '--brand'],
  muted:       ['--text-muted', '--muted', '--ink-60'],
  rule:        ['--rule', '--border', '--hairline', '--divider'],
  label:       ['--text-label', '--label'],
  fontDisplay: ['--font-display', '--font-heading', '--font-head', '--font-serif'],
  fontBody:    ['--font-body', '--font-sans', '--font-text'],
  fontLabel:   ['--font-label', '--font-mono', '--font-monospace'],
};

function pick(vars, names) {
  for (const n of names) {
    if (vars[n] != null) {
      const v = resolve(vars, vars[n]);
      if (v) return v;
    }
  }
  return null;
}

function tokensFrom(css) {
  const { root, dark } = parseBlocks(css);
  const all = { ...root };                 // aliassen oplossen tegen :root
  const out = { light: {}, dark: {} };
  for (const [key, names] of Object.entries(WANT)) {
    out.light[key] = pick(all, names);
    // De donkere grond overschrijft alleen wat hij zelf noemt.
    const merged = { ...all, ...dark };
    const d = pick({ ...merged }, names);
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
