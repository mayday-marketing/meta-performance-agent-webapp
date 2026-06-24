const crypto = require('crypto');

const SECRET = process.env.AUTH_SECRET || 'change-this-secret';
const TOKEN_MAX_AGE_MS = 10 * 60 * 60 * 1000;
const BASE = 'https://connectors.windsor.ai';

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

// Windsor.ai REST data endpoint:
//   GET https://connectors.windsor.ai/{connector_slug}?api_key=...&fields=...&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
// Connector IDs (bevestigd via Windsor MCP):
//   instagram          → IG organic (media + insights + stories)
//   facebook           → Meta Ads (paid, ondanks de naam)
//   facebookorganic    → te bevestigen voor FB organic
//   googleanalytics4   → GA4
async function windsor(connector, apiKey, params, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const search = new URLSearchParams({ api_key: apiKey, ...params });
    const url = `${BASE}/${connector}?${search.toString()}`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Windsor ${res.status}: ${text.slice(0, 300)}`);
    }
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Windsor timeout (${timeoutMs}ms): ${connector}`);
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

  const { action, clientId, token, connector, fields, startDate, endDate, datePreset, filter } = req.body || {};

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

      // Generic data query — pass connector + comma-separated fields + datums.
      // Voorbeeld: { connector: "instagram", fields: "media_id,media_caption,media_reach,timestamp", startDate: "2026-05-04", endDate: "2026-05-11" }
      // Voor schema-ontdekking gebruik Windsor's MCP-tools (get_connectors, get_fields) — niet via REST.
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
      case 'getDashboard': {
        if (!startDate || !endDate) return res.status(400).json({ error: 'startDate en endDate vereist.' });
        const dateParams = { date_from: startDate, date_to: endDate };

        const IG_FIELDS = [
          'media_id', 'media_caption', 'media_type', 'media_product_type',
          'timestamp', 'media_thumbnail_url', 'media_url', 'media_permalink',
          'media_like_count', 'media_comments_count',
          'media_reach', 'media_views', 'media_saved', 'media_shares',
          'media_engagement', 'media_reel_total_watch_time', 'media_reel_avg_watch_time',
          'media_reel_total_interactions',
        ].join(',');

        // Daily-per-campaign rows zodat we de Meta Ads-lijn per week kunnen aggregeren
        // zonder pro-rata-schattingen (zoals we voor Metricool moesten doen).
        // Campagne-niveau — bewezen werkend. Voedt de trend/KPI's én dient als fallback
        // voor de Library wanneer de ad-level fetch hieronder faalt.
        const ADS_FIELDS = [
          'date', 'campaign_id', 'campaign_name',
          'impressions', 'reach', 'clicks', 'spend', 'cpm', 'cpc', 'ctr',
        ].join(',');

        // Ad-niveau — ZONDER `date` (Windsor aggregeert per advertentie → ±N rijen i.p.v.
        // N×dagen). CORE = STRIKT het essentiële, snelle minimum (engagement + paid-basics).
        // Dit is de primaire call die de losse advertenties + engagement levert. Alle zwaardere
        // extra's (creative-type, video-retentie, conversies) zitten in APARTE, niet-fatale
        // calls — zo kan een trage Meta-breakdown de core niet de 55s-timeout in trekken.
        const ADS_AD_CORE = [
          'ad_id', 'ad_name', 'campaign_name', 'image_url',
          'impressions', 'reach', 'clicks', 'spend', 'ctr', 'cpm',
          'actions_post_reaction', 'actions_comment', 'actions_post', 'actions_onsite_conversion_post_save',
        ].join(',');

        // Creative-type — aparte/niet-fatale call (IG-velden = exact format; object_type fallback).
        const ADS_AD_CREATIVE = [
          'ad_id',
          'effective_instagram_media__media_type', 'effective_instagram_media__media_product_type', 'object_type',
        ].join(',');

        // Video-retentie — Meta's per-video breakdowns zijn traag; apart/niet-fataal.
        const ADS_AD_VIDEO = [
          'ad_id',
          'video_p25_watched_actions_video_view', 'video_p50_watched_actions_video_view',
          'video_p75_watched_actions_video_view', 'video_p95_watched_actions_video_view',
          'video_p100_watched_actions_video_view', 'video_play_actions_video_view',
        ].join(',');

        // Conversies (ROAS-waarde + CAC-aantal) — value-breakdowns zijn zwaar; apart/niet-fataal.
        const ADS_AD_CONV = [
          'ad_id',
          'actions_purchase', 'actions_omni_purchase', 'action_values_purchase', 'action_values_omni_purchase',
          'actions_lead',
        ].join(',');

        // Core krijgt het volle budget (55s); de extra's een krappere timeout zodat een trage
        // breakdown de functie niet tot 55s gijzelt en de core-data altijd op tijd terugkomt.
        const FETCH_MS = 55000;
        const ADDON_MS = 35000;
        const [igData, adsData, adsAdData, adsCreativeData, adsVideoData, adsConvData] = await Promise.all([
          safeCall(windsor('instagram', apiKey, { fields: IG_FIELDS, ...dateParams }, FETCH_MS), 'ig'),
          safeCall(windsor('facebook',  apiKey, { fields: ADS_FIELDS, ...dateParams }, FETCH_MS), 'fb-ads'),
          safeCall(windsor('facebook',  apiKey, { fields: ADS_AD_CORE, ...dateParams }, FETCH_MS), 'fb-ads-core'),
          safeCall(windsor('facebook',  apiKey, { fields: ADS_AD_CREATIVE, ...dateParams }, ADDON_MS), 'fb-ads-creative'),
          safeCall(windsor('facebook',  apiKey, { fields: ADS_AD_VIDEO, ...dateParams }, ADDON_MS), 'fb-ads-video'),
          safeCall(windsor('facebook',  apiKey, { fields: ADS_AD_CONV, ...dateParams }, ADDON_MS), 'fb-ads-conv'),
        ]);

        // Merge alle add-on-velden in de ad-core rows op ad_id (allen no-date → 1 rij per ad).
        if (adsAdData && Array.isArray(adsAdData.data)) {
          const mergeById = (src, keys) => {
            if (!src || !Array.isArray(src.data)) return;
            const idx = {};
            for (const r of src.data) if (r.ad_id != null) idx[r.ad_id] = r;
            for (const r of adsAdData.data) {
              const m = idx[r.ad_id];
              if (m) for (const k of keys) if (m[k] != null) r[k] = m[k];
            }
          };
          mergeById(adsCreativeData, [
            'effective_instagram_media__media_type', 'effective_instagram_media__media_product_type', 'object_type',
          ]);
          mergeById(adsVideoData, [
            'video_p25_watched_actions_video_view', 'video_p50_watched_actions_video_view',
            'video_p75_watched_actions_video_view', 'video_p95_watched_actions_video_view',
            'video_p100_watched_actions_video_view', 'video_play_actions_video_view',
          ]);
          mergeById(adsConvData, [
            'actions_purchase', 'actions_omni_purchase', 'action_values_purchase', 'action_values_omni_purchase',
            'actions_lead',
          ]);
        }

        return res.status(200).json({
          period: { startDate, endDate },
          instagram: igData,
          ads: adsData,        // campagne-niveau (trend/KPI + fallback)
          adsAd: adsAdData,    // ad-niveau core (Library per advertentie, indien gelukt)
          // Diagnostiek: per-connector foutmeldingen meesturen i.p.v. stil opslokken.
          errors: {
            instagram: igData && igData.__error ? igData.__error : null,
            ads: adsData && adsData.__error ? adsData.__error : null,
            adsAd: adsAdData && adsAdData.__error ? adsAdData.__error : null,
            // Add-ons falen niet-fataal; tóch meesturen zodat ontbrekende velden te herleiden zijn.
            adsCreative: adsCreativeData && adsCreativeData.__error ? adsCreativeData.__error : null,
            adsVideo: adsVideoData && adsVideoData.__error ? adsVideoData.__error : null,
            adsConv: adsConvData && adsConvData.__error ? adsConvData.__error : null,
          },
        });
      }

      // Veld-ontdekking: vraagt de autoritatieve veldenlijst van een connector op
      // (account-specifiek). Geeft de velden terug die matchen op video/engagement-termen,
      // zodat we de juiste veldnamen kunnen instellen zonder te gokken.
      case 'getFields': {
        const conn = connector || 'facebook';
        const url = `${BASE}/${conn}/fields?api_key=${encodeURIComponent(apiKey)}`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 25000);
        try {
          const r = await fetch(url, { signal: ctrl.signal });
          const text = await r.text();
          let data;
          try { data = JSON.parse(text); } catch { return res.status(200).json({ connector: conn, raw: text.slice(0, 3000) }); }
          const list = Array.isArray(data) ? data
            : (Array.isArray(data.data) ? data.data : (Array.isArray(data.fields) ? data.fields : []));
          // Standaard-filter dekt video/engagement én creative-type-termen (type/format/
          // creative/object/asset/placement/reel/carousel/media). Override via body.filter.
          const rx = filter
            ? new RegExp(filter, 'i')
            : /video|p25|p50|p75|p95|p100|react|comment|share|save|engag|\blike|play|view|watch|type|format|creative|object|asset|placement|reel|carousel|carrousel|media|story/i;
          const matched = list
            .filter(f => rx.test(JSON.stringify(f)))
            .map(f => ({ id: f.id || f.field || f.name, name: f.name || f.label, type: f.type }));
          // Volledige id-lijst meesturen zodat een veld dat de filter mist toch zichtbaar is.
          const allIds = list.map(f => f.id || f.field || f.name).filter(Boolean);
          return res.status(200).json({ connector: conn, total: list.length, matched, allIds });
        } finally { clearTimeout(timer); }
      }

      default:
        return res.status(400).json({ error: `Onbekende action: ${action} (alleen 'getData', 'getDashboard', 'getFields' beschikbaar).` });
    }
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
