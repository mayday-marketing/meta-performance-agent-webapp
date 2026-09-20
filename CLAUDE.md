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
- **GA4** (`googleanalytics4` via Windsor) — omzetbron voor de ROAS-tab:
  `purchase_revenue` per dag, totaal én per `session_source_medium`. Property-id
  uit de Config-tab (`GA4 property`).

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
- **Break-even** = `(1 − korting) / (brutomarge − korting)` per kortingswave.
  Brutomarge + kortingen staan in de Config-tab (`Brutomarge`, `Korting wave 1..4`,
  `Actieve wave`, of `Minimum ROAS` als directe override) en zijn in de tab live
  te overschrijven voor scenario's — die overschrijving wordt **niet** bewaard.
- **Alleen `facebook` heeft geverifieerde veldnamen.** Voor niet-gekoppelde
  connectors staan kandidaat-omzetvelden in de registry; wijst Windsor er één af,
  dan valt `fetchChannel` terug op alleen spend (`platformRevenueAvailable:false`)
  en blijft de GA4-ROAS staan. Campagnes van zo'n kanaal krijgen **geen** oordeel —
  een ROAS van 0 zou anders 'uitzetten' opleveren terwijl er niets gemeten is.
- **Isolatie:** elke nieuwe connector-slug hoort in `ACCOUNT_ID_CONNECTORS` in
  `windsor.js`. Ontbreekt hij daar, dan geldt de fail-closed-regel niet en geeft een
  niet-geconfigureerde connector álle klanten terug.

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
client passwords + per-client keys — mark Sensitive in Vercel),
`GOOGLE_SERVICE_ACCOUNT_KEY` (JSON, mark Sensitive). Optional prompt overrides:
`AGENT_SYSTEM_PROMPT`, `ANALYSIS_SYSTEM_PROMPT`.

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
