const crypto = require('crypto');

const SECRET = process.env.AUTH_SECRET || 'change-this-secret';
const TOKEN_MAX_AGE_MS = 10 * 60 * 60 * 1000;
const BASE = 'https://connect.windsor.ai';

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
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Windsor ${res.status}: ${text.slice(0, 300)}`);
    }
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Windsor timeout (${timeoutMs}ms): ${path}`);
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
      case 'getDashboard': {
        if (!startDate || !endDate) return res.status(400).json({ error: 'startDate en endDate vereist.' });
        const dateParams = { date_from: startDate, date_to: endDate };

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
        ]);

        return res.status(200).json({
          period: { startDate, endDate },
          instagram: igData,
          facebook: fbData,
          ads: adsData,
        });
      }

      default:
        return res.status(400).json({ error: `Onbekende action: ${action}` });
    }
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
