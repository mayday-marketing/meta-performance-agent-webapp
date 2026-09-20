/* ==========================================================
   _channels.js — registry van betaalde kanalen (ROAS-tab)
   ==========================================================
   Gedeelde module (underscore-prefix = geen Vercel-route). Eén bron van waarheid
   voor: welke betaalde kanalen bestaan, in welke groep ze horen (paid social /
   paid search), uit welke Windsor-connector hun spend komt en hoe hun verkeer in
   GA4 te herkennen is.

   Een kanaal verschijnt in het dashboard zodra er een account-id voor in de
   Config-tab van de klantsheet staat (zie _config.js). Zo groeit de tab mee:
   staat er een TikTok-ad-account in de sheet, dan komt TikTok erbij zonder dat
   hier code hoeft te veranderen.

   TWEE ROAS-DEFINITIES per kanaal — bewust naast elkaar:
   - GA4-ROAS      = GA4 purchase_revenue (last click) / spend van het platform.
                     Eén consistente meetlat, telt niet dubbel over kanalen heen.
   - Platform-ROAS = de omzet die het platform zélf claimt / spend.
                     Hoger (view-through + eigen attributievenster); kanalen
                     claimen dezelfde sale, dus optellen mag niet.

   VELDNAMEN: alleen `facebook` is geverifieerd via Windsor's get_fields. Voor de
   nog niet gekoppelde connectors staan kandidaat-veldnamen in `revenueFields` /
   `convFields`; windsor.js probeert ze en valt terug op enkel spend als Windsor
   een veld afwijst. De GA4-ROAS blijft dan gewoon werken.
   ========================================================== */

// GA4-medium dat betaald verkeer aanduidt. Zonder deze check zou organisch
// Facebook-verkeer (medium=referral) als Meta-advertentieomzet meetellen.
const PAID_MEDIUM_RE = /cpc|ppc|paid|display|retargeting|remarketing|banner/i;

// GA4 default channel groups per groep — voor de restpost ('overig betaald'),
// zodat betaalde omzet die geen enkel kanaal matcht zichtbaar blijft i.p.v. weg
// te vallen. 'Cross-network' (PMax, Advantage+) valt bewust onder search noch
// social: die krijgt zijn eigen restregel.
const GA4_GROUPS = {
  social: ['paid social'],
  search: ['paid search', 'paid shopping'],
  other: ['cross-network', 'paid video', 'paid other', 'display'],
};

const CHANNELS = [
  /* ---------------- Paid social ---------------- */
  {
    key: 'meta',
    label: 'Meta Ads',
    group: 'social',
    connector: 'facebook',          // Windsor-slug (Meta Ads, ondanks de naam)
    campaignField: 'campaign_name',
    spendField: 'spend',
    revenueFields: ['action_values_omni_purchase', 'action_values_purchase'],
    convFields: ['actions_omni_purchase', 'actions_purchase'],
    ga4Source: /^(facebook|instagram|meta|fb|ig|an|audiencenetwork)\b/i,
    verified: true,
  },
  {
    key: 'tiktok',
    label: 'TikTok Ads',
    group: 'social',
    connector: 'tiktok',
    campaignField: 'campaign',
    spendField: 'totalcost',
    revenueFields: ['conversion_value', 'total_purchase_value', 'total_complete_payment'],
    convFields: ['conversions', 'total_purchase'],
    ga4Source: /^tiktok/i,
    verified: false,
  },
  {
    key: 'pinterest',
    label: 'Pinterest Ads',
    group: 'social',
    connector: 'pinterest',
    campaignField: 'campaign',
    spendField: 'totalcost',
    revenueFields: ['conversion_value', 'total_conversion_value'],
    convFields: ['conversions'],
    ga4Source: /^pinterest/i,
    verified: false,
  },
  {
    key: 'snapchat',
    label: 'Snapchat Ads',
    group: 'social',
    connector: 'snapchat',
    campaignField: 'campaign',
    spendField: 'totalcost',
    revenueFields: ['conversion_purchases_value', 'conversion_value'],
    convFields: ['conversion_purchases'],
    ga4Source: /^snapchat/i,
    verified: false,
  },
  {
    key: 'linkedin',
    label: 'LinkedIn Ads',
    group: 'social',
    connector: 'linkedin',
    campaignField: 'campaign',
    spendField: 'totalcost',
    revenueFields: ['conversion_value', 'external_website_conversions_value'],
    convFields: ['conversions', 'external_website_conversions'],
    ga4Source: /^linkedin/i,
    verified: false,
  },

  /* ---------------- Paid search ---------------- */
  {
    key: 'google_ads',
    label: 'Google Ads',
    group: 'search',
    connector: 'google_ads',
    campaignField: 'campaign',
    spendField: 'totalcost',
    revenueFields: ['conversion_value', 'conversionvalue', 'all_conversion_value'],
    convFields: ['conversions', 'all_conversions'],
    ga4Source: /^google\b/i,
    verified: false,
  },
  {
    key: 'bing',
    label: 'Microsoft Ads (Bing)',
    group: 'search',
    connector: 'bing',
    campaignField: 'campaign',
    spendField: 'totalcost',
    revenueFields: ['revenue', 'conversion_value'],
    convFields: ['conversions'],
    ga4Source: /^(bing|microsoft|msn)\b/i,
    verified: false,
  },
  {
    key: 'amazon_ads',
    label: 'Amazon Ads',
    group: 'search',
    connector: 'amazon_ads',
    campaignField: 'campaign',
    spendField: 'totalcost',
    revenueFields: ['attributed_sales14d', 'sales', 'conversion_value'],
    convFields: ['attributed_conversions14d', 'conversions'],
    ga4Source: /^amazon/i,
    verified: false,
  },
  {
    key: 'chatgpt_ads',
    label: 'ChatGPT Ads',
    group: 'search',
    connector: null,                 // nog geen Windsor-connector — GA4-omzet only
    campaignField: null,
    spendField: null,
    revenueFields: [],
    convFields: [],
    ga4Source: /^(chatgpt|openai)/i,
    verified: false,
  },
];

const BY_KEY = Object.fromEntries(CHANNELS.map(c => [c.key, c]));

// Config-sleutel waaronder het account-id van een kanaal in de Config-tab staat.
// Gelijk aan de connector-slug, zodat _config.js en windsor.js dezelfde sleutel delen.
function configKey(ch) { return ch.connector; }

/**
 * De kanalen die voor déze klant actief zijn: alles waarvoor een account-id in
 * de Config-tab (of CLIENTS.windsor_accounts) staat. Kanalen zonder connector
 * (bv. ChatGPT Ads) komen nooit als 'actief' terug — die hebben geen spend-bron.
 */
function activeChannels(accounts = {}) {
  return CHANNELS.filter(c => c.connector && accounts[c.connector]);
}

/** Kanalen zonder account-id: tonen we als 'niet gekoppeld' i.p.v. ze te verzwijgen. */
function pendingChannels(accounts = {}) {
  return CHANNELS.filter(c => !c.connector || !accounts[c.connector]);
}

/**
 * Bepaalt bij welk kanaal een GA4-rij hoort, op basis van `session_source_medium`
 * ("facebook / cpc"). Geeft null terug voor organisch/onbetaald verkeer — die
 * omzet hoort in het totaal, niet bij een advertentiekanaal.
 */
function matchGa4Channel(sourceMedium) {
  const raw = String(sourceMedium || '').trim();
  if (!raw) return null;
  const [sourcePart, mediumPart] = raw.split('/').map(s => (s || '').trim());
  if (!PAID_MEDIUM_RE.test(mediumPart)) return null;
  const hit = CHANNELS.find(c => c.ga4Source.test(sourcePart));
  return hit ? hit.key : null;
}

/** Groep ('social' | 'search' | 'other') van een GA4 default channel group. */
function ga4GroupOf(channelGroup) {
  const g = String(channelGroup || '').trim().toLowerCase();
  for (const [key, names] of Object.entries(GA4_GROUPS)) {
    if (names.includes(g)) return key;
  }
  return null;
}

module.exports = {
  CHANNELS, BY_KEY, GA4_GROUPS, PAID_MEDIUM_RE,
  activeChannels, pendingChannels, matchGa4Channel, ga4GroupOf, configKey,
};
