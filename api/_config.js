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

// Drive-bestand: een deel-URL of een kaal bestand-id. Geeft altijd het id terug,
// zodat de rest van de code niet hoeft te weten in welke vorm het genoteerd was.
// De Config-tab geldt als vertrouwde bron (hij wordt server-side opgehaald met
// CLIENTS[clientId].sheetId), dus een id hieruit mag gevolgd worden — anders dan
// een id uit een request, dat nooit vertrouwd wordt.
function okDriveFile(v) {
  const s = String(v).trim();
  const m = /\/d\/([A-Za-z0-9_-]{20,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{20,})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : null;
}

// Een mapnaam, geen pad en geen id: geen slashes, geen quotes (die zouden de
// Drive-query kunnen breken), en begrensd op lengte.
function okFolderName(v) {
  const s = String(v).trim();
  if (!s || s.length > 80) return null;
  if (/["'\\/]/.test(s)) return null;
  return s;
}

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

// Search Console-property. Twee geldige vormen in Google's API:
//   sc-domain:example.com      (domeinproperty)
//   https://www.example.com/   (URL-prefix-property)
// Past bewust niet in okAccount(): die staat geen dubbele punt of slash toe.
// De waarde moet exact matchen met wat Windsor als account_id teruggeeft.
function okSearchConsoleSite(v) {
  const s = String(v).trim();
  const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
  // Domeinproperty. Windsor geeft hem terug ZONDER het 'sc-domain:'-voorvoegsel
  // ('merk.be'), Google's eigen UI mét. Beide mogen hier; windsor.js haalt het
  // voorvoegsel weg voor de vergelijking (zie normId).
  if (/^sc-domain:/i.test(s)) {
    const host = s.slice(10).trim();
    return HOST.test(host) ? 'sc-domain:' + host.toLowerCase() : null;
  }
  if (HOST.test(s)) return s.toLowerCase();
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return u.origin + '/';            // Google's URL-prefix-vorm eindigt op een slash
  } catch { return null; }
}

// GA4-eventnaam van het hoofddoel. Belandt in een Windsor-veldnaam
// (conversions_<event>), dus strikt: kleine letters, cijfers, underscore.
function okEventName(v) {
  const s = String(v).trim().toLowerCase().replace(/\s+/g, '_');
  return /^[a-z][a-z0-9_]{0,39}$/.test(s) ? s : null;
}

// Websitetype bepaalt welk funnelblok de Website-tab toont. Niet ingevuld →
// afgeleid uit de data (omzet gemeten = webshop), zie windsor.js getWebsite.
function okWebsiteType(v) {
  const s = String(v).toLowerCase().replace(/[^a-z]/g, '');
  if (/^(webshop|ecommerce|shop|verkoop|commerce)/.test(s)) return 'webshop';
  if (/^(lead|contact|offerte|afspraak|service)/.test(s)) return 'leads';
  return null;
}

// Merk-domein voor de SEO-tab. Alleen de host telt: DataForSEO geeft in een
// SERP-resultaat ook alleen een host terug. Protocol, www en pad gaan eraf,
// zodat 'https://www.merk.be/nl/' en 'merk.be' hetzelfde veld opleveren.
function okDomain(v) {
  let s = String(v).trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
  const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
  return HOST.test(s) && s.length <= 100 ? s : null;
}

// Markt voor DataForSEO: 'Belgium', 'Netherlands', 'Antwerp,Flanders,Belgium'.
// De waarde moet exact matchen met een locatienaam uit hun lijst; we kunnen die
// hier niet controleren, dus beperken we de vorm en laten de API de rest zeggen.
function okLocationName(v) {
  const s = String(v).trim().replace(/\s*,\s*/g, ',');
  return /^[\p{L}][\p{L} .,'()-]{1,79}$/u.test(s) ? s : null;
}

// Tweeletterige taalcode ('nl', 'fr', 'en'). DataForSEO kent ook varianten als
// 'nl-BE', maar die accepteren we bewust niet: bij de zoekvolume-endpoint is
// dat een stille bron van lege resultaten.
function okLanguageCode(v) {
  const s = String(v).trim().toLowerCase();
  return /^[a-z]{2}$/.test(s) ? s : null;
}

// Keywordlijst in één cel: gescheiden door komma, puntkomma of regeleinde.
// Zelfde sanering als api/seo.js (controletekens weg, max 80 tekens per stuk,
// ontdubbeld), zodat de sheet nooit iets doorlaat dat de API afkeurt.
function okKeywordList(v) {
  const out = [];
  for (const raw of String(v).split(/[,;\n\r]+/)) {
    const k = raw.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!k || k.length > 80) continue;
    if (!out.includes(k)) out.push(k);
    if (out.length >= 60) break;
  }
  return out.length ? out : null;
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
  // Steunkleur: tweede merkkleur, uitsluitend als vlakvulling met donkere tekst.
  // Nooit als tekstkleur en nooit als statuskleur — zie §9 van de briefing.
  steunkleur:        { path: 'support',                    check: okHex },
  tweedekleur:       { path: 'support',                    check: okHex },
  logourl:           { path: 'logoUrl',                    check: v => okHttpsUrl(v, LOGO_HOSTS) },
  // Naam van de map met het presentatie-design-system, binnen de Drive-map van
  // deze klant. Bewust een náám en geen map-id: deze tab staat in een sheet dat
  // met de klant gedeeld kan worden, en een id accepteren zou een klant het
  // design system van een andere klant laten inladen. Een naam kan alleen iets
  // aanwijzen dat al in zijn eigen map staat. Leeg → er wordt gezocht op een map
  // met 'design system' in de naam.
  designsystem:      { path: 'designSystem',               check: okFolderName },
  designsysteem:     { path: 'designSystem',               check: okFolderName },
  instagramaccount:  { path: 'accounts.instagram',         check: okAccount },
  facebookaccount:   { path: 'accounts.facebook_organic',  check: okAccount },
  metaadaccount:     { path: 'accounts.facebook',          check: okAccount },
  klaviyoaccount:    { path: 'accounts.klaviyo',           check: okAccount },
  mailerliteaccount: { path: 'accounts.mailerlite',        check: okAccount },
  convertkitaccount: { path: 'accounts.convertkit',        check: okAccount },
  // Organische TikTok/LinkedIn (Social-tab). Nog geen datakoppeling: de tab
  // meldt 'staat ingesteld, data volgt' tot de veldnamen geverifieerd zijn.
  tiktokaccount:     { path: 'accounts.tiktok_organic',    check: okAccount },
  linkedinaccount:   { path: 'accounts.linkedin_organic',  check: okAccount },

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

  // --- Website-tab: GA4-analytics + organisch zoeken ------------------------
  // De GA4-property staat hierboven al (ga4property). Search Console is een eigen
  // connector met een eigen id-vorm (sc-domain:… of https://…/).
  searchconsolesite:     { path: 'accounts.searchconsole', check: okSearchConsoleSite },
  searchconsoleproperty: { path: 'accounts.searchconsole', check: okSearchConsoleSite },
  googlesearchconsole:   { path: 'accounts.searchconsole', check: okSearchConsoleSite },
  // 'webshop' of 'leads'. Bepaalt of de tab de e-commerce-funnel of de
  // leadconversies toont. Leeg → afgeleid uit de data.
  websitetype:           { path: 'website.type',      check: okWebsiteType },
  // GA4-eventnaam van het hoofddoel, bv. 'purchase', 'generate_lead' of
  // 'property_form_submit'. Bepaalt de conversiekolom in de hele tab.
  conversiedoel:         { path: 'website.goalEvent', check: okEventName },
  conversiedoellabel:    { path: 'website.goalLabel', check: v => v.slice(0, 40) },

  // --- SEO-tab: DataForSEO (zoekvolumes + posities) ------------------------
  // Geen account-id: DataForSEO werkt met één gedeeld account. Wat hier staat
  // bepaalt wélke markt, taal, keywords en welk domein er bevraagd worden. De
  // inloggegevens zelf blijven in de CLIENTS env var — nooit in deze tab.
  seodomein:      { path: 'seo.domain',   check: okDomain },
  seodomain:      { path: 'seo.domain',   check: okDomain },
  seomarkt:       { path: 'seo.location', check: okLocationName },
  seolocatie:     { path: 'seo.location', check: okLocationName },
  seotaal:        { path: 'seo.language', check: okLanguageCode },
  seokeywords:    { path: 'seo.keywords', check: okKeywordList },
  seozoekwoorden: { path: 'seo.keywords', check: okKeywordList },

  // --- ROAS-tab: break-even-parameters -------------------------------------
  // Brutomarge en de lopende seizoenskorting bepalen de minimum-ROAS waaronder
  // een kanaal of campagne verlies draait. Zie roasTargets() voor de formule.
  brutomarge:        { path: 'roas.grossMargin',      check: okPercent },
  seizoenskorting:   { path: 'roas.seasonalDiscount', check: okPercent },
  minimumroas:       { path: 'roas.minRoas',          check: okRatio },
  // Welke omzetdefinitie het oordeel (uitzetten/bijsturen/schalen) bepaalt.
  // Per klant instelbaar omdat het antwoord afhangt van de kwaliteit van de
  // tracking: met sluitende server-side tracking is GA4 betrouwbaar, zonder
  // consent-mode-dekking onderschat GA4 structureel en is platform realistischer.
  // De toggle in de ROAS-tab blijft altijd beschikbaar; dit zet alleen de default.
  oordeelop:     { path: 'roas.verdictSource', check: okVerdictSource },

  // --- Losse links naar materiaal buiten het dashboard ----------------------
  // Een rapportagedeck, een brandbook, een contentkalender: dingen waar het
  // dashboard zelf niets mee rekent, maar waar de klant en de agent wel naartoe
  // moeten kunnen. Ze horen hier omdat de Config-tab per klant is en
  // meeverhuist; zonder deze velden geeft elke regel 'Onbekend veld — genegeerd'.
  // Alleen https, en de URL wordt niet naar een hostlijst beperkt zoals het logo:
  // dit is een verwijzing, geen bron die de pagina inlaadt.
  presentatie:     { path: 'links.deck',      check: okHttpsUrl },
  presentatielink: { path: 'links.deck',      check: okHttpsUrl },
  // links.report is niet alleen een verwijzing: staat er een markdown in Drive,
  // dan leest de Rapport-tab die als sjabloon voor het deck (drive.js, action
  // 'report-template'). Vandaar okDriveFile in die module om er een bestand-id
  // uit te halen.
  rapportlink:     { path: 'links.report',    check: okHttpsUrl },
  brandbook:       { path: 'links.brandbook', check: okHttpsUrl },
};

/**
 * Break-even ROAS voor twee scenario's: volle prijs en de lopende seizoenskorting.
 *
 * Bij een brutomarge m op de volle prijs en een korting d geldt per €100 catalogus-
 * waarde: kostprijs goederen = 100·(1−m), verkoopprijs = 100·(1−d). De brutowinst
 * die overblijft om advertenties te betalen is dus (1−d) − (1−m) = m − d, op een
 * omzet van (1−d). Break-even = omzet / advertentiekosten =
 *
 *     ROAS_be = (1 − d) / (m − d)
 *
 * Bij d ≥ m is er geen marge meer over: elke euro advertising is dan per definitie
 * verlies. Dat geven we terug als null met een expliciete reden, niet als een
 * misleidend negatief getal.
 *
 * Het actieve scenario (= de drempel) is de seizoenskorting zodra die is ingevuld
 * en groter dan nul; anders volle prijs. In het dashboard is dat met één klik om
 * te zetten zonder de sheet aan te passen.
 */
function roasTargets(roas) {
  const m = roas && typeof roas.grossMargin === 'number' ? roas.grossMargin : null;
  if (m == null) return null;

  const discount = typeof roas.seasonalDiscount === 'number' ? roas.seasonalDiscount : null;
  const scenario = (key, label, d) => {
    const margin = m - d;
    return {
      key, label,
      discount: d,
      // Netto marge per €100 catalogusprijs, vóór advertentiekosten.
      netMargin: Math.round(margin * 10000) / 10000,
      breakEvenRoas: margin > 0 ? Math.round(((1 - d) / margin) * 100) / 100 : null,
      loss: margin <= 0,
    };
  };

  const scenarios = [scenario('full', 'Volle prijs', 0)];
  if (discount != null && discount > 0) scenarios.push(scenario('season', 'Seizoenskorting', discount));

  return {
    grossMargin: m,
    seasonalDiscount: discount,
    activeScenario: (discount != null && discount > 0) ? 'season' : 'full',
    scenarios,
  };
}

function emptyConfig() {
  return { brandName: null, accent: null, accentText: null, support: null, logoUrl: null, accounts: {}, links: {}, roas: {}, roasTargets: null, website: {}, seo: {} };
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

/* ==========================================================
   Google-token — twee wegen, in deze volgorde
   ==========================================================
   1. WORKLOAD IDENTITY FEDERATION (voorkeur). Vercel geeft elke functie een
      kortlevend OIDC-token in VERCEL_OIDC_TOKEN. Google's STS ruilt dat in voor
      een federated token, en daarmee doen we ons voor als het service-account.
      Er bestaat dan nergens een private key: niet in een env var, niet in een
      bestand, niet in een foutmelding.

      Waarom nog steeds impersonatie en niet rechtstreeks de federated identity:
      Drive- en Sheets-toegang hangt aan het e-MAILADRES van het service-account
      (dat is met elke klantmap gedeeld). Een federated principal heeft geen
      adres om mee te delen, dus we lenen dat van het service-account. Alle
      bestaande shares blijven daardoor werken.

   2. SERVICE-ACCOUNT-SLEUTEL (terugval). Werkt zoals altijd. Nodig voor lokale
      scripts en als vangnet zolang de federatie niet bewezen is. Zodra die staat
      kan GOOGLE_SERVICE_ACCOUNT_KEY uit Vercel en de sleutel uit Google weg.

   De scope is een parameter omdat dezelfde functie Sheets- én Drive-lezers
   bedient: met alleen de spreadsheets-scope geeft elke Drive-call een 403
   'insufficient authentication scopes'.
   ========================================================== */

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const STS_URL = 'https://sts.googleapis.com/v1/token';
const IAM_CREDENTIALS = 'https://iamcredentials.googleapis.com/v1';

// Tokens leven een uur; we hergebruiken ze binnen één warme instantie en laten
// een minuut marge zodat een token niet halverwege een reeks calls verloopt.
const tokenCache = new Map(); // scope -> { token, exp }

/* Waar het OIDC-token vandaan komt, verschilt per omgeving (geverifieerd in de
   Vercel-documentatie en aan den lijve): in een draaiende Function zit het in de
   header `x-vercel-oidc-token` van het request, in een build en lokaal
   (`vercel env pull`) in de env var VERCEL_OIDC_TOKEN. Alleen naar de env var
   kijken betekent dus: lokaal werkt de federatie, in productie stilletjes niet.

   Elke handler die uiteindelijk bij Google uitkomt geeft het request hier even
   door. Het token leeft twee uur en Vercel hergebruikt het tot 90 minuten, dus
   het bewaren tussen aanroepen van dezelfde warme instantie is prima. */
let runtimeOidcToken = null;

function captureOidcToken(req) {
  const h = req && req.headers;
  const token = (h && typeof h.get === 'function') ? h.get('x-vercel-oidc-token') : (h && h['x-vercel-oidc-token']);
  if (token) runtimeOidcToken = token;
}

function federationConfig() {
  const audience = process.env.GCP_WORKLOAD_IDENTITY_AUDIENCE;
  const serviceAccount = process.env.GCP_SERVICE_ACCOUNT_EMAIL;
  const oidcToken = runtimeOidcToken || process.env.VERCEL_OIDC_TOKEN;
  if (!audience || !serviceAccount || !oidcToken) return null;
  return { audience, serviceAccount, oidcToken };
}

async function tokenViaFederation(cfg, scope) {
  // Stap 1 — OIDC-token inruilen bij Google's STS.
  const stsRes = await fetch(STS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: cfg.audience,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: cfg.oidcToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    }),
  });
  const sts = await stsRes.json().catch(() => ({}));
  if (!stsRes.ok || !sts.access_token) {
    throw new Error(`STS ${stsRes.status}: ${String(sts.error_description || sts.error || '').slice(0, 200)}`);
  }

  // Stap 2 — met dat token het service-account impersoneren, voor de scope die
  // de aanroeper nodig heeft.
  const impRes = await fetch(
    `${IAM_CREDENTIALS}/projects/-/serviceAccounts/${encodeURIComponent(cfg.serviceAccount)}:generateAccessToken`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sts.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: scope.split(/\s+/).filter(Boolean), lifetime: '3600s' }),
    });
  const imp = await impRes.json().catch(() => ({}));
  if (!impRes.ok || !imp.accessToken) {
    throw new Error(`Impersonatie ${impRes.status}: ${String(imp.error?.message || '').slice(0, 200)}`);
  }
  return imp.accessToken;
}

async function getAccessToken(scope = SHEETS_SCOPE) {
  const hit = tokenCache.get(scope);
  if (hit && hit.exp > Date.now() + 60000) return hit.token;

  const cfg = federationConfig();
  if (cfg) {
    try {
      const token = await tokenViaFederation(cfg, scope);
      tokenCache.set(scope, { token, exp: Date.now() + 3600000 });
      return token;
    } catch (e) {
      // Zolang er nog een sleutel is, is een mislukte federatie geen storing.
      // Wel luid loggen: anders migreren we stilzwijgend nooit.
      if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) throw e;
      console.error('[auth] federatie mislukt, terugval op de sleutel:', e.message);
    }
  }

  const token = await tokenViaServiceAccountKey(scope);
  tokenCache.set(scope, { token, exp: Date.now() + 3600000 });
  return token;
}

async function tokenViaServiceAccountKey(scope = SHEETS_SCOPE) {
  const keyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyRaw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY niet ingesteld.');

  const key = JSON.parse(keyRaw);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claimSet = Buffer.from(JSON.stringify({
    iss: key.client_email,
    scope,
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

// getAccessToken wordt ook door _sheetdata.js gebruikt — één implementatie i.p.v.
// een derde kopie van hetzelfde JWT-dansje.
module.exports = { getClientConfig, emptyConfig, parseConfigRows, normKey, roasTargets, getAccessToken, captureOidcToken, okDriveFile, SHEETS_SCOPE };
