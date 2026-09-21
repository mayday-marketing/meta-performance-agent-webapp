const crypto = require('crypto');
const { getClientConfig, captureOidcToken } = require('./_config');
const { activeChannels, pendingChannels, matchGa4Channel, ga4GroupOf } = require('./_channels');
const { getWebsiteSheetData, getConnectorRows } = require('./_sheetdata');

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
  captureOidcToken(req);   // OIDC-token uit de request-header (zie _config.js)
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
  const apiKey = client?.windsor_api_key || null;

  // Zonder API-sleutel is de datasheet de enige bron. Dat is een geldige toestand
  // (demo- en archiefklanten), maar alleen als er ook écht een datasheet is —
  // anders is er niets om uit te lezen en blijft de oude foutmelding staan.
  const sheetOnly = !apiKey;
  if (sheetOnly && !client?.dataSheetId) {
    return res.status(400).json({ error: 'Geen Windsor-koppeling voor deze klant.' });
  }

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
  //   CLIENTS: "merknaam": { "windsor_api_key": "<mayday>", "windsor_accounts": { "instagram": "17841457272403407", "facebook": "1060778095034495" } }
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
    // Website-tab: organisch zoeken. account_id = de property ('sc-domain:merk.be'
    // of 'https://www.merk.be/'), dus scoping werkt hier net als bij de rest.
    'searchconsole',
  ]);
  // Normaliseer voor vergelijking: string, lowercase, en de voorvoegsels weg die
  // een platform wel toont maar Windsor niet teruggeeft: 'act_' (Meta) en
  // 'sc-domain:' (Search Console — Windsor geeft 'merk.be', Google's UI toont
  // 'sc-domain:merk.be'; zonder deze strip matcht de config nooit en blijft de
  // tab leeg).
  const normId = (v) => String(v == null ? '' : v).replace(/^act_/, '').replace(/^sc-domain:/i, '').toLowerCase();
  async function windsorScoped(connector, fieldsCsv, params, timeout, label) {
    const sharedMode = hasScopeConfig; // gedeeld Windsor-account (meerdere klanten)
    const wantRaw = scopedAccounts[connector];
    const scopable = ACCOUNT_ID_CONNECTORS.has(connector);
    // Gedeeld account + scopebare connector zonder configuratie → NIET ophalen. Anders zou een
    // niet-geconfigureerde connector alle klanten teruggeven (data-lek). Lege dataset.
    if (sharedMode && scopable && !wantRaw) return { data: [] };
    const scope = !!wantRaw && scopable;

    // Sheet-only: de datasheet beantwoordt de vraag, of niemand doet het. Scoping
    // op account-id is hier niet nodig — een datasheet hoort bij één klant, dus
    // de fail-closed-regel hierboven is al gedekt door de sheet zelf.
    if (sheetOnly) {
      const rows = await getConnectorRows(clientId, connector, fieldsCsv, {
        from: params?.date_from, to: params?.date_to,
      }).catch(e => ({ __error: e.message }));
      if (rows) return rows;
      return { data: [], __error: `Geen tab in de datasheet voor ${connector}.` };
    }

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

        // VERGELIJKINGSPERIODE — even lang, direct ervoor. Hij wordt apart
        // opgehaald en alleen voor de KPI-totalen gebruikt: organisch bereik,
        // interacties, publicaties en kliks. Bewust niet op advertentieniveau en
        // zonder de add-ons; die kosten het meest en zeggen over een vorige
        // periode niets wat een totaal niet al zegt.
        //
        // Voor een klant zonder API-sleutel kost dit vrijwel niets: de tabbladen
        // van de datasheet staan dan al in de procescache, dus het is een tweede
        // filter over dezelfde rijen. Voor een API-klant zijn het drie extra
        // aanroepen met een krappere timeout, niet-fataal.
        const spanDays = rangeDays;
        const prevEnd = new Date(`${startDate}T12:00:00Z`);
        prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
        const prevStart = new Date(prevEnd);
        prevStart.setUTCDate(prevStart.getUTCDate() - (spanDays - 1));
        const prevStartDate = prevStart.toISOString().slice(0, 10);
        const prevEndDate = prevEnd.toISOString().slice(0, 10);
        const prevDateParams = { date_from: prevStartDate, date_to: prevEndDate };

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
        const PREV_MS = sheetOnly ? FETCH_MS : 20000;
        const [
          igData, fbOrgData, adsData, adsAdData, adsCreativeData, adsVideoData, adsConvData,
          igPrev, fbOrgPrev, adsPrev,
        ] = await Promise.all([
          windsorScoped('instagram', IG_FIELDS, dateParams, FETCH_MS, 'ig'),
          windsorScoped('facebook_organic', FB_ORG_FIELDS, dateParams, FETCH_MS, 'fb-organic'),
          windsorScoped('facebook', ADS_FIELDS, dateParams, FETCH_MS, 'fb-ads'),
          windsorScoped('facebook', ADS_AD_CORE, adDateParams, FETCH_MS, 'fb-ads-core'),
          windsorScoped('facebook', ADS_AD_CREATIVE, adDateParams, ADDON_MS, 'fb-ads-creative'),
          windsorScoped('facebook', ADS_AD_VIDEO, adDateParams, ADDON_MS, 'fb-ads-video'),
          windsorScoped('facebook', ADS_AD_CONV, adDateParams, ADDON_MS, 'fb-ads-conv'),
          windsorScoped('instagram', IG_FIELDS, prevDateParams, PREV_MS, 'ig-prev'),
          windsorScoped('facebook_organic', FB_ORG_FIELDS, prevDateParams, PREV_MS, 'fb-organic-prev'),
          windsorScoped('facebook', ADS_FIELDS, prevDateParams, PREV_MS, 'fb-ads-prev'),
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

        // Een vergelijkingsblok dat leeg terugkwam sturen we als null mee, niet als
        // een lege lijst: nul gemeten is iets anders dan niets gemeten, en de UI
        // moet dat verschil kunnen tonen.
        const prevOrNull = (d) => (d && Array.isArray(d.data) && d.data.length ? d : null);
        return res.status(200).json({
          period: { startDate, endDate, prevStartDate, prevEndDate },
          previous: {
            instagram: prevOrNull(igPrev),
            fbOrganic: prevOrNull(fbOrgPrev),
            ads: prevOrNull(adsPrev),
          },
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
            // Vergelijking faalt niet-fataal: de huidige periode blijft staan.
            previous: [igPrev, fbOrgPrev, adsPrev].map(d => d && d.__error).filter(Boolean).join(' · ') || null,
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

      // Website-tab — analytics-overzicht van de site zelf: GA4 (verkeer, gedrag,
      // conversie) + Search Console (organisch zoeken). Bewust géén spend of ROAS:
      // dat blijft in de ROAS-tab, anders ontstaan er twee waarheden over dezelfde
      // euro's. Beide bronnen komen uit de Config-tab; een ontbrekende bron is
      // ONBEKEND (null + vlag), nooit nul.
      case 'getWebsite': {
        if (!startDate || !endDate) return res.status(400).json({ error: 'startDate en endDate vereist.' });

        const hasGa4 = !!scopedAccounts.googleanalytics4;
        const hasGsc = !!scopedAccounts.searchconsole;
        const webCfg = (clientConfig && clientConfig.website) || {};
        const goalEvent = webCfg.goalEvent || null;

        // GA4 levert de datum als YYYYMMDD, Search Console als YYYY-MM-DD.
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
        const errOf = (d) => (d && d.__error ? d.__error : null);
        // Deling waarbij een ontbrekende teller/noemer '—' oplevert i.p.v. 0.
        const div = (a, b) => (a != null && b) ? a / b : null;
        const EMPTY = { data: [] };

        // --- Veldsets. Alleen velden die in Windsor's GA4-/Search-Console-schema
        //     staan (geverifieerd via get_fields). Ratio's halen we NIET op:
        //     een gemiddelde over dagen optellen geeft onzin. We rekenen ze uit
        //     de ruwe tellers (engaged/sessions, clicks/impressions).
        // Totalen ZONDER datum: GA4 ontdubbelt gebruikers over de hele periode.
        // Met 'date' erbij telt iemand die op drie dagen langskomt drie keer mee —
        // dat gaf eerder meer nieuwe gebruikers dan gebruikers in totaal.
        const GA4_TOTALS    = 'sessions,totalusers,newusers,engaged_sessions,screen_page_views,user_engagement_duration,conversions,purchase_revenue,transactions';
        // Dagreeks: alléén optelbare maatstaven (sessies, events, omzet). Gebruikers
        // staan hier bewust niet in — zie hierboven.
        const GA4_DAILY     = 'date,sessions,engaged_sessions,screen_page_views,conversions,purchase_revenue,transactions';
        const GA4_CHANNELS  = 'session_default_channel_group,sessions,engaged_sessions,newusers,conversions,purchase_revenue,transactions';
        const GA4_SOURCES   = 'session_source_medium,sessions,engaged_sessions,conversions,purchase_revenue';
        const GA4_LANDING   = 'landing_page,sessions,engaged_sessions,conversions,purchase_revenue';
        const GA4_DEVICES   = 'devicecategory,sessions,engaged_sessions,conversions,purchase_revenue';
        const GA4_COUNTRIES = 'country,sessions,conversions';
        const GA4_RETURNING = 'new_vs_returning,sessions,conversions,purchase_revenue';
        // E-commerce-funnel. item_view_events is item-scoped en combineert niet in
        // elke property met de rest; daarom een minimale fallback (zie fetchFunnel).
        const GA4_FUNNEL     = 'item_view_events,add_to_carts,checkouts,ecommerce_purchases,transactions,purchase_revenue,first_time_purchasers,total_purchasers';
        const GA4_FUNNEL_MIN = 'add_to_carts,checkouts,ecommerce_purchases,transactions,purchase_revenue';
        const GSC_TOTALS    = 'date,clicks,impressions,position';
        const GSC_QUERIES   = 'query,clicks,impressions,position';
        const GSC_PAGES     = 'pagepath,clicks,impressions,position';

        // Het hoofddoel als apart, niet-fataal veld: conversions_<event> bestaat
        // alleen als dat event in déze property een key event is. Zou het in de
        // hoofdcall zitten, dan sloopt één verkeerde eventnaam de hele tab.
        const goalFields = goalEvent
          ? `date,session_default_channel_group,conversions_${goalEvent}`
          : null;

        // Tokens waarop een zoekopdracht als merkgebonden telt: de merknaam uit de
        // Config-tab en het eerste label van de Search-Console-property
        // ('sc-domain:merk.be' → 'merk'). Zonder allebei geen merkopsplitsing —
        // een lege lijst zou alles als niet-merkgebonden bestempelen.
        const brandTokens = (() => {
          const out = new Set();
          const add = (v) => {
            const t = String(v || '').trim().toLowerCase();
            if (t.length >= 3) out.add(t);
          };
          add(clientConfig && clientConfig.brandName);
          const site = scopedAccounts.searchconsole || '';
          const host = String(site).replace(/^sc-domain:/i, '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
          const label = host.split('.')[0];
          add(label);
          if (label.includes('-')) add(label.replace(/-/g, ' '));
          return Array.from(out);
        })();

        async function fetchFunnel(params, timeout) {
          const full = await windsorScoped('googleanalytics4', GA4_FUNNEL, params, timeout, 'web-ga4-funnel');
          if (!full || !full.__error) return { data: full, degraded: false };
          const min = await windsorScoped('googleanalytics4', GA4_FUNNEL_MIN, params, timeout, 'web-ga4-funnel-min');
          return { data: min, degraded: !min.__error, firstError: full.__error };
        }

        // Eén periode ophalen. detail=false (vergelijkingsperiodes) haalt alleen de
        // totalen + kanalen op: die voeden de deltas, de detailtabellen niet.
        // Pagina- en querydata zijn hoog-cardinaal: Windsor levert ze ongeaggregeerd
        // en zónder accountfilter (de REST-endpoint negeert `accounts` en `limit` —
        // geverifieerd), dus we downloaden élke rij van élke klant en filteren pas
        // server-side. Voor een grote site is dat tienduizenden rijen per 10 dagen.
        // Daarom hetzelfde interim-recept als de ad-level-cap in getDashboard: een
        // korter venster voor die calls, en het echte venster mee terug naar de UI.
        const PAGE_LEVEL_MAX_DAYS = 30;
        const DAY_MS = 86400000;

        function pageWindow(from, to) {
          const days = Math.round((new Date(to) - new Date(from)) / DAY_MS) + 1;
          if (days <= PAGE_LEVEL_MAX_DAYS) return { from, to, capped: false };
          const d = new Date(to);
          d.setDate(d.getDate() - (PAGE_LEVEL_MAX_DAYS - 1));
          return { from: d.toISOString().slice(0, 10), to, capped: true };
        }

        async function buildRange(from, to, detail, timeout, sheet) {
          const params = { date_from: from, date_to: to };
          const pw = pageWindow(from, to);
          const pageParams = { date_from: pw.from, date_to: pw.to };
          const ADDON_MS = Math.min(timeout, 25000);
          const ga4 = (f, label, t, p) => (hasGa4 ? windsorScoped('googleanalytics4', f, p || params, t || timeout, label) : Promise.resolve(EMPTY));
          const gsc = (f, label, t, p) => (hasGsc ? windsorScoped('searchconsole', f, p || params, t || timeout, label) : Promise.resolve(EMPTY));

          // Wat de datasheet al levert, halen we niet nog eens op. Een tab die de
          // periode niet dekt of ontbreekt telt hier niet mee; die gaten worden
          // hieronder gewoon live opgehaald. Zo werkt de tab ook voor een klant
          // zonder datasheet precies zoals voorheen.
          const sd = sheet || {};
          const useTotals   = !!sd.totals;
          const useChannels = !!sd.channels;
          const useLanding  = detail && !!sd.landingPages;
          const useSearch   = !!sd.search;
          const useQueries  = detail && !!sd.queries;
          const useSources  = !!sd.sources;
          const skip = Promise.resolve(EMPTY);

          // Bronnen zitten in core en niet bij de add-ons: de tabel toont een
          // verschil met de vorige periode, en daarvoor moet ook de
          // vergelijkingsperiode (detail=false) deze uitsplitsing hebben.
          const core = [
            useTotals ? skip : ga4(GA4_TOTALS, 'web-ga4-totals'),
            useChannels ? skip : ga4(GA4_CHANNELS, 'web-ga4-channels'),
            useSearch ? skip : gsc(GSC_TOTALS, 'web-gsc-totals'),
            useSources ? skip : ga4(GA4_SOURCES, 'web-ga4-sources', ADDON_MS),
          ];
          // Add-ons: krappere timeout en niet-fataal, zodat één trage breakdown de
          // kerncijfers niet meesleurt (zelfde afweging als getDashboard).
          const extras = detail ? [
            useTotals ? skip : ga4(GA4_DAILY, 'web-ga4-daily', ADDON_MS),
            useLanding ? skip : ga4(GA4_LANDING, 'web-ga4-landing', ADDON_MS, pageParams),
            ga4(GA4_DEVICES, 'web-ga4-devices', ADDON_MS),
            ga4(GA4_COUNTRIES, 'web-ga4-countries', ADDON_MS),
            ga4(GA4_RETURNING, 'web-ga4-returning', ADDON_MS),
            hasGa4 ? fetchFunnel(params, ADDON_MS) : Promise.resolve({ data: EMPTY, degraded: false }),
            useQueries ? skip : gsc(GSC_QUERIES, 'web-gsc-queries', ADDON_MS, pageParams),
            gsc(GSC_PAGES, 'web-gsc-pages', ADDON_MS, pageParams),
          ] : [];
          // De doelkolom zit al in de sheet-tabs; dan is deze losse call overbodig.
          const goalCall = (!useTotals && hasGa4 && goalFields)
            ? ga4(goalFields, 'web-ga4-goal', ADDON_MS)
            : Promise.resolve(EMPTY);

          const [totalsRaw, channelsRaw, gscTotalsRaw, sourcesRaw, goalRaw, ...rest] =
            await Promise.all([...core, goalCall, ...extras]);
          const [dailyRaw, landingRaw, devicesRaw, countriesRaw, returningRaw, funnelRes, queriesRaw, gscPagesRaw] = rest;

          const errors = {};
          if (errOf(totalsRaw)) errors.ga4Totals = errOf(totalsRaw);
          if (errOf(channelsRaw)) errors.ga4Channels = errOf(channelsRaw);
          if (errOf(gscTotalsRaw)) errors.gscTotals = errOf(gscTotalsRaw);
          if (errOf(goalRaw)) errors.ga4Goal = errOf(goalRaw);
          if (errOf(sourcesRaw)) errors.ga4Sources = errOf(sourcesRaw);
          // Add-ons falen niet-fataal, maar stil falen mag niet: een lege tabel
          // moet te herleiden zijn tot een timeout i.p.v. op 'geen data' lijken.
          if (detail) {
            for (const [k, raw] of [['ga4Sources', sourcesRaw], ['ga4Landing', landingRaw],
              ['ga4Devices', devicesRaw], ['ga4Countries', countriesRaw], ['ga4Returning', returningRaw]]) {
              if (errOf(raw)) errors[k] = errOf(raw);
            }
          }

          const ga4Available = useTotals || (hasGa4 && !errors.ga4Totals);
          const gscAvailable = useSearch || (hasGsc && !errors.gscTotals);
          // Het doelveld bestaat alleen als het event in deze property een key event
          // is. Lukt het niet, dan valt de tab terug op 'conversions' (álle key
          // events samen) — met een vlag, want dat is een ander cijfer.
          const goalKey = goalEvent ? `conversions_${goalEvent}` : null;
          const goalAvailable = useTotals
            ? (sd.totals.goalConversions != null)
            : !!(goalKey && !errors.ga4Goal && rowsOf(goalRaw).some(r => r[goalKey] != null));

          // --- Doelconversies per dag en per kanaal ----------------------------
          const goalByDate = {}, goalByChannel = {};
          if (goalAvailable) {
            for (const r of rowsOf(goalRaw)) {
              const v = num(r[goalKey]);
              const d = isoDate(r.date);
              goalByDate[d] = (goalByDate[d] || 0) + v;
              const ch = String(r.session_default_channel_group || '(onbekend)');
              goalByChannel[ch] = (goalByChannel[ch] || 0) + v;
            }
          }

          // --- Dagreeks (GA4) — alleen optelbare maatstaven ----------------------
          const daily = new Map();
          for (const r of rowsOf(detail ? dailyRaw : { data: [] })) {
            const d = isoDate(r.date);
            const cur = daily.get(d) || { date: d, sessions: 0, engagedSessions: 0, pageViews: 0, conversions: 0, revenue: 0, transactions: 0 };
            cur.sessions += num(r.sessions);
            cur.engagedSessions += num(r.engaged_sessions);
            cur.pageViews += num(r.screen_page_views);
            cur.conversions += num(r.conversions);
            cur.revenue += num(r.purchase_revenue);
            cur.transactions += num(r.transactions);
            daily.set(d, cur);
          }
          for (const [d, v] of Object.entries(goalByDate)) {
            const cur = daily.get(d);
            if (cur) cur.goal = v;
          }

          // --- Totalen ----------------------------------------------------------
          const t = { sessions: 0, users: 0, newUsers: 0, engagedSessions: 0, pageViews: 0, engagementTime: 0, conversions: 0, revenue: 0, transactions: 0 };
          for (const r of rowsOf(totalsRaw)) {
            t.sessions += num(r.sessions);
            t.users += num(r.totalusers);
            t.newUsers += num(r.newusers);
            t.engagedSessions += num(r.engaged_sessions);
            t.pageViews += num(r.screen_page_views);
            t.engagementTime += num(r.user_engagement_duration);
            t.conversions += num(r.conversions);
            t.revenue += num(r.purchase_revenue);
            t.transactions += num(r.transactions);
          }
          const goalTotal = goalAvailable
            ? Object.values(goalByDate).reduce((s, v) => s + v, 0)
            : null;

          const totalsLive = ga4Available ? {
            available: true,
            sessions: t.sessions,
            users: t.users,
            newUsers: t.newUsers,
            // GA4 haalt 'gebruikers' en 'nieuwe gebruikers' uit verschillende
            // aggregaties; bij lage volumes kan nieuw gróter zijn dan totaal
            // (gemeten: 15 nieuw op 10 gebruikers). Dan is het aandeel onzin en
            // geven we null i.p.v. een afgekapte 100%. De echte nieuw/terugkerend-
            // verdeling staat in newVsReturning, op sessies — die is wél consistent.
            newUserShare: (t.users > 0 && t.newUsers <= t.users) ? t.newUsers / t.users : null,
            engagedSessions: t.engagedSessions,
            pageViews: t.pageViews,
            engagementRate: div(t.engagedSessions, t.sessions),
            avgEngagementTime: div(t.engagementTime, t.sessions),
            pagesPerSession: div(t.pageViews, t.sessions),
            conversions: t.conversions,
            conversionRate: div(t.conversions, t.sessions),
            goalConversions: goalTotal,
            goalConversionRate: goalAvailable ? div(goalTotal, t.sessions) : null,
            revenue: t.revenue,
            transactions: t.transactions,
            aov: div(t.revenue, t.transactions),
            revenuePerSession: div(t.revenue, t.sessions),
          } : {
            available: false,
            sessions: null, users: null, newUsers: null, newUserShare: null,
            engagedSessions: null, pageViews: null, engagementRate: null,
            avgEngagementTime: null, pagesPerSession: null, conversions: null,
            conversionRate: null, goalConversions: null, goalConversionRate: null,
            revenue: null, transactions: null, aov: null, revenuePerSession: null,
          };
          // De sheet wint als hij de periode dekt; anders het live opgehaalde blok.
          const totals = useTotals ? sd.totals : totalsLive;

          // --- Kanaalgroepen ----------------------------------------------------
          const chMap = new Map();
          for (const r of rowsOf(channelsRaw)) {
            const name = String(r.session_default_channel_group || '(onbekend)');
            const c = chMap.get(name) || { channel: name, sessions: 0, engagedSessions: 0, newUsers: 0, conversions: 0, revenue: 0, transactions: 0 };
            c.sessions += num(r.sessions);
            c.engagedSessions += num(r.engaged_sessions);
            c.newUsers += num(r.newusers);
            c.conversions += num(r.conversions);
            c.revenue += num(r.purchase_revenue);
            c.transactions += num(r.transactions);
            chMap.set(name, c);
          }
          const channelsLive = Array.from(chMap.values()).map(c => ({
            ...c,
            goalConversions: goalAvailable ? (goalByChannel[c.channel] || 0) : null,
            engagementRate: div(c.engagedSessions, c.sessions),
            conversionRate: div(goalAvailable ? (goalByChannel[c.channel] || 0) : c.conversions, c.sessions),
            revenuePerSession: div(c.revenue, c.sessions),
          })).sort((a, b) => b.sessions - a.sessions);
          const channels = useChannels ? sd.channels : channelsLive;

          // --- Search Console: totalen + dagreeks --------------------------------
          let sClicks = 0, sImpr = 0, sPosWeighted = 0;
          const searchDaily = new Map();
          for (const r of rowsOf(gscTotalsRaw)) {
            const clicks = num(r.clicks), impr = num(r.impressions), pos = num(r.position);
            sClicks += clicks; sImpr += impr; sPosWeighted += pos * impr;
            const d = isoDate(r.date);
            const cur = searchDaily.get(d) || { date: d, clicks: 0, impressions: 0, posWeighted: 0 };
            cur.clicks += clicks; cur.impressions += impr; cur.posWeighted += pos * impr;
            searchDaily.set(d, cur);
          }
          // Nul rijen over een hele periode betekent in de praktijk een verkeerde
          // property in de Config-tab, niet 'nul kliks'. Dan liever '—' tonen dan
          // een nul die als meting leest.
          // Alleen alarm slaan als die call ook écht gedaan is: komt het zoekblok
          // uit de datasheet, dan is `gscTotalsRaw` leeg omdat we hem oversloegen,
          // niet omdat Google niets teruggaf.
          const gscRows = rowsOf(gscTotalsRaw).length;
          if (gscAvailable && !useSearch && !gscRows) errors.gscEmpty = 'Search Console leverde geen rijen — controleer de property in de Config-tab.';
          const searchLive = (gscAvailable && gscRows) ? {
            available: true,
            clicks: sClicks,
            impressions: sImpr,
            // CTR en positie zijn ratio's: optellen mag niet. CTR uit de tellers,
            // positie gewogen naar impressies (anders telt een query met 3 vertoningen
            // even zwaar als één met 30.000).
            ctr: div(sClicks, sImpr),
            position: div(sPosWeighted, sImpr),
          } : { available: false, clicks: null, impressions: null, ctr: null, position: null };
          const search = useSearch ? sd.search : searchLive;

          // Bronnen worden voor élke periode berekend (ook de vergelijking), zodat
          // de tabel per cijfer een verschil kan tonen.
          const sourcesTable = useSources ? sd.sources : (() => {
            const m = new Map();
            for (const r of rowsOf(sourcesRaw)) {
              const k = String(r.session_source_medium || '(onbekend)');
              const c = m.get(k) || { source: k, sessions: 0, engagedSessions: 0, conversions: 0, revenue: 0 };
              c.sessions += num(r.sessions);
              c.engagedSessions += num(r.engaged_sessions);
              c.conversions += num(r.conversions);
              c.revenue += num(r.purchase_revenue);
              m.set(k, c);
            }
            return Array.from(m.values()).sort((a, b) => b.sessions - a.sessions).slice(0, 60)
              .map(c => ({ source: c.source, sessions: c.sessions, engagementRate: div(c.engagedSessions, c.sessions), conversions: c.conversions, revenue: c.revenue }));
          })();

          const out = {
            window: { startDate: from, endDate: to },
            // Venster dat de pagina-/querytabellen écht dekken (kan korter zijn dan
            // de selectie, zie PAGE_LEVEL_MAX_DAYS). null = gelijk aan de periode.
            pageLevelWindow: (detail && pw.capped) ? { startDate: pw.from, endDate: pw.to, maxDays: PAGE_LEVEL_MAX_DAYS } : null,
            ga4Available,
            gscAvailable: gscAvailable && !!gscRows,
            goalAvailable,
            totals,
            channels,
            search,
            sources: sourcesTable,
            daily: useTotals
              ? (sd.daily || [])
              : Array.from(daily.values()).sort((a, b) => a.date.localeCompare(b.date)),
            searchDaily: useSearch
              ? (sd.searchDaily || [])
              : Array.from(searchDaily.values())
                  .map(d => ({ date: d.date, clicks: d.clicks, impressions: d.impressions, position: div(d.posWeighted, d.impressions) }))
                  .sort((a, b) => a.date.localeCompare(b.date)),
            // Per blok: kwam dit uit de datasheet of live uit Windsor? De voetnoot
            // in de UI toont dat, zodat een afwijkend cijfer te herleiden is.
            origin: {
              totals: useTotals ? 'sheet' : 'api',
              channels: useChannels ? 'sheet' : 'api',
              landingPages: useLanding ? 'sheet' : 'api',
              sources: useSources ? 'sheet' : 'api',
              search: useSearch ? 'sheet' : 'api',
              queries: useQueries ? 'sheet' : 'api',
            },
            sheetCoverage: sd.coverage || null,
            sheetWarnings: sd.warnings && sd.warnings.length ? sd.warnings : null,
            errors,
          };
          if (!detail) return out;

          // --- Detailtabellen (alleen huidige periode) ---------------------------
          // Windsor levert normaal één rij per dimensiewaarde, maar dat is niet
          // gegarandeerd. Daarom altijd optellen op de dimensie i.p.v. de rijen
          // rechtstreeks tonen — anders staat dezelfde pagina twee keer in de lijst.
          const group = (rows, keyOf, add) => {
            const m = new Map();
            for (const r of rows) {
              const k = keyOf(r);
              let cur = m.get(k);
              if (!cur) { cur = { key: k, sessions: 0, engagedSessions: 0, conversions: 0, revenue: 0, views: 0, engagementTime: 0 }; m.set(k, cur); }
              add(cur, r);
            }
            return Array.from(m.values());
          };
          const addSession = (cur, r) => {
            cur.sessions += num(r.sessions);
            cur.engagedSessions += num(r.engaged_sessions);
            cur.conversions += num(r.conversions);
            cur.revenue += num(r.purchase_revenue);
          };
          const bySessions = (a, b) => b.sessions - a.sessions;

          out.landingPages = useLanding ? sd.landingPages : group(rowsOf(landingRaw), r => String(r.landing_page || '(onbekend)'), addSession)
            .sort(bySessions).slice(0, 200)
            .map(c => ({ page: c.key, sessions: c.sessions, engagementRate: div(c.engagedSessions, c.sessions), conversions: c.conversions, conversionRate: div(c.conversions, c.sessions), revenue: c.revenue }));
          // pageLevelWindow geldt alleen voor de live variant: de sheet dekt de
          // hele periode, anders was hij hierboven afgekeurd.
          if (useLanding) out.pageLevelWindow = null;

          out.devices = group(rowsOf(devicesRaw), r => String(r.devicecategory || '(onbekend)'), addSession)
            .sort(bySessions)
            .map(c => ({ device: c.key, sessions: c.sessions, engagementRate: div(c.engagedSessions, c.sessions), conversions: c.conversions, conversionRate: div(c.conversions, c.sessions), revenue: c.revenue }));

          out.countries = group(rowsOf(countriesRaw), r => String(r.country || '(onbekend)'), addSession)
            .sort(bySessions).slice(0, 8)
            .map(c => ({ country: c.key, sessions: c.sessions, conversions: c.conversions }));

          out.newVsReturning = group(rowsOf(returningRaw), r => String(r.new_vs_returning || '(onbekend)'), addSession)
            .sort(bySessions)
            .map(c => ({ group: c.key, sessions: c.sessions, conversions: c.conversions, revenue: c.revenue }));

          // E-commerce-funnel. Ontbreekt de call, dan is de funnel ONBEKEND:
          // nullen zouden 'niemand legt iets in de winkelmand' suggereren.
          const funnelRaw = funnelRes && funnelRes.data;
          const funnelErr = errOf(funnelRaw);
          if (funnelErr) errors.ga4Funnel = funnelErr;
          if (funnelRes && funnelRes.degraded) errors.ga4FunnelDegraded = funnelRes.firstError;
          const f = { itemViews: 0, addToCarts: 0, checkouts: 0, purchases: 0, transactions: 0, revenue: 0, firstTimePurchasers: 0, purchasers: 0 };
          let funnelRows = 0;
          for (const r of rowsOf(funnelRaw)) {
            funnelRows++;
            f.itemViews += num(r.item_view_events);
            f.addToCarts += num(r.add_to_carts);
            f.checkouts += num(r.checkouts);
            f.purchases += num(r.ecommerce_purchases);
            f.transactions += num(r.transactions);
            f.revenue += num(r.purchase_revenue);
            f.firstTimePurchasers += num(r.first_time_purchasers);
            f.purchasers += num(r.total_purchasers);
          }
          out.funnel = (!funnelErr && funnelRows) ? {
            available: true,
            itemViews: (funnelRes && funnelRes.degraded) ? null : f.itemViews,
            addToCarts: f.addToCarts,
            checkouts: f.checkouts,
            purchases: f.purchases,
            revenue: f.revenue,
            firstTimePurchasers: (funnelRes && funnelRes.degraded) ? null : f.firstTimePurchasers,
            purchasers: (funnelRes && funnelRes.degraded) ? null : f.purchasers,
            cartRate: div(f.addToCarts, f.itemViews || null),
            checkoutRate: div(f.checkouts, f.addToCarts || null),
            purchaseRate: div(f.purchases, f.checkouts || null),
            aov: div(f.revenue, f.transactions || null),
          } : { available: false };

          // --- Search Console: queries, pagina's, branded ------------------------
          if (errOf(queriesRaw)) errors.gscQueries = errOf(queriesRaw);
          if (errOf(gscPagesRaw)) errors.gscPages = errOf(gscPagesRaw);

          const qMap = new Map();
          for (const r of rowsOf(queriesRaw)) {
            const q = String(r.query || '(onbekend)');
            const cur = qMap.get(q) || { query: q, clicks: 0, impressions: 0, posWeighted: 0 };
            cur.clicks += num(r.clicks);
            cur.impressions += num(r.impressions);
            cur.posWeighted += num(r.position) * num(r.impressions);
            qMap.set(q, cur);
          }
          const queries = Array.from(qMap.values()).map(q => ({
            query: q.query,
            clicks: q.clicks,
            impressions: q.impressions,
            ctr: div(q.clicks, q.impressions),
            position: div(q.posWeighted, q.impressions),
          }));
          out.queries = useQueries ? sd.queries.top : [...queries].sort((a, b) => b.clicks - a.clicks).slice(0, 15);
          // Quick wins: net buiten de eerste pagina (positie 8–20) met genoeg
          // vertoningen om iets te winnen. Dit is de lijst waar SEO-werk begint.
          out.quickWins = useQueries ? sd.queries.quickWins : queries
            .filter(q => q.position != null && q.position >= 8 && q.position <= 20 && q.impressions >= 50)
            .sort((a, b) => b.impressions - a.impressions)
            .slice(0, 10);

          const pMap = new Map();
          for (const r of rowsOf(gscPagesRaw)) {
            // Een lege pagepath is de homepage (Search Console geeft daar '' terug),
            // niet een onbekende pagina.
            const p = r.pagepath == null || r.pagepath === '' ? '/' : String(r.pagepath);
            const cur = pMap.get(p) || { page: p, clicks: 0, impressions: 0, posWeighted: 0 };
            cur.clicks += num(r.clicks);
            cur.impressions += num(r.impressions);
            cur.posWeighted += num(r.position) * num(r.impressions);
            pMap.set(p, cur);
          }
          out.searchPages = Array.from(pMap.values())
            .map(p => ({ page: p.page, clicks: p.clicks, impressions: p.impressions, ctr: div(p.clicks, p.impressions), position: div(p.posWeighted, p.impressions) }))
            .sort((a, b) => b.clicks - a.clicks).slice(0, 15);

          // Merkgebonden vs. niet-merkgebonden rekenen we zélf uit de querytabel.
          // Windsor heeft een veld branded_vs_nonbranded, maar dat markeert alleen
          // queries waar de volledige domeinnaam in staat: voor merk.be telde
          // 'merk' (2.852 kliks) daar als niet-merkgebonden. Met de merknaam als
          // token klopt het wél, en de regel is uitlegbaar aan de klant.
          const split = { branded: { clicks: 0, impressions: 0 }, nonbranded: { clicks: 0, impressions: 0 } };
          // Rekenen over de volledige lijst, niet over de getoonde top 15 — en dus
          // over de sheetlijst zodra die gebruikt wordt.
          const brandedSource = useQueries ? (sd.queries.all || []) : queries;
          if (brandTokens.length) {
            for (const q of brandedSource) {
              // Search Console levert af en toe een rij zonder querytekst (bij ons
              // 2 op de 60.000). Die zijn niet te classificeren: ze overslaan is
              // eerlijker dan ze als niet-merkgebonden meetellen — en zonder deze
              // controle liet één lege cel de hele Website-tab crashen.
              if (q == null || q.query == null || q.query === '') continue;
              const hay = String(q.query).toLowerCase();
              const bucket = brandTokens.some(t => hay.includes(t)) ? split.branded : split.nonbranded;
              bucket.clicks += q.clicks;
              bucket.impressions += q.impressions;
            }
          }
          out.branded = brandTokens.length ? {
            tokens: brandTokens,
            branded: { ...split.branded, ctr: div(split.branded.clicks, split.branded.impressions) },
            nonbranded: { ...split.nonbranded, ctr: div(split.nonbranded.clicks, split.nonbranded.impressions) },
          } : null;

          return out;
        }

        // Twee vergelijkingsperiodes: dezelfde lengte direct ervoor, en dezelfde
        // dagen vorig jaar. Allebei alleen de totalen + kanalen (detail=false) —
        // ze voeden de deltas, niet de tabellen. Falen mag niet fataal zijn.
        const prevFrom = req.body?.compareStartDate;
        const prevTo = req.body?.compareEndDate;
        const yoyFrom = req.body?.yearAgoStartDate;
        const yoyTo = req.body?.yearAgoEndDate;
        // 35s i.p.v. krapper: een koude Search-Console-call duurt bij Windsor ~28s
        // (warm ~1s, hij cachet per periode). Met een krappe timeout zou de
        // vergelijking bij het eerste bezoek structureel wegvallen.
        const compare = (from, to, sheet) => ((from && to)
          ? buildRange(from, to, false, 35000, sheet).catch(e => ({ __error: e.message }))
          : Promise.resolve(null));

        // Datasheet eerst. De module cachet de ruwe tabrijen per klant, dus de
        // twee vergelijkingsperiodes kosten geen extra leesactie — ze filteren
        // dezelfde rijen op een ander datumbereik. Faalt het lezen, dan is `null`
        // gewoon 'geen sheet' en haalt buildRange alles live op.
        const loadSheet = async (from, to) => {
          try { return await getWebsiteSheetData(clientId, from, to); }
          catch (e) { console.error('[windsor] datasheet lezen mislukt:', e.message); return null; }
        };
        const sheetCur = await loadSheet(startDate, endDate);
        const [sheetPrev, sheetYoy] = await Promise.all([
          (prevFrom && prevTo) ? loadSheet(prevFrom, prevTo) : Promise.resolve(null),
          (yoyFrom && yoyTo) ? loadSheet(yoyFrom, yoyTo) : Promise.resolve(null),
        ]);

        const [current, previous, yearAgo] = await Promise.all([
          buildRange(startDate, endDate, true, 45000, sheetCur),
          compare(prevFrom, prevTo, sheetPrev),
          compare(yoyFrom, yoyTo, sheetYoy),
        ]);

        // Websitetype bepaalt welk funnelblok de UI toont. Staat het niet in de
        // Config-tab, dan leiden we het af: gemeten omzet = webshop.
        const measuredRevenue = (current.totals && current.totals.revenue) || 0;
        const type = webCfg.type || (measuredRevenue > 0 ? 'webshop' : 'leads');

        return res.status(200).json({
          period: { startDate, endDate },
          comparePeriod: (prevFrom && prevTo) ? { startDate: prevFrom, endDate: prevTo } : null,
          yearAgoPeriod: (yoyFrom && yoyTo) ? { startDate: yoyFrom, endDate: yoyTo } : null,
          hasGa4,
          hasGsc,
          // Heeft deze klant een datasheet, en werd die ook echt gebruikt?
          dataSheet: {
            configured: !!(sheetCur && sheetCur.sheetId),
            used: !!(sheetCur && sheetCur.available),
            tabs: sheetCur ? sheetCur.tabs : null,
            warnings: sheetCur && sheetCur.warnings.length ? sheetCur.warnings : null,
          },
          website: {
            type,
            typeSource: webCfg.type ? 'config' : 'afgeleid',
            goalEvent,
            goalLabel: webCfg.goalLabel || null,
            goalAvailable: current.goalAvailable,
          },
          current,
          previous: previous && previous.__error ? null : previous,
          previousError: previous && previous.__error ? previous.__error : null,
          yearAgo: yearAgo && yearAgo.__error ? null : yearAgo,
          yearAgoError: yearAgo && yearAgo.__error ? yearAgo.__error : null,
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
          if (sheetOnly) { conn = c; break; }   // geen sleutel → geen probe; de sheet beslist
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
        return res.status(400).json({ error: `Onbekende action: ${action} (alleen 'getData', 'getDashboard', 'getRoas', 'getWebsite', 'getEmail', 'getFields' beschikbaar).` });
    }
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
