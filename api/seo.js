/* ==========================================================
   seo.js — SEO-tab: zoekvolumes, concurrentie, CPC en posities
   ==========================================================
   Bron: DataForSEO REST (https://api.dataforseo.com/v3), Basic auth.
   Gemodelleerd op TEMPLATE_seo-dashboard.html uit Drive (7.3 AI-agents-skills/
   dashboards), maar dan multi-tenant en server-side.

   Twee endpoints, bewust gescheiden omdat ze een factor duizend in prijs schelen:

     keywords_data/google_ads/search_volume/live   — ÉÉN call voor álle keywords
                                                     (tot 1000), verwaarloosbare kost
     serp/google/organic/live/advanced             — ÉÉN call PER keyword,
                                                     ~€0,002 per stuk

   Daarom zit de rank-check achter een aparte knop in de UI en achter een eigen
   actie hier. Volumes mogen bij elk tabbezoek; posities alleen op verzoek.

   ISOLATIE: domein, markt, taal en de standaard-keywordlijst komen server-side
   uit de Config-tab van de klantsheet (_config.js), nooit uit het request. Het
   DataForSEO-saldo is gedeeld over alle klanten, dus het request mag geen
   resource aanwijzen. Keywords zijn de enige uitzondering: dat zijn zoektermen,
   geen resource-ids — ze worden gesaneerd en in aantal begrensd.

   GEVERIFIEERD (docs.dataforseo.com, 20-09-2026):
   - Beide endpoints nemen een ARRAY van taken, maar een live-call mag er maar
     één bevatten. Meerdere keywords ranken = meerdere HTTP-calls (parallel).
   - `monthly_searches` is in REST een ARRAY van {year, month, search_volume} —
     de MCP levert een {"YYYY-MM": n}-object. Wie de handover naast deze code
     legt: dat verschil is echt.
   - Google Ads live-endpoints: max 12 requests per minuut per account.
   ========================================================== */

const crypto = require('crypto');
const { getClientConfig } = require('./_config');

const SECRET = process.env.AUTH_SECRET;
const TOKEN_MAX_AGE_MS = 10 * 60 * 60 * 1000;
const BASE = 'https://api.dataforseo.com/v3';

// Hoeveel keywords er maximaal door mogen. Volumes zijn één call, dus ruim;
// posities kosten per keyword, dus krap. Beide begrenzen ook de reactietijd.
const MAX_VOLUME_KEYWORDS = 100;
const MAX_RANK_KEYWORDS = 25;

// Posities halen we parallel op, maar niet onbeperkt: DataForSEO staat 2000
// calls/minuut toe, de functie heeft 60 s. Zes tegelijk houdt 25 keywords
// binnen het budget zonder de API te bestoken.
const RANK_CONCURRENCY = 6;
const RANK_DEADLINE_MS = 45000;   // daarna geen nieuwe calls meer starten
const SERP_DEPTH = 20;            // top 20; daaronder is een positie geen positie

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

/* ---------- Cache ----------
   Per dag, per klant. Serverless-instanties worden hergebruikt (Fluid Compute),
   dus dit scheelt echte calls, maar het is geen garantie — de echte rem zit in
   de dagcache in de browser. Sleutel ALTIJD met clientId erin: een gedeelde
   cache zonder klant in de sleutel was in deze app al eens een lek. */
const cache = new Map(); // key -> { data, day }

function today() {
  // Europe/Brussels: een dagcache die om middernacht UTC omslaat vervalt hier
  // om 1 of 2 uur 's nachts. Dat is precies wat je wil.
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Brussels' });
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && hit.day === today()) return hit.data;
  if (hit) cache.delete(key);
  return null;
}

function cacheSet(key, data) {
  // Ruim andere dagen op zodat de Map niet eindeloos groeit in een warme instantie.
  if (cache.size > 200) for (const [k, v] of cache) if (v.day !== today()) cache.delete(k);
  cache.set(key, { data, day: today() });
}

/* ---------- Keywords saneren ----------
   Een keyword is een zoekterm, geen identifier: het wijst nooit data van een
   andere klant aan. Maar het gaat wel ongefilterd een externe API in, dus:
   controletekens eruit, lengte begrensd (DataForSEO: 80 tekens), ontdubbeld. */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

function cleanKeywords(list, max) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const k = String(raw == null ? '' : raw)
      .replace(CONTROL_CHARS, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!k || k.length > 80) continue;
    if (!out.includes(k)) out.push(k);
    if (out.length >= max) break;
  }
  return out;
}

function keywordKey(keywords) {
  return crypto.createHash('sha1').update([...keywords].sort().join('\n')).digest('hex').slice(0, 16);
}

/* ---------- DataForSEO ---------- */

function resolveAuth(client) {
  // Eén gedeeld DataForSEO-account bedient alle klanten (zie de handover). Een
  // eigen sleutel per klant mag, net als bij Anthropic in chat.js/analysis.js.
  const login = client?.dataforseo_login || process.env.DATAFORSEO_LOGIN;
  const password = client?.dataforseo_password || process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) return null;
  return Buffer.from(`${login}:${password}`).toString('base64');
}

async function dfsPost(path, task, auth, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([task]),          // live-call: precies één taak
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new Error(`DataForSEO ${res.status}: ${text.slice(0, 200)}`); }
    if (!res.ok) throw new Error(`DataForSEO ${res.status}: ${body.status_message || text.slice(0, 200)}`);
    // 20000 = Ok. Alles daarbuiten is een echte fout, ook bij HTTP 200.
    if (body.status_code !== 20000) throw new Error(`DataForSEO ${body.status_code}: ${body.status_message}`);
    const t = (body.tasks || [])[0];
    if (!t) throw new Error('DataForSEO gaf geen taak terug.');
    if (t.status_code !== 20000) throw new Error(`DataForSEO ${t.status_code}: ${t.status_message}`);
    return { result: t.result || [], cost: Number(body.cost) || 0 };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`DataForSEO timeout (${timeoutMs} ms) op ${path}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Vaste-breedte worker pool: start er nooit meer dan `limit` tegelijk.
async function pool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

/* ---------- Normaliseren ---------- */

// REST geeft monthly_searches als array met losse year/month-velden; de UI wil
// een oplopende reeks van {month:'YYYY-MM', volume}. Hier één keer omzetten,
// zodat de frontend nooit met twee vormen te maken heeft.
function normMonthly(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(m => m && m.year && m.month)
    .map(m => ({
      month: `${m.year}-${String(m.month).padStart(2, '0')}`,
      volume: m.search_volume == null ? null : Number(m.search_volume),
    }))
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

function normVolumeItem(it) {
  return {
    keyword: String(it.keyword || '').toLowerCase(),
    volume: it.search_volume == null ? null : Number(it.search_volume),
    competition: it.competition || null,                       // HIGH | MEDIUM | LOW | null
    competitionIndex: it.competition_index == null ? null : Number(it.competition_index),
    cpc: it.cpc == null ? null : Number(it.cpc),
    lowBid: it.low_top_of_page_bid == null ? null : Number(it.low_top_of_page_bid),
    highBid: it.high_top_of_page_bid == null ? null : Number(it.high_top_of_page_bid),
    monthly: normMonthly(it.monthly_searches),
  };
}

function emptyVolumeItem(keyword) {
  return {
    keyword, volume: null, competition: null, competitionIndex: null,
    cpc: null, lowBid: null, highBid: null, monthly: [],
  };
}

// Hostvergelijking voor de positiebepaling. `www.` eraf, en een subdomein telt
// mee (shop.merk.be hoort bij merk.be) — anders mist de rank-check precies de
// webshop waar het om draait.
function hostMatches(host, domain) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  if (!h || !domain) return false;
  return h === domain || h.endsWith('.' + domain);
}

/* ---------- Instellingen uit de Config-tab ---------- */

async function loadSettings(clientId) {
  let config = null;
  const warnings = [];
  try {
    const r = await getClientConfig(clientId);
    config = r.config;
  } catch (e) {
    warnings.push(e.message);
  }
  const seo = (config && config.seo) || {};
  return {
    domain: seo.domain || null,
    location: seo.location || 'Belgium',
    language: seo.language || 'nl',
    // Standaardlijst uit de sheet. Leeg = de klant moet eerst keywords kiezen;
    // we verzinnen er geen.
    defaultKeywords: Array.isArray(seo.keywords) ? seo.keywords : [],
    locationSource: seo.location ? 'config' : 'default',
    languageSource: seo.language ? 'config' : 'default',
    warnings,
  };
}

/* ---------- Handler ---------- */

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, clientId, token, keywords: reqKeywords, force } = req.body || {};

  if (!verifyToken(token, clientId)) {
    return res.status(401).json({ error: 'Sessie verlopen. Meld opnieuw aan.' });
  }

  let clients;
  try {
    clients = JSON.parse(process.env.CLIENTS || '{}');
  } catch {
    return res.status(500).json({ error: 'Serverconfiguratie fout.' });
  }
  const client = clients[String(clientId).toLowerCase()];
  const auth = resolveAuth(client);

  const settings = await loadSettings(clientId);
  const cid = String(clientId).toLowerCase();

  // Wat de UI mag tonen, ongeacht of er data is. `hasCredentials` = volumes
  // kunnen; `canRank` = posities kunnen (daar is ook een domein voor nodig).
  const meta = {
    domain: settings.domain,
    location: settings.location,
    language: settings.language,
    locationSource: settings.locationSource,
    languageSource: settings.languageSource,
    defaultKeywords: settings.defaultKeywords,
    hasCredentials: !!auth,
    canRank: !!auth && !!settings.domain,
    maxVolumeKeywords: MAX_VOLUME_KEYWORDS,
    maxRankKeywords: MAX_RANK_KEYWORDS,
    warnings: settings.warnings,
  };

  try {
    switch (action) {

      // Alleen de instellingen — waarmee de tab kan renderen vóór er data is.
      case 'settings':
        return res.status(200).json({ settings: meta });

      /* ---- Zoekvolumes: één call voor de hele lijst ---- */
      case 'volumes': {
        if (!auth) {
          return res.status(400).json({ error: 'Geen DataForSEO-koppeling ingesteld.', settings: meta });
        }
        // Lijst uit het request (de klant mag keywords toevoegen in de tab),
        // anders de standaardlijst uit de Config-tab.
        const wanted = cleanKeywords(
          (Array.isArray(reqKeywords) && reqKeywords.length) ? reqKeywords : settings.defaultKeywords,
          MAX_VOLUME_KEYWORDS
        );
        if (!wanted.length) {
          return res.status(400).json({
            error: 'Geen keywords. Zet ze in de Config-tab bij "SEO keywords" of voeg ze hier toe.',
            settings: meta,
          });
        }

        const key = `${cid}|vol|${settings.location}|${settings.language}|${keywordKey(wanted)}`;
        if (!force) {
          const hit = cacheGet(key);
          if (hit) return res.status(200).json({ ...hit, settings: meta, fromCache: true });
        }

        const { result, cost } = await dfsPost('/keywords_data/google_ads/search_volume/live', {
          keywords: wanted,
          location_name: settings.location,
          language_code: settings.language,
        }, auth, 30000);

        const items = (result || []).map(normVolumeItem);
        // DataForSEO laat keywords zonder data weg. Die willen we tóch in de
        // tabel zien: 'geen volume' is een antwoord, een ontbrekende rij niet.
        const seen = new Set(items.map(i => i.keyword));
        for (const k of wanted) if (!seen.has(k)) items.push(emptyVolumeItem(k));

        const payload = { items, keywords: wanted, cost, fetchedAt: new Date().toISOString() };
        cacheSet(key, payload);
        return res.status(200).json({ ...payload, settings: meta, fromCache: false });
      }

      /* ---- Posities: één SERP-call per keyword, dus achter een eigen knop ---- */
      case 'ranks': {
        if (!auth) {
          return res.status(400).json({ error: 'Geen DataForSEO-koppeling ingesteld.', settings: meta });
        }
        if (!settings.domain) {
          return res.status(400).json({
            error: 'Geen merk-domein. Zet "SEO domein" in de Config-tab van de klantsheet.',
            settings: meta,
          });
        }
        const wanted = cleanKeywords(
          (Array.isArray(reqKeywords) && reqKeywords.length) ? reqKeywords : settings.defaultKeywords,
          MAX_RANK_KEYWORDS
        );
        if (!wanted.length) {
          return res.status(400).json({ error: 'Geen keywords om te controleren.', settings: meta });
        }

        const key = `${cid}|rank|${settings.domain}|${settings.location}|${settings.language}|${keywordKey(wanted)}`;
        if (!force) {
          const hit = cacheGet(key);
          if (hit) return res.status(200).json({ ...hit, settings: meta, fromCache: true });
        }

        const deadline = Date.now() + RANK_DEADLINE_MS;
        let cost = 0;
        const ranks = {};

        await pool(wanted, RANK_CONCURRENCY, async (kw) => {
          // Budget op: niet meer starten. Liever een gedeeltelijk resultaat met
          // een eerlijke melding dan een functie die halverwege wordt afgekapt.
          if (Date.now() > deadline) { ranks[kw] = { skipped: true }; return; }
          try {
            const r = await dfsPost('/serp/google/organic/live/advanced', {
              keyword: kw,
              location_name: settings.location,
              language_code: settings.language,
              depth: SERP_DEPTH,
            }, auth, 25000);
            cost += r.cost;
            const items = (r.result && r.result[0] && r.result[0].items) || [];
            const hit = items.find(it => it && it.type === 'organic' && hostMatches(it.domain, settings.domain));
            ranks[kw] = hit
              ? { pos: hit.rank_group, abs: hit.rank_absolute, url: hit.url || null, title: hit.title || null }
              : { pos: null };
          } catch (e) {
            console.error(`[seo] rank-check "${kw}" mislukt:`, e.message);
            ranks[kw] = { error: e.message };
          }
        });

        const skipped = Object.values(ranks).filter(r => r && r.skipped).length;
        const payload = {
          ranks,
          keywords: wanted,
          domain: settings.domain,
          depth: SERP_DEPTH,
          cost: Math.round(cost * 10000) / 10000,
          skipped,
          checkedAt: new Date().toISOString(),
        };
        // Gedeeltelijke runs niet cachen: dan blijft een halve meting een dag staan.
        if (!skipped) cacheSet(key, payload);
        return res.status(200).json({ ...payload, settings: meta, fromCache: false });
      }

      default:
        return res.status(400).json({ error: `Onbekende actie: ${action}` });
    }
  } catch (e) {
    console.error('[seo] fout:', e.message);
    return res.status(500).json({ error: e.message, settings: meta });
  }
};
