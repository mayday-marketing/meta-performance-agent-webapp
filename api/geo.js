/* ==========================================================
   geo.js — GEO-tab: AI-zichtbaarheid (baseline + live bronnen)
   ==========================================================
   Geport van TEMPLATE_geo-dashboard.html uit Drive (7.3 AI-agents-skills/
   dashboards). Twee bronnen, bewust gescheiden:

     action 'baseline'  → geo-dashboard.json uit de Drive-map van de klant
                          (zie _geodata.js). Dit is de gemeten audit: KPI's,
                          engine-scorecard, promptmatrix, readiness, acties.
                          Statisch — er wordt niets live opgevraagd.
     action 'sources'   → DataForSEO LLM-mentions, live. Welke domeinen en
                          pagina's voeden AI-antwoorden in deze markt.

   De scheiding is het hele punt. De baseline is een meting met een datum en een
   methode; die verzin je niet en die ververs je niet per ongeluk. De Sources-
   laag is marktdata die elke dag mag veranderen en niets over déze klant
   beweert — daarom mag die wel live.

   KOSTEN: een sources-pull kost ~$0,10 (DataForSEO rekent per call, niet per
   rij). Dat is duurder dan een rank-check in de SEO-tab en staat daarom achter
   een knop, met een dagcache eroverheen.

   GEVERIFIEERD (live call, 20-09-2026): de respons is
   tasks[0].result[0].items[0].total.sources_domain[] met {key, mentions,
   ai_search_volume}, en items[0].items[] met dezelfde vorm per domein/pagina.
   De nieuwere endpointnaam (top_mentioned_domains) noemt dat blok
   `aggregated_metrics` in plaats van `total`; beide worden hier afgevangen.
   ========================================================== */

const crypto = require('crypto');
const { captureOidcToken } = require('./_config');
const { getGeoBaseline } = require('./_geodata');

const SECRET = process.env.AUTH_SECRET;
const TOKEN_MAX_AGE_MS = 10 * 60 * 60 * 1000;
const BASE = 'https://api.dataforseo.com/v3';

// DataForSEO's live LLM-mentions endpoints mogen tot 120 s duren. De functie
// heeft er 120 in vercel.json; we kappen zelf eerder af zodat er een nette
// melding terugkomt in plaats van een afgebroken request.
const SOURCES_TIMEOUT_MS = 100000;

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

/* ---------- Dagcache voor de live laag ---------- */

const cache = new Map(); // key -> { data, day }
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Brussels' });

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && hit.day === today()) return hit.data;
  if (hit) cache.delete(key);
  return null;
}
function cacheSet(key, data) {
  if (cache.size > 100) for (const [k, v] of cache) if (v.day !== today()) cache.delete(k);
  cache.set(key, { data, day: today() });
}

/* ---------- DataForSEO ---------- */

function resolveAuth(client) {
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
      body: JSON.stringify([task]),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new Error(`DataForSEO ${res.status}: ${text.slice(0, 200)}`); }
    if (res.status === 404) { const e = new Error('endpoint-not-found'); e.notFound = true; throw e; }
    if (!res.ok) throw new Error(`DataForSEO ${res.status}: ${body.status_message || text.slice(0, 200)}`);
    if (body.status_code !== 20000) throw new Error(`DataForSEO ${body.status_code}: ${body.status_message}`);
    const t = (body.tasks || [])[0];
    if (!t) throw new Error('DataForSEO gaf geen taak terug.');
    if (t.status_code !== 20000) throw new Error(`DataForSEO ${t.status_code}: ${t.status_message}`);
    return { result: t.result || [], cost: Number(body.cost) || 0 };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`DataForSEO timeout (${Math.round(timeoutMs / 1000)} s) — de LLM-mentions-endpoints mogen tot 120 s duren.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// DataForSEO heeft de endpoints hernoemd (top_domains → top_mentioned_domains)
// maar houdt de oude paden in stand. We proberen de huidige naam en vallen bij
// een 404 terug op de oude, zodat een naamswijziging aan hun kant de tab niet
// sloopt.
async function dfsPostWithFallback(paths, task, auth, timeoutMs) {
  let lastErr;
  for (const path of paths) {
    try {
      return await dfsPost(path, task, auth, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (!e.notFound) throw e;
    }
  }
  throw lastErr || new Error('Geen bruikbaar endpoint.');
}

const groupList = (list) => (Array.isArray(list) ? list : []).map((g) => ({
  key: String(g?.key ?? '').slice(0, 300),
  mentions: Number(g?.mentions) || 0,
  aiSearchVolume: g?.ai_search_volume == null ? null : Number(g.ai_search_volume),
})).filter((g) => g.key);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  captureOidcToken(req);   // OIDC-token uit de request-header (zie _config.js)
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, clientId, token, keyword, platform, force } = req.body || {};

  if (!verifyToken(token, clientId)) {
    return res.status(401).json({ error: 'Sessie verlopen. Meld opnieuw aan.' });
  }

  let clients;
  try {
    clients = JSON.parse(process.env.CLIENTS || '{}');
  } catch {
    return res.status(500).json({ error: 'Serverconfiguratie fout.' });
  }
  const cid = String(clientId).toLowerCase();
  const client = clients[cid];
  const auth = resolveAuth(client);

  try {
    switch (action) {

      /* ---- De gemeten baseline uit Drive ---- */
      case 'baseline': {
        const base = await getGeoBaseline(cid, client?.driveFolderId, force === true);
        return res.status(200).json({
          baseline: base.data,
          reason: base.reason,
          searched: base.searched,
          warnings: base.warnings,
          file: base.file || null,
          otherFiles: base.otherFiles || 0,
          hasSources: !!auth,
        });
      }

      /* ---- Live: welke bronnen voeden AI-antwoorden in deze markt ---- */
      case 'sources': {
        if (!auth) {
          return res.status(400).json({ error: 'Geen DataForSEO-koppeling ingesteld.' });
        }
        // Het keyword en de markt komen uit het `sources`-blok van de baseline,
        // server-side. Het request mag alleen kiezen uit wat daar staat — zo kan
        // een klant geen willekeurige (betaalde) query afvuren op het gedeelde
        // DataForSEO-saldo.
        const base = await getGeoBaseline(cid, client?.driveFolderId, false);
        const cfg = base.data?.sources;
        if (!cfg || !cfg.keyword) {
          return res.status(400).json({
            error: 'Geen sources-configuratie in geo-dashboard.json. Zet daar een blok "sources" met minstens een keyword.',
          });
        }
        // Het request mag hooguit het platform omzetten tussen de twee waarden
        // die DataForSEO kent; al de rest is server-side.
        const plat = (platform === 'google' || platform === 'chat_gpt') ? platform : cfg.platform;
        // Een keyword uit het request wordt genegeerd tenzij het exact het
        // geconfigureerde keyword is — expliciet, zodat later niemand denkt dat
        // dit veld iets doet.
        if (keyword && String(keyword) !== cfg.keyword) {
          return res.status(400).json({ error: 'Het keyword staat vast in geo-dashboard.json.' });
        }
        const location = cfg.location || 'Belgium';
        const language = cfg.language || 'nl';

        const key = `${cid}|src|${cfg.keyword}|${plat}|${location}|${language}`;
        if (!force) {
          const hit = cacheGet(key);
          if (hit) return res.status(200).json({ ...hit, fromCache: true });
        }

        const task = {
          target: [{ keyword: cfg.keyword, match_type: 'partial_match', search_filter: 'include' }],
          platform: plat,
          location_name: location,
          language_code: language,
          links_scope: 'sources',
          items_list_limit: 10,
          internal_list_limit: 10,
        };

        const [domRes, pagRes] = await Promise.all([
          dfsPostWithFallback([
            '/ai_optimization/llm_mentions/top_mentioned_domains/live',
            '/ai_optimization/llm_mentions/top_domains/live',
          ], task, auth, SOURCES_TIMEOUT_MS).catch((e) => ({ __error: e.message })),
          dfsPostWithFallback([
            '/ai_optimization/llm_mentions/top_mentioned_pages/live',
            '/ai_optimization/llm_mentions/top_pages/live',
          ], { ...task, internal_list_limit: 2 }, auth, SOURCES_TIMEOUT_MS).catch((e) => ({ __error: e.message })),
        ]);

        const errors = {};
        let cost = 0;

        // result[0].items[0] draagt zowel het totaalblok als de lijst. De
        // nieuwere endpointnaam zet dat totaalblok onder `aggregated_metrics`.
        const firstItem = (r) => (r?.result?.[0]?.items?.[0]) || r?.result?.[0] || null;

        let domains = [];
        let totals = null;
        if (domRes.__error) {
          errors.domains = domRes.__error;
        } else {
          cost += domRes.cost || 0;
          const it = firstItem(domRes);
          const agg = it?.total || it?.aggregated_metrics || null;
          domains = groupList(agg?.sources_domain);
          totals = agg ? {
            mentions: groupList(agg.platform)[0]?.mentions ?? null,
            aiSearchVolume: groupList(agg.platform)[0]?.aiSearchVolume ?? null,
            brands: groupList(agg.brand_entities_title).slice(0, 10),
          } : null;
        }

        let pages = [];
        if (pagRes.__error) {
          errors.pages = pagRes.__error;
        } else {
          cost += pagRes.cost || 0;
          const it = firstItem(pagRes);
          pages = (Array.isArray(it?.items) ? it.items : []).map((p) => {
            const loc = groupList(p?.location)[0] || null;
            return {
              url: String(p?.key ?? '').replace(/\?utm_source=chatgpt\.com$/, '').slice(0, 400),
              mentions: loc?.mentions ?? null,
              aiSearchVolume: loc?.aiSearchVolume ?? null,
            };
          }).filter((p) => p.url);
        }

        const payload = {
          keyword: cfg.keyword,
          platform: plat,
          location, language,
          domains, pages, totals,
          errors,
          cost: Math.round(cost * 1000) / 1000,
          fetchedAt: new Date().toISOString(),
        };
        // Alleen cachen als er iets bruikbaars uitkwam; anders blijft een
        // mislukte pull een dag lang 'het antwoord'.
        if (domains.length || pages.length) cacheSet(key, payload);
        return res.status(200).json({ ...payload, fromCache: false });
      }

      default:
        return res.status(400).json({ error: `Onbekende actie: ${action}` });
    }
  } catch (e) {
    console.error('[geo] fout:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
