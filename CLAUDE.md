# CLAUDE.md — meta-performance-agent-webapp

Guidance for Claude Code working in this repo. Read this first; it captures the
architecture and the non-obvious rules that aren't visible from any single file.

## What this is

A **multi-tenant social-media performance dashboard** for **mayday marketing**, a
Dutch marketing agency. One shared deployment serves many client brands. Each
client logs in with a code + password and sees only their own Instagram/Facebook
(organic + Meta Ads) performance, plus an AI analysis and an AI chat agent.

UI language and product copy are **Dutch**. Commit messages and code comments in
this repo are Dutch too — match that.

## Architecture (no build step)

- **Frontend:** a single static `index.html` + `app.js` (~3k lines, one IIFE) +
  `styles.css` + `data.js`. No framework, no bundler, **no `package.json`**. Edit
  and deploy as-is.
- **Backend:** Vercel serverless functions in `api/*.js` (Node, CommonJS
  `module.exports = async (req,res) => …`). Timeouts/memory set per-function in
  `vercel.json`.
- **No tests, no lint config** currently. See `evals/` for the analysis/chat
  quality harness.

## Multi-tenant model — the load-bearing rule

Every client's config lives in the **`CLIENTS` env var** (JSON), keyed by lowercase
client id: `{ "spotto": { password, sheetId, driveFolderId, brandName,
metricool_token, metricool_user_id, windsor_api_key, anthropic_api_key,
email_connector } }`. Most fields are optional; connectors are enabled per client.

**RULE: never trust a client-supplied resource identifier.** Every per-client
resource (sheetId, Drive folder, connector credentials, cache key) MUST be derived
server-side from `CLIENTS[clientId.toLowerCase()]` **after** `verifyToken`. Do not
accept a sheetId/folderId/etc. from the request body or query. The shared Google
service account and shared API keys can reach *every* client's data, so trusting a
request-supplied id = cross-tenant read/write. This app has already had two
isolation bugs (an email cache that wasn't client-keyed; a `sheetId` IDOR in
`sheets.js`) — treat any request field that names a resource as a red flag.
`metricool.js`, `windsor.js`, and `drive.js` are the correct reference pattern.

## Auth

- Login (`api/auth.js`) checks `clientId`+`password` against `CLIENTS`, returns an
  HMAC token: `base64("<clientId>:<ts>:<HMAC-SHA256(clientId:ts, AUTH_SECRET)>")`.
- Every other endpoint calls the same `verifyToken(token, clientId)` (copied into
  each file): checks the signature with `crypto.timingSafeEqual`, binds the token's
  embedded id to the supplied `clientId`, and enforces a 10h expiry.
- **`AUTH_SECRET` has no fallback** — if it's unset, the HMAC throws and all tokens
  fail closed (this is intentional). It must be set in every Vercel environment.
- The frontend stores the session (token + clientId + flags) in `sessionStorage`.

## Data sources

- **Windsor.ai** (`api/windsor.js`) — the primary live source. REST calls to
  `connectors.windsor.ai/{connector}` with the client's `windsor_api_key`.
  Connectors: `instagram` (IG organic), `facebook` (Meta **Ads**, despite the
  name), `klaviyo`/`convertkit` (email). `getDashboard` fans out IG + Meta Ads
  (campaign-level + ad-level core + non-fatal add-on calls for creative/video/
  conversions, merged by `ad_id`).
- **Metricool** (`api/metricool.js`) — alternative source for clients on Metricool.
- **Google Drive** (`api/drive.js`) — per-client brand context + raw-data CSVs/PDFs,
  read via a service-account JWT. Folder tree is a fixed convention
  (`06_PERFORMANTIE/6.4_Ruwe-Data`, `00_AI-CONTEXT`, etc.). Actions: `scan`,
  `load-period`, `load-all`, `analysis-benchmarks`, `context`.
- **Google Sheets** (`api/sheets.js`) — reads `Merkcontext`, appends analysis
  history. Sheet is resolved from `CLIENTS[clientId].sheetId` (never the request).
- **GA4** (`googleanalytics4` via Windsor) — omzetbron voor de ROAS-tab en
  hoofdbron voor de Website-tab: `purchase_revenue` per dag, totaal én per
  `session_source_medium`. Property-id uit de Config-tab (`GA4 property`).
- **Search Console** (`searchconsole` via Windsor) — organisch zoeken in de
  Website-tab: kliks, vertoningen, positie, queries en pagina's. Property uit de
  Config-tab (`Search Console site`).

## ROAS-tab (blended MER + kanaalsplitsing)

Gemodelleerd op de handmatige "Daily ROAS"-sheet van een klant. Eigen pagina
(`#page-roas`, nav `data-page="roas"`) met een **eigen periode** (month-to-date),
los van de dashboardperiode in de topbar.

- **`api/_channels.js`** — registry van betaalde kanalen: groep (`social`/`search`),
  Windsor-connector-slug, spend-/omzetveld en een regex om het kanaal in GA4's
  `session_source_medium` te herkennen. **Een kanaal verschijnt zodra er een
  account-id voor in de Config-tab staat** — nieuwe kanalen (TikTok, Bing, …)
  vergen geen codewijziging, alleen een regel in de sheet.
- **`api/windsor.js` action `getRoas`** — haalt per periode GA4-totalen, de GA4-
  uitsplitsing per source/medium en elk actief kanaal op campagne-niveau op. Doet
  dat twee keer (huidige periode + dezelfde periode vorig jaar).
- **Twee omzetdefinities, nooit opgeteld:** GA4-omzet (last click, één meetlat,
  telt niet dubbel) en platform-omzet (wat het kanaal zelf claimt, inclusief
  view-through). De UI toont ze naast elkaar en waarschuwt als ze aan weerszijden
  van de break-even-drempel uitkomen. **Welke van de twee het oordeel bepaalt**
  staat per klant in de Config-tab onder `Oordeel op` (`GA4` of `Platform`,
  default GA4); de toggle in de tab overschrijft dat voor de sessie
  (`state.roasRevenueMode = null` betekent 'volg de config').
- **Break-even** = `(1 − korting) / (brutomarge − korting)`, voor twee scenario's:
  volle prijs en de lopende seizoenskorting. De Config-tab heeft daarvoor twee
  velden — `Brutomarge` en `Seizoenskorting` — plus `Minimum ROAS` als directe
  override. Actief scenario = seizoenskorting zodra die > 0 is, anders volle prijs;
  in de tab met één klik om te zetten. Beide velden zijn daar ook live te
  overschrijven voor een scenario — dat wordt **niet** bewaard.
- **Alleen `facebook` heeft geverifieerde veldnamen.** Voor niet-gekoppelde
  connectors staan kandidaat-omzetvelden in de registry; wijst Windsor er één af,
  dan valt `fetchChannel` terug op alleen spend (`platformRevenueAvailable:false`)
  en blijft de GA4-ROAS staan. Campagnes van zo'n kanaal krijgen **geen** oordeel —
  een ROAS van 0 zou anders 'uitzetten' opleveren terwijl er niets gemeten is.
- **Gedeeltelijke config is een geldige toestand.** Ontbrekende data is *onbekend*,
  nooit nul: zonder GA4-property zijn `totals.revenue` en `ga4Revenue` `null`
  (vlaggen `revenueAvailable` / `ga4Available`), toont de UI streepjes en valt de
  tab terug op platform-omzet. Zonder `Brutomarge` is er geen drempel en dus geen
  oordeel, maar blijven alle ROAS-cijfers staan. Let op in JS: `null / getal === 0`,
  dus overal expliciet op `!= null` toetsen.
- **Isolatie:** elke nieuwe connector-slug hoort in `ACCOUNT_ID_CONNECTORS` in
  `windsor.js` (inclusief `searchconsole`). Ontbreekt hij daar, dan geldt de
  fail-closed-regel niet en geeft een niet-geconfigureerde connector álle klanten
  terug.

## Website-tab (GA4 + Search Console)

Analytics-overzicht van de site zelf (`#page-website`, nav `data-page="website"`,
`api/windsor.js` action `getWebsite`). Volgt **wel** de dashboardperiode uit de
topbar — anders dan de ROAS-tab, die een eigen maandperiode heeft.

- **Scheiding met de ROAS-tab is bewust.** Betaald verkeer staat hier als kanaal,
  maar zónder spend of ROAS. Eén cijfer, één plek; anders ontstaan twee waarheden.
- **Twee vergelijkingsperiodes worden in dezelfde call opgehaald** (vorige periode
  én vorig jaar), allebei met `detail:false` (alleen totalen + kanalen). De toggle
  in de UI wisselt daartussen zonder nieuwe fetch.
- **Hoofddoel per klant.** `Conversiedoel` in de Config-tab is een GA4-eventnaam;
  die wordt een veldnaam (`conversions_<event>`) in een **aparte, niet-fatale**
  call. Bestaat het event niet, dan valt de tab terug op `conversions` (álle key
  events samen) met de vlag `goalAvailable:false`. Dat verschil is groot — bij één
  klant 2.112 formulieren tegenover 72.004 key events — dus de UI zegt altijd welk
  van de twee je ziet. Zet het veld nooit in de hoofdcall: één verkeerde eventnaam
  sloopt dan de hele tab.
- **`Websitetype`** (`webshop`/`leads`) bepaalt of de verkoopfunnel of de
  leadweergave verschijnt. Leeg → afgeleid uit de data (gemeten omzet = webshop).
- **Gebruikers mag je niet over dagen optellen.** De totalen-call gaat daarom
  zónder `date` (GA4 ontdubbelt dan over de periode); de dagreeks is een aparte
  call met alleen optelbare maatstaven. Ook binnen één call kan GA4 bij lage
  volumes méér nieuwe dan totale gebruikers rapporteren — daarom is `newUserShare`
  `null` zodra nieuw > totaal, in plaats van afgekapt op 100%.
- **Ratio's altijd zelf uitrekenen** uit de tellers: CTR = kliks/vertoningen,
  zoekpositie gewogen naar vertoningen, engagement rate = engaged/sessions. Een
  gemiddelde van dagelijkse gemiddelden klopt niet.
- **Merkgebonden vs. niet-merkgebonden rekenen we zelf** uit de querytabel met
  merktokens. Windsor's veld `branded_vs_nonbranded` markeert alleen queries met de
  volledige domeinnaam erin: voor `spotto.be` viel de query "spotto" (2.852 kliks)
  daar onder *niet*-merkgebonden.

### Donut, verschilkolommen en zoeken in de Website-tab

- **Donut onder Kanalen** (`Charts.donut` in `charts.js`) vat GA4's dozijn channel
  groups samen tot zeven vaste groepen: organisch, betaald, direct, verwijzing,
  e-mail, AI, overig. De volgorde ligt vast en daarmee de kleur — **kleur volgt het
  kanaal, nooit zijn rangorde**, dus 'organisch' blijft dezelfde tint ook als het
  een keer het kleinste segment is. Lege groepen blijven in de legenda staan zodat
  de toewijzing niet verschuift.
- **Eigen slice-palet** (`--slice-1` … `--slice-7`), bewust los van het merkaccent:
  een kanaalgroep moet in elk thema dezelfde kleur houden. Zeven tinten voor licht
  en zeven aparte stappen voor donker, allebei gevalideerd op lichtheid, chroma,
  kleurenblindheid en contrast. Het lichte palet zakt onder 3:1 contrast, wat is
  opgevangen met de legenda die de cijfers draagt en 2px tussenruimte tussen de
  segmenten. Vervang die waarden niet zonder opnieuw te valideren.
- **Grafieken bakken hun kleuren in de SVG.** Na een thema- of accentwissel moet de
  pagina opnieuw getekend worden; dat doet `repaintCharts()` in `app.js`.
- **Verschilkolommen bij Bronnen** vergen de bronnenuitsplitsing óók voor de
  vergelijkingsperiode. Daarom staat `GA4_SOURCES` in `core` en niet bij de add-ons,
  en leidt `_sheetdata.js` de bronnen af uit de kanaal-tab (die heeft
  `session_source_medium` al). Een bron die vorige periode niet bestond krijgt het
  label 'nieuw' in plaats van een misleidende +100%.
- **Zoeken in landingspagina's** filtert client-side over de 200 rijen die de
  server meestuurt (getoond worden er 15). De rijen zitten in een eigen `tbody`
  met een id, zodat een aanslag alleen dat blok hertekent — een volledige
  re-render zou het invoerveld vervangen en de focus wegnemen.

## Datasheet-eerst (api/_sheetdata.js)

Windsor exporteert per klant elke nacht naar een **Windsor.ai-data-sheet**. De
Website-tab leest die eerst en gaat alleen naar de API voor wat de sheet niet dekt.
Gemeten: een sheet-tab lezen duurt 0,3–2,3 s, een koude Windsor-fetch over 90 dagen
17,9 s met 13–21 aanroepen per bezoek.

- **`CLIENTS[clientId].dataSheetId`** wijst de spreadsheet aan. Bewust in de env var
  en **niet** in de Config-tab: die tab staat in een sheet dat met de klant gedeeld
  kán worden, en een sheet-id daaruit accepteren zou een klant laten kiezen wiens
  data hij leest.
- **Tabs worden op patroon herkend**, niet op naam: de exportnamen verschillen per
  klant (`Google Analytics 4 - dag - SPOTTO - windsor.ai`). `_windsor_staging_*` is
  een restant van een lopende export en wordt overgeslagen.
- **Koppen worden genormaliseerd** (kleine letters, leestekens weg): GA4 schrijft
  `Date`, Search Console `date`. Het doelveld heet `Key event count for <event>` en
  wordt op voorvoegsel herkend.
- **Dekking wordt op gaten gecontroleerd**, niet alleen op begin en eind. Een
  lopende backfill levert losse dagen over een jaar: min/max zien er dan goed uit
  terwijl de helft ontbreekt, en het totaal zou stilzwijgend te laag worden. Per
  bron geldt een marge (GA4 2 dagen, Search Console 4) omdat de dag van vandaag
  nog niet geëxporteerd is.
- **Per blok terugvallen.** `origin` in de respons zegt per blok `sheet` of `api`;
  de voetnoot in de UI toont dat, inclusief de reden waarom een tab afviel.
- **Twee dingen kan een dagtabel niet.** Unieke gebruikers zijn niet optelbaar
  (`users: null`, de UI toont nieuwe gebruikers, die zijn wél optelbaar). En
  sessies liggen ~1,2% hoger dan GA4's eigen periodetotaal, omdat een sessie over
  middernacht in twee dagen telt: gemeten 280.576 tegenover 277.353.
- **De querytabel telt nooit op tot het totaal.** Google geeft alleen zoekopdrachten
  boven een privacydrempel vrij én kapt af op 5.000 rijen per dag. Gemeten: 59.754
  kliks op queryniveau tegenover 146.543 in de dagtabel. Het totaal komt daarom
  altijd uit de dag-tab, nooit uit een som over zoekopdrachten.
- **Let op de API-sleutel in de sheet.** Windsor schrijft mislukte runs inclusief
  de volledige aanroep-URL naar de `Queries`-tab, mét `api_key=`. Die sleutel is
  gedeeld over meerdere klanten. Deel een Windsor.ai-data-sheet dus nooit met een
  klant.

## Known pitfalls in de Website-tab

- **Windsor's REST-endpoint negeert `accounts` én `limit`** (geverifieerd). Elke
  call haalt dus álle klanten op en filtert pas server-side. Voor hoog-cardinale
  dimensies is dat fataal: `page_path` over 30 dagen was 272.000 rijen / 61 MB /
  65 s. Daarom is die tabel geschrapt en geldt `PAGE_LEVEL_MAX_DAYS = 30` voor
  landingspagina's en Search-Console-queries/pagina's; `pageLevelWindow` vertelt de
  UI het echte venster (zelfde recept als `adLevelWindow`).
- **Search Console is traag bij een koude cache**: ~28 s voor de eerste call van een
  periode, ~1 s daarna. Vandaar 35 s timeout op de vergelijkingsperiodes.
- **Search Console lag**: data loopt 2–3 dagen achter; de UI meldt de laatste dag
  met data, anders lijkt het einde van elke periode een daling.
- **Account-id-vorm.** Windsor geeft een domeinproperty terug als `spotto.be`,
  zonder het `sc-domain:`-voorvoegsel dat Google's UI toont. `normId` in
  `windsor.js` stript dat voorvoegsel; zonder die strip matcht de config nooit en
  blijft de tab (fail-closed) leeg. Een URL-prefix-property moet exact matchen,
  inclusief slash: `https://www.merk.be/`.
- **"Key events" is geen conversieratio.** Op bron-, pagina- en apparaatniveau
  splitst GA4 het hoofddoel niet uit, dus daar staat het GA4-totaal over álle key
  events. De landingspagina-tabel toont dat als *per sessie* (kan boven 1 uitkomen),
  het apparaatblok toont betrokkenheid in plaats van een ratio. Maak daar geen
  percentage van.

## SEO-tab (DataForSEO)

Zoekvolume, concurrentie, CPC, twaalfmaandstrend en de organische positie van het
merk-domein per keyword (`#page-seo`, nav `data-page="seo"`, `api/seo.js`).
Geport van `TEMPLATE_seo-dashboard.html` in Drive (7.3 AI-agents-skills/dashboards,
handover ernaast) — daar een los artifact op de DataForSEO **MCP**, hier
multi-tenant en server-side op de **REST**-API met Basic auth.

- **Twee endpoints die duizend keer in prijs schelen, dus twee knoppen.**
  `keywords_data/google_ads/search_volume/live` is één batch-call voor de hele
  lijst (verwaarloosbaar); `serp/google/organic/live/advanced` is één call **per
  keyword** (~€0,002). Vraag volumes nooit per keyword op, en zet de rank-check
  nooit in het laadpad van de tab.
- **REST ≠ MCP in de responsvorm.** `monthly_searches` is in REST een array van
  `{year, month, search_volume}`; de MCP geeft `{"YYYY-MM": n}`. `normMonthly()`
  zet dat om naar `[{month:'YYYY-MM', volume}]`. De handover in Drive beschrijft
  de MCP-vorm — dat verschil is echt.
- **Een live-call bevat precies één taak**, ook al is de body een array. Posities
  gaan daarom via een worker pool (`RANK_CONCURRENCY = 6`) met een deadline van
  45 s; wat daarna zou starten komt terug als `skipped` en wordt **niet** gecached.
  Google Ads-live staat maar 12 requests per minuut toe.
- **Geen periode.** Zoekvolume is een maandcijfer en een positie een momentopname,
  dus de topbar-periode geldt hier niet (anders dan de Website-tab).
- **Isolatie.** Domein, markt, taal en de startlijst komen uit de Config-tab
  (`SEO domein`, `SEO markt`, `SEO taal`, `SEO keywords`). Keywords zijn de enige
  waarde die het request wél mag aanleveren — dat zijn zoektermen, geen
  resource-ids — en ze worden gesaneerd en begrensd (100 voor volumes, 25 voor
  posities). Het DataForSEO-saldo is gedeeld over alle klanten.
- **Dagcache op twee plekken**, altijd met `clientId` én de keywordlijst in de
  sleutel: een Map in de functie (verdwijnt met een koude instantie) en
  `localStorage` in de browser (de echte rem op de kosten). De template
  waarschuwt expliciet voor een cache-prefix die tussen klanten botst.
- **Ontbrekende data is onbekend, nooit nul.** Een keyword zonder Google-data
  krijgt toch een rij (`volume: null`); de grafiek tekent alleen maanden die élk
  keyword heeft, want `charts.js` kent geen gaten en zou een ontbrekende maand als
  nul tekenen. Zonder `SEO domein` blijven volumes gewoon werken, alleen de
  rank-check valt weg.
- **Positie matcht ook subdomeinen** (`shop.merk.be` hoort bij `merk.be`) en telt
  alleen `type === "organic"` — een local pack is geen organische positie.

## GEO-tab (AI-zichtbaarheid)

Hoe de vijf AI-engines over het merk praten (`#page-geo`, nav `data-page="geo"`,
`api/geo.js` + `api/_geodata.js`). Geport van `TEMPLATE_geo-dashboard.html` in
Drive. Vijf sub-tabs: Overzicht, Prompts, Sources · live, Website, Acties.

- **De baseline is een bestand, geen parser.** De `geo-visibility-audit`-skill
  levert een markdown-rapport voor mensen. Twee echte audits (mayday en Just
  Jane, beide 28-07-2026) hebben verschillende koppen, andere tabelkolommen
  (`Runs` vs `Prompts`, `Top competitor by SoV` vs `Top concurrent`), een andere
  taal en bij Just Jane een extra baseline-tabel vóór de scorecard. Een parser
  daarop faalt niet luid — hij geeft een verkeerd getal. Daarom leest de tab
  **`geo-dashboard.json`** uit de Drive-map van de klant. Schema en een ingevuld
  voorbeeld: `agents/GEO_Dashboard_Schema.md` + `agents/geo-dashboard.example.json`.
- **Geen audit = geen cijfers.** Zonder bestand toont de tab wat er moet gebeuren
  en waar gezocht is. Nooit nullen, nooit demo-data: een klant ziet het verschil
  niet.
- **Bestand vinden:** klantmap → `GEO/` → `00_AI-CONTEXT/`, elk bestand dat
  matcht op `geo-dashboard*.json`, nieuwste wint. De map komt uit
  `CLIENTS[clientId].driveFolderId`, nooit uit het request.
- **Percentages zijn 0–100 in dat bestand, geen fracties** (velden heten `*Pct`).
  Een validator die soms `0,15` en soms `15` accepteert is een fout die je pas
  in het dashboard ziet.
- **De promptmatrix kent vier toestanden**, niet drie: 0 niet genoemd, 1 genoemd,
  2 genoemd-maar-fout, en **weggelaten = niet gemeten**. Die vierde staat niet in
  de HTML-template maar is nodig: bij Just Jane is Gemini op 7 van de 20 prompts
  gemeten. Zonder onderscheid telt 'niet gemeten' als 'niet genoemd' en zakt de
  mention rate structureel. De UI telt de vier apart onder de tabel.
- **Readiness telt `unknown` apart van `fail`.** Zolang een site niet bereikbaar
  is valt er niets te controleren; dat is geen gezakte check.
- **Alleen de Sources-tab is live.** DataForSEO LLM-mentions: welke domeinen,
  merken en pagina's voeden AI-antwoorden in deze markt. Dat is marktdata en zegt
  niets over déze klant — daarom mag die wél elke dag veranderen, terwijl de
  baseline een meting met een datum blijft.
- **Sources-kosten: ~$0,10 per pull** (per call, niet per rij) en tot 120 s
  looptijd — vandaar `maxDuration: 120`, een knop en een dagcache. Het keyword
  staat vast in het auditbestand; het request mag alleen het platform wisselen,
  anders kan een klant willekeurige betaalde queries afvuren op het gedeelde
  saldo.
- **Responsvorm geverifieerd** (live call, 20-09-2026):
  `tasks[0].result[0].items[0].total.sources_domain[]` met `{key, mentions,
  ai_search_volume}`. DataForSEO heeft de endpoints hernoemd
  (`top_domains` → `top_mentioned_domains`) en noemt dat blok daar
  `aggregated_metrics`; `geo.js` probeert de nieuwe naam en valt bij een 404
  terug op de oude, en leest beide sleutels.
- **Databasegrenzen:** de Belgische database kent alleen platform `google`
  (AI Overviews/AI Mode) en vereist een taal; de ChatGPT-database bestaat enkel
  voor VS/EN. De UI waarschuwt vóór de call bij die combinatie in plaats van een
  leeg resultaat te tonen.

## The two AI agents (know which prompt serves which consumer)

- **Analysis** (`api/analysis.js` + `agents/Analysis_Agent.md`): single-shot,
  returns strict JSON (`summary`/`winners`/`losers`/`recs`). The frontend builds a
  pre-aggregated, pre-classified `summary` in `buildAnalysisSummary()` (app.js) and
  the prompt consumes exactly those field names — keep them in sync. Uses
  `claude-opus-4-8`, `max_tokens: 8192`. `extractJson`/`repairTruncatedJson`
  tolerate truncated/fenced output.
- **Chat** (`api/chat.js`): **single-shot, stateless, no tools.** Loads
  `agents/Chat_Agent.md` (lean, harness-matched) with fallback to
  `agents/Meta-Performance_Agent.md`. The frontend injects context into the
  request — `clientContext` (→ system prompt), `dashboardData` from
  `buildAnalysisSummary()` and Drive `contextFiles` (→ prepended to the user
  message). The chat has NO tools; it cannot fetch anything itself.
  - `agents/Meta-Performance_Agent.md` is the **original 52KB multi-phase,
    tool-using agent manual** — it is for an Anthropic Project/Claude-agent-with-MCP
    setup, NOT the webapp. Do not point the webapp at it; do not "polish" it to fit
    the webapp. It's kept only as the fallback.

## Frontend rendering: escape untrusted text

`app.js` renders via `innerHTML`. LLM answers and API text (ad names, captions,
sheet cells) are **attacker-influenceable** → always `escapeHtml()` before
interpolating. The chat panel (`appendMsg`) escapes by default and only lets
explicitly-trusted, self-authored markup through (`html: true`). Consequence for
prompts: the chat window renders **plain text** (escaped, `\n`→`<br>`), so markdown
syntax shows literally — the chat prompt tells the model to avoid `**`/`#`/etc.

## Known pitfalls / interim hacks (don't "fix" without understanding)

- **Ad-level window cap:** `windsor.js getDashboard` caps ad-level breakdowns to the
  last 35 days (`AD_LEVEL_MAX_DAYS`) because Meta's per-ad breakdown times out over
  long ranges. Campaign-level + organic use the full range. `adLevelWindow` in the
  response tells the UI the real coverage.
- **Klaviyo email cap:** `getEmail` caps Klaviyo to the last 30 days for the same
  reason.
- **Non-fatal add-on calls:** creative/video/conversion ad fields are fetched in
  separate calls with a tighter timeout so a slow breakdown can't sink the core
  fetch; failures return `{__error}` and are surfaced in `errors`, not thrown.
- **Per-client Anthropic key:** `chat.js`/`analysis.js` use
  `CLIENTS[clientId].anthropic_api_key` if present, else the shared
  `ANTHROPIC_API_KEY`.
- **Truncated-JSON repair** in `analysis.js` is a band-aid for `max_tokens` cutoff —
  the proper fix is structured output / tool-use, not a bigger regex.

## Env vars

`AUTH_SECRET` (required, no fallback), `ANTHROPIC_API_KEY`, `CLIENTS` (JSON, holds
client passwords + per-client keys — mark Sensitive in Vercel; per klant optioneel
`dataSheetId` voor de Windsor-datasheet, zie 'Datasheet-eerst'),
`GOOGLE_SERVICE_ACCOUNT_KEY` (JSON, mark Sensitive), `DATAFORSEO_LOGIN` +
`DATAFORSEO_PASSWORD` (van app.dataforseo.com/api-access — één gedeeld account
voor alle klanten; per klant te overschrijven met `dataforseo_login` /
`dataforseo_password` in `CLIENTS`. Zonder deze twee blijven de SEO-tab en de
Sources-sub-tab van GEO leeg met een uitleg; de rest van het dashboard — inclusief
de GEO-baseline, die uit Drive komt — merkt er niets van). Optional prompt
overrides: `AGENT_SYSTEM_PROMPT`, `ANALYSIS_SYSTEM_PROMPT`.

## Deploy

Vercel project `mayday-marketings-projects/meta-performance-agent-webapp`, connected
to GitHub `mayday-marketing/meta-performance-agent-webapp` (branch `main`).

- Preview: `vercel` (prints a preview URL; preview deploys are behind Vercel SSO).
- Production: `vercel --prod`.
- `vercel` deploys the **local working directory**, so if you deploy without
  pushing, GitHub `main` drifts from what's live — push (or merge) to keep the repo
  authoritative. GitHub auth from the plain CLI doesn't work here; the user pushes
  via **GitHub Desktop**.

## Conventions

- Dutch commit messages and code comments.
- CommonJS in `api/`; browser globals + one IIFE in `app.js`.
- No build/test step — verify by syntax-checking (`node --check <file>`) and by
  driving the deployed preview (login → load dashboard → exercise the feature).
