/* ==========================================================
   _googleads.js — Google Ads voor de Ads-pagina (leadweergave)
   ==========================================================
   Gedeelde module (underscore-prefix = geen Vercel-route). Alleen rekenwerk op
   rijen die windsor.js al opgehaald en per account gefilterd heeft; geen fetch,
   geen klantkennis.

   Veldnamen geverifieerd via Windsor get_fields/get_data op Spotto (25-09 en
   29-09-2026). Nooit de all_-velden: bij Spotto telt all_conversions ook
   pageviews mee (680.000 tegenover 1.230 echte conversies).

   Ratio's rekenen we altijd zelf uit de tellers (CTR, CPC, kosten per conversie):
   een gemiddelde van daggemiddelden klopt niet. Daarom vragen we ctr/cpc ook
   nooit op.
   ========================================================== */

// Kern: één rij per campagne per dag.
const CAMPAIGN_FIELDS = 'date,campaign_id,campaign,campaign_type,campaign_status,impressions,clicks,totalcost,conversions';
// Vergelijkingsperiode: alleen de optelbare tellers.
const CAMPAIGN_PREV_FIELDS = 'date,campaign,impressions,clicks,totalcost,conversions';
// Impression share per campagne per dag. Alleen zoekcampagnes hebben een waarde;
// display geeft null. Share + lost-budget + lost-rank telt per rij op tot 1.
const IS_FIELDS = 'date,campaign,impressions,search_impression_share,search_budget_lost_impression_share,search_rank_lost_impression_share';
// Detail: zeer hoge korrel (bij Spotto ~3.500 zoektermen per dag), dus een kort venster.
const SEARCH_TERM_FIELDS = 'date,campaign,ad_group_name,search_term,impressions,clicks,totalcost,conversions';
const DEVICE_FIELDS = 'date,campaign,device,impressions,clicks,totalcost,conversions';
// Zonder impressions/clicks: Google weigert die met conversion_action_name.
const CONV_ACTION_FIELDS = 'date,campaign,conversion_action_name,conversions';

const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
// Google meldt een share onder 10% als 0,0999 ('< 10%'). Een waarde boven 1
// is een percentage dat als getal binnenkwam.
const share = (v) => {
  if (v == null || v === '') return null;
  let n = Number(v);
  if (!isFinite(n)) return null;
  if (n > 1) n = n / 100;
  return n >= 0 && n <= 1 ? n : null;
};
const div = (a, b) => (b > 0 ? a / b : null);

function ratios(t) {
  return {
    ...t,
    ctr: div(t.clicks, t.impressions),
    cpc: div(t.cost, t.clicks),
    cpa: div(t.cost, t.conversions),
    convRate: div(t.conversions, t.clicks),
  };
}

function emptyTotals() { return { cost: 0, impressions: 0, clicks: 0, conversions: 0 }; }
function addRow(t, r) {
  t.cost += num(r.totalcost);
  t.impressions += num(r.impressions);
  t.clicks += num(r.clicks);
  t.conversions += num(r.conversions);
}

// Campagne-id's blijven tekst (te groot voor een JS-getal); de naam is de
// terugval als de sheet geen id heeft.
const campKey = (r) => String(r.campaign_id || r.campaign || '(onbekend)');

function summarizeCampaigns(rows = []) {
  const totals = emptyTotals();
  const byCamp = new Map();
  const byDay = new Map();
  for (const r of rows) {
    if (!r) continue;
    addRow(totals, r);
    const k = campKey(r);
    if (!byCamp.has(k)) {
      byCamp.set(k, { id: r.campaign_id ? String(r.campaign_id) : null, name: r.campaign || '(zonder naam)',
        type: r.campaign_type || null, status: r.campaign_status || null, lastDate: null, ...emptyTotals() });
    }
    const c = byCamp.get(k);
    addRow(c, r);
    // Status en type van de jongste rij: een campagne die deze maand gepauzeerd
    // werd, is nu gepauzeerd.
    const d = String(r.date || '').slice(0, 10);
    if (d && (!c.lastDate || d >= c.lastDate)) {
      c.lastDate = d;
      if (r.campaign_status) c.status = r.campaign_status;
      if (r.campaign_type) c.type = r.campaign_type;
    }
    if (d) {
      if (!byDay.has(d)) byDay.set(d, { date: d, ...emptyTotals() });
      addRow(byDay.get(d), r);
    }
  }
  const campaigns = [...byCamp.values()]
    .filter(c => c.cost > 0 || c.impressions > 0 || c.conversions > 0)
    .map(ratios)
    .sort((a, b) => b.cost - a.cost);
  const daily = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { totals: ratios(totals), campaigns, daily };
}

/**
 * Impression share over een periode, per campagne en in totaal. Een share is een
 * ratio per dag, dus middelen mag niet: we wegen naar de vertoningen waar de
 * campagne recht op had (vertoningen ÷ share). Lost-budget en lost-rank delen
 * diezelfde noemer. Rijen zonder share (display) tellen niet mee.
 */
function summarizeImpressionShare(rows = []) {
  const mk = () => ({ impressions: 0, eligible: 0, lostBudget: 0, lostRank: 0, belowTen: 0, days: 0 });
  const total = mk();
  const byName = new Map();
  for (const r of rows) {
    const s = share(r && r.search_impression_share);
    const impr = num(r && r.impressions);
    if (s == null || s <= 0 || impr <= 0) continue;
    const eligible = impr / s;
    const lb = share(r.search_budget_lost_impression_share) || 0;
    const lr = share(r.search_rank_lost_impression_share) || 0;
    const name = r.campaign || '(zonder naam)';
    if (!byName.has(name)) byName.set(name, mk());
    for (const t of [total, byName.get(name)]) {
      t.impressions += impr;
      t.eligible += eligible;
      t.lostBudget += eligible * lb;
      t.lostRank += eligible * lr;
      t.days += 1;
      if (Math.abs(s - 0.0999) < 0.00005) t.belowTen += 1;
    }
  }
  const fin = (t) => (t.eligible > 0 ? {
    share: t.impressions / t.eligible,
    lostBudget: t.lostBudget / t.eligible,
    lostRank: t.lostRank / t.eligible,
    impressions: t.impressions,
    // Aandeel van de dagen waarop Google '< 10%' meldde: dan is de share hier een
    // bovengrens voor de vertoningen en een ondergrens voor het gemiste deel.
    belowTenShare: t.days ? t.belowTen / t.days : 0,
  } : null);
  const byCampaign = {};
  for (const [name, t] of byName) byCampaign[name] = fin(t);
  return { total: fin(total), byCampaign };
}

// Groepeer rijen op één of meer sleutelvelden en tel de tellers op.
function groupBy(rows, keyFields, limit) {
  const map = new Map();
  for (const r of rows || []) {
    if (!r) continue;
    const key = keyFields.map(f => String(r[f] == null ? '' : r[f]).trim()).join('\u0001');
    if (!key.replace(/\u0001/g, '')) continue;
    if (!map.has(key)) {
      const g = emptyTotals();
      for (const f of keyFields) g[f] = r[f] == null ? null : String(r[f]).trim();
      map.set(key, g);
    }
    addRow(map.get(key), r);
  }
  const out = [...map.values()].map(ratios).sort((a, b) => b.cost - a.cost || b.conversions - a.conversions);
  return { rows: limit ? out.slice(0, limit) : out, count: out.length };
}

function summarizeSearchTerms(rows, limit = 200) {
  const g = groupBy(rows, ['search_term'], limit);
  // In hoeveel campagnes/advertentiegroepen een term opdook zegt iets over
  // overlap tussen campagnes; de rest van die kolommen laten we weg.
  const spread = new Map();
  for (const r of rows || []) {
    if (!r || !r.search_term) continue;
    const k = String(r.search_term).trim();
    if (!spread.has(k)) spread.set(k, new Set());
    spread.get(k).add(r.campaign || '');
  }
  g.rows.forEach(t => { t.campaigns = spread.get(t.search_term)?.size || null; });
  // Kosten zonder één conversie: de lijst waar je uitsluitingswoorden uit haalt.
  const all = groupBy(rows, ['search_term']).rows;
  const noConv = all.filter(t => t.conversions === 0 && t.cost > 0);
  g.wasted = { cost: noConv.reduce((a, t) => a + t.cost, 0), terms: noConv.length };
  return g;
}

function summarizeDevices(rows) { return groupBy(rows, ['device']); }

// Welke conversieacties de 'conversies' zijn. Alleen conversies: Google staat
// geen vertoningen of kliks toe naast de actienaam, dus geen kosten per actie.
function summarizeConversionActions(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const name = r && r.conversion_action_name ? String(r.conversion_action_name).trim() : null;
    if (!name) continue;
    map.set(name, (map.get(name) || 0) + num(r.conversions));
  }
  const total = [...map.values()].reduce((a, n) => a + n, 0);
  return [...map.entries()]
    .map(([name, conversions]) => ({ name, conversions, share: total > 0 ? conversions / total : null }))
    .filter(a => a.conversions > 0)
    .sort((a, b) => b.conversions - a.conversions);
}

module.exports = {
  CAMPAIGN_FIELDS, CAMPAIGN_PREV_FIELDS, IS_FIELDS, SEARCH_TERM_FIELDS, DEVICE_FIELDS, CONV_ACTION_FIELDS,
  summarizeCampaigns, summarizeImpressionShare, summarizeSearchTerms, summarizeDevices, summarizeConversionActions,
};
