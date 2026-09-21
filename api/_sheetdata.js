/* ==========================================================
   _sheetdata.js — websitedata uit de Windsor-datasheet
   ==========================================================
   Gedeelde module (underscore-prefix = geen Vercel-route). Leest de tabs die
   Windsor.ai elke nacht naar de klant-datasheet exporteert, zodat de Website-tab
   niet bij elk bezoek de Windsor-API hoeft te bevragen.

   WAAROM: een koude Windsor-fetch over 90 dagen duurde ~18s en kost per bezoek
   13 tot 21 API-aanroepen. Eén sheet-tab lezen duurt 0,3 tot 2,3s en kost niets:
   de export draait één keer per etmaal, hoeveel mensen het dashboard ook openen.

   ISOLATIE: de spreadsheet-id komt uit CLIENTS[clientId].dataSheetId en NOOIT uit
   een request of uit de Config-tab. De gedeelde service-account kan bij élke
   datasheet, en de Config-tab staat in een spreadsheet dat in principe met de
   klant gedeeld kan worden — een sheet-id daaruit accepteren zou een klant laten
   kiezen wiens data hij leest. Zie CLAUDE.md, 'Multi-tenant model'.

   ONTBREKENDE DATA IS ONBEKEND, NOOIT NUL. Elke tabel die niet gelezen kan worden
   of de periode niet dekt, komt terug als null met een reden; windsor.js haalt dat
   stuk dan alsnog live op.
   ========================================================== */

const { getAccessToken } = require('./_config');

const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20000;

// Altijd per klant gekeyed — een gedeelde cache zonder klant in de sleutel was
// eerder al een cross-tenant lek in deze app.
const tabCache = new Map();   // `${clientId}|${title}` -> { rows, ts }
const metaCache = new Map();  // clientId -> { titles, ts }

function resolveDataSheetId(clientId) {
  try {
    const clients = JSON.parse(process.env.CLIENTS || '{}');
    return clients[String(clientId).toLowerCase()]?.dataSheetId || null;
  } catch {
    return null;
  }
}

/* ---------- Tabherkenning ----------
   De exporttaken krijgen in Windsor een lange naam die per klant verschilt
   ('Google Analytics 4 - dag - MERKNAAM - windsor.ai'). We matchen daarom op
   patroon in plaats van op een exacte naam, zodat er niets per klant
   geconfigureerd hoeft te worden. `_windsor_staging_*` zijn restanten van een
   lopende export en worden overgeslagen. */

const TABLES = [
  { key: 'ga4Daily',   source: /analytics/i,      marker: /(^|[^a-z])dag([^a-z]|$)/i,     lagDays: 2 },
  { key: 'ga4Channel', source: /analytics/i,      marker: /kanaal|channel/i,              lagDays: 2 },
  { key: 'ga4Landing', source: /analytics/i,      marker: /landing/i,                     lagDays: 2 },
  { key: 'gscDaily',   source: /search\s*console/i, marker: /(^|[^a-z])dag([^a-z]|$)/i,   lagDays: 4 },
  { key: 'gscQuery',   source: /search\s*console/i, marker: /quer(y|ies)|zoekopdracht/i,  lagDays: 4 },
];

function matchTabs(titles) {
  const out = {};
  for (const t of TABLES) {
    const hit = titles.find(title =>
      !/^_windsor_staging/i.test(title) && t.source.test(title) && t.marker.test(title));
    if (hit) out[t.key] = hit;
  }
  return out;
}

/* ---------- Kolomherkenning ----------
   Windsor schrijft leesbare koppen ('Total users'), en die verschillen per bron
   in hoofdlettergebruik: GA4 levert 'Date', Search Console 'date'. Daarom
   normaliseren we elke kop tot kleine letters zonder leestekens. */

function normHeader(h) {
  return String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, '');
}

const HEADER_MAP = {
  date: 'date',
  sessions: 'sessions',
  engagedsessions: 'engagedSessions',
  totalusers: 'users',
  users: 'users',
  newusers: 'newUsers',
  views: 'pageViews',
  screenpageviews: 'pageViews',
  userengagement: 'engagementTime',
  userengagementduration: 'engagementTime',
  keyevents: 'conversions',
  conversions: 'conversions',
  purchaserevenue: 'revenue',
  transactions: 'transactions',
  sessiondefaultchannelgroup: 'channel',
  sessionsourcemedium: 'sourceMedium',
  landingpage: 'page',
  page: 'page',
  clicks: 'clicks',
  impressions: 'impressions',
  position: 'position',
  searchquery: 'query',
  query: 'query',
};

// 'Key event count for property_form_submit' → het doelveld. De eventnaam staat
// in de kop, dus we herkennen het op het voorvoegsel i.p.v. op de volledige naam.
const GOAL_PREFIX = 'keyeventcountfor';

function headerIndex(headerRow) {
  const idx = {};
  let goalEvent = null;
  (headerRow || []).forEach((h, i) => {
    const n = normHeader(h);
    if (n.startsWith(GOAL_PREFIX)) {
      idx.goal = i;
      goalEvent = String(h).slice(String(h).toLowerCase().indexOf('for ') + 4).trim() || null;
      return;
    }
    const key = HEADER_MAP[n];
    if (key && idx[key] == null) idx[key] = i;
  });
  return { idx, goalEvent };
}

/* ---------- Lezen ---------- */

const num = (v) => {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return isFinite(n) ? n : 0;
};
const isoOf = (v) => {
  const d = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const digits = d.replace(/[^0-9]/g, '');
  return digits.length >= 8 ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}` : null;
};

async function fetchJson(url, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Sheets ${res.status}: ${String(body.error?.message || '').slice(0, 160)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function listTabs(clientId, sheetId, token) {
  const hit = metaCache.get(clientId);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.titles;
  const data = await fetchJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`, token);
  const titles = (data.sheets || []).map(s => s.properties.title);
  metaCache.set(clientId, { titles, ts: Date.now() });
  return titles;
}

async function readTab(clientId, sheetId, title, token) {
  const cacheKey = `${clientId}|${title}`;
  const hit = tabCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.rows;
  const data = await fetchJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(title)}`, token);
  const rows = data.values || [];
  tabCache.set(cacheKey, { rows, ts: Date.now() });
  return rows;
}

/* ---------- Periodedekking ----------
   Een tab dekt de periode als hij vóór de startdatum begint en tot vlak bij de
   einddatum loopt. 'Vlak bij', want de export van vandaag heeft de dag van
   vandaag nog niet, en Search Console loopt bij Google zelf al twee tot drie
   dagen achter. Zonder die marge zou elke periode die tot vandaag loopt de
   sheet afkeuren en alsnog de API bevragen. */

function covers(dates, from, to, lagDays) {
  if (!dates.length) return { ok: false, reason: 'tab is leeg' };
  const min = dates[0], max = dates[dates.length - 1];

  // Einde van wat we redelijkerwijs kunnen verwachten: de einddatum minus de
  // vertraging van de bron.
  const limit = new Date(`${to}T12:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() - lagDays);
  const needed = limit.toISOString().slice(0, 10);
  if (needed < from) return { ok: false, reason: 'periode valt volledig binnen de vertraging van de bron', min, max };
  if (min > from) return { ok: false, reason: `sheet begint pas op ${min}`, min, max };
  if (max < needed) return { ok: false, reason: `sheet loopt tot ${max}`, min, max };

  // GATEN TELLEN, niet alleen begin en eind. Een backfill die nog loopt levert
  // losse dagen verspreid over een jaar: min en max zien er dan goed uit terwijl
  // de helft van de dagen ontbreekt. Dat zou het totaal stilzwijgend te laag
  // maken — erger dan een trage live-aanroep.
  const present = new Set(dates.filter(d => d >= from && d <= needed));
  const dayMs = 86400000;
  const expected = Math.round((new Date(`${needed}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / dayMs) + 1;
  if (present.size < expected) {
    return { ok: false, reason: `${expected - present.size} van de ${expected} dagen ontbreken nog in de sheet`, min, max, days: present.size, expected };
  }
  return { ok: true, min, max, days: present.size, expected };
}

// Rijen binnen de periode, met een kolom-index erbij.
function rowsInPeriod(rows, from, to) {
  if (!rows.length) return { header: [], body: [], dates: [] };
  const { idx, goalEvent } = headerIndex(rows[0]);
  if (idx.date == null) return { header: rows[0], body: [], dates: [], idx, goalEvent, noDate: true };
  const all = [], body = [];
  for (const r of rows.slice(1)) {
    const d = isoOf(r[idx.date]);
    if (!d) continue;
    all.push(d);
    if (d >= from && d <= to) body.push({ d, r });
  }
  all.sort();
  return { header: rows[0], body, dates: all, idx, goalEvent };
}

/* ---------- Publieke functie ---------- */

/**
 * Websitedata voor één klant en periode uit de datasheet.
 * Geeft per blok data óf null met een reden; windsor.js vult de gaten live aan.
 */
async function getWebsiteSheetData(clientId, startDate, endDate) {
  const result = {
    available: false, sheetId: null, tabs: {}, coverage: {}, warnings: [],
    totals: null, daily: null, channels: null, landingPages: null, sources: null,
    search: null, searchDaily: null, queries: null, goalEvent: null,
  };

  const sheetId = resolveDataSheetId(clientId);
  if (!sheetId) { result.warnings.push('Geen dataSheetId voor deze klant.'); return result; }
  result.sheetId = sheetId;

  let token;
  try { token = await getAccessToken(); }
  catch (e) { result.warnings.push(`Google-token mislukt: ${e.message}`); return result; }

  let titles;
  try { titles = await listTabs(clientId, sheetId, token); }
  catch (e) { result.warnings.push(`Datasheet niet leesbaar: ${e.message}`); return result; }

  const found = matchTabs(titles);
  result.tabs = found;
  if (!Object.keys(found).length) {
    result.warnings.push('Geen herkenbare exporttabs in de datasheet.');
    return result;
  }

  const load = async (key) => {
    const title = found[key];
    if (!title) { result.coverage[key] = { ok: false, reason: 'tab ontbreekt' }; return null; }
    const lag = (TABLES.find(t => t.key === key) || {}).lagDays || 2;
    let rows;
    try { rows = await readTab(clientId, sheetId, title, token); }
    catch (e) { result.coverage[key] = { ok: false, reason: e.message }; return null; }
    const parsed = rowsInPeriod(rows, startDate, endDate);
    if (parsed.noDate) { result.coverage[key] = { ok: false, reason: 'tab heeft geen datumkolom' }; return null; }
    const cov = covers(parsed.dates, startDate, endDate, lag);
    result.coverage[key] = { ...cov, tab: title, rows: parsed.body.length };
    if (!cov.ok) return null;
    if (parsed.goalEvent && !result.goalEvent) result.goalEvent = parsed.goalEvent;
    return parsed;
  };

  const [daily, channel, landing, gscDaily, gscQuery] = await Promise.all(
    ['ga4Daily', 'ga4Channel', 'ga4Landing', 'gscDaily', 'gscQuery'].map(load));

  // --- GA4-totalen en dagreeks -------------------------------------------
  // Alles hier is optelbaar. 'Total users' bewust NIET: unieke gebruikers over
  // dagen optellen telt iemand die vijf dagen langskomt vijf keer. Dat cijfer is
  // uit een dagtabel niet te herleiden, dus het blijft null (de UI toont dan
  // nieuwe gebruikers, die wél optelbaar zijn — je bent maar één keer nieuw).
  //
  // LET OP — sessies zijn bijna, maar niet helemaal optelbaar. Een sessie die
  // over middernacht loopt telt GA4 in beide dagen. Gemeten over 30 dagen bij één
  // klant: 280.576 uit de dagtabel tegenover 277.353 als GA4 dezelfde periode in
  // één keer berekent, een verschil van 1,2%. Elke dagtabel heeft dat, ook die
  // van Looker Studio. Het is consistent en klein, maar verklaart waarom dit
  // dashboard net iets hoger uitkomt dan de GA4-interface.
  if (daily) {
    const g = daily.idx;
    const t = { sessions: 0, newUsers: 0, engagedSessions: 0, pageViews: 0, engagementTime: 0, conversions: 0, goal: 0, revenue: 0, transactions: 0 };
    const series = new Map();
    for (const { d, r } of daily.body) {
      const add = {
        sessions: num(r[g.sessions]), engagedSessions: num(r[g.engagedSessions]),
        newUsers: num(r[g.newUsers]), pageViews: num(r[g.pageViews]),
        engagementTime: num(r[g.engagementTime]), conversions: num(r[g.conversions]),
        goal: g.goal != null ? num(r[g.goal]) : 0,
        revenue: num(r[g.revenue]), transactions: num(r[g.transactions]),
      };
      for (const k of Object.keys(t)) t[k] += add[k];
      const cur = series.get(d) || { date: d, sessions: 0, engagedSessions: 0, pageViews: 0, conversions: 0, revenue: 0, transactions: 0, goal: 0 };
      cur.sessions += add.sessions; cur.engagedSessions += add.engagedSessions;
      cur.pageViews += add.pageViews; cur.conversions += add.conversions;
      cur.revenue += add.revenue; cur.transactions += add.transactions; cur.goal += add.goal;
      series.set(d, cur);
    }
    const div = (a, b) => (a != null && b) ? a / b : null;
    result.totals = {
      available: true, fromSheet: true,
      sessions: t.sessions,
      users: null,              // niet optelbaar — zie toelichting hierboven
      newUsers: t.newUsers,
      newUserShare: null,
      engagedSessions: t.engagedSessions,
      pageViews: t.pageViews,
      engagementRate: div(t.engagedSessions, t.sessions),
      avgEngagementTime: div(t.engagementTime, t.sessions),
      pagesPerSession: div(t.pageViews, t.sessions),
      conversions: t.conversions,
      conversionRate: div(t.conversions, t.sessions),
      goalConversions: daily.idx.goal != null ? t.goal : null,
      goalConversionRate: daily.idx.goal != null ? div(t.goal, t.sessions) : null,
      revenue: t.revenue,
      transactions: t.transactions,
      aov: div(t.revenue, t.transactions),
      revenuePerSession: div(t.revenue, t.sessions),
    };
    result.daily = Array.from(series.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  // --- Kanalen -------------------------------------------------------------
  if (channel) {
    const g = channel.idx;
    const m = new Map();
    for (const { r } of channel.body) {
      const name = String(r[g.channel] || '(onbekend)');
      const c = m.get(name) || { channel: name, sessions: 0, engagedSessions: 0, newUsers: 0, conversions: 0, goalConversions: 0, revenue: 0, transactions: 0 };
      c.sessions += num(r[g.sessions]);
      c.engagedSessions += num(r[g.engagedSessions]);
      c.newUsers += num(r[g.newUsers]);
      c.conversions += num(r[g.conversions]);
      if (g.goal != null) c.goalConversions += num(r[g.goal]);
      c.revenue += num(r[g.revenue]);
      c.transactions += num(r[g.transactions]);
      m.set(name, c);
    }
    const div = (a, b) => (a != null && b) ? a / b : null;
    const hasGoal = g.goal != null;
    result.channels = Array.from(m.values()).map(c => ({
      ...c,
      goalConversions: hasGoal ? c.goalConversions : null,
      engagementRate: div(c.engagedSessions, c.sessions),
      conversionRate: div(hasGoal ? c.goalConversions : c.conversions, c.sessions),
      revenuePerSession: div(c.revenue, c.sessions),
    })).sort((a, b) => b.sessions - a.sessions);
  }

  // --- Bronnen (source / medium) -------------------------------------------
  // Komt uit dezelfde kanaal-tab: die heeft naast de kanaalgroep ook
  // session_source_medium. Scheelt een aparte export én een aparte API-call,
  // en levert meteen ook de vergelijkingsperiode voor de verschilkolommen.
  if (channel && channel.idx.sourceMedium != null) {
    const g = channel.idx;
    const m = new Map();
    for (const { r } of channel.body) {
      const k = String(r[g.sourceMedium] || '(onbekend)');
      const c = m.get(k) || { source: k, sessions: 0, engagedSessions: 0, conversions: 0, revenue: 0 };
      c.sessions += num(r[g.sessions]);
      c.engagedSessions += num(r[g.engagedSessions]);
      c.conversions += num(r[g.conversions]);
      c.revenue += num(r[g.revenue]);
      m.set(k, c);
    }
    const div = (a, b) => (a != null && b) ? a / b : null;
    result.sources = Array.from(m.values())
      .sort((a, b) => b.sessions - a.sessions).slice(0, 60)
      .map(c => ({
        source: c.source, sessions: c.sessions,
        engagementRate: div(c.engagedSessions, c.sessions),
        conversions: c.conversions, revenue: c.revenue,
      }));
  }

  // --- Landingspagina's ----------------------------------------------------
  if (landing) {
    const g = landing.idx;
    const m = new Map();
    for (const { r } of landing.body) {
      const name = String(r[g.page] || '(onbekend)');
      const c = m.get(name) || { page: name, sessions: 0, engagedSessions: 0, conversions: 0, revenue: 0 };
      c.sessions += num(r[g.sessions]);
      c.engagedSessions += num(r[g.engagedSessions]);
      c.conversions += num(r[g.conversions]);
      c.revenue += num(r[g.revenue]);
      m.set(name, c);
    }
    const div = (a, b) => (a != null && b) ? a / b : null;
    // Ruim meer dan de 15 getoonde rijen: de zoekbalk in de tab filtert
    // client-side, dus wat hier niet in zit is onvindbaar.
    result.landingPages = Array.from(m.values())
      .sort((a, b) => b.sessions - a.sessions).slice(0, 200)
      .map(c => ({
        page: c.page, sessions: c.sessions,
        engagementRate: div(c.engagedSessions, c.sessions),
        conversions: c.conversions,
        conversionRate: div(c.conversions, c.sessions),
        revenue: c.revenue,
      }));
  }

  // --- Search Console: totalen ---------------------------------------------
  // CTR en positie opnieuw uitrekenen uit kliks en vertoningen. De sheet heeft
  // geen CTR-kolom, en een gemiddelde van dagelijkse posities zou de drukke
  // dagen even zwaar laten wegen als de stille.
  if (gscDaily) {
    const g = gscDaily.idx;
    let clicks = 0, impressions = 0, posWeighted = 0;
    const series = new Map();
    for (const { d, r } of gscDaily.body) {
      const c = num(r[g.clicks]), i = num(r[g.impressions]), p = num(r[g.position]);
      clicks += c; impressions += i; posWeighted += p * i;
      const cur = series.get(d) || { date: d, clicks: 0, impressions: 0, posWeighted: 0 };
      cur.clicks += c; cur.impressions += i; cur.posWeighted += p * i;
      series.set(d, cur);
    }
    const div = (a, b) => (a != null && b) ? a / b : null;
    result.search = {
      available: true, fromSheet: true,
      clicks, impressions, ctr: div(clicks, impressions), position: div(posWeighted, impressions),
    };
    result.searchDaily = Array.from(series.values())
      .map(x => ({ date: x.date, clicks: x.clicks, impressions: x.impressions, position: div(x.posWeighted, x.impressions) }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // --- Search Console: zoekopdrachten --------------------------------------
  // LET OP: deze tabel telt NOOIT op tot het totaal hierboven. Google geeft
  // alleen zoekopdrachten boven een privacydrempel vrij, en kapt bovendien af op
  // 5.000 rijen per dag. Gemeten bij één klant: 59.754 kliks op queryniveau
  // tegenover 146.543 in de dagtabel. Daarom komt het totaal altijd uit gscDaily.
  if (gscQuery) {
    const g = gscQuery.idx;
    const m = new Map();
    for (const { r } of gscQuery.body) {
      const q = String(r[g.query] || '(onbekend)');
      const c = m.get(q) || { query: q, clicks: 0, impressions: 0, posWeighted: 0 };
      c.clicks += num(r[g.clicks]);
      c.impressions += num(r[g.impressions]);
      c.posWeighted += num(r[g.position]) * num(r[g.impressions]);
      m.set(q, c);
    }
    const div = (a, b) => (a != null && b) ? a / b : null;
    const all = Array.from(m.values()).map(q => ({
      query: q.query, clicks: q.clicks, impressions: q.impressions,
      ctr: div(q.clicks, q.impressions), position: div(q.posWeighted, q.impressions),
    }));
    result.queries = {
      // `all` is alleen voor server-side gebruik (de merkopsplitsing in
      // windsor.js rekent over álle zoekopdrachten, niet over de top 15).
      // Het gaat bewust niet mee in de respons naar de browser.
      all,
      top: [...all].sort((a, b) => b.clicks - a.clicks).slice(0, 15),
      quickWins: all
        .filter(q => q.position != null && q.position >= 8 && q.position <= 20 && q.impressions >= 50)
        .sort((a, b) => b.impressions - a.impressions).slice(0, 10),
    };
  }

  result.available = !!(result.totals || result.channels || result.search);
  return result;
}

/* ==========================================================
   Connector-passthrough — de datasheet in plaats van de API
   ==========================================================
   Voor een klant zónder `windsor_api_key` is de datasheet de enige bron. Dat kan,
   omdat Windsor zijn exporttabs de veldnamen van de connector als kop geeft
   ('media_reel_avg_watch_time', 'action_values_omni_purchase') en getDashboard,
   getRoas en getEmail die rijen vrijwel ongewijzigd doorgeven aan de frontend.
   Eén doorgeeffunctie volstaat dus; geen tweede codepad per tab.

   GA4 en Search Console zijn de uitzondering: die exporteert Windsor met leesbare
   koppen ('Purchase revenue'), niet met veldnamen. Koppen én veldnamen worden
   daarom genormaliseerd (kleine letters, leestekens weg) en waar dat niet volstaat
   helpt FIELD_ALIASES.

   WELKE TAB BIJ WELKE VRAAG. Een connector heeft vaak meerdere tabs (Meta Ads per
   campagne én per advertentie; GA4 per dag, per kanaal en per landingspagina). De
   verkeerde kiezen telt dubbel: de kanaal-tab bevat dezelfde omzet als de dag-tab,
   maar uitgesplitst. Daarom valt een tab af zodra hij een dimensiekolom heeft die
   niet gevraagd is — dat is precies het teken dat hij fijner is dan de vraag. Van
   wat overblijft wint de tab die de meeste gevraagde velden dekt. */

const CONNECTOR_TABS = {
  instagram:        /instagram/i,
  facebook_organic: /facebook\s*org/i,
  facebook:         /meta\s*ads/i,
  googleanalytics4: /analytic/i,
  searchconsole:    /search\s*console/i,
  google_ads:       /google\s*ads/i,
  klaviyo:          /klaviyo/i,
  mailerlite:       /mailerlite/i,
  convertkit:       /convertkit/i,
};

// Velden waarvan de kop in de sheet anders heet dan het Windsor-veld.
const FIELD_ALIASES = {
  totalusers: ['totalusers', 'users'],
  screenpageviews: ['views', 'screenpageviews'],
  conversions: ['keyevents', 'conversions'],
  userengagementduration: ['userengagementduration', 'userengagement'],
  query: ['query', 'searchquery'],
};

// Kolommen die een tabel fijner maken dan een totaal, gegroepeerd per niveau.
// Per niveau, niet per kolom: 'campaign_id' en 'campaign_name' zijn dezelfde
// korrel, dus een tab met allebei is niet fijner dan een vraag om één van de
// twee. Een tab valt af zodra hij een niveau heeft waar de vraag niets over zegt
// — dát is het teken dat hij dezelfde cijfers verder uitsplitst en dus dubbel
// zou tellen.
const DIMENSION_LEVELS = {
  source:   ['sessionsourcemedium', 'sessiondefaultchannelgroup'],
  page:     ['landingpage', 'page'],
  query:    ['query', 'searchquery'],
  campaign: ['campaign', 'campaignname', 'campaignid'],
  ad:       ['adid', 'adname'],
  post:     ['mediaid', 'postid', 'videoid'],
  product:  ['producttitle', 'sku'],
  flow:     ['flowname', 'flowid'],
};

// Kolommen waarop we op periode filteren, in volgorde van voorkeur.
const DATE_HEADERS = ['date', 'timestamp', 'postcreatedtime', 'createtime', 'sentat', 'month'];

function headerCandidates(field) {
  const n = normHeader(field);
  const out = new Set([n]);
  for (const a of (FIELD_ALIASES[n] || [])) out.add(a);
  // 'conversions_purchase' → kop 'Key event count for purchase'.
  const m = /^conversions(.+)$/.exec(n);
  if (m) out.add(GOAL_PREFIX + m[1]);
  return out;
}

// '2026-06-01T18:20:00+0200' en '2026-06' leveren allebei iets vergelijkbaars op.
function dayOfCell(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}$/.test(s)) return s + '-01';
  return isoOf(s.slice(0, 10)) || isoOf(s);
}

function cellValue(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    if (isFinite(n)) return n;
  }
  return s;
}

/**
 * Rijen voor één connector uit de datasheet, in de vorm die windsor.js van de API
 * verwacht: { data: [ {veld: waarde} ] }. Geeft null terug als de sheet deze vraag
 * niet kan beantwoorden — de aanroeper beslist dan wat er gebeurt.
 */
async function getConnectorRows(clientId, connector, fieldsCsv, { from, to } = {}) {
  const pattern = CONNECTOR_TABS[connector];
  if (!pattern) return null;

  const sheetId = resolveDataSheetId(clientId);
  if (!sheetId) return null;

  let token, titles;
  try {
    token = await getAccessToken();
    titles = await listTabs(clientId, sheetId, token);
  } catch (e) {
    return { __error: `Datasheet niet leesbaar: ${e.message}` };
  }

  const wanted = String(fieldsCsv || '').split(',').map(f => f.trim()).filter(Boolean);
  const wantedHeaders = new Set();
  for (const f of wanted) for (const h of headerCandidates(f)) wantedHeaders.add(h);

  let best = null;
  for (const title of titles) {
    if (/^_windsor_staging/i.test(title) || !pattern.test(title)) continue;
    let rows;
    try { rows = await readTab(clientId, sheetId, title, token); }
    catch { continue; }
    if (!rows.length) continue;

    const headers = rows[0].map(normHeader);
    // Te fijn voor deze vraag → overslaan (zou dubbel tellen).
    const tooFine = Object.values(DIMENSION_LEVELS).some(level =>
      level.some(h => headers.includes(h)) && !level.some(h => wantedHeaders.has(h)));
    if (tooFine) continue;

    let score = 0;
    const colOf = {};
    for (const f of wanted) {
      const cands = headerCandidates(f);
      const i = headers.findIndex(h => cands.has(h));
      if (i !== -1) { colOf[f] = i; score++; }
    }
    if (score < 2) continue;
    if (!best || score > best.score) best = { title, rows, headers, colOf, score };
  }

  if (!best) return null;

  const dateCol = DATE_HEADERS.map(h => best.headers.indexOf(h)).find(i => i !== -1);
  const data = [];
  let min = null, max = null;
  for (const r of best.rows.slice(1)) {
    if (dateCol != null) {
      const d = dayOfCell(r[dateCol]);
      if (d) {
        if (min == null || d < min) min = d;
        if (max == null || d > max) max = d;
        if (from && d < from) continue;
        if (to && d > to) continue;
      }
    }
    const row = {};
    for (const [field, i] of Object.entries(best.colOf)) row[field] = cellValue(r[i]);
    data.push(row);
  }

  // Herkomst meesturen: de UI mag weten dat dit uit de sheet komt en tot wanneer
  // die loopt. Onbekende sleutels in het antwoord raken de frontend niet.
  return { data, __sheet: { tab: best.title, rows: data.length, min, max, dated: dateCol != null } };
}

module.exports = { getWebsiteSheetData, matchTabs, headerIndex, covers, getConnectorRows };
