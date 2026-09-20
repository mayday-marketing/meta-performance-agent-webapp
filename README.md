# mayday marketing — Meta Performance Agent

Multi-tenant social-media-performancedashboard. Eén deployment bedient alle
klanten: een klant logt in met een code + wachtwoord en ziet uitsluitend zijn
eigen Instagram-, Meta Ads-, website-, SEO- en GEO-cijfers, plus een
AI-analyse en een AI-chat.

- **Nieuwe klant opzetten:** [docs/NIEUWE-KLANT.md](docs/NIEUWE-KLANT.md)
- **Architectuur en valkuilen:** [CLAUDE.md](CLAUDE.md)

---

## Bestandsstructuur

Geen build-stap, geen framework, geen `package.json`. Wat er staat is wat er
draait.

```
meta-performance-agent-webapp/
├── index.html                 ← dashboard (één pagina, tabs via de nav)
├── app.js                     ← alle frontendlogica, één IIFE
├── charts.js                  ← SVG-grafieken
├── styles.css                 ← design tokens + componenten
├── data.js                    ← statische fallbackdata
├── fonts/inter-variable.woff2 ← zelf gehost
├── api/                       ← Vercel serverless functions (CommonJS)
│   ├── auth.js                ← login → HMAC-token
│   ├── windsor.js             ← Windsor.ai: dashboard, ROAS, website, e-mail
│   ├── sheets.js              ← Merkcontext lezen, analysehistoriek bijschrijven
│   ├── drive.js               ← merkcontext + ruwe data uit Google Drive
│   ├── analysis.js            ← analyse-agent (strikte JSON)
│   ├── chat.js                ← chat-agent (single-shot, zonder tools)
│   ├── seo.js                 ← DataForSEO: zoekvolumes + posities
│   ├── geo.js                 ← AI-zichtbaarheid: baseline + live sources
│   ├── metricool.js           ← alternatieve bron voor klanten op Metricool
│   ├── _config.js             ← Config-tab per klant (gedeelde module)
│   ├── _channels.js           ← registry van betaalde kanalen
│   ├── _sheetdata.js          ← websitedata uit de Windsor-datasheet
│   └── _geodata.js            ← geo-dashboard.json uit Drive
├── agents/                    ← systeemprompts + schema's
├── docs/NIEUWE-KLANT.md       ← klant-onboarding, stap voor stap
├── evals/                     ← promptevals voor analyse en chat
├── scripts/add-config-tab.js  ← Config-tab uitrollen naar klantsheets
└── vercel.json                ← timeouts en geheugen per functie
```

Bestanden in `api/` met een underscore-prefix zijn gedeelde modules, geen routes.

---

## Omgevingsvariabelen

Allemaal in Vercel (Settings → Environment Variables), in élke omgeving.

| Variabele | Verplicht | Waarvoor |
|---|---|---|
| `AUTH_SECRET` | ja | HMAC-sleutel voor de sessietokens. **Geen fallback** — ontbreekt hij, dan falen alle logins (bewust) |
| `CLIENTS` | ja | JSON met per klant het wachtwoord, de sheet-, map- en connector-verwijzingen. Markeer als **Sensitive** |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | ja | service-account-JSON voor Sheets + Drive. Markeer als **Sensitive** |
| `ANTHROPIC_API_KEY` | ja | analyse + chat; per klant te overschrijven met `anthropic_api_key` in `CLIENTS` |
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | nee | SEO-tab en de Sources-sub-tab van GEO. Zonder deze twee blijven die leeg met uitleg; de rest merkt er niets van |
| `LOGO_HOSTS` | nee | extra toegestane hosts voor klantlogo's |
| `AGENT_SYSTEM_PROMPT` / `ANALYSIS_SYSTEM_PROMPT` | nee | prompt-overrides |

De volledige veldenlijst van `CLIENTS` staat in
[docs/NIEUWE-KLANT.md](docs/NIEUWE-KLANT.md#10--voeg-de-klant-toe-aan-clients-in-vercel).

---

## Lokaal draaien

1. Haal de variabelen op uit Vercel:

```bash
vercel env pull .env.local
```

2. Start de dev-server (serveert de statische bestanden én `api/`):

```bash
vercel dev
```

Er is geen installatiestap: geen `package.json`, geen dependencies.

---

## Deployen

Vercel-project `mayday-marketings-projects/meta-performance-agent-webapp`,
gekoppeld aan GitHub `mayday-marketing/meta-performance-agent-webapp`, branch
`main`.

```bash
vercel --prod
```

`vercel` deployt de **lokale werkmap**. Deploy je zonder te pushen, dan drijft
GitHub `main` af van wat live staat — push daarna via GitHub Desktop. Een
preview maak je met `vercel` zonder `--prod`; previews zitten achter Vercel SSO.

Een gewijzigde env-variabele wordt pas actief na een nieuwe deploy of een
redeploy.

---

## Nieuwe klant toevoegen

De volledige procedure staat in **[docs/NIEUWE-KLANT.md](docs/NIEUWE-KLANT.md)**:
Drive-mappen, klantsheet, Config-tab, Windsor-account-id's, de `CLIENTS` env var,
de GEO-baseline, deploy en de testronde — met een afvinkbare checklist.

Verkort:

1. Drive-klantmap volgens de mappenconventie, gedeeld met het service-account (Viewer)
2. Klantsheet met de tabs `Merkcontext`, `Config` en `Analysehistoriek`, gedeeld met
   hetzelfde service-account (Editor)
3. Config-tab invullen — vooral de Windsor-account-id's: die zijn fail-closed, een
   ontbrekend id geeft een lege tab
4. Klant toevoegen aan de `CLIENTS` env var in Vercel
5. Deployen en elke tab natrekken tegen de bron

---

## Scripts en evals

De Config-tab uitrollen naar klantsheets (droogloop standaard, overschrijft nooit
een bestaande tab):

```bash
node scripts/add-config-tab.js --apply --only <klantcode>
```

Promptevals na een wijziging aan `agents/Analysis_Agent.md` of
`agents/Chat_Agent.md` — zie [evals/README.md](evals/README.md):

```bash
node evals/run.mjs
```

Er is geen test- of lintstap. Verifiëren doe je met `node --check <bestand>` en
door de deployment te bedienen: inloggen, dashboard laden, de gewijzigde tab
uitproberen.

---

## Veiligheid

- **Isolatie per klant is de belangrijkste regel.** Elke per-klant-bron
  (sheet-id, Drive-map, connector-account, cachesleutel) wordt server-side
  afgeleid uit `CLIENTS[clientId]` ná `verifyToken` — nooit uit het request. De
  gedeelde service-account en de gedeelde API-sleutels kunnen bij élke klant.
- **Windsor-connectors zijn fail-closed:** een scopebare connector zonder
  account-id levert een lege dataset in plaats van de data van alle klanten.
- Tokens zijn HMAC-ondertekend, gebonden aan de klantcode en verlopen na 10 uur.
- Alle API-aanroepen gaan server-side; sleutels bereiken de browser nooit.
- Tekst uit API's en van de modellen wordt geëscaped vóór hij in `innerHTML`
  belandt.
- `.gitignore` dekt `.env*` en `.vercel`. De prompts in `agents/` staan **wel**
  in de repo — die is privé.
- Deel een Windsor-datasheet nooit met een klant: Windsor schrijft mislukte runs
  inclusief `api_key=` naar de `Queries`-tab.

---

## Kosten per maand, ruwweg

| Onderdeel | Kost |
|---|---|
| Vercel hosting | €0 |
| Google Sheets + Drive API | €0 |
| Anthropic API | ~€0,15–0,30 per analyse-run |
| DataForSEO — zoekvolumes | verwaarloosbaar (één batch-call) |
| DataForSEO — rank-check | ~€0,002 per keyword per check |
| DataForSEO — GEO sources | ~$0,10 per pull, dagcache |

---

*mayday marketing · vertrouwelijk*
