const crypto = require('crypto');
const { getClientConfig } = require('./_config');
const { activeChannels, pendingChannels, matchGa4Channel, ga4GroupOf } = require('./_channels');

const SECRET = process.env.AUTH_SECRET;
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

  // Account-ids komen uit de Config-tab van de klantsheet (zie _config.js). De env var
  // CLIENTS.windsor_accounts blijft werken als fallback per connector, zodat klanten
  // één voor één gemigreerd kunnen worden. Beide zijn server-side; het request levert
  // nooit een account-id aan.
  let sheetAccounts = {};
  let clientConfig = null;
  try {
    const { config } = await getClientConfig(clientId);
    clientConfig = config;
    sheetAccounts = config.accounts || {};
  } catch (e) {
    console.error('[windsor] config-tab lezen mislukt:', e.message);
  }
  const scopedAccounts = { ...(client.windsor_accounts || {}), ...sheetAccounts };
  const hasScopeConfig = Object.keys(scopedAccounts).length > 0;

  // Account-scoping: bij een gedeeld Windsor-account (bv. mayday.marketing met meerdere klanten)
  // beperkt `windsor_accounts` per connector tot één account-id, zodat er enkel data van déze
  // klant doorkomt. Niet ingesteld → alle accounts (backward-compatible met per-klant-sleutels).
  //   CLIENTS: "spotto": { "windsor_api_key": "<mayday>", "windsor_accounts": { "instagram": "17841457272403407", "facebook": "1060778095034495" } }
  //
  // LET OP: de Windsor REST-endpoint negeert de `accounts`-queryparam (geverifieerd) — die werkt
  // alleen via de MCP. Daarom vragen we `account_id` op en filteren we server-side. Alleen voor
  // connectors die een account_id-veld hebben (convertkit heeft er geen → single-account, geen filter).
  // Let op: élke connector die in een gedeeld Windsor-account meerdere klanten kan
  // bevatten hoort hier te staan. Ontbreekt hij, dan geldt de fail-closed-regel
  // hieronder niet en zou een niet-geconfigureerde connector álle klanten teruggeven.
  const ACCOUNT_ID_CONNECTORS = new Set([
    'instagram', 'facebook', 'facebook_organic', 'klaviyo', 'mailerlite',
    // ROAS-tab: omzetbron + betaalde kanalen (zie _channels.js).
    'googleanalytics4', 'tiktok', 'google_ads', 'bing', 'linkedin', 'pinterest',
    'snapchat', 'amazon_ads',
  ]);
  // Normaliseer voor vergelijking: string, act_-prefix weg, lowercase.
  const normId = (v) => String(v == null ? '' : v).replace(/^act_/, '').toLowerCase();
  async function windsorScoped(connector, fieldsCsv, params, timeout, label) {
    const sharedMode = hasScopeConfig; // gedeeld Windsor-account (meerdere klanten)
    const wantRaw = scopedAccounts[connector];
    const scopable = ACCOUNT_ID_CONNECTORS.has(connector);
    // Gedeeld account + scopebare connector zonder configuratie → NIET ophalen. Anders zou een
    // niet-geconfigureerde connector alle klanten teruggeven (data-lek). Lege dataset.
    if (sharedMode && scopable && !wantRaw) return { data: [] };
    const scope = !!wantRaw && scopable;
    let fields = fieldsCsv;
    if (scope) {
      // Vraag zowel account_id als account_name op — de configwaarde mag op één van beide matchen.
      // (Meta Ads: account_id = connector-id; Instagram: account_id ≠ connector-id, maar
      //  account_name = de username, dus dáár filteren we op.)
      if (!/(^|,)\s*account_id\s*(,|$)/.test(fields)) fields = 'account_id,' + fields;
      if (!/(^|,)\s*account_name\s*(,|$)/.test(fields)) fields = 'account_name,' + fields;
    }
    const data = await safeCall(windsor(connector, apiKey, { fields, ...params }, timeout), label);
    if (scope && data && Array.isArray(data.data) && data.data.some(r => r && (r.account_id != null || r.account_name != null))) {
      const want = normId(wantRaw);
      data.data = data.data.filter(r => normId(r.account_id) === want || normId(r.account_name) === want);
    }
    return data;
  }

  try {
    switch (action) {

      // Generic data query — pass connector + comma-separated fields + datums.
      // Voorbeeld: { connector: "instagram", fields: "media_id,media_caption,media_reach,timestamp", startDate: "2026-05-04", endDate: "2026-05-11" }
      // Voor schema-ontdekking gebruik Windsor's MCP-tools (get_connectors, get_fields) — niet via REST.
      case 'getData': {
        if (!connector || !fields) return res.status(400).json({ error: 'connector en fields vereist.' });
        const params = {};
        if (startDate) params.date_from = startDate;
        if (endDate) params.date_to = endDate;
        if (datePreset) params.date_preset = datePreset;
        // Via windsorScoped, niet via windsor(): anders zou deze actie bij een gedeelde
        // Windsor-sleutel álle klantaccounts teruggeven. Een `accounts` uit het request
        // wordt bewust genegeerd — scoping komt alleen server-side uit de config.
        const data = await windsorScoped(connector, fields, params, 25000, 'getData');
        if (data && data.__error) return res.status(502).json({ error: data.__error });
        return res.status(200).json(data);
      }

      // Eén-shot dashboard fetch — IG organic + Meta Ads parallel. FB organic komt later
      // zodra we de juiste connector-slug hebben bevestigd.
      case 'getDashboard': {
        if (!startDate || !endDate) return res.status(400).json({ error: 'startDate en endDate vereist.' });
        const dateParams = { date_from: startDate, date_to: endDate };

        // Hobby-interim: Meta's ad-level breakdown is te traag over lange periodes (>55s timeout).
        // Cap daarom het ad-level venster tot de laatste AD_LEVEL_MAX_DAYS; campagne-niveau,
        // KPI's en organic blijven het volledige bereik gebruiken. Bij een definitieve cache/
        // warehouse-pipeline (zie UITVOERINGSLIJST) vervalt deze cap. `adLevelWindow` wordt
        // meegestuurd zodat de UI kan tonen welk venster de advertentie-detail dekt.
        const AD_LEVEL_MAX_DAYS = 35;
        const DAY_MS = 86400000;
        const rangeDays = Math.round((new Date(endDate) - new Date(startDate)) / DAY_MS) + 1;
        let adFrom = startDate;
        if (rangeDays > AD_LEVEL_MAX_DAYS) {
          const d = new Date(endDate);
          d.setDate(d.getDate() - (AD_LEVEL_MAX_DAYS - 1));
          adFrom = d.toISOString().slice(0, 10);
        }
        const adDateParams = { date_from: adFrom, date_to: endDate };
        const adLevelCapped = adFrom !== startDate;

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

        // Facebook Organic (pagina-posts) — geverifieerde veldnamen. reach = post_impressions_unique,
        // shares via post_activity_by_action_type_share, reacties via post_reactions_total.
        const FB_ORG_FIELDS = [
          'post_id', 'post_created_time', 'type', 'post_message', 'permalink_url', 'full_picture',
          'post_impressions', 'post_impressions_unique',
          'post_reactions_total', 'post_comments_total', 'post_activity_by_action_type_share',
          'post_video_views',
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
        const [igData, fbOrgData, adsData, adsAdData, adsCreativeData, adsVideoData, adsConvData] = await Promise.all([
          windsorScoped('instagram', IG_FIELDS, dateParams, FETCH_MS, 'ig'),
          windsorScoped('facebook_organic', FB_ORG_FIELDS, dateParams, FETCH_MS, 'fb-organic'),
          windsorScoped('facebook', ADS_FIELDS, dateParams, FETCH_MS, 'fb-ads'),
          windsorScoped('facebook', ADS_AD_CORE, adDateParams, FETCH_MS, 'fb-ads-core'),
          windsorScoped('facebook', ADS_AD_CREATIVE, adDateParams, ADDON_MS, 'fb-ads-creative'),
          windsorScoped('facebook', ADS_AD_VIDEO, adDateParams, ADDON_MS, 'fb-ads-video'),
          windsorScoped('facebook', ADS_AD_CONV, adDateParams, ADDON_MS, 'fb-ads-conv'),
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
          // Venster dat de ad-level data écht dekt (kan korter zijn dan de selectie, zie cap).
          adLevelWindow: adLevelCapped ? { startDate: adFrom, endDate, maxDays: AD_LEVEL_MAX_DAYS } : null,
          instagram: igData,
          fbOrganic: fbOrgData, // Facebook organic pagina-posts
          ads: adsData,        // campagne-niveau (trend/KPI + fallback)
          adsAd: adsAdData,    // ad-niveau core (Library per advertentie, indien gelukt)
          // Diagnostiek: per-connector foutmeldingen meesturen i.p.v. stil opslokken.
          errors: {
            instagram: igData && igData.__error ? igData.__error : null,
            fbOrganic: fbOrgData && fbOrgData.__error ? fbOrgData.__error : null,
            ads: adsData && adsData.__error ? adsData.__error : null,
            adsAd: adsAdData && adsAdData.__error ? adsAdData.__error : null,
            // Add-ons falen niet-fataal; tóch meesturen zodat ontbrekende velden te herleiden zijn.
            adsCreative: adsCreativeData && adsCreativeData.__error ? adsCreativeData.__error : null,
            adsVideo: adsVideoData && adsVideoData.__error ? adsVideoData.__error : null,
            adsConv: adsConvData && adsConvData.__error ? adsConvData.__error : null,
          },
        });
      }

      // ROAS-tab — blended MER + ROAS per betaald kanaal, opgesplitst naar paid
      // social en paid search. Twee omzetdefinities naast elkaar:
      //   GA4-omzet      → purchase_revenue per session_source_medium (last click,
      //                    één meetlat, telt niet dubbel over kanalen heen)
      //   platform-omzet → wat het kanaal zélf claimt (view-through inbegrepen)
      // Welke kanalen meedoen komt uit de Config-tab (zie _channels.js); een kanaal
      // zonder account-id wordt niet opgehaald en verschijnt als 'niet gekoppeld'.
      case 'getRoas': {
        if (!startDate || !endDate) return res.status(400).json({ error: 'startDate en endDate vereist.' });

        const active = activeChannels(scopedAccounts);
        const pending = pendingChannels(scopedAccounts);
        const hasGa4 = !!scopedAccounts.googleanalytics4;

        // GA4 levert de datum als YYYYMMDD; ad-connectors als YYYY-MM-DD.
        const isoDate = (v) => {
          const d = String(v == null ? '' : v).replace(/[^0-9]/g, '');
          return d.length >= 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : String(v || '');
        };
        const num = (v) => {
          if (v == null || v === '') return 0;
          const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
          return isFinite(n) ? n : 0;
        };
        const rowsOf = (d) => (d && Array.isArray(d.data) ? d.data : []);
        // Eerste veld uit een kandidatenlijst dat in de rij zit. Nodig omdat de
        // omzetveldnaam per connector verschilt en alleen Meta geverifieerd is.
        const pick = (row, keys) => {
          for (const k of keys) if (row[k] != null && row[k] !== '') return num(row[k]);
          return 0;
        };

        // Eén kanaal ophalen op campagne-niveau. De omzet-/conversievelden zijn voor
        // niet-geverifieerde connectors een gok; wijst Windsor er één af (400), dan
        // halen we het kanaal opnieuw op met alleen spend. De GA4-ROAS blijft dan staan,
        // alleen de platform-ROAS ontbreekt — beter dan een leeg kanaal.
        async function fetchChannel(ch, params, timeout) {
          const base = ['date', ch.campaignField, ch.spendField].filter(Boolean);
          const extra = [...ch.revenueFields, ...ch.convFields];
          const full = await windsorScoped(ch.connector, [...base, ...extra].join(','), params, timeout, `roas-${ch.key}`);
          if (!full || !full.__error) return { data: full, degraded: false };
          const minimal = await windsorScoped(ch.connector, base.join(','), params, timeout, `roas-${ch.key}-min`);
          return { data: minimal, degraded: !minimal.__error, firstError: full.__error };
        }

        // Alles voor één periode: GA4-totalen, GA4-uitsplitsing en elk actief kanaal.
        async function buildRange(from, to, timeout) {
          const params = { date_from: from, date_to: to };
          const GA4_TOTALS = 'date,sessions,purchase_revenue,transactions';
          const GA4_SPLIT = 'date,session_default_channel_group,session_source_medium,sessions,purchase_revenue,transactions';

          const [ga4Totals, ga4Split, ...channelResults] = await Promise.all([
            hasGa4 ? windsorScoped('googleanalytics4', GA4_TOTALS, params, timeout, 'roas-ga4-totals') : Promise.resolve({ data: [] }),
            hasGa4 ? windsorScoped('googleanalytics4', GA4_SPLIT, params, timeout, 'roas-ga4-split') : Promise.resolve({ data: [] }),
            ...active.map(ch => fetchChannel(ch, params, timeout)),
          ]);

          const errors = {};
          if (ga4Totals && ga4Totals.__error) errors.ga4Totals = ga4Totals.__error;
          if (ga4Split && ga4Split.__error) errors.ga4Split = ga4Split.__error;

          // Zonder GA4-property (of bij een GA4-fout) is de omzet ONBEKEND, niet nul.
          // Als 0 zou elke ROAS 0,00× worden en zou alles 'uitzetten' krijgen terwijl
          // er simpelweg niets gemeten is. Daarom expliciete vlaggen + null.
          const totalsAvailable = hasGa4 && !errors.ga4Totals;
          const splitAvailable = hasGa4 && !errors.ga4Split;

          // --- Omzet & sessies per dag (alle kanalen samen) ---------------------
          const daily = new Map(); // isoDate -> { date, revenue, sessions, transactions, spend }
          const dayOf = (d) => {
            if (!daily.has(d)) daily.set(d, { date: d, revenue: 0, sessions: 0, transactions: 0, spend: 0 });
            return daily.get(d);
          };
          for (const r of rowsOf(ga4Totals)) {
            const day = dayOf(isoDate(r.date));
            day.revenue += num(r.purchase_revenue);
            day.sessions += num(r.sessions);
            day.transactions += num(r.transactions);
          }

          // --- GA4-omzet per kanaal + restposten per groep ----------------------
          const ga4ByChannel = {};   // channelKey -> { revenue, sessions, transactions }
          const ga4Unmatched = { social: 0, search: 0, other: 0 };
          for (const r of rowsOf(ga4Split)) {
            const revenue = num(r.purchase_revenue);
            const key = matchGa4Channel(r.session_source_medium);
            if (key) {
              const c = (ga4ByChannel[key] = ga4ByChannel[key] || { revenue: 0, sessions: 0, transactions: 0, daily: {} });
              c.revenue += revenue;
              c.sessions += num(r.sessions);
              c.transactions += num(r.transactions);
              const d = isoDate(r.date);
              c.daily[d] = (c.daily[d] || 0) + revenue;
              continue;
            }
            // Geen kanaalmatch: alleen meetellen als de rij in een bétaalde
            // channel group zit — anders is het organisch verkeer.
            const grp = ga4GroupOf(r.session_default_channel_group);
            if (grp) ga4Unmatched[grp] += revenue;
          }

          // --- Spend + platformomzet per kanaal ---------------------------------
          const channels = {};
          active.forEach((ch, i) => {
            const result = channelResults[i] || {};
            const raw = result.data;
            const err = raw && raw.__error ? raw.__error : null;
            const ga4 = ga4ByChannel[ch.key] || { revenue: 0, sessions: 0, transactions: 0, daily: {} };

            const campaigns = new Map();
            const perDay = new Map();
            let spend = 0, platformRevenue = 0, platformConversions = 0;

            for (const r of rowsOf(raw)) {
              const s = num(r[ch.spendField]);
              const rev = pick(r, ch.revenueFields);
              const conv = pick(r, ch.convFields);
              spend += s;
              platformRevenue += rev;
              platformConversions += conv;

              const d = isoDate(r.date);
              const dd = perDay.get(d) || { date: d, spend: 0, platformRevenue: 0 };
              dd.spend += s; dd.platformRevenue += rev;
              perDay.set(d, dd);
              dayOf(d).spend += s;

              const name = String(r[ch.campaignField] || '(onbekend)');
              const c = campaigns.get(name) || { name, spend: 0, platformRevenue: 0, platformConversions: 0 };
              c.spend += s; c.platformRevenue += rev; c.platformConversions += conv;
              campaigns.set(name, c);
            }

            channels[ch.key] = {
              spend,
              platformRevenue,
              platformConversions,
              // Platformomzet ontbreekt als de connector die velden niet kent —
              // dan is null eerlijker dan 0 (0 zou 'geen omzet' suggereren).
              platformRevenueAvailable: !result.degraded && !err,
              ga4Available: splitAvailable,
              ga4Revenue: splitAvailable ? ga4.revenue : null,
              ga4Sessions: splitAvailable ? ga4.sessions : null,
              ga4Transactions: splitAvailable ? ga4.transactions : null,
              daily: Array.from(perDay.values()).sort((a, b) => a.date.localeCompare(b.date)),
              ga4Daily: ga4.daily,
              campaigns: Array.from(campaigns.values()).sort((a, b) => b.spend - a.spend),
              error: err,
              degradedReason: result.degraded ? result.firstError : null,
            };
          });

          // --- Groepstotalen ----------------------------------------------------
          const groups = { social: null, search: null };
          for (const grp of ['social', 'search']) {
            const list = active.filter(c => c.group === grp);
            const g = { spend: 0, ga4Revenue: 0, platformRevenue: 0, platformRevenueAvailable: list.length > 0, ga4Available: splitAvailable, channels: list.map(c => c.key) };
            for (const ch of list) {
              const c = channels[ch.key];
              g.spend += c.spend;
              g.ga4Revenue += (c.ga4Revenue || 0);
              g.platformRevenue += c.platformRevenue;
              if (!c.platformRevenueAvailable) g.platformRevenueAvailable = false;
            }
            if (!splitAvailable) g.ga4Revenue = null;
            g.unmatchedGa4Revenue = splitAvailable ? ga4Unmatched[grp] : null;
            groups[grp] = g;
          }

          const totals = { revenue: 0, sessions: 0, transactions: 0, spend: 0, revenueAvailable: totalsAvailable };
          for (const d of daily.values()) {
            totals.revenue += d.revenue;
            totals.sessions += d.sessions;
            totals.transactions += d.transactions;
            totals.spend += d.spend;
          }
          if (!totalsAvailable) { totals.revenue = null; totals.sessions = null; totals.transactions = null; }

          return {
            window: { startDate: from, endDate: to },
            totals,
            daily: Array.from(daily.values()).sort((a, b) => a.date.localeCompare(b.date)),
            channels,
            groups,
            unmatchedGa4Revenue: ga4Unmatched,
            errors,
          };
        }

        // Huidige periode krijgt het ruime budget; de vergelijkingsperiode een
        // krappere timeout — die is nice-to-have en mag de hoofdcijfers niet ophouden.
        const compareFrom = req.body?.compareStartDate;
        const compareTo = req.body?.compareEndDate;
        const [current, previous] = await Promise.all([
          buildRange(startDate, endDate, 45000),
          (compareFrom && compareTo)
            ? buildRange(compareFrom, compareTo, 30000).catch(e => ({ __error: e.message }))
            : Promise.resolve(null),
        ]);

        return res.status(200).json({
          period: { startDate, endDate },
          comparePeriod: (compareFrom && compareTo) ? { startDate: compareFrom, endDate: compareTo } : null,
          hasGa4,
          // Metadata zodat de frontend geen eigen kopie van de registry nodig heeft.
          channels: active.map(c => ({ key: c.key, label: c.label, group: c.group, connector: c.connector, verified: c.verified })),
          pending: pending.map(c => ({ key: c.key, label: c.label, group: c.group, connector: c.connector })),
          targets: clientConfig?.roasTargets || null,
          roasConfig: clientConfig?.roas || {},
          current,
          previous: previous && previous.__error ? null : previous,
          previousError: previous && previous.__error ? previous.__error : null,
        });
      }

      // E-mail data — ConvertKit (subscribers + broadcasts) of Klaviyo (campagne-performance).
      // Connector wordt automatisch bepaald: expliciet via CLIENTS.email_connector, anders een
      // goedkope probe (klaviyo → convertkit; een 400 "No ... account" betekent niet-gekoppeld).
      // Klaviyo is traag over lange periodes → venster gecapt op de laatste 30 dagen.
      case 'getEmail': {
        if (!startDate || !endDate) return res.status(400).json({ error: 'startDate en endDate vereist.' });
        const DAY_MS = 86400000;
        const FETCH_MS = 55000;

        const candidates = client.email_connector ? [client.email_connector] : ['klaviyo', 'convertkit'];
        let conn = null;
        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i];
          if (i === candidates.length - 1) { conn = c; break; } // laatste kandidaat: aannemen (bespaart een probe)
          const probeField = c === 'klaviyo' ? 'campaign' : 'broadcasts__id';
          const probe = await safeCall(windsor(c, apiKey, { fields: probeField, date_from: endDate, date_to: endDate }, 20000), `email-probe-${c}`);
          if (!probe.__error || !/No .* account/i.test(probe.__error)) { conn = c; break; }
        }
        if (!conn) return res.status(200).json({ connector: null, reason: 'Geen e-mailconnector gekoppeld.' });

        if (conn === 'klaviyo') {
          const EMAIL_MAX_DAYS = 30;
          const rangeDays = Math.round((new Date(endDate) - new Date(startDate)) / DAY_MS) + 1;
          let from = startDate;
          if (rangeDays > EMAIL_MAX_DAYS) {
            const d = new Date(endDate); d.setDate(d.getDate() - (EMAIL_MAX_DAYS - 1));
            from = d.toISOString().slice(0, 10);
          }
          const KLAVIYO_FIELDS = [
            'campaign', 'campaign_id', 'sent_at', 'campaign_report_recipients',
            'campaign_report_open_rate', 'campaign_report_click_rate', 'campaign_report_click_to_open_rate',
            'campaign_report_conversions', 'campaign_report_conversion_value', 'campaign_report_revenue_per_recipient',
            'campaign_report_unsubscribe_rate', 'campaign_report_bounce_rate',
          ].join(',');
          const data = await windsorScoped('klaviyo', KLAVIYO_FIELDS, { date_from: from, date_to: endDate }, FETCH_MS, 'klaviyo');
          return res.status(200).json({
            connector: 'klaviyo',
            window: { startDate: from, endDate, capped: from !== startDate, maxDays: EMAIL_MAX_DAYS },
            campaigns: data,
            errors: { campaigns: data && data.__error ? data.__error : null },
          });
        }

        if (conn === 'mailerlite') {
          // Campagne-stats zitten genest in campaigns__stats (object met sent/opens/clicks/rates).
          const ML_FIELDS = [
            'campaigns__id', 'campaigns__name', 'campaigns__finished_at', 'campaigns__created_at',
            'campaigns__status', 'campaigns__stats',
          ].join(',');
          const data = await windsorScoped('mailerlite', ML_FIELDS, { date_from: startDate, date_to: endDate }, FETCH_MS, 'mailerlite');
          return res.status(200).json({
            connector: 'mailerlite',
            window: { startDate, endDate },
            campaigns: data,
            errors: { campaigns: data && data.__error ? data.__error : null },
          });
        }

        // convertkit — lichtgewicht: broadcasts + subscribers over de volledige periode.
        const [bc, subs] = await Promise.all([
          windsorScoped('convertkit', 'broadcasts__id,broadcasts__subject,broadcasts__created_at', { date_from: startDate, date_to: endDate }, FETCH_MS, 'ck-broadcasts'),
          windsorScoped('convertkit', 'subscribers__id,subscribers__created_at,subscribers__state', { date_from: startDate, date_to: endDate }, FETCH_MS, 'ck-subscribers'),
        ]);
        return res.status(200).json({
          connector: 'convertkit',
          window: { startDate, endDate },
          broadcasts: bc,
          subscribers: subs,
          errors: { broadcasts: bc && bc.__error ? bc.__error : null, subscribers: subs && subs.__error ? subs.__error : null },
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
        return res.status(400).json({ error: `Onbekende action: ${action} (alleen 'getData', 'getDashboard', 'getEmail', 'getFields' beschikbaar).` });
    }
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
