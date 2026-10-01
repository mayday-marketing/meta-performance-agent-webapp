# Roadmap en todo

Open punten die bewust naar later zijn geschoven. Per punt: waarom het nodig is en
wat de eerste stap is. Afgewerkt → schrappen, niet laten staan.

## Data en exports

### Instagram-volgers als eigen export (Spotto, later voor alle klanten)
- **Waarom:** `followers_count` hoort bij Windsor's tabel `user_info` (profiel), niet
  bij de posts. In dezelfde export als de posts levert het per dag een extra rij
  zonder `media_id`/`timestamp`. Bij Spotto telde dat als 8 extra posts, en nu
  weigert het dashboard daardoor de hele Instagram-tab (lege verplichte velden).
  Gemeten op 01-10-2026: de terugval naar live kost **45,5 s** en is daarmee het
  traagste blok van `getDashboard` (51,9 s in totaal) — dus van de Overview.
- **Eerste stap:** `followers_count` uit de Instagram-postexport (Windsor-taak 44905)
  halen, bestaande rijen wissen, volledige backfill.
- **Daarna:** aparte export `date, account_name, followers_count` naar een tab
  zónder "Instagram" in de naam (bv. `IG volgers - SPOTTO`), anders probeert
  `_sheetdata.js` hem als posttab te lezen. Dan een volgersverloop in Social bouwen
  (niet optelbaar over dagen: laatste waarde van de periode, geen som).

### Facebook organisch: backfill afmaken (Spotto)
- **Waarom:** de tab `Facebook Org - SPOTTO` had op 29-09-2026 3 posts voor de
  laatste 90 dagen, live 35. De code ziet dat niet: alle kolommen zijn gevuld.
- **Tot dan:** `Datasheet overslaan` = `facebook_organic` in de Config-tab. Pas
  leegmaken als de sheet dezelfde telling geeft als live.

### Doelgroep weer uit de datasheet, zonder verlies onder de privacydrempel
- **Tussenoplossing (sinds 01-10-2026):** de Doelgroep-tab haalt leeftijd ×
  geslacht (× kanaal) altijd live en over de hele periode in één keer op, nooit
  uit de datasheet (`useDemo = false` in `getWebsite`, `skipSheet` op de
  doelgroep- en conversiecalls). Dat werkt, maar is een uitzondering op
  'datasheet eerst': elke bezoek kost 3–4 extra live GA4-calls (plus 3 per
  conversie uit `Conversies`), en de cijfers kunnen tussen twee keer laden
  verschuiven.
- **Waarom niet uit de sheet:** de doelgroepexport is per dag, en GA4 laat per
  rij kleine groepen weg. Bij Spotto (3–30 sept. 2026) bleef van ruim 1.100
  AI-sessies met bekende leeftijd en geslacht per dag precies één rij over; AI en
  Verwijzing verdwenen bij mannen uit de kanaalmatrix.
- **Eerste stap:** in Windsor testen welke korrel weinig verliest en toch op
  periode te filteren is: een export per week of per maand (GA4 `yearWeek` /
  `yearMonth` in plaats van `date`) tegenover de live periodecijfers. Meten met
  de AI-sessies van mannen als toets (live: 518).
- **Daarna:** `_sheetdata.js` die korrel laten lezen (periodes die niet op een
  week- of maandgrens vallen: de randen live aanvullen of de dekking melden), en
  `useDemo` weer aanzetten. Alternatief: de periodecijfers nachtelijk
  voorberekenen (zie 'Nachtelijke voorberekening per klant').

## Snelheid

### Historiek van de grootste exports inkorten (Spotto)
- **Waarom:** het dashboard leest uit deze tabs hooguit 30 dagen detail
  (`PAGE_LEVEL_MAX_DAYS`, `DETAIL_MAX_DAYS`), maar leest ze wel volledig in.
  Gemeten op 01-10-2026: Search Console query 475.000 rijen (6,4 s), Google Ads
  zoektermen 318.000 rijen (8,9 s), GA4 landing 259.000 rijen (7,8 s), Google Ads
  conversieacties 81.000 rijen (6,1 s). Ze zitten in `getWebsite` (28,9 s) en
  `getGoogleAds` (26,4 s).
- **Eerste stap:** in Windsor.ai de exporttaken van die vier tabs op een rollend
  venster zetten (bv. de laatste 60 dagen, ruimte voor de vergelijkingsperiode),
  daarna opnieuw meten met de `[tijd]`-regels.
- **Let op:** de dagtabs (GA4 dag, Search Console dag) níet inkorten: die dragen
  de totalen over lange periodes en de jaar-op-jaarvergelijking.

### Nachtelijke voorberekening per klant
- **Waarom:** een login bij Spotto kost ~20–33 s. De sheets veranderen één keer per
  dag, maar worden bij elke koude login opnieuw gelezen en ontleed. De Search
  Console-querytab (475.000 rijen) kost alleen al ~10 s.
- **Eerste stap:** meten met de `[tijd]`-regels welke blokken na de exportfixes nog
  traag zijn; pas dan beslissen of het een Vercel-cron + Runtime Cache/Blob wordt.

## Features

### Agents-bibliotheek via de MCP-koppeling
- **Wat:** een overzicht van de mayday-agents (analyse, rapport, chat, GEO-audit,
  SEO, …) dat je via `/api/mcp` kunt opvragen en starten vanuit Claude Code,
  Claude Chat (claude.ai) en Claude Cowork. Eén bron, zodat elke omgeving dezelfde
  instructies en dezelfde cijfers gebruikt.
- **Waarom:** de agent-instructies staan nu verspreid (`agents/*.md` in de repo,
  `7.3 AI-agents-skills` in Drive) en worden per omgeving los gekopieerd. Een
  bijgewerkte prompt bereikt zo niet elke plek.
- **Hoe (voorstel):** MCP kent naast tools ook *prompts* en *resources*. Elke agent
  wordt een prompt (naam, beschrijving, argumenten zoals `clientId` en periode) die
  de bestaande tools (`get_dashboard`, `get_roas`, `get_website`, …) gebruikt, plus
  een tool `list_agents` voor het overzicht. De rekenlaag blijft `summary.js`, dus
  een agent zegt niets anders dan het dashboard.
- **Let op:**
  - `agents/Meta-Performance_Agent.md` is geschreven voor een agent mét tools; de
    webapp-prompts (`Chat_Agent.md`, `Analysis_Agent.md`) zijn afgestemd op
    single-shot met ingespoten context. Per agent kiezen welke versie de MCP-variant
    wordt, niet blind hergebruiken.
  - claude.ai en Cowork vragen OAuth per gebruiker: dat is MCP V2 (zie CLAUDE.md,
    'MCP V2'). Claude Code werkt al met de agency-sleutel.
  - Geen betaalde calls in een agent die zelfstandig loopt (DataForSEO-rank-check,
    GEO-bronnen): dezelfde regel als voor de huidige tools.
- **Eerste stap:** inventaris van alle agents (repo + Drive): doel, doelomgeving,
  welke data ze nodig hebben, welke al een MCP-tool heeft.

### Google Ads-leadweergave (Ads-pagina)
- **Waarom:** Spotto is een leadklant; `conversion_value` = 1 per lead, dus de
  platform-ROAS in de ROAS-tab zegt niets. Nodig: kosten per lead per campagne,
  impression share (gewogen naar vertoningen), zoekwoorden, zoektermen,
  conversieacties, apparaat. De datasheettabs bestaan al.
</content>
</invoke>
