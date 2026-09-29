/* ==========================================================
   cron-demo.js — de demo-dataset elke nacht laten meeschuiven
   ==========================================================
   Een demo-account met data die op 19 september 2026 ophoudt is na een maand
   een demo met een gat. Deze route schuift daarom elke nacht álle datums in de
   demo-datasheet één dag op, zodat de laatste dag altijd gisteren is.

   WAAROM SCHUIVEN EN NIET AANVULLEN
   Er zit een verhaal in die dataset: Black Friday, de creative fatigue van
   augustus, de ChatGPT Ads-test. Wie er elke dag een nieuwe dag bij genereert,
   laat die gebeurtenissen steeds verder wegzakken tot ze niets meer illustreren.
   Schuiven houdt ze op een vaste afstand van vandaag: de creative fatigue zit
   altijd 'vorige maand'. De reeks blijft even lang, de vorm blijft identiek,
   alleen de etiketten verschuiven.

   ISOLATIE — LEES DIT VOOR JE IETS WIJZIGT
   Deze route SCHRIJFT in een Google Sheet. Dat is het enige stuk van deze app
   dat dat doet. Drie sloten, en ze moeten alle drie blijven staan:
     1. De sheet-id komt uit DEMO_SHEET_ID, een env var. Nooit uit het request.
        Zonder die env var doet de route niets.
     2. De route weigert te draaien als DEMO_SHEET_ID gelijk is aan de
        dataSheetId of sheetId van een échte klant in CLIENTS. Een verkeerd
        geplakte id kan dus geen klantdata verschuiven.
     3. Alleen de datumkolom wordt herschreven. Geen enkele andere cel.

   IDEMPOTENT PER TAB
   De stand staat in een verborgen tab `_demo_state`: per tab de datum waar hij
   naartoe geschoven is. Loopt de functie halverwege vast, dan pakt de volgende
   run alleen de tabs op die achterlopen — de dataset kan dus niet half
   verschoven achterblijven, en een dubbele run schuift niets twee keer.
   ========================================================== */

const { getAccessToken } = require('./_config');

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const STATE_TAB = '_demo_state';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

// Kolomkoppen die een datum dragen, in volgorde van voorkeur. Een tab met
// meerdere (Shopify-orders heeft er twee) schuift alleen de eerste die hij vindt
// — de andere zijn afgeleid en staan in dezelfde rij.
const DATE_HEADERS = ['date', 'datum', 'timestamp', 'created_at', 'sent_at',
                      'create_time', 'post_created_time', 'month'];

const DAY_MS = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);

// 'Gisteren' in Europe/Brussels, niet in UTC: anders springt de demo om
// middernacht UTC en dat is hier één of twee uur 's nachts.
function yesterdayBrussels() {
  const nu = new Date(new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Brussels' }));
  return new Date(Date.UTC(nu.getFullYear(), nu.getMonth(), nu.getDate()) - DAY_MS);
}

async function api(path, token, init) {
  const res = await fetch(`${SHEETS}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const tekst = await res.text();
  if (!res.ok) {
    const kort = tekst.slice(0, 300);
    if (res.status === 403) {
      throw new Error(`Google weigert (403). Het service-account heeft geen bewerkrecht op deze sheet. Deel hem als Bewerker. — ${kort}`);
    }
    throw new Error(`Sheets ${res.status}: ${kort}`);
  }
  return tekst ? JSON.parse(tekst) : {};
}

/* ---------- Datumwaarden verschuiven ----------
   Sheets levert een datumcel als serieel getal (dagen sinds 30-12-1899) of als
   tekst, afhankelijk van de celopmaak. Allebei afvangen, en het formaat
   teruggeven zoals het binnenkwam — een tab waarvan de datums ineens anders
   geschreven zijn, herkent _sheetdata.js niet meer. */
function schuif(waarde, dagen) {
  if (waarde == null || waarde === '') return waarde;

  // Serieel getal: optellen volstaat.
  if (typeof waarde === 'number') return waarde + dagen;

  const s = String(waarde).trim();

  // YYYY-MM (Klaviyo-flows, per maand). Verschuiven op dagbasis en daarna
  // terug naar een maand: over een jaar klopt dat op een maand na, en een
  // flowtabel per maand heeft geen scherpere resolutie dan dat.
  let m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, 1) + dagen * DAY_MS);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  // YYYY-MM-DD, eventueel met tijd erachter (2025-01-01T12:40:00+0200).
  m = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(s);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) + dagen * DAY_MS);
    return iso(d) + m[4];
  }

  return waarde; // onbekend formaat: met rust laten
}

// Laatste datum in een kolom, om bij de eerste run te bepalen hoever een tab
// achterloopt.
function laatsteDatum(kolom) {
  let max = null;
  for (const rij of kolom) {
    const v = rij && rij[0];
    if (v == null || v === '') continue;
    let d = null;
    if (typeof v === 'number') d = new Date(Date.UTC(1899, 11, 30) + v * DAY_MS);
    else {
      const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(String(v).trim());
      if (m) d = new Date(Date.UTC(+m[1], +m[2] - 1, +(m[3] || 1)));
    }
    if (d && !isNaN(d) && (max == null || d > max)) max = d;
  }
  return max;
}

const kolomletter = (i) => {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s;
  return s;
};

module.exports = async (req, res) => {
  // Vercel Cron stuurt een Authorization-header met CRON_SECRET. Zonder geldig
  // geheim doet deze route niets — hij schrijft, dus hij is geen open endpoint.
  const geheim = process.env.CRON_SECRET;
  const meegestuurd = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!geheim || meegestuurd !== geheim) {
    return res.status(401).json({ error: 'Niet toegestaan.' });
  }

  const sheetId = process.env.DEMO_SHEET_ID;
  if (!sheetId) {
    return res.status(200).json({ ok: true, overgeslagen: 'DEMO_SHEET_ID niet ingesteld.' });
  }

  // Slot 2: nooit de sheet van een echte klant aanraken.
  try {
    const clients = JSON.parse(process.env.CLIENTS || '{}');
    for (const [id, c] of Object.entries(clients)) {
      if (id.toLowerCase() === 'senja') continue;
      if (c && (c.dataSheetId === sheetId || c.sheetId === sheetId)) {
        return res.status(400).json({ error: `DEMO_SHEET_ID hoort bij klant '${id}'. Geweigerd.` });
      }
    }
  } catch { /* geen geldige CLIENTS: dan is er ook niets te beschermen */ }

  const doel = yesterdayBrussels();
  const begonnen = Date.now();

  try {
    const token = await getAccessToken(SHEETS_SCOPE);
    const meta = await api(`${sheetId}?fields=sheets(properties(title,gridProperties(rowCount,columnCount)))`, token);
    const tabs = (meta.sheets || []).map(s => s.properties);

    // Stand ophalen. Ontbreekt de tab, dan is dit de eerste run.
    let stand = {};
    if (tabs.some(t => t.title === STATE_TAB)) {
      const r = await api(`${sheetId}/values/${encodeURIComponent(STATE_TAB)}!A:B`, token);
      for (const [tab, datum] of (r.values || []).slice(1)) if (tab) stand[tab] = datum;
    } else {
      await api(`${sheetId}:batchUpdate`, token, {
        method: 'POST',
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: STATE_TAB, hidden: true } } }] }),
      });
    }

    const verwerkt = [];
    for (const t of tabs) {
      if (t.title === STATE_TAB) continue;

      // Koprij lezen om de datumkolom te vinden.
      const kop = await api(`${sheetId}/values/${encodeURIComponent(t.title)}!1:1`, token);
      const koppen = ((kop.values || [[]])[0] || []).map(h => String(h || '').toLowerCase().trim());
      const idx = DATE_HEADERS.map(h => koppen.indexOf(h)).find(i => i !== -1);
      if (idx == null || idx < 0) { verwerkt.push({ tab: t.title, overgeslagen: 'geen datumkolom' }); continue; }

      const letter = kolomletter(idx);
      const bereik = `${t.title}!${letter}2:${letter}${t.gridProperties.rowCount}`;
      const data = await api(
        `${sheetId}/values/${encodeURIComponent(bereik)}?valueRenderOption=UNFORMATTED_VALUE`, token);
      const kolom = data.values || [];
      if (!kolom.length) { verwerkt.push({ tab: t.title, overgeslagen: 'leeg' }); continue; }

      // Hoeveel dagen loopt deze tab achter? Bij een bekende stand: het verschil
      // met die stand. Anders: het verschil met de laatste datum in de kolom.
      let vanaf = stand[t.title] ? new Date(stand[t.title] + 'T00:00:00Z') : laatsteDatum(kolom);
      if (!vanaf || isNaN(vanaf)) { verwerkt.push({ tab: t.title, overgeslagen: 'geen leesbare datum' }); continue; }
      const dagen = Math.round((doel - vanaf) / DAY_MS);
      if (dagen === 0) { verwerkt.push({ tab: t.title, dagen: 0 }); continue; }

      const nieuw = kolom.map(rij => [schuif(rij[0], dagen)]);
      await api(`${sheetId}/values/${encodeURIComponent(bereik)}?valueInputOption=RAW`, token, {
        method: 'PUT', body: JSON.stringify({ values: nieuw }),
      });

      // Stand meteen wegschrijven, per tab. Valt de functie hierna om, dan weet
      // de volgende run precies waar hij gebleven was.
      const rijNr = Object.keys(stand).indexOf(t.title);
      stand[t.title] = iso(doel);
      const alle = Object.entries(stand);
      await api(`${sheetId}/values/${encodeURIComponent(STATE_TAB)}!A1:B${alle.length + 1}?valueInputOption=RAW`, token, {
        method: 'PUT',
        body: JSON.stringify({ values: [['tab', 'geschoven_tot'], ...alle] }),
      });
      void rijNr;

      verwerkt.push({ tab: t.title, dagen, rijen: nieuw.length });
    }

    return res.status(200).json({
      ok: true,
      doel: iso(doel),
      duurMs: Date.now() - begonnen,
      tabs: verwerkt,
    });
  } catch (e) {
    console.error('[cron-demo] mislukt:', e.message);
    return res.status(500).json({ error: e.message, doel: iso(doel), duurMs: Date.now() - begonnen });
  }
};
