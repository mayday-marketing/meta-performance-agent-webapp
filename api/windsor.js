const crypto = require('crypto');

const SECRET = process.env.AUTH_SECRET || 'change-this-secret';
const TOKEN_MAX_AGE_MS = 10 * 60 * 60 * 1000;
<<<<<<< HEAD
const BASE = 'https://connectors.windsor.ai';
=======
const BASE = 'https://connect.windsor.ai';
>>>>>>> 422dcec30936311ea9ee71744f3c2a454ba9cd58

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

<<<<<<< HEAD
// Windsor.ai REST data endpoint:
//   GET https://connect.windsor.ai/{connector_slug}?api_key=...&fields=...&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
// Connector IDs confirmed via Windsor MCP:
//   instagram          → IG organic (media + insights + stories)
//   facebook           → Meta Ads (paid, despite the name)
//   facebookorganic    → te bevestigen voor FB organic
//   googleanalytics4   → GA4
async function windsor(connector, apiKey, params, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const search = new URLSearchParams({ api_key: apiKey, ...params });
    const url = `${BASE}/${connector}?${search.toString()}`;
=======
// Generic Windsor REST call with timeout. Confirm exact path/params against
// https://windsor.ai docs — endpoints adjusted via WINDSOR_PATHS below.
const WINDSOR_PATHS = {
  data: '/',                         // GET /?api_key=...&connector=...&fields=...&date_from=...&date_to=...
  connectors: '/api/v1/connectors',  // GET /api/v1/connectors?api_key=...
  fields: '/api/v1/fields',          // GET /api/v1/fields?api_key=...&connector=...
};

async function windsor(path, params, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const search = new URLSearchParams(params);
    const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}${search.toString()}`;
>>>>>>> 422dcec30936311ea9ee71744f3c2a454ba9cd58
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Windsor ${res.status}: ${text.slice(0, 300)}`);
    }
    return await res.json();
  } catch (e) {
<<<<<<< HEAD
    if (e.name === 'AbortError') throw new Error(`Windsor timeout (${timeoutMs}ms): ${connector}`);
=======
    if (e.name === 'AbortError') throw new Error(`Windsor timeout (${timeoutMs}ms): ${path}`);
>>>>>>> 422dcec30936311ea9ee71744f3c2a454ba9cd58
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function safeCall(promise, label) {
  return promise.catch((e) => {
    console.error(`[windsor] ${label || ''} failed:`, e.message);
    return { __error: e.message };
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, clientId, token, connector, fields, startDate, endDate, datePreset } = req.body || {};

  if (!verifyToken(token, clientId)) {
    return res.status(401).json({ error: 'Sessie verlopen. Meld opnieuw aan.' });
  }

  let clients;
  try {
    clients = JSON.parse(process.env.CLIENTS || '{}');
  } catch {
    return res.status(500).json({ error: 'Serverconfiguratie fout.' });
  }

  const client = clients[clientId.toLowerCase()];
  if (!client?.windsor_api_key) {
    return res.status(400).json({ error: 'Geen Windsor-koppeling voor deze klant.' });
  }

  const apiKey = client.windsor_api_key;

  try {
    switch (action) {

<<<<<<< HEAD
      // Generic data query — pass connector + comma-separated fields + datums.
      // Voorbeeld: { connector: "instagram", fields: "media_id,media_caption,media_reach,timestamp", startDate: "2026-05-04", endDate: "2026-05-11" }
      // Voor schema-ontdekking gebruik Windsor's MCP-tools (get_connectors, get_fields) — niet beschikbaar via REST.
      case 'getData': {
        if (!connector || !fields) return res.status(400).json({ error: 'connector en fields vereist.' });
        const params = { fields };
        if (startDate) params.date_from = startDate;
        if (endDate) params.date_to = endDate;
        if (datePreset) params.date_preset = datePreset;
        const data = await windsor(connector, apiKey, params);
        return res.status(200).json(data);
      }

      // Eén-shot dashboard fetch — IG organic + Meta Ads parallel. FB organic komt later
      // zodra we de juiste connector-slug hebben bevestigd.
=======
      // List all connectors set up in this Windsor account (e.g. instagram, facebook_page_insights, facebook_ads).
      case 'getConnectors': {
        const data = await windsor(WINDSOR_PATHS.connectors, { api_key: apiKey });
        return res.status(200).json(data);
      }

      // List available fields for a specific connector.
      case 'getFields': {
        if (!connector) return res.status(400).json({ error: 'connector vereist.' });
        const data = await windsor(WINDSOR_PATHS.fields, { api_key: apiKey, connector });
        return res.status(200).json(data);
      }

      // Raw data query — for prototyping a field-mapping before full migratie.
      // Voorbeeld: { connector: "facebook_page_insights", fields: "post_id,post_message,post_impressions_unique", startDate: "2026-02-11", endDate: "2026-05-11" }
      case 'getData': {
        if (!connector || !fields) return res.status(400).json({ error: 'connector en fields vereist.' });
        const params = { api_key: apiKey, connector, fields };
        if (startDate) params.date_from = startDate;
        if (endDate) params.date_to = endDate;
        if (datePreset) params.date_preset = datePreset;
        const data = await windsor(WINDSOR_PATHS.data, params);
        return res.status(200).json(data);
      }

      // Voor latere migratie — equivalent van Metricool's getDashboard. Skeleton.
      // Vul connector-namen en field-lijsten in zodra coverage bevestigd is.
>>>>>>> 422dcec30936311ea9ee71744f3c2a454ba9cd58
      case 'getDashboard': {
        if (!startDate || !endDate) return res.status(400).json({ error: 'startDate en endDate vereist.' });
        const dateParams = { date_from: startDate, date_to: endDate };

<<<<<<< HEAD
        const IG_FIELDS = [
          'media_id', 'media_caption', 'media_type', 'media_product_type',
          'timestamp', 'media_thumbnail_url', 'media_url', 'media_permalink',
          'media_like_count', 'media_comments_count',
          'media_reach', 'media_views', 'media_saved', 'media_shares',
          'media_engagement', 'media_reel_total_watch_time', 'media_reel_avg_watch_time',
          'media_reel_total_interactions',
        ].join(',');

        const ADS_FIELDS = [
          'campaign_id', 'campaign_name', 'ad_id', 'ad_name',
          'impressions', 'reach', 'clicks', 'spend',
          'date_start', 'date_stop', 'cpm', 'cpc', 'ctr',
        ].join(',');

        const [igData, adsData] = await Promise.all([
          safeCall(windsor('instagram', apiKey, { fields: IG_FIELDS, ...dateParams }), 'ig'),
          safeCall(windsor('facebook',  apiKey, { fields: ADS_FIELDS, ...dateParams }), 'fb-ads'),
=======
        const [igData, fbData, adsData] = await Promise.all([
          safeCall(windsor(WINDSOR_PATHS.data, {
            api_key: apiKey,
            connector: 'instagram_business',
            fields: 'media_id,media_caption,media_type,media_product_type,timestamp,media_thumbnail_url,media_url,media_like_count,media_comments_count,media_reach,media_views,media_saved,media_shares,media_reel_video_views,media_reel_avg_watch_time',
            ...dateParams,
          }), 'ig-data'),
          safeCall(windsor(WINDSOR_PATHS.data, {
            api_key: apiKey,
            connector: 'facebook_page_insights',
            fields: 'post_id,post_created_time,post_message,full_picture,permalink_url,type,post_reactions_totaal,post_comments_totaal,post_impressions,post_impressions_unique,post_clicks,post_clicks_by_type_link_clicks,post_video_views',
            ...dateParams,
          }), 'fb-data'),
          safeCall(windsor(WINDSOR_PATHS.data, {
            api_key: apiKey,
            connector: 'facebook_ads',
            fields: 'campaign_id,campaign_name,ad_id,ad_name,impressions,reach,clicks,spend,date_start,date_stop',
            ...dateParams,
          }), 'fb-ads'),
>>>>>>> 422dcec30936311ea9ee71744f3c2a454ba9cd58
        ]);

        return res.status(200).json({
          period: { startDate, endDate },
          instagram: igData,
<<<<<<< HEAD
=======
          facebook: fbData,
>>>>>>> 422dcec30936311ea9ee71744f3c2a454ba9cd58
          ads: adsData,
        });
      }

      default:
<<<<<<< HEAD
        return res.status(400).json({ error: `Onbekende action: ${action} (alleen 'getData' en 'getDashboard' beschikbaar).` });
=======
        return res.status(400).json({ error: `Onbekende action: ${action}` });
>>>>>>> 422dcec30936311ea9ee71744f3c2a454ba9cd58
    }
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
