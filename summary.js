/* ==========================================================
   summary.js — gedeelde rekenlaag voor dashboard én MCP-koppeling
   ==========================================================
   Eén bestand, twee afnemers:
     - de browser laadt het vóór app.js en krijgt `window.Summary`;
     - api/mcp.js doet require('../summary.js') en rekent server-side precies
       hetzelfde uit.
   Zo kan een strategisch gesprek in Claude nooit een ander cijfer noemen dan
   het dashboard: normalisatie, classifiers, KPI's, drempels en oordelen
   bestaan maar één keer.

   Regels voor wie hier iets toevoegt:
     - Geen DOM, geen `state`, geen fetch. Alles wat een functie nodig heeft
       komt binnen als argument; app.js heeft dunne wrappers die `state`
       doorgeven.
     - Onbekend blijft null, nooit 0 (zie CLAUDE.md).
     - Tijdzone: de server draait in UTC, de browser in de tijdzone van de
       gebruiker. Weekindelingen en 'gisteren' kunnen daardoor rond middernacht
       een dag verschillen; totalen niet.
   ========================================================== */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Summary = api;
})(typeof self !== "undefined" ? self : this, function () {

  // Datumhulpjes voor goalRange (dezelfde definities als in app.js).
  const pad2 = (n) => String(n).padStart(2, "0");
  const ymd = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;
  const lastDayOf = (y, m) => new Date(y, m + 1, 0).getDate();
  const webAtNoon = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d, 12); };

  const fmt = {
    int: (n) => Math.round(n).toLocaleString("nl-NL"),
    k: (n) => {
      if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
      return String(Math.round(n));
    },
    pct: (n) => n.toFixed(1) + "%",
    dateNL: (d) => d.toLocaleDateString("nl-NL", { day: "numeric", month: "short" }),
    dateISO: (d) => d.toISOString().slice(0, 10),
  };

  function safeUrl(s) {
    // Block javascript:, data: (except images), and weird schemes.
    if (!s) return "";
    const lower = s.toLowerCase().trim();
    if (lower.startsWith("javascript:") || lower.startsWith("vbscript:")) return "";
    return s.replace(/["'<>]/g, "");
  }

  const TYPE_LABELS = {
    FEED_CAROUSEL_ALBUM: "Carrousel",
    CAROUSEL_ALBUM: "Carrousel",
    CAROUSEL: "Carrousel",
    GRAPH_IMAGE: "Foto",
    IMAGE: "Foto",
    PHOTO: "Foto",
    GRAPH_VIDEO: "Video",
    VIDEO: "Video",
    REELS: "Reel",
    REEL: "Reel",
    STORY: "Story",
    STATUS: "Status",
    LINK: "Link",
    SHARE: "Share",
    EVENT: "Event",
  };

  function friendlyType(raw, fallback) {
    if (!raw) return fallback;
    const k = String(raw).toUpperCase();
    return TYPE_LABELS[k] || fallback;
  }

  function aggregatePosts(posts) {
    return posts.reduce((acc, p) => {
      acc.reach += p.reach || 0;
      acc.clicks += p.clicks || 0;
      acc.interactions += p.interactions || 0;
      acc.count += 1;
      return acc;
    }, { reach: 0, clicks: 0, interactions: 0, count: 0 });
  }

  function arrayOrEmpty(x) { return Array.isArray(x) ? x : []; }

  /* ---------- Benchmark per post ----------
     Geen oordeel, geen gewogen formule: één maatstaf per post tegenover het
     gemiddelde van dezelfde groep in de gekozen periode. De groepen zijn de
     kanaaltabs (IG posts, IG reels, FB posts, FB reels, advertenties), zodat
     een reel nooit tegen een foto wordt gelegd en de kolom hetzelfde gemiddelde
     gebruikt als de rij 'Gemiddelde' bovenaan de tabel.
     - Organisch: engagement rate (interacties / bereik).
     - Advertenties: ROAS zodra de set aankopen heeft, anders CTR.
     Het gemiddelde is dat van de posts zelf (elke post telt één keer), niet
     interacties/bereik over de hele groep: anders bepaalt één virale post de
     lat. Onder 3 posts met een waarde is er geen benchmark (null, geen 0). */
  const BENCH_MIN_N = 3;
  const GROUP_LABELS = {
    "ig-posts": "Instagram posts", "ig-reels": "Instagram reels",
    "fb-posts": "Facebook posts", "fb-reels": "Facebook reels",
    ads: "advertenties", other: "overige posts",
  };

  // Zelfde indeling als de kanaaltabs in de bibliotheek (librarySourceOf in app.js).
  function postGroupOf(post) {
    if (post.platform === "ig") return post.type === "Reel" ? "ig-reels" : "ig-posts";
    if (post.platform === "fb") {
      const video = post.type === "Reel" || post.type === "Video" || /video|reel/i.test(post.kind || "");
      return video ? "fb-reels" : "fb-posts";
    }
    if (post.platform === "ads") return "ads";
    return "other";
  }

  function benchmarkPosts(list) {
    const groups = {};
    for (const p of list || []) {
      if (!p) continue;
      (groups[postGroupOf(p)] = groups[postGroupOf(p)] || []).push(p);
    }
    for (const [key, posts] of Object.entries(groups)) {
      let metric, label, valueOf;
      if (key === "ads") {
        const roas = posts.some(a => (a.purchases || 0) > 0);
        metric = roas ? "roas" : "ctr";
        label = roas ? "ROAS" : "CTR";
        valueOf = roas ? (a => (a.spend > 0 && a.roas != null) ? a.roas : null)
                       : (a => (a.impressions > 0) ? (a.ctr || 0) : null);
      } else {
        metric = "engagement"; label = "Engagement";
        valueOf = (p => (p.reach > 0) ? (p.engagement || 0) : null);
      }
      const vals = posts.map(valueOf);
      const known = vals.filter(v => v != null);
      const avg = known.length ? known.reduce((a, v) => a + v, 0) / known.length : null;
      const ok = known.length >= BENCH_MIN_N && avg > 0;
      posts.forEach((p, i) => {
        const v = vals[i];
        p.benchIndex = (ok && v != null) ? +(v / avg).toFixed(3) : null;
        p.bench = { group: key, groupLabel: GROUP_LABELS[key] || key, metric, label,
                    value: v, avg: ok ? avg : null, n: known.length };
      });
    }
    return list;
  }

  function normalizeWindsorIgPost(raw) {
    if (!raw || typeof raw !== "object") return null;
    const date = raw.timestamp ? new Date(raw.timestamp) : null;
    const reach = Number(raw.media_reach) || 0;
    const likes = Number(raw.media_like_count) || 0;
    const comments = Number(raw.media_comments_count) || 0;
    const shares = Number(raw.media_shares) || 0;
    const saves = Number(raw.media_saved) || 0;
    const views = Number(raw.media_views) || 0;
    const engagementFromApi = Number(raw.media_engagement) || 0;
    const interactions = engagementFromApi || (likes + comments + shares + saves);
    const engagement = reach ? (interactions / reach) * 100 : 0;
    const captionRaw = typeof raw.media_caption === "string" ? raw.media_caption : "";
    const caption = captionRaw ? captionRaw.replace(/\s+/g, " ").trim() : "—";
    const rawType = raw.media_product_type || raw.media_type;
    const type = friendlyType(rawType, "Post");
    // Windsor levert reel-kijktijd in milliseconden → omzetten naar seconden.
    const avgWatchTime = Number(raw.media_reel_avg_watch_time) > 0
      ? Number(raw.media_reel_avg_watch_time) / 1000
      : 0;
    return {
      id: String(raw.media_id || `ig-${raw.timestamp || Math.random()}`),
      platform: "ig",
      type,
      date,
      dateLabel: date ? fmt.dateNL(date) : "—",
      startMs: 0, stopMs: 0,
      reach, impressions: views, likes, comments, shares, saves,
      clicks: 0, views,
      interactions, engagement, ctr: 0,
      avgWatchTime,
      caption,
      thumb: typeof raw.media_thumbnail_url === "string" ? raw.media_thumbnail_url
           : typeof raw.media_url === "string" ? raw.media_url : "",
      url: typeof raw.media_permalink === "string" ? raw.media_permalink : "",
    };
  }

  // Facebook Organic pagina-post → post-shape. reach = post_impressions_unique, reacties/comments/
  // shares uit de geverifieerde FB-organic velden. FB heeft geen "saves".
  function normalizeWindsorFbPost(raw) {
    if (!raw || typeof raw !== "object") return null;
    const date = raw.post_created_time ? new Date(raw.post_created_time) : null;
    const reach = Number(raw.post_impressions_unique) || 0;
    const impressions = Number(raw.post_impressions) || 0;
    const likes = Number(raw.post_reactions_total) || 0;   // alle reacties (like/love/…)
    const comments = Number(raw.post_comments_total) || 0;
    const shares = Number(raw.post_activity_by_action_type_share) || 0;
    const views = Number(raw.post_video_views) || 0;
    const interactions = likes + comments + shares;
    const engagement = reach ? (interactions / reach) * 100 : 0;
    const captionRaw = typeof raw.post_message === "string" ? raw.post_message : "";
    const caption = captionRaw ? captionRaw.replace(/\s+/g, " ").trim() : "—";
    const type = friendlyType(raw.type || raw.media_type, "Post");
    return {
      id: String(raw.post_id || `fb-${raw.post_created_time || Math.random()}`),
      platform: "fb",
      type,
      // Ruw posttype ('video_inline', 'video_direct_response', 'photo', 'album').
      // Facebook onderscheidt reels niet van andere video's; de tab 'Facebook
      // reels' leest daarom dit veld. Bewust niet in `type`: dat stuurt de
      // groepsindeling (postGroupOf) en de KPI's.
      kind: typeof raw.type === "string" ? raw.type : "",
      date,
      dateLabel: date ? fmt.dateNL(date) : "—",
      startMs: 0, stopMs: 0,
      reach, impressions, likes, comments, shares, saves: 0,
      clicks: 0, views,
      interactions, engagement, ctr: 0,
      avgWatchTime: 0,
      caption,
      thumb: typeof raw.full_picture === "string" ? raw.full_picture : "",
      url: typeof raw.permalink_url === "string" ? raw.permalink_url : "",
    };
  }

  // Windsor levert Meta-actiestatistieken soms als platte scalar (suffix _video_view),
  // soms als action-breakdown array: [{action_type:"video_view", value:"2459"}].
  // Number([{…}]) → NaN → stilletjes 0 (precies de bug die de retentiecurve liet
  // verdwijnen). Deze helper haalt het getal uit beide vormen.
  function numFromAction(v) {
    if (v == null) return 0;
    if (Array.isArray(v)) {
      const hit = v.find(a => a && (a.action_type === "video_view" || a.action_type == null)) || v[0];
      return Number(hit && hit.value) || 0;
    }
    return Number(v) || 0;
  }

  function normalizeWindsorAdRow(raw) {
    if (!raw || typeof raw !== "object") return null;
    return {
      date: raw.date ? new Date(raw.date) : null,
      adId: String(raw.ad_id || ""),
      adName: String(raw.ad_name || ""),
      campaignId: String(raw.campaign_id || ""),
      campaignName: String(raw.campaign_name || ""),
      thumb: typeof raw.image_url === "string" && raw.image_url ? raw.image_url
        : (typeof raw.thumbnail_url === "string" ? raw.thumbnail_url : ""),
      // Advertentietekst (gewone advertentie). De CTA-type en `link` waren in de
      // test leeg; `website_destination_url` en de CTA-asset vullen dat aan.
      adTitle: String(raw.title || ""),
      adBody: String(raw.body || ""),
      cta: String(raw.call_to_action_type || ""),
      link: String(raw.website_destination_url || raw.link || ""),
      // Niet optelbaar: per advertentie zoals Meta hem over de periode ontdubbelt.
      frequency: raw.frequency != null && raw.frequency !== "" ? Number(raw.frequency) || null : null,
      igProfileVisits: Number(raw.instagram_profile_visits) || 0,
      // Creative-type (geverifieerde Windsor-velden) — bepaalt het getoonde ad-type.
      igMediaType: String(raw.effective_instagram_media__media_type || ""),
      igProductType: String(raw.effective_instagram_media__media_product_type || ""),
      objectType: String(raw.object_type || ""),
      reach: Number(raw.reach) || 0,
      impressions: Number(raw.impressions) || 0,
      clicks: Number(raw.clicks) || 0,
      spend: Number(raw.spend) || 0,
      // Engagement op ad-niveau — geverifieerde Windsor-veldnamen (actions_*).
      likes:    Number(raw.actions_post_reaction) || 0,
      comments: Number(raw.actions_comment) || 0,
      shares:   Number(raw.actions_post) || 0,
      saves:    Number(raw.actions_onsite_conversion_post_save) || 0,
      // Video-retentie (Blok F) — geverifieerde veldnamen (suffix _video_view).
      // numFromAction vangt zowel de scalar- als de nested-array-vorm op, zodat een
      // veldnaam- of Windsor-gedragswijziging de curve niet opnieuw stil op 0 zet.
      vp25:   numFromAction(raw.video_p25_watched_actions_video_view ?? raw.video_p25_watched_actions),
      vp50:   numFromAction(raw.video_p50_watched_actions_video_view ?? raw.video_p50_watched_actions),
      vp75:   numFromAction(raw.video_p75_watched_actions_video_view ?? raw.video_p75_watched_actions),
      vp95:   numFromAction(raw.video_p95_watched_actions_video_view ?? raw.video_p95_watched_actions),
      vp100:  numFromAction(raw.video_p100_watched_actions_video_view ?? raw.video_p100_watched_actions),
      vplays: numFromAction(raw.video_play_actions_video_view ?? raw.video_play_actions),
      avgWatch: raw.video_avg_time_watched_actions_video_view != null
        ? numFromAction(raw.video_avg_time_watched_actions_video_view) : null,
      // Conversies — voor ROAS (waarde) en CAC (aantal). 0 als de klant niet trackt.
      // Eén definitie: omni (web + app + offline) waar Meta hem levert, anders het
      // gewone veld. Nooit optellen — omni bevat de gewone aankopen al, en de som
      // telde elke webaankoop dubbel.
      purchases:     numFromAction(raw.actions_omni_purchase ?? raw.actions_purchase),
      purchaseValue: numFromAction(raw.action_values_omni_purchase ?? raw.action_values_purchase),
      leads:         numFromAction(raw.actions_lead),
      addToCart:      numFromAction(raw.actions_omni_add_to_cart),
      addToCartValue: numFromAction(raw.action_values_omni_add_to_cart),
      checkouts:      numFromAction(raw.actions_initiate_checkout),
      checkoutValue:  numFromAction(raw.action_values_initiate_checkout),
    };
  }

  function sumAdsRowsInWeek(adsRows, week) {
    return adsRows.reduce((s, r) => {
      if (!r?.date) return s;
      return s + (inWeek(r.date, week) ? (r.reach || 0) : 0);
    }, 0);
  }

  // Aggregeer Windsor daily ads-rows tot pseudo-posts voor de Library (Blok B + Q2).
  // Werkt zowel op ad-niveau (heeft adId → één card per advertentie) als op
  // campagne-niveau (fallback wanneer de ad-level fetch faalt → één card per campagne).
  // Reach wordt gesommeerd over dagen (consistent met de KPI-berekening hierboven;
  // dit overschat unieke reach licht — bekende beperking van daily rows).
  // Leid het getoonde ad-type af uit de creative-velden. IG-velden zijn het meest
  // specifiek (Reel/Carrousel/Foto/Video); object_type is de FB-zijde fallback;
  // als laatste redmiddel onderscheidt video-afspeeldata Video van Foto.
  function adCreativeType(g) {
    const pt = (g.igProductType || "").toUpperCase(); // FEED / REELS / STORY
    const mt = (g.igMediaType || "").toUpperCase();    // IMAGE / VIDEO / CAROUSEL_ALBUM
    const ot = (g.objectType || "").toUpperCase();     // VIDEO / PHOTO / SHARE / STATUS
    if (pt === "REELS") return "Reel";
    if (pt === "STORY") return "Story";
    if (mt === "CAROUSEL_ALBUM") return "Carrousel";
    if (mt === "VIDEO") return "Video";
    if (mt === "IMAGE") return "Foto";
    if (ot === "VIDEO") return "Video";
    if (ot === "PHOTO") return "Foto";
    if (ot === "SHARE" || ot === "STATUS") return "Post";
    if ((g.vplays || 0) > 0) return "Video";
    return "Advertentie"; // type onbekend → neutrale fallback
  }

  // `extra` = raw.adsExtra uit getDashboard: campagnedoel per naam en de creatieve
  // varianten per advertentie. Beide optioneel.
  function aggregateWindsorAds(adsRows, extra = {}) {
    const objectives = extra.objectives || {};
    const assets = extra.assets || {};
    const groups = {};
    for (const r of adsRows) {
      if (!r) continue;
      // Een sheettab kan ad_name hebben zonder ad_id. Dan groeperen we op naam;
      // anders viel elke advertentie samen tot één kaart 'onbekend'.
      const isAd = !!(r.adId || r.adName);
      const id = r.adId || (r.adName ? `naam:${r.adName}` : (r.campaignId || r.campaignName || "onbekend"));
      const g = groups[id] || (groups[id] = {
        id, isAd,
        name: isAd ? (r.adName || id) : (r.campaignName || id),
        campaign: r.campaignName || "", thumb: "",
        igMediaType: "", igProductType: "", objectType: "",
        reach: 0, impressions: 0, clicks: 0, spend: 0, lastDate: null,
        likes: 0, comments: 0, shares: 0, saves: 0,
        vp25: 0, vp50: 0, vp75: 0, vp95: 0, vp100: 0, vplays: 0,
        purchases: 0, purchaseValue: 0, leads: 0,
        addToCart: 0, addToCartValue: 0, checkouts: 0, checkoutValue: 0, igProfileVisits: 0,
        adTitle: "", adBody: "", cta: "", link: "",
        freqRows: 0, frequency: null, watchWeighted: 0, watchPlays: 0,
      });
      g.reach += r.reach || 0;
      g.impressions += r.impressions || 0;
      g.clicks += r.clicks || 0;
      g.spend += r.spend || 0;
      g.likes += r.likes || 0; g.comments += r.comments || 0;
      g.shares += r.shares || 0; g.saves += r.saves || 0;
      g.vp25 += r.vp25 || 0; g.vp50 += r.vp50 || 0; g.vp75 += r.vp75 || 0;
      g.vp95 += r.vp95 || 0; g.vp100 += r.vp100 || 0; g.vplays += r.vplays || 0;
      g.purchases += r.purchases || 0; g.purchaseValue += r.purchaseValue || 0; g.leads += r.leads || 0;
      g.addToCart += r.addToCart || 0; g.addToCartValue += r.addToCartValue || 0;
      g.checkouts += r.checkouts || 0; g.checkoutValue += r.checkoutValue || 0;
      g.igProfileVisits += r.igProfileVisits || 0;
      // Frequentie is een ratio over ontdubbelde personen. Alleen overnemen als de
      // groep uit precies één rij bestaat (ad-niveau, zonder datum); bij meer rijen
      // (campagne per dag) is er geen juist getal te maken.
      if (r.frequency != null) { g.freqRows++; g.frequency = r.frequency; }
      // Kijktijd is een gemiddelde per play → wegen naar plays, niet middelen.
      if (r.avgWatch != null && r.vplays > 0) { g.watchWeighted += r.avgWatch * r.vplays; g.watchPlays += r.vplays; }
      if (!g.adTitle && r.adTitle) g.adTitle = r.adTitle;
      if (!g.adBody && r.adBody) g.adBody = r.adBody;
      if (!g.cta && r.cta) g.cta = r.cta;
      if (!g.link && r.link) g.link = r.link;
      if (!g.campaign && r.campaignName) g.campaign = r.campaignName;
      if (!g.thumb && r.thumb) g.thumb = r.thumb;
      // Creative-type is constant per advertentie — eerste niet-lege waarde volstaat.
      if (!g.igMediaType && r.igMediaType) g.igMediaType = r.igMediaType;
      if (!g.igProductType && r.igProductType) g.igProductType = r.igProductType;
      if (!g.objectType && r.objectType) g.objectType = r.objectType;
      if (r.date && (!g.lastDate || r.date > g.lastDate)) g.lastDate = r.date;
    }
    return Object.values(groups).map(g => {
      const ctr = g.impressions ? (g.clicks / g.impressions) * 100 : 0;
      const cpm = g.impressions ? (g.spend / g.impressions) * 1000 : 0;
      const interactions = g.likes + g.comments + g.shares + g.saves;
      const engagement = g.reach ? (interactions / g.reach) * 100 : 0;
      // Paid-conversiemetrics. CAC = spend / #acquisities (purchases indien aanwezig, anders
      // leads — "automatisch"). ROAS = aankoopwaarde / spend. null als er geen conversiedata is.
      const conversions = g.purchases > 0 ? g.purchases : g.leads;
      const variants = g.isAd ? (assets[g.id] || null) : null;
      // CTA: het gewone veld, anders de (enige of grootste) CTA-asset.
      const cta = g.cta || (variants?.cta?.[0]?.value || "");
      const cac = (g.spend > 0 && conversions > 0) ? g.spend / conversions : null;
      const roas = (g.spend > 0 && g.purchaseValue > 0) ? g.purchaseValue / g.spend : null;
      // Retentiecurve (Blok F): percentage van video-plays dat elk checkpoint haalt.
      const retention = g.vplays > 0 ? {
        p3:  100, // ~start; Meta levert geen apart 3s-checkpoint op deze breakdown
        p25: Math.round((g.vp25 / g.vplays) * 100),
        p50: Math.round((g.vp50 / g.vplays) * 100),
        p75: Math.round((g.vp75 / g.vplays) * 100),
        p95: Math.round(((g.vp95 || g.vp100) / g.vplays) * 100),
      } : null;
      return {
        id: `ads-${g.id}`,
        platform: "ads",
        isAd: g.isAd,                          // robuuste ad-vs-campagne-vlag (los van de label-string)
        type: g.isAd ? adCreativeType(g) : "Campagne",
        subtitle: g.isAd ? g.campaign : "",   // campagne als context-subregel bij ad-cards
        date: g.lastDate,
        dateLabel: g.lastDate ? fmt.dateNL(g.lastDate) : "—",
        startMs: 0, stopMs: 0,
        reach: g.reach, impressions: g.impressions,
        likes: g.likes, comments: g.comments, shares: g.shares, saves: g.saves,
        clicks: g.clicks, views: g.vplays,
        interactions, engagement, ctr, cpm,
        avgWatchTime: g.watchPlays > 0 ? g.watchWeighted / g.watchPlays : 0, spend: g.spend,
        frequency: g.freqRows === 1 ? g.frequency : null,
        objective: objectives[g.campaign] || (!g.isAd ? (objectives[g.id] || objectives[g.name] || "") : ""),
        adTitle: g.adTitle, adBody: g.adBody, cta, link: g.link,
        variants,
        addToCart: g.addToCart, addToCartValue: g.addToCartValue,
        checkouts: g.checkouts, checkoutValue: g.checkoutValue,
        igProfileVisits: g.igProfileVisits,
        // Paid-conversiemetrics (null = geen data → UI toont "—").
        purchases: g.purchases, purchaseValue: g.purchaseValue, leads: g.leads,
        cac, roas, conversions: conversions || 0,
        retention,
        // url = de landingspagina: een klik in de Library opent waar de advertentie heen stuurt.
        caption: g.name, thumb: g.thumb, url: g.link || "",
      };
    });
  }

  // opts.vs = het vergelijkingslabel op de KPI-kaarten ('vs vorige periode').
  function transformWindsorDashboard(raw, opts = {}) {
    const kpi = (l, c, p, f, u) => buildKpi(l, c, p, f, u, opts.vs || null);
    const igPostsRaw = arrayOrEmpty(raw.instagram?.data);
    const fbOrgRaw = arrayOrEmpty(raw.fbOrganic?.data); // Facebook organic pagina-posts
    const adsRowsRaw = arrayOrEmpty(raw.ads?.data);    // campagne-niveau (reach voor trend/KPI)
    const adsAdRaw = arrayOrEmpty(raw.adsAd?.data);    // ad-niveau (per advertentie, indien gelukt)

    const igPosts = igPostsRaw.map(normalizeWindsorIgPost).filter(Boolean);
    const fbPosts = fbOrgRaw.map(normalizeWindsorFbPost).filter(Boolean);
    const adsRows = adsRowsRaw.map(normalizeWindsorAdRow).filter(Boolean);
    const adsAdRows = adsAdRaw.map(normalizeWindsorAdRow).filter(Boolean);

    const allPosts = [...igPosts, ...fbPosts]; // IG + FB organic
    // Library: per advertentie zodra de ad-level fetch rijen gaf; anders fallback per campagne.
    const adsExtra = raw.adsExtra || {};
    const adsCampaigns = aggregateWindsorAds(adsAdRows.length ? adsAdRows : adsRows, adsExtra);
    benchmarkPosts([...allPosts, ...adsCampaigns]); // kolom 't.o.v. gemiddelde'


    const curAgg = aggregatePosts(allPosts);
    const adsReachCur = adsRows.reduce((s, r) => s + (r.reach || 0), 0);
    const adsClicksCur = adsRows.reduce((s, r) => s + (r.clicks || 0), 0);

    const erCur = curAgg.reach ? (curAgg.interactions / curAgg.reach) * 100 : 0;

    // VERGELIJKINGSPERIODE — getDashboard stuurt hem mee sinds de datasheet ook
    // de vorige periode kan leveren. Kwam er niets terug (API-klant met een
    // trage connector, of een sheet die niet zo ver terugloopt), dan blijft het
    // null en zegt de kaart 'geen vergelijkbare vorige periode' — nooit nul.
    const prev = raw.previous || {};
    const prevIg = arrayOrEmpty(prev.instagram?.data).map(normalizeWindsorIgPost).filter(Boolean);
    const prevFb = arrayOrEmpty(prev.fbOrganic?.data).map(normalizeWindsorFbPost).filter(Boolean);
    const prevAdsRows = arrayOrEmpty(prev.ads?.data).map(normalizeWindsorAdRow).filter(Boolean);
    const heeftVergelijking = prevIg.length || prevFb.length || prevAdsRows.length;
    const prvAgg = heeftVergelijking ? aggregatePosts([...prevIg, ...prevFb]) : null;
    const adsReachPrv = prevAdsRows.reduce((s, r) => s + (r.reach || 0), 0);
    const adsClicksPrv = prevAdsRows.reduce((s, r) => s + (r.clicks || 0), 0);
    const erPrv = prvAgg && prvAgg.reach ? (prvAgg.interactions / prvAgg.reach) * 100 : null;

    const kpis = [
      kpi("Totale reach", curAgg.reach + adsReachCur,
        prvAgg ? prvAgg.reach + adsReachPrv : null, fmt.k, "pct"),
      kpi("Engagement rate", erCur, erPrv, (n) => fmt.pct(n), "pp"),
      kpi("Posts gepubliceerd", curAgg.count, prvAgg ? prvAgg.count : null, (n) => String(n), "pct"),
      kpi("Clicks", curAgg.clicks + adsClicksCur,
        prvAgg ? prvAgg.clicks + adsClicksPrv : null, fmt.k, "pct"),
    ];

    const startDate = raw.period.startDate;
    const endDate = raw.period.endDate;

    // KPI sparklines
    const sparkWeeks = enumerateWeeks(startDate, endDate, 12);
    kpis[0].spark = sparkWeeks.map(w => sumPostsField(allPosts, w, "reach") + sumAdsRowsInWeek(adsRows, w));
    const weekER = sparkWeeks.map(w => {
      const r = sumPostsField(allPosts, w, "reach");
      const i = sumPostsField(allPosts, w, "interactions");
      return r ? (i / r) * 100 : 0;
    });
    kpis[1].spark = weekER;
    kpis[2].spark = sparkWeeks.map(w => countPostsInWeek(allPosts, w));
    kpis[3].spark = sparkWeeks.map(w => sumPostsField(allPosts, w, "clicks") + adsRows.reduce((s, r) => s + (r.date && inWeek(r.date, w) ? (r.clicks || 0) : 0), 0));

    // Trend chart
    const trendWeeks = enumerateWeeks(startDate, endDate);
    const trendIG = trendWeeks.map(w => sumPostsField(igPosts, w, "reach"));
    const trendFB = trendWeeks.map(w => sumPostsField(fbPosts, w, "reach"));
    const trendAds = trendWeeks.map(w => sumAdsRowsInWeek(adsRows, w));
    const timeseries = {
      weeks: trendWeeks.map((w, i) => `wk ${i + 1}`),
      series: [
        { label: "Instagram", values: trendIG },
        { label: "Facebook", values: trendFB },
        { label: "Meta Ads", values: trendAds },
      ],
    };

    // Channel mix
    const igReach = trendIG.reduce((s, v) => s + v, 0);
    const fbReach = fbPosts.reduce((s, p) => s + (p.reach || 0), 0);
    const adsReach = adsReachCur;
    const totalChannelReach = igReach + fbReach + adsReach || 1;
    const channels = [
      { label: "Instagram", color: "var(--accent-100)", value: Math.round((igReach / totalChannelReach) * 100) },
      { label: "Facebook",  color: "var(--chart-3)", value: Math.round((fbReach / totalChannelReach) * 100) },
      { label: "Meta Ads",  color: "var(--chart-4)", value: Math.round((adsReach / totalChannelReach) * 100) },
    ];

    // Top posts (organic IG, top 5 op engagement-rate)
    const topPosts = [...allPosts]
      .sort((a, b) => b.engagement - a.engagement)
      .slice(0, 5)
      .map((p, i) => {
        const cleanUrl = safeUrl(p.thumb);
        const isHttp = cleanUrl && cleanUrl.startsWith("http");
        return {
          id: p.id,
          caption: p.caption,
          type: p.type,
          platform: p.platform,
          date: p.dateLabel,
          engagement: p.engagement.toFixed(1) + "%",
          imageUrl: isHttp ? cleanUrl : null,
          fallbackBg: gradientFor(i),
        };
      });

    // Cadence
    const cadenceWeeks = enumerateWeeks(startDate, endDate, 13);
    const cadence = [];
    for (let d = 0; d < 7; d++) {
      const row = [];
      for (let w = 0; w < cadenceWeeks.length; w++) {
        row.push(allPosts.filter(p => p.date && p.date.getDay() === ((d + 1) % 7) && inWeek(p.date, cadenceWeeks[w])).length);
      }
      cadence.push(row);
    }

    return {
      kpis,
      timeseries,
      channels,
      topPosts,
      cadenceWeeks,
      cadence,
      allPosts,
      adsCampaigns, // geaggregeerde campagne-cards uit daily rows (Blok B)
      // Kosten, vertoningen en kliks uit de campagnerijen: die dekken de hele
      // periode, de advertentiekaarten hierboven hooguit het ad-venster (35 d).
      // Geen conversies — die vraagt getDashboard alleen op advertentieniveau op.
      adsPeriodTotals: adsRows.length ? {
        spend: adsRows.reduce((a, r) => a + (r.spend || 0), 0),
        impressions: adsRows.reduce((a, r) => a + (r.impressions || 0), 0),
        clicks: adsClicksCur,
      } : null,
      adsLoading: false, // Windsor levert ads in dezelfde call → geen aparte wachttijd
      adLevelWindow: raw.adLevelWindow || null, // venster dat de ad-detail dekt (Hobby-cap)
      // Accountbereik, demografie en regio (null = niet gemeten). Zie getDashboard.
      adsExtra: {
        accountReach: adsExtra.accountReach || null,
        accountReachPrev: adsExtra.accountReachPrev || null,
        demographics: adsExtra.demographics || null,
        regions: adsExtra.regions || null,
        errors: raw.errors || {},
      },
      _raw: raw,
      _source: "windsor",
    };
  }

  // §4 van de design-system-briefing: een KPI-tegel zonder vergelijking mag niet.
  // Een kaal getal is niet te beoordelen — de lezer vult dan zelf een referentie in.
  // Daarom onderscheiden we vier toestanden in plaats van 'delta of streepje':
  //
  //   delta  vorige periode > 0  → pijl + percentage, semantische kleur
  //   flat   niets veranderd     → ±0% in neutraal grijs, nooit groen
  //   new    vorige was 0, nu >0 → 'nieuw'; groei vanaf nul is geen percentage
  //   empty  beide periodes 0    → 'geen activiteit'; er ís gemeten, er was niets
  //   none   geen vorige periode → 'geen vergelijking', met reden in de voetnoot
  //
  // `delta` en `direction` houden hun oude betekenis, zodat buildAnalysisSummary
  // en de analyse-agent ongewijzigd blijven werken.
  function buildKpi(label, current, previous, formatter, deltaUnit, vs = null) {
    let state = "none";
    let delta = null;

    if (previous != null && previous > 0) {
      delta = deltaUnit === "pp" ? (current - previous) : ((current - previous) / previous) * 100;
      state = Math.abs(delta) < 0.05 ? "flat" : "delta";
    } else if (previous === 0) {
      // Vorige periode is gemeten en was nul — dat is iets anders dan geen data.
      state = current > 0 ? "new" : "empty";
    }

    return {
      label,
      value: formatter(current),
      delta: delta != null ? Math.abs(delta) : null,
      direction: delta == null ? null : (delta >= 0 ? "up" : "down"),
      state,
      vs,
      unit: deltaUnit,
      spark: [],
    };
  }

  function enumerateWeeks(startISO, endISO, force) {
    const start = new Date(startISO);
    const end = new Date(endISO);
    const totalDays = Math.max(1, Math.round((end - start) / 86400000) + 1);
    const bucketCount = force || Math.max(4, Math.min(17, Math.ceil(totalDays / 7)));
    const bucketSize = totalDays / bucketCount;
    const weeks = [];
    for (let i = 0; i < bucketCount; i++) {
      const ws = new Date(start.getTime() + Math.floor(i * bucketSize) * 86400000);
      const we = new Date(start.getTime() + (Math.floor((i + 1) * bucketSize) - 1) * 86400000);
      weeks.push({ num: i + 1, start: ws, end: we });
    }
    return weeks;
  }

  function inWeek(date, week) {
    return date >= week.start && date <= new Date(week.end.getTime() + 86400000 - 1);
  }

  function sumPostsField(posts, week, field) {
    return posts.reduce((s, p) => s + (p.date && inWeek(p.date, week) ? (p[field] || 0) : 0), 0);
  }

  function countPostsInWeek(posts, week) {
    return posts.reduce((s, p) => s + (p.date && inWeek(p.date, week) ? 1 : 0), 0);
  }

  function gradientFor(i) {
    // Neutrale, palette-gestuurde thumbnail-fallbacks (var() werkt in style-attribuut).
    // Decoratie, geen data: daarom accenttinten en geen chartkleuren. Kleur hoort
    // in dit systeem betekenis te dragen — een thumbnail-fallback draagt er geen.
    const palette = [
      "linear-gradient(135deg, var(--accent-25), var(--accent-50))",
      "linear-gradient(135deg, var(--accent-50), var(--accent-25))",
      "linear-gradient(135deg, var(--accent-10), var(--accent-50))",
      "linear-gradient(135deg, var(--accent-50), var(--accent-75))",
      "linear-gradient(135deg, var(--accent-25), var(--accent-75))",
    ];
    return palette[i % palette.length];
  }

  // Bekende meetbronnen. `sum`: telt op over de periode, dus er is een
  // verwachte stand halverwege. `ratio`: een verhouding, die vergelijk je direct.
  const GOAL_METRICS = {
    "ga4.sessies":     { label: "Sessies · GA4",           unit: "",  kind: "sum",   need: "ga4" },
    "ga4.conversies":  { label: "Key events · GA4",        unit: "",  kind: "sum",   need: "ga4" },
    "ga4.doel":        { label: "Hoofddoel · GA4",         unit: "",  kind: "sum",   need: "ga4Goal" },
    "ga4.omzet":       { label: "Omzet · GA4",             unit: "€", kind: "sum",   need: "ga4" },
    "ga4.transacties": { label: "Transacties · GA4",       unit: "",  kind: "sum",   need: "ga4" },
    "meta.kosten":     { label: "Advertentiekosten · Meta", unit: "€", kind: "sum",  need: "meta" },
    "meta.klikken":    { label: "Kliks · Meta",            unit: "",  kind: "sum",   need: "meta" },
    "meta.leads":      { label: "Leads · Meta",            unit: "",  kind: "sum",   need: "meta" },
    "meta.aankopen":   { label: "Aankopen · Meta",         unit: "",  kind: "sum",   need: "meta" },
    "meta.omzet":      { label: "Omzet · Meta",            unit: "€", kind: "sum",   need: "meta" },
    "meta.roas":       { label: "ROAS · Meta",             unit: "x", kind: "ratio", need: "meta" },
  };

  const MAANDEN = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

  // '2026' → jaar, '2026-Q4' / 'Q4 2026' → kwartaal, '2026-09' → maand.
  // Meetvenster = periode tot en met gisteren (vandaag is nog niet af).
  function goalRange(periode) {
    const t = String(periode || "").trim();
    let y, m0, m1, label;
    let mt;
    if ((mt = t.match(/^(\d{4})$/))) { y = +mt[1]; m0 = 0; m1 = 11; label = String(y); }
    else if ((mt = t.match(/^(\d{4})\s*[-/ ]?\s*Q([1-4])$/i) || t.match(/^Q([1-4])\s*[-/ ]?\s*(\d{4})$/i))) {
      const q = /^Q/i.test(t) ? +mt[1] : +mt[2];
      y = /^Q/i.test(t) ? +mt[2] : +mt[1];
      m0 = (q - 1) * 3; m1 = m0 + 2; label = `Q${q} ${y}`;
    }
    else if ((mt = t.match(/^(\d{4})-(\d{1,2})$/)) && +mt[2] >= 1 && +mt[2] <= 12) {
      y = +mt[1]; m0 = m1 = +mt[2] - 1; label = `${MAANDEN[m0]} ${y}`;
    }
    else return null;
    const start = ymd(y, m0, 1), end = ymd(y, m1, lastDayOf(y, m1));
    const gister = new Date(); gister.setDate(gister.getDate() - 1);
    const g = ymd(gister.getFullYear(), gister.getMonth(), gister.getDate());
    const tot = end < g ? end : g;
    const dagen = (a, b) => Math.round((webAtNoon(b) - webAtNoon(a)) / 86400000) + 1;
    return {
      start, end, label,
      measureEnd: start <= g ? tot : null,           // null = nog niet begonnen
      elapsed: start > g ? 0 : Math.min(1, dagen(start, tot) / dagen(start, end)),
      done: end <= g,
    };
  }

  // De stand van één doel: gemeten, handmatig of onbekend — en waarom.
  // ctx = { goalMetrics, loading, hasWindsor } — de meetstand van getGoalMetrics.
  function goalState(g, ctx = {}) {
    const r = goalRange(g.period);
    const m = g.source ? GOAL_METRICS[g.source] : null;
    const unit = m ? m.unit : (g.target?.unit || g.actual?.unit || "");
    let actual = null, bron = "", note = "";
    if (g.source && !m) {
      note = `onbekende meetbron '${g.source}'`;
    } else if (m && !r) {
      note = "periode niet herkend — gebruik 2026, 2026-Q4 of 2026-09";
    } else if (m && !r.measureEnd) {
      note = "periode nog niet begonnen";
    } else if (m) {
      const gm = ctx.goalMetrics;
      const res = gm && gm[`${r.start}|${r.measureEnd}`];
      if (!ctx.hasWindsor) note = "meetbron vraagt een Windsor-koppeling";
      else if (ctx.loading) note = "wordt gemeten…";
      else if (gm && gm.__error) note = gm.__error;
      else if (gm && gm.__available && !gm.__available[m.need]) {
        note = m.need === "meta" ? "geen Meta Ads-account in de Config-tab"
          : m.need === "ga4Goal" ? "geen Conversiedoel in de Config-tab" : "geen GA4-property in de Config-tab";
      } else if (res && res.values && res.values[g.source] != null) {
        actual = res.values[g.source];
        bron = `gemeten t/m ${r.measureEnd.split("-").reverse().join("-")}`;
      } else if (res && res.errors && Object.keys(res.errors).length) {
        note = Object.values(res.errors)[0];
      }
    }
    // Handmatig als terugval: een meetbron die (nog) niets oplevert mag de
    // ingevulde stand niet wegvegen.
    if (actual == null && g.actual) { actual = g.actual.value; bron = bron || "handmatig"; }
    const target = g.target ? g.target.value : null;
    const pct = (actual != null && target) ? actual / target : null;

    // Oordeel. Verwachte stand alleen bij optelbare meetbronnen in een lopende
    // periode: een handmatige 'Huidig' kan net zo goed een momentopname zijn.
    let status = null;
    if (pct != null && r) {
      if (pct >= 1) status = { toon: "good", tekst: "behaald" };
      else if (r.done) status = { toon: "bad", tekst: "niet behaald" };
      else if (m && m.kind === "sum" && bron.startsWith("gemeten") && r.elapsed > 0) {
        const tovSchema = pct / r.elapsed;
        status = tovSchema >= 1 ? { toon: "good", tekst: "op schema" }
          : tovSchema >= 0.9 ? { toon: "warn", tekst: "net achter" }
          : { toon: "bad", tekst: "achter op schema" };
      }
    }
    return { r, m, unit, actual, target, pct, bron, note, status,
      expected: (m && m.kind === "sum" && r && !r.done && r.elapsed > 0) ? r.elapsed : null };
  }

  const OBJECTIVE_LABELS = {
    OUTCOME_SALES: "Verkoop", OUTCOME_LEADS: "Leads", OUTCOME_TRAFFIC: "Verkeer",
    OUTCOME_ENGAGEMENT: "Interactie", OUTCOME_AWARENESS: "Bekendheid", OUTCOME_APP_PROMOTION: "App-promotie",
    CONVERSIONS: "Conversies", LINK_CLICKS: "Linkkliks", REACH: "Bereik", BRAND_AWARENESS: "Bekendheid",
    POST_ENGAGEMENT: "Interactie", VIDEO_VIEWS: "Videoweergaven", LEAD_GENERATION: "Leads",
    MESSAGES: "Berichten", PRODUCT_CATALOG_SALES: "Catalogusverkoop", APP_INSTALLS: "App-installaties",
  };

  const CTA_LABELS = {
    SIGN_UP: "Inschrijven", DOWNLOAD: "Downloaden", SHOP_NOW: "Nu kopen", LEARN_MORE: "Meer info",
    BOOK_TRAVEL: "Boeken", BOOK_NOW: "Nu boeken", CONTACT_US: "Contact opnemen", APPLY_NOW: "Nu aanvragen",
    SUBSCRIBE: "Abonneren", GET_OFFER: "Aanbieding bekijken", ORDER_NOW: "Nu bestellen",
    SEND_MESSAGE: "Bericht sturen", WHATSAPP_MESSAGE: "WhatsApp", GET_QUOTE: "Offerte aanvragen",
    WATCH_MORE: "Meer bekijken", SEE_MORE: "Meer bekijken", BUY_NOW: "Nu kopen", CALL_NOW: "Nu bellen",
    NO_BUTTON: "Geen knop",
  };

  const humanCode = (v) => String(v || "").toLowerCase().replace(/_/g, " ").replace(/^./, c => c.toUpperCase());

  const objectiveLabel = (v) => OBJECTIVE_LABELS[v] || humanCode(v);

  const ctaLabel = (v) => CTA_LABELS[v] || humanCode(v);

  // Aggregeer overview-data tot een compacte JSON voor de LLM.
  // We sturen géén ruwe posts-array (te duur in tokens) — wel groeperingen,
  // top/bottom-uittreksels en samenvattingen die het patroon vasthouden.
  // extras = { periodDays, website, seo, geo }: de al gebouwde deelsamenvattingen.
  // null = die tab is niet geladen; dan blijft hij weg i.p.v. nullen te sturen.
  function buildAnalysisSummary(ov, extras = {}) {
    // Zonder Overview is er nog steeds context: de SEO-, GEO- en Websitetab
    // kunnen wél geladen zijn. Die hoorden de agent altijd al te bereiken, maar
    // deze functie gaf hier `null` terug en stuurde dus helemaal niets mee —
    // waarop de agent terecht antwoordde dat hij geen data had.
    if (!ov) {
      const partial = {
        website: extras.website ?? null,
        seo: extras.seo ?? null,
        geo: extras.geo ?? null,
      };
      return Object.values(partial).some(v => v != null) ? partial : null;
    }
    const posts = arrayOrEmpty(ov.allPosts);
    const ads = arrayOrEmpty(ov.adsCampaigns);

    const groupBy = (arr, keyFn) => {
      const m = {};
      for (const p of arr) {
        const k = keyFn(p);
        if (!k) continue;
        if (!m[k]) m[k] = { count: 0, totalReach: 0, totalInteractions: 0, totalEngagement: 0, withEngagement: 0 };
        m[k].count += 1;
        m[k].totalReach += p.reach || 0;
        m[k].totalInteractions += p.interactions || 0;
        if (p.engagement) { m[k].totalEngagement += p.engagement; m[k].withEngagement += 1; }
      }
      const out = {};
      for (const k of Object.keys(m)) {
        const g = m[k];
        out[k] = {
          count: g.count,
          totalReach: Math.round(g.totalReach),
          avgReach: g.count ? Math.round(g.totalReach / g.count) : 0,
          avgEngagement: g.withEngagement ? +(g.totalEngagement / g.withEngagement).toFixed(2) : 0,
        };
      }
      return out;
    };

    const slimPost = (p) => ({
      caption: (p.caption || "").slice(0, 140),
      platform: p.platform,
      type: p.type,
      date: p.dateLabel,
      reach: p.reach || 0,
      engagement: +(p.engagement || 0).toFixed(2),
      likes: p.likes || 0,
      comments: p.comments || 0,
      shares: p.shares || 0,
      saves: p.saves || 0,
      // Benchmark: engagement ÷ gemiddelde engagement van dezelfde groep in deze
      // periode (1 = gemiddeld). null = te weinig posts in de groep.
      benchIndex: p.benchIndex != null ? p.benchIndex : null,
      benchGroup: p.bench ? p.bench.groupLabel : null,
    });

    const byEngagement = [...posts].filter(p => p.reach >= 100).sort((a, b) => b.engagement - a.engagement);
    const byReach = [...posts].sort((a, b) => b.reach - a.reach);
    const top10 = byEngagement.slice(0, 10).map(slimPost);
    const bottom5 = byEngagement.slice(-5).reverse().map(slimPost);

    const days = ["Zo", "Ma", "Di", "Wo", "Do", "Vr", "Za"];
    const dayCounts = Array(7).fill(0);
    for (const p of posts) {
      if (p.date instanceof Date) dayCounts[p.date.getDay()] += 1;
    }
    const busiestIdx = dayCounts.indexOf(Math.max(...dayCounts));
    const quietestIdx = dayCounts.indexOf(Math.min(...dayCounts.filter(v => v >= 0)));

    // Boven- en onder het gemiddelde van de eigen groep (benchmarkPosts). Een
    // plaats, geen oordeel: de index zegt hoe ver een post van het gemiddelde zit.
    const rated = posts.filter(p => p.benchIndex != null);
    const aboveAverage = rated.filter(p => p.benchIndex > 1)
      .sort((a, b) => b.benchIndex - a.benchIndex).slice(0, 5).map(slimPost);
    const belowAverage = rated.filter(p => p.benchIndex < 1)
      .sort((a, b) => a.benchIndex - b.benchIndex).slice(0, 5).map(slimPost);

    return {
      kpis: ov.kpis.map(k => ({
        label: k.label,
        value: k.value,
        delta: k.delta != null ? +k.delta.toFixed(2) : null,
        direction: k.direction,
        unit: k.unit,
      })),
      channels: ov.channels.map(c => ({ label: c.label, sharePct: c.value })),
      byPlatform: groupBy(posts, p => ({ ig: "Instagram", fb: "Facebook" })[p.platform]),
      byType: groupBy(posts, p => p.type),
      cadence: {
        totalPosts: posts.length,
        postsPerWeek: +((posts.length / Math.max(1, (extras.periodDays || 1) / 7))).toFixed(1),
        postsPerDay: days.map((d, i) => ({ day: d, count: dayCounts[i] })),
        busiestDay: days[busiestIdx],
        quietestDay: days[quietestIdx],
      },
      topPostsByEngagement: top10,
      bottomPostsByEngagement: bottom5,
      topPostsByReach: byReach.slice(0, 5).map(slimPost),
      // Benchmark: engagement t.o.v. het gemiddelde van dezelfde groep (IG posts,
      // IG reels, FB posts, FB reels) in deze periode.
      aboveAverage,
      belowAverage,
      ads: buildAdsSummary(ads, ov.adsExtra),
      // Websitecijfers meesturen zodra de Website-tab geladen is. Zonder die tab
      // is er geen websitedata in het geheugen; dan blijft dit weg i.p.v. nullen
      // te sturen die de agent als 'geen verkeer' zou lezen.
      website: extras.website ?? null,
      // SEO en GEO meesturen zodra die tabs geladen zijn. Net als bij website:
      // niet geladen = weglaten, niet nullen sturen.
      seo: extras.seo ?? null,
      geo: extras.geo ?? null,
    };
  }

  // Compacte samenvatting van de GEO-tab (AI-zichtbaarheid). Een audit is een
  // momentopname met een datum en een methode; die twee gaan mee, anders kan de
  // agent een half jaar oude meting als 'de stand van vandaag' presenteren.
  function buildGeoSummary(geo) {
    if (!geo) return null;
    const { g, full, cur, prev } = geoCtx(geo);
    if (!cur) return null;
    const pack = (m) => {
      const b = geoBlocks(g, m);
      const sov = geoSov(g, m);
      return {
        date: m.date,
        mentionUnbrandedPct: geoMention(g, m, GEO_UNBRANDED).pct,
        mentionBrandedPct: b.herk,
        descriptorPct: b.descr,
        blocks: {
          leesbaarheid: b.r.total ? `${b.r.pass}/${b.r.total} (${b.r.fail} falen, ${b.r.unk} onmeetbaar)` : null,
          herkenningJuistPct: b.herkCorrect, categoriePct: b.cat, expertisePct: b.exp,
          vertrouwenExterneCitaties: b.vert, voorkeurPct: b.voor,
        },
        perEngine: g.engines.map(e => ({ engine: e.name, mentionPct: geoMention(g, m, null, [e.id]).pct })),
        shareOfVoice: sov ? sov.rows.map(r => ({ brand: r.brand, pct: r.pct == null ? null : Math.round(r.pct * 10) / 10 })) : null,
        brandSplit: b.sc.total ? Object.fromEntries(GEO_SPLIT.map(([k]) => [k, b.sc[k]])) : null,
      };
    };
    return {
      brand: g.brand.name || null,
      fullMeasurements: full.length,
      method: g.method || null,
      current: pack(cur),
      previous: prev ? pack(prev) : null,
      actions: arrayOrEmpty(g.actions).slice(0, 5).map(a => ({ priority: a.priority, title: a.title, moves: a.moves })),
    };
  }

  // Compacte samenvatting van de Website-tab voor de analyse-agent en de chat.
  // Alleen de cijfers waar een uitspraak op te baseren is; geen lange lijsten.
  function buildWebsiteSummary(w) {
    if (!w || !w.current) return null;
    const t = w.current.totals;
    const prev = w.previous ? w.previous.totals : null;
    const goal = webGoal(w);
    const round = (n, d = 2) => (n == null || !isFinite(n)) ? null : +n.toFixed(d);

    return {
      period: w.period,
      comparePeriod: w.comparePeriod,
      siteType: w.website.type,
      goal: { label: goal.label, event: w.website.goalEvent, measured: goal.on },
      totals: {
        sessions: t.sessions,
        users: t.users,
        newUserShare: round(t.newUserShare, 3),
        engagementRate: round(t.engagementRate, 3),
        avgEngagementTimeSec: round(t.avgEngagementTime, 0),
        conversions: goal.valueOf(t),
        conversionRate: round(goal.rateOf(t), 4),
        revenue: round(t.revenue, 2),
        transactions: t.transactions,
        aov: round(t.aov, 2),
      },
      previousTotals: prev ? {
        sessions: prev.sessions,
        engagementRate: round(prev.engagementRate, 3),
        conversions: goal.valueOf(prev),
        conversionRate: round(goal.rateOf(prev), 4),
        revenue: round(prev.revenue, 2),
      } : null,
      channels: (w.current.channels || []).slice(0, 8).map(c => ({
        channel: c.channel,
        sessions: c.sessions,
        engagementRate: round(c.engagementRate, 3),
        conversions: goal.rowOf(c),
        conversionRate: round(c.conversionRate, 4),
        revenue: round(c.revenue, 2),
      })),
      topLandingPages: (w.current.landingPages || []).slice(0, 8).map(p => ({
        page: p.page, sessions: p.sessions,
        engagementRate: round(p.engagementRate, 3),
        conversionRate: round(p.conversionRate, 4),
      })),
      search: w.current.search.available ? {
        clicks: w.current.search.clicks,
        impressions: w.current.search.impressions,
        ctr: round(w.current.search.ctr, 4),
        position: round(w.current.search.position, 1),
        topQueries: (w.current.queries || []).slice(0, 8).map(q => ({
          query: q.query, clicks: q.clicks, impressions: q.impressions, position: round(q.position, 1),
        })),
        quickWins: (w.current.quickWins || []).slice(0, 8).map(q => ({
          query: q.query, impressions: q.impressions, clicks: q.clicks, position: round(q.position, 1),
        })),
      } : null,
      funnel: (w.current.funnel && w.current.funnel.available) ? w.current.funnel : null,
    };
  }

  // Per-ad/paid samenvatting (Blok 2). Onderscheidt campagne- en ad-niveau, en neemt
  // retentie alleen mee als de curve echt gevuld is (anders niets — geen fake data).
  function buildAdsSummary(ads, adsExtra) {
    const slimAd = (a) => {
      const out = {
        name: (a.caption || "").slice(0, 100),
        level: a.isAd ? "ad" : "campaign",
        adType: a.isAd ? a.type : null,   // Reel / Carrousel / Foto / Video / Post
        campaign: a.subtitle || null,
        reach: a.reach || 0,
        impressions: a.impressions || 0,
        clicks: a.clicks || 0,
        ctr: +(a.ctr || 0).toFixed(2),
        cpm: +(a.cpm || 0).toFixed(2),
        engagement: +(a.engagement || 0).toFixed(2),
        spend: a.spend != null ? +(a.spend).toFixed(2) : null,
        // Conversiemetrics — null als de klant niet trackt (agent: dan niet over ROAS/CAC claimen).
        roas: a.roas != null ? +a.roas.toFixed(2) : null,
        cac: a.cac != null ? +a.cac.toFixed(2) : null,
        purchases: a.purchases || 0,
        leads: a.leads || 0,
        addToCart: a.addToCart || 0,
        checkouts: a.checkouts || 0,
        igProfileVisits: a.igProfileVisits || 0,
        frequency: a.frequency != null ? +a.frequency.toFixed(2) : null,
        // ROAS (bij aankopen) of CTR ÷ het gemiddelde van alle advertenties; 1 = gemiddeld.
        benchIndex: a.benchIndex != null ? a.benchIndex : null,
        benchMetric: a.bench ? a.bench.metric : null,
        objective: a.objective ? objectiveLabel(a.objective) : null,
        avgWatchSec: a.avgWatchTime > 0 ? +a.avgWatchTime.toFixed(1) : null,
      };
      // Creatie: wat de advertentie zei. Ingekort — het model heeft de strekking
      // nodig, niet elke regel.
      if (a.isAd) {
        if (a.adTitle) out.headline = a.adTitle.slice(0, 120);
        if (a.adBody) out.bodyText = String(a.adBody).replace(/\s+/g, " ").slice(0, 300);
        if (a.cta) out.cta = ctaLabel(a.cta);
        // Varianten: per type alleen als er echt iets te vergelijken valt, met
        // aandelen (de conversies hier zijn niet-omni en dus geen absolute telling).
        if (a.variants) {
          const v = {};
          for (const [k, list] of Object.entries(a.variants)) {
            if (!list || list.length < 2) continue;
            const impr = list.reduce((t, x) => t + x.impressions, 0);
            const conv = list.reduce((t, x) => t + (x.purchases || x.leads || 0), 0);
            v[k] = list.slice(0, 4).map(x => ({
              value: k === "image" ? "(afbeelding)" : String(x.value).replace(/\s+/g, " ").slice(0, 100),
              impressionShare: impr ? +((x.impressions / impr) * 100).toFixed(1) : null,
              ctr: x.impressions ? +((x.clicks / x.impressions) * 100).toFixed(2) : null,
              conversionShare: conv ? +(((x.purchases || x.leads || 0) / conv) * 100).toFixed(1) : null,
            }));
          }
          if (Object.keys(v).length) out.creativeVariants = v;
        }
      }
      // Retentie alleen meesturen als de curve daadwerkelijk gevuld is (zie task_3c228fd4).
      if (a.retention && a.retention.p50 != null) {
        out.retention = {
          p25: a.retention.p25, p50: a.retention.p50,
          p75: a.retention.p75, p95: a.retention.p95,
        };
      }
      return out;
    };

    const adLevel = ads.filter(a => a.isAd);
    const byEng = (arr) => [...arr].filter(a => (a.reach || 0) >= 100).sort((x, y) => (y.engagement || 0) - (x.engagement || 0));
    const engAds = byEng(adLevel);

    // Account-niveau paid-totalen → afgeleide ratio's (correcter dan gemiddelde-van-ratio's).
    const tSpend = ads.reduce((s, a) => s + (a.spend || 0), 0);
    const tImpr  = ads.reduce((s, a) => s + (a.impressions || 0), 0);
    const tVal   = ads.reduce((s, a) => s + (a.purchaseValue || 0), 0);
    const tConv  = ads.reduce((s, a) => s + (a.conversions || 0), 0);
    const tClicks = ads.reduce((s, a) => s + (a.clicks || 0), 0);
    const tSum = (k) => ads.reduce((s, a) => s + (a[k] || 0), 0);
    const extra = adsExtra || {};

    // Demografie als aandelen (zie renderAdsDemo): de doelactie is de verste
    // funnelstap waar iets gemeten is.
    let audience = null;
    if (extra.demographics?.length) {
      const d = extra.demographics;
      const sum = (rows, k) => rows.reduce((t, r) => t + (r[k] || 0), 0);
      const doel = ["purchases", "leads", "addToCart", "clicks"].find(k => sum(d, k) > 0) || "clicks";
      const tSp = sum(d, "spend"), tD = sum(d, doel);
      const pct = (n, t) => t > 0 ? +((n / t) * 100).toFixed(1) : null;
      audience = {
        goalMetric: doel,
        note: "Aandelen in %, niet-omni cijfers; niet optellen of vergelijken met de omni-totalen.",
        groups: d.map(r => ({ age: r.age, gender: r.gender, spendShare: pct(r.spend, tSp), goalShare: pct(r[doel] || 0, tD) }))
          .filter(g => (g.spendShare || 0) >= 1 || (g.goalShare || 0) > 0)
          .sort((a, b) => (b.goalShare || 0) - (a.goalShare || 0)).slice(0, 10),
        byGender: ["female", "male", "unknown"].map(g => {
          const gr = d.filter(r => r.gender === g);
          return gr.length ? { gender: g, spendShare: pct(sum(gr, "spend"), tSp), goalShare: pct(sum(gr, doel), tD) } : null;
        }).filter(Boolean),
      };
      if (extra.regions?.length) {
        const r = extra.regions, rSp = sum(r, "spend");
        audience.regions = [...r].sort((a, b) => b.spend - a.spend).slice(0, 6)
          .map(x => ({ region: x.region, spendShare: pct(x.spend, rSp) }));
      }
    }

    return {
      level: adLevel.length ? "ad" : "campaign",  // welk granulariteitsniveau de data heeft
      campaignCount: ads.length,
      totalReach: ads.reduce((s, a) => s + (a.reach || 0), 0),
      totalSpend: +tSpend.toFixed(2),
      paidTotals: {
        spend: +tSpend.toFixed(2),
        cpm: tImpr ? +((tSpend / tImpr) * 1000).toFixed(2) : null,
        ctr: tImpr ? +((tClicks / tImpr) * 100).toFixed(2) : null,
        roas: (tSpend > 0 && tVal > 0) ? +(tVal / tSpend).toFixed(2) : null,
        cac: (tSpend > 0 && tConv > 0) ? +(tSpend / tConv).toFixed(2) : null,
        conversions: tConv,
      },
      // Funnel over de advertenties (omni waar het bestaat). Kost per stap = spend / aantal.
      funnel: {
        impressions: tImpr, clicks: tClicks,
        addToCart: tSum("addToCart"), checkouts: tSum("checkouts"),
        purchases: tSum("purchases"), purchaseValue: +tSum("purchaseValue").toFixed(2),
        leads: tSum("leads"), igProfileVisits: tSum("igProfileVisits"),
      },
      // Ontdubbeld over de hele periode (accountniveau); null = niet gemeten.
      accountFrequency: extra.accountReach ? +extra.accountReach.frequency.toFixed(2) : null,
      accountFrequencyPrev: extra.accountReachPrev ? +extra.accountReachPrev.frequency.toFixed(2) : null,
      audience,
      topByReach: [...ads].sort((a, b) => (b.reach || 0) - (a.reach || 0)).slice(0, 3).map(slimAd),
      bestAdsByEngagement: engAds.slice(0, 3).map(slimAd),
      // Alleen los meesturen als er genoeg ads zijn om best/worst te onderscheiden.
      worstAdsByEngagement: engAds.length > 4 ? engAds.slice(-3).reverse().map(slimAd) : [],
    };
  }

  // Effectieve break-even-parameters: Config-tab als basis, live invoer van de
  // gebruiker daarbovenop. De live waarden blijven in het geheugen van deze sessie
  // (scenario's doorrekenen) en worden niet naar de sheet teruggeschreven.
  // cfg = roasConfig uit de getRoas-respons; o = live invoer van de gebruiker
  // (in de browser state.roasInputs, op de server leeg).
  function roasParams(cfg = {}, o = {}) {
    const val = (k) => (o[k] != null ? o[k] : (typeof cfg[k] === "number" ? cfg[k] : null));
    const discount = val("seasonalDiscount");
    return {
      grossMargin: val("grossMargin"),
      seasonalDiscount: discount,
      // Loopt er een seizoenskorting, dan is díé de drempel — anders volle prijs.
      // Met één klik om te zetten, zonder de sheet aan te passen.
      activeScenario: o.activeScenario || ((discount != null && discount > 0) ? "season" : "full"),
      minRoasOverride: typeof cfg.minRoas === "number" ? cfg.minRoas : null,
      fromConfig: {
        grossMargin: typeof cfg.grossMargin === "number",
        seasonalDiscount: typeof cfg.seasonalDiscount === "number",
      },
    };
  }

  // Break-even ROAS = (1 − korting) / (brutomarge − korting). Zelfde formule als
  // server-side in _config.js roasTargets(); hier client-side herhaald zodat de
  // live invoer meteen doorrekent zonder round-trip.
  function roasScenarios(p) {
    const m = p.grossMargin;
    if (m == null) return [];
    const defs = [{ key: "full", label: "Volle prijs", discount: 0 }];
    if (typeof p.seasonalDiscount === "number" && p.seasonalDiscount > 0) {
      defs.push({ key: "season", label: "Seizoenskorting", discount: p.seasonalDiscount });
    }
    return defs.map(w => {
      const margin = m - w.discount;
      return {
        ...w,
        netMargin: margin,
        breakEven: margin > 0 ? (1 - w.discount) / margin : null,
        loss: margin <= 0,
      };
    });
  }

  // De drempel waartegen kanalen en campagnes beoordeeld worden: 'Minimum ROAS'
  // uit de Config-tab wint, anders de break-even van het actieve scenario.
  function roasMinTarget(p) {
    if (p.minRoasOverride) return { value: p.minRoasOverride, source: "Minimum ROAS (Config-tab)" };
    const scenarios = roasScenarios(p);
    const active = scenarios.find(w => w.key === p.activeScenario) || scenarios[0];
    if (!active) return { value: null, source: null };
    if (active.loss) return { value: null, source: `${active.label} — geen marge over`, loss: true };
    return { value: active.breakEven, source: `break-even ${active.label.toLowerCase()}` };
  }

  // Zowel spend als omzet moeten een getal zijn: ontbrekende platformomzet (null)
  // gedeeld door spend gaf eerder 0,00× — wat 'niets verdiend' suggereert terwijl
  // we simpelweg niets meten.
  const safeRoas = (rev, spend) => (spend > 0 && rev != null && isFinite(rev) ? rev / spend : null);

  // Oordeel t.o.v. de break-even-ROAS: boven of onder de drempel, meer niet.
  // Geen 'schalen' of 'uitzetten' — het dashboard stelt niets voor (beslissing
  // eigenaar, 29-09-2026); wat je ermee doet hoort in het gesprek via de MCP.
  // `note` beschrijft alleen de afstand tot de drempel.
  function roasVerdict(roas, minRoas, spend, minSpend) {
    if (spend < minSpend) return { key: "nodata", label: "Te weinig spend", tone: "mute", note: "Te weinig besteed om betrouwbaar te meten." };
    if (roas == null) return { key: "nodata", label: "Geen data", tone: "mute", note: "Geen omzet gemeten op dit kanaal." };
    if (minRoas == null) return { key: "unknown", label: "Geen drempel", tone: "mute", note: "Zonder brutomarge is er geen break-even." };
    const pct = Math.round((roas / minRoas - 1) * 100);
    const gap = `${pct >= 0 ? "+" : "−"}${Math.abs(pct)}% t.o.v. de drempel`;
    if (roas < minRoas) return { key: "below", label: "Onder break-even", tone: "bad", note: gap };
    return { key: "above", label: "Boven break-even", tone: "good", note: gap };
  }

  // GA4 kan omzet niet per campagne toewijzen zonder sluitende UTM-tagging, dus
  // campagnes worden beoordeeld op platformomzet. Die claimt structureel meer dan
  // GA4 meet; we schalen hem daarom met de verhouding GA4/platform van het kanaal
  // zélf, zodat de campagne-ROAS op dezelfde meetlat ligt als de break-even.
  // r = de getRoas-respons, min = roasMinTarget(...).
  function roasCampaignRows(r, min) {
    if (!r?.current) return [];
    const out = [];
    for (const c of (r.channels || [])) {
      const d = r.current.channels[c.key];
      if (!d || !d.campaigns?.length) continue;
      // Zonder omzetveld van de connector is er per campagne géén omzet bekend.
      // Een ROAS van 0 zou dan 'onder break-even' opleveren terwijl we niets
      // meten — die campagnes krijgen expliciet geen oordeel.
      const noRevenue = d.platformRevenueAvailable === false;
      const ratio = (!noRevenue && d.platformRevenue > 0 && d.ga4Revenue != null)
        ? d.ga4Revenue / d.platformRevenue : null;
      for (const camp of d.campaigns) {
        const platRoas = noRevenue ? null : safeRoas(camp.platformRevenue, camp.spend);
        const corrected = (platRoas != null && ratio != null) ? platRoas * ratio : null;
        const judged = corrected != null ? corrected : platRoas;
        out.push({
          channel: c.label, group: c.group, name: camp.name,
          spend: camp.spend,
          platformRevenue: noRevenue ? null : camp.platformRevenue,
          platRoas, corrected, judged, ratio, noRevenue,
          verdict: noRevenue
            ? { key: "norevenue", label: "Geen omzetdata", tone: "mute", note: `${c.label} levert geen omzet per campagne; alleen het kanaaltotaal is gemeten.` }
            : roasVerdict(judged, min.value, camp.spend, 25),
        });
      }
    }
    return out.sort((a, b) => b.spend - a.spend);
  }

  // Het conversiecijfer dat de hele tab gebruikt: het ingestelde hoofddoel als dat
  // meetbaar is, anders álle key events samen. Dat verschil is groot (bij een klant
  // 2.112 formulieren tegenover 72.004 key events), dus het label zegt welk van de
  // twee je ziet.
  function webGoal(w) {
    const on = !!(w && w.website && w.website.goalAvailable);
    // Een doel kan ingesteld zijn terwijl de eventnaam leeg terugkomt; dan is het
    // label null en viel elke .toLowerCase() erop om.
    const label = on
      ? (w.website.goalLabel || w.website.goalEvent || "Hoofddoel")
      : "Conversies";
    return {
      on,
      label,
      sub: on ? `GA4-event ${w.website.goalEvent}` : "alle key events samen",
      valueOf: (t) => (!t ? null : (on ? t.goalConversions : t.conversions)),
      rateOf: (t) => (!t ? null : (on ? t.goalConversionRate : t.conversionRate)),
      rowOf: (r) => (!r ? null : (on ? r.goalConversions : r.conversions)),
    };
  }

  const GEO_SPLIT = [
    ["correct_entity", "herkend als juiste entiteit", "ok"],
    ["correct_entity_wrong_description", "juiste entiteit, fout omschreven", "wrong"],
    ["namesake", "verward met naamgenoot", "namesake"],
    ["invented", "verzonnen aanbod", "invented"],
    ["generic_no_entity", "geen entiteit (algemene uitleg)", "generic"],
  ];

  function geoCtx(g) {
    const all = g.measurements || [];
    const full = all.filter(m => m.kind === "full");
    return { g, full, cur: full[full.length - 1] || null, prev: full.length > 1 ? full[full.length - 2] : null, latest: all[all.length - 1] || null };
  }

  // null = niet gemeten · 0 niet genoemd · 1 juist · 2 fout omschreven (één pass volstaat)
  function geoCell(m, engineId, n) {
    const passes = m?.runs?.[engineId]?.[n];
    if (!passes || !passes.length) return null;
    if (passes.includes(2)) return 2;
    if (passes.includes(1)) return 1;
    return 0;
  }

  const geoPct = (a, b) => (b ? Math.round((a / b) * 100) : null);

  function geoMention(g, m, types, engineIds) {
    const ids = engineIds || g.engines.map(e => e.id);
    let hit = 0, of = 0, ok = 0, wrong = 0;
    if (m) g.prompts.filter(p => !types || types.includes(p.type)).forEach(p => ids.forEach(e => {
      const c = geoCell(m, e, p.n);
      if (c == null) return;
      of++; if (c > 0) hit++; if (c === 1) ok++; if (c === 2) wrong++;
    }));
    return { hit, of, ok, wrong, pct: geoPct(hit, of) };
  }

  const GEO_UNBRANDED = ["category", "comparison", "how-to", "problem"];

  function geoReadiness(m) {
    const c = m?.checks || [];
    const n = s => c.filter(x => x.status === s).length;
    return { pass: n("pass"), fail: n("fail"), unk: n("unknown"), total: c.length };
  }

  function geoSov(g, m) {
    if (!m?.brandCounts || !g.competitors.length) return null;
    const set = [g.brand.name, ...g.competitors].filter(Boolean);
    const tot = set.reduce((a, b) => a + (m.brandCounts[b] || 0), 0);
    return { tot, rows: set.map(b => ({ brand: b, n: m.brandCounts[b] || 0, pct: tot ? (m.brandCounts[b] || 0) / tot * 100 : null })) };
  }

  function geoSplitCounts(m) {
    const out = { total: 0 };
    GEO_SPLIT.forEach(([k]) => { out[k] = 0; });
    (m?.brandSplit || []).forEach(r => { out[r.class] = (out[r.class] || 0) + 1; out.total++; });
    return out;
  }

  function geoBlocks(g, m) {
    const r = geoReadiness(m);
    const brand = geoMention(g, m, ["brand"]);
    const sc = geoSplitCounts(m);
    const sov = geoSov(g, m);
    return {
      r, brand, sc,
      lees: m && r.total ? r.pass : null,
      herk: brand.pct,
      herkCorrect: geoPct(sc.correct_entity, sc.total),
      descr: brand.hit ? geoPct(brand.ok, brand.hit) : null,
      cat: geoMention(g, m, ["category"]).pct,
      exp: geoMention(g, m, ["how-to", "problem"]).pct,
      vert: m?.externalCitations ?? null,
      voor: geoMention(g, m, ["comparison"]).pct,
      sovOwn: sov ? (sov.rows.find(x => x.brand === g.brand.name)?.pct ?? null) : null,
    };
  }


  /* ---------- Periodes ---------- */

  // Vorige periode van dezelfde lengte, direct ervoor. Op de middag gerekend,
  // zodat een zomertijdwissel geen dag laat verspringen.
  function prevPeriod(start, end) {
    const days = Math.round((webAtNoon(end) - webAtNoon(start)) / 86400000) + 1;
    const e = webAtNoon(start); e.setDate(e.getDate() - 1);
    const s = new Date(e); s.setDate(s.getDate() - (days - 1));
    const iso = (dt) => ymd(dt.getFullYear(), dt.getMonth(), dt.getDate());
    return { start: iso(s), end: iso(e) };
  }

  // Zelfde dagen, één jaar eerder. 29 februari bestaat niet elk jaar → terugvallen
  // op de laatste dag van die maand i.p.v. stil doorschuiven naar 1 maart.
  function yearAgoPeriod(range) {
    const shift = (iso) => {
      const [y, m, d] = iso.split("-").map(Number);
      const py = y - 1, pm = m - 1;
      return ymd(py, pm, Math.min(d, lastDayOf(py, pm)));
    };
    return { start: shift(range.start), end: shift(range.end) };
  }

  /* ---------- ROAS: omzetdefinitie en samenvatting ---------- */

  // Actieve omzetdefinitie: een expliciete keuze wint, anders 'Oordeel op' uit de
  // Config-tab, anders GA4. Zonder GA4-property is platformomzet de enige bron.
  function roasModeOf(r, override) {
    if (override) return override;
    if (r && r.hasGa4 === false) return "platform";
    return r?.roasConfig?.verdictSource || "ga4";
  }

  // Omzet van een kanaal of groep volgens de definitie. Ontbreekt de bron, dan
  // null (en dus een streepje), nooit 0.
  function roasRevenueByMode(obj, mode) {
    if (mode === "platform") {
      return obj.platformRevenueAvailable === false ? null : obj.platformRevenue;
    }
    return obj.ga4Available === false ? null : obj.ga4Revenue;
  }

  // Compacte samenvatting van de ROAS-tab: dezelfde drempel, dezelfde
  // omzetdefinitie en dezelfde oordelen als op het scherm, zonder de live
  // invoer (die bestaat alleen in de browser).
  function buildRoasSummary(r, opts = {}) {
    if (!r || !r.current) return null;
    const round = (n, d = 2) => (n == null || !isFinite(n)) ? null : +n.toFixed(d);
    const mode = roasModeOf(r, opts.mode || null);
    const params = roasParams(r.roasConfig || {}, {});
    const min = roasMinTarget(params);
    const cur = r.current, prev = r.previous;

    const totalsOf = (p) => {
      if (!p || !p.totals) return null;
      const t = p.totals;
      const ga4 = t.revenueAvailable === false ? null : t.revenue;
      const plat = t.platformRevenue != null ? t.platformRevenue : null;
      return {
        spend: round(t.spend),
        ga4Revenue: round(ga4),
        platformRevenue: round(plat),
        blendedRoasGa4: round(safeRoas(ga4, t.spend)),
        blendedRoasPlatform: round(safeRoas(plat, t.spend)),
      };
    };

    const channels = (r.channels || []).map(c => {
      const d = (cur.channels || {})[c.key] || {};
      const pd = prev ? ((prev.channels || {})[c.key] || {}) : null;
      const ga4Roas = safeRoas(d.ga4Available === false ? null : d.ga4Revenue, d.spend);
      const platRoas = d.platformRevenueAvailable === false ? null : safeRoas(d.platformRevenue, d.spend);
      const judged = safeRoas(roasRevenueByMode(d, mode), d.spend);
      return {
        channel: c.label,
        group: c.group,
        spend: round(d.spend || 0),
        roasGa4: round(ga4Roas),
        roasPlatform: round(platRoas),
        roasJudged: round(judged),
        roasJudgedPrevYear: pd ? round(safeRoas(roasRevenueByMode(pd, mode), pd.spend)) : null,
        verdict: roasVerdict(judged, min.value, d.spend || 0, 25).label,
        // Aan weerszijden van de drempel: beslis dan niet op één bron.
        sourcesDisagree: !!(min.value && ga4Roas != null && platRoas != null
          && (ga4Roas < min.value) !== (platRoas < min.value)),
        note: d.error || (d.degradedReason ? "platformomzet niet beschikbaar voor deze connector" : null),
      };
    });

    const groups = ["social", "search"].map(k => {
      const g = (cur.groups || {})[k];
      if (!g || !g.channels || !g.channels.length) return null;
      const judged = safeRoas(roasRevenueByMode(g, mode), g.spend);
      return {
        group: k === "social" ? "paid social" : "paid search",
        spend: round(g.spend),
        roasJudged: round(judged),
        verdict: roasVerdict(judged, min.value, g.spend, 25).label,
        unmatchedGa4Revenue: round(g.unmatchedGa4Revenue || 0),
      };
    }).filter(Boolean);

    const campaigns = roasCampaignRows(r, min).slice(0, 15).map(c => ({
      channel: c.channel,
      campaign: String(c.name || "").slice(0, 120),
      spend: round(c.spend),
      roasPlatform: round(c.platRoas),
      roasCorrectedToGa4: round(c.corrected),
      verdict: c.verdict.label,
      verdictNote: c.verdict.note,
    }));

    const daily = Array.isArray(cur.daily) ? cur.daily : [];
    return {
      period: r.period || null,
      comparePeriod: r.comparePeriod || null,
      lastDataDate: daily.length ? daily[daily.length - 1].date : null,
      verdictBasis: mode === "platform" ? "platform-omzet (wat het kanaal claimt)" : "GA4-omzet (last click)",
      threshold: {
        minRoas: round(min.value),
        source: min.source,
        scenarios: roasScenarios(params).map(w => ({
          scenario: w.label, discount: w.discount, breakEvenRoas: round(w.breakEven), loss: w.loss,
        })),
      },
      totals: totalsOf(cur),
      previousYearTotals: totalsOf(prev),
      groups,
      channels,
      campaigns,
      pendingChannels: (r.pending || []).map(c => c.label),
      note: "GA4- en platformomzet zijn twee meetlatten voor dezelfde omzet: nooit optellen.",
    };
  }

  /* ---------- Doelen (tab Doelen) ---------- */

  // KPI's, objectives en hun key results als één platte lijst.
  function flattenGoals(goals) {
    const out = [];
    for (const g of goals || []) {
      out.push(g);
      for (const kr of g.keyResults || []) out.push(kr);
    }
    return out;
  }

  // De meetvensters die getGoalMetrics moet ophalen: één per doelperiode met een
  // bekende meetbron, alleen als de periode al begonnen is.
  function goalMetricRanges(goals) {
    const ranges = new Map();
    for (const g of flattenGoals(goals)) {
      if (!g.source || !GOAL_METRICS[g.source]) continue;
      const r = goalRange(g.period);
      if (r && r.measureEnd) ranges.set(`${r.start}|${r.measureEnd}`, { start: r.start, end: r.measureEnd });
    }
    return [...ranges.values()];
  }

  // getGoalMetrics-respons → de map die goalState als ctx.goalMetrics verwacht.
  function goalMetricsMap(res) {
    if (!res) return null;
    if (res.__error) return { __error: res.__error };
    const map = {};
    for (const r of res.results || []) map[`${r.start}|${r.end}`] = r;
    map.__available = res.available || {};
    return map;
  }

  function buildGoalsSummary(goals, ctx = {}) {
    const round = (n, d = 2) => (n == null || !isFinite(n)) ? null : +n.toFixed(d);
    const one = (g) => {
      const st = goalState(g, ctx);
      return {
        kind: g.kind,
        goal: g.title,
        period: g.period || null,
        target: st.target,
        actual: st.actual,
        unit: st.unit || null,
        pctOfTarget: st.pct != null ? round(st.pct * 100, 1) : null,
        // Verwachte stand vandaag bij een optelbare meetbron in een lopende periode.
        expectedPctToday: st.expected != null ? round(st.expected * 100, 1) : null,
        status: st.status ? st.status.tekst : null,
        measuredBy: st.m ? st.m.label : null,
        basis: st.bron || null,
        note: st.note || null,
      };
    };
    return (goals || []).map(g => {
      const out = one(g);
      if (g.keyResults && g.keyResults.length) out.keyResults = g.keyResults.map(one);
      return out;
    });
  }

  return {
    // basis en opmaak
    fmt, safeUrl, TYPE_LABELS, friendlyType, arrayOrEmpty,
    // organisch: normalisatie en benchmark
    aggregatePosts, postGroupOf, benchmarkPosts,
    // Windsor → dashboardvorm
    normalizeWindsorIgPost, normalizeWindsorFbPost, numFromAction, normalizeWindsorAdRow,
    sumAdsRowsInWeek, adCreativeType, aggregateWindsorAds, transformWindsorDashboard,
    buildKpi, enumerateWeeks, inWeek, sumPostsField, countPostsInWeek, gradientFor,
    // Meta Ads-labels
    OBJECTIVE_LABELS, CTA_LABELS, humanCode, objectiveLabel, ctaLabel,
    // samenvattingen voor de agents en de MCP-koppeling
    buildAnalysisSummary, buildAdsSummary, buildWebsiteSummary, buildGeoSummary,
    buildRoasSummary, buildGoalsSummary,
    // website en periodes
    webGoal, prevPeriod, yearAgoPeriod,
    // doelen
    GOAL_METRICS, MAANDEN, goalRange, goalState, flattenGoals, goalMetricRanges, goalMetricsMap,
    // GEO
    GEO_SPLIT, GEO_UNBRANDED, geoCtx, geoCell, geoPct, geoMention, geoReadiness, geoSov,
    geoSplitCounts, geoBlocks,
    // ROAS
    roasParams, roasScenarios, roasMinTarget, safeRoas, roasVerdict, roasCampaignRows,
    roasModeOf, roasRevenueByMode,
  };
});
