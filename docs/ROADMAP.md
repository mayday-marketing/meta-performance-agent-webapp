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

### Conversieratio's in de Doelgroep-tab kloppen niet precies bij een filter
- **Waarom:** bij het geslachtsfilter (Alle / Vrouwen / Mannen) en de
  conversieschakelaar sluiten de ratio's en kleuren niet helemaal aan. Nog verder
  uit te zoeken (gemeld 02-10-2026).
- **Eerste spoor:** de kanaalmatrix filtert de cellen op geslacht, maar vergelijkt
  ze met het gemiddelde over álle sessies, inclusief onbekend geslacht
  (`avgRate` in `renderWebsiteDemoBase`, doorgegeven aan
  `renderWebsiteDemoMatrix`). Op de screenshot van Spotto (Mannen, formulieren):
  voetnoot 'gemiddelde van 1,23%', terwijl de rij 'Alle leeftijden' voor mannen
  1,00% geeft. Groen en rood zijn dan relatief tegenover de verkeerde lat, en de
  kop 'converteren het best … tegenover x% gemiddeld' gebruikt hetzelfde getal.
- **Verder nakijken:** de aandelen in de staafgrafiek blijven bewust van het
  totaal (staat in de voetnoot), maar de index ernaast misschien niet; de
  onbekend-rij in de matrix; en of de schakelaar (Huur / Koop) overal dezelfde
  noemer gebruikt. Telkens narekenen tegen GA4 zelf voor één periode.

## Kwaliteit

### Nachtelijke testscenario's: wat kan er mislopen
- **Waarom:** er zijn geen tests (zie CLAUDE.md). Fouten zoals deze week (een
  ontbrekende hulpfunctie die de Doelgroep-tab stil liet uitvallen, de datasheet
  die AI-verkeer liet verdwijnen, een Instagram-export met lege rijen die alles
  45 s trager maakte) werden pas gezien als iemand toevallig keek.
- **Wat (voorstel, per klant, elke avond):**
  - **Isolatie:** een token van klant A tegen elk endpoint met `clientId` B moet
    401 geven; geen enkel endpoint mag een resource-id uit het request volgen.
  - **Elke tab laadt:** `getDashboard`, `getWebsite`, `getRoas`, `getGoogleAds`,
    `brand`, GEO, en de renderers geven HTML zonder JS-fout (bv. met een headless
    browser of de renderers in Node met opgenomen responses).
  - **Sheet tegenover live:** per connector de totalen van de laatste volle week
    uit de datasheet naast live; een verschil boven een drempel = melding
    (vangt exports die nog vullen of rijen verliezen).
  - **Exportgezondheid:** lege verplichte velden, tabs die achterlopen, gaten in
    de dekking, `Queries`-tab met fouten.
  - **Config-tab:** waarschuwingen 'ongeldige waarde' of 'onbekend veld', een
    `Conversiedoel` of `Conversies`-event dat in GA4 niet bestaat.
  - **Bekende valkuilen als regressietest:** omni-aankopen niet dubbel, nul
    tegenover onbekend (`null / getal`), privacydrempel bij kleine kanalen,
    summary.js en het scherm geven hetzelfde getal, MCP-tools antwoorden.
  - **Snelheid:** `[tijd]`-regels per call; boven een budget (bv. 30 s per
    endpoint) = melding.
- **Hoe:** een Vercel-cron of een geplande Claude-routine die de checks draait en
  's ochtends één overzicht stuurt (wat faalde, bij welke klant, sinds wanneer).
  Geen betaalde calls (DataForSEO) in de nachtelijke run.
- **Eerste stap:** de lijst hierboven aanvullen met wat er de afgelopen maanden
  echt misliep (CLAUDE.md 'Known pitfalls' en de git-log), en per scenario
  bepalen hoe je het automatisch vaststelt.

### Werken op `main` en een testomgeving: opties nagaan
- **Waarom:** nu gaat alles rechtstreeks naar productie. Er wordt gewerkt op
  `main`, gepusht via GitHub Desktop en uitgerold met `vercel --prod` vanuit de
  lokale map (die kan dus afwijken van GitHub). Een fout zoals de ontbrekende
  hulpfunctie in de Doelgroep-tab (01-10-2026) staat dan meteen bij klanten.
- **Opties om na te gaan:**
  - **Werkbranch + Vercel-preview:** wijzigingen op een eigen branch, elke push
    geeft een preview-URL; pas na controle mergen naar `main`. Let op: previews
    staan achter Vercel SSO, en hebben eigen env vars nodig (`AUTH_SECRET`,
    `CLIENTS`, `GOOGLE_SERVICE_ACCOUNT_KEY`, `MCP_AGENCY_KEYS`) in de omgeving
    Preview.
  - **Vaste testomgeving:** een `staging`-branch met een eigen domein (bv.
    `staging.dashboard.mayday.marketing`), altijd de volgende versie.
  - **Productie alleen via GitHub:** `main` beschermen en Vercel laten uitrollen
    bij een merge, in plaats van `vercel --prod` vanaf een laptop. Dan is GitHub
    altijd wat er live staat.
  - **Testdata:** SENJA (demoklant, `DEMO_CLIENTS`) als vaste testklant, zodat een
    testomgeving geen echte klantcijfers nodig heeft; voor echte randgevallen
    (Spotto: privacydrempel, grote exports) toch één echte klant met leesrechten.
- **Raakt aan:** de nachtelijke testscenario's hierboven (die kunnen tegen de
  testomgeving draaien vóór een merge) en de MCP-koppeling (een staging-adres
  mag geen productiesleutels delen).
- **Eerste stap:** beslissen tussen 'preview per branch' en 'vaste staging', en
  nagaan welke env vars en Google-rechten een tweede omgeving nodig heeft.

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

### Vraagbalk: weergaven bouwen in gewone taal (zoals PostHog AI)
- **Eerst de eigenaar vragen.** Dit punt is een eerste schets (02-10-2026). Zodra
  het ter sprake komt of opgepakt wordt: eerst om meer duiding vragen (wat moet de
  vraagbalk kunnen, voor wie, waar in de app, wat nadrukkelijk niet) vóór er een
  catalogus of prototype gebouwd wordt.
- **Wat:** een vraagbalk waarin je beschrijft wat je wilt zien ("huur- en
  koopformulieren per leeftijd, per maand, alleen AI-verkeer"). Claude redeneert
  mee op basis van wat er voor díe klant beschikbaar is (gekoppelde connectoren,
  ingestelde conversies, welke uitsplitsingen een bron toelaat) en stelt een
  weergave voor: maatstaf, uitsplitsing, grafiektype, periode. Kan iets niet, dan
  zegt hij waarom en wat het dichtstbijzijnde alternatief is ("TikTok is niet
  gekoppeld", "gebruikers zijn niet optelbaar over dagen; nieuwe gebruikers wel",
  "per dag valt AI-verkeer weg onder de privacydrempel, per maand niet"). De
  gebruiker bevestigt of stuurt bij, en kan de weergave bewaren als tegel.
- **Waarom:** elke klant kijkt naar iets anders, en nu vraagt elke nieuwe weergave
  een codewijziging. Een vrije bouwer met dropdowns laat iemand ook combinaties
  kiezen die niet kloppen; Claude kan de meetregels uitleggen terwijl je bouwt.
- **Hoe (voorstel):**
  - **Catalogus als enige wereld.** Claude krijgt een catalogus van maatstaven en
    uitsplitsingen (bron, connector, optelbaar ja/nee, geldige combinaties,
    minimale korrel) plus wat er voor deze klant gekoppeld en ingesteld is. Meer
    niet: geen ruwe data, geen id's.
  - **Uitvoer is een specificatie, geen code.** Claude geeft een gestructureerde
    spec terug (tool-use of structured output) met alleen catalogussleutels. De
    server valideert die tegen de catalogus en rekent via `summary.js`, zodat een
    tegel nooit iets anders zegt dan de vaste tabs en de MCP-koppeling. Geen
    door het model geschreven HTML of queries.
  - **Andere chat dan nu.** `api/chat.js` is single-shot zonder tools; dit vraagt
    een gesprek met tools (catalogus opvragen, voorbeeldcijfers ophalen). Dezelfde
    tools kunnen in de MCP-koppeling, zodat het ook vanuit claude.ai werkt.
- **Randvoorwaarden uit de bestaande regels:**
  - **Isolatie.** Een spec bevat alleen catalogussleutels en een periode, nooit een
    sheet-, account- of connector-id; resources blijven server-side uit `CLIENTS`
    en de Config-tab komen. Tekst van de gebruiker is data, geen instructie aan de
    server.
  - **Dashboard, geen adviseur.** Claude helpt een weergave bouwen en legt
    meetregels uit; hij geeft geen aanbevelingen over de marketing zelf. Analyse
    blijft in het gesprek via de MCP-koppeling.
  - **Meetregels gaan mee.** Niet-optelbare maatstaven, ontbrekend = streepje,
    GA4- en platformomzet nooit in één som, privacydrempel per korrel.
  - **Kosten.** Elke vraag is een modelcall (per klant `anthropic_api_key` of de
    gedeelde sleutel); voorbeeldcijfers via de bestaande caches, geen betaalde
    DataForSEO-calls.
  - **Opslag.** Er is nu geen database; bewaarde tegels per klant vragen opslag
    die per `clientId` gescheiden is (bv. een Marketplace-database of Blob).
- **Eerste stap:** de catalogus opstellen van alle maatstaven en uitsplitsingen die
  de tabs nu tonen (bron, optelbaar, geldige combinaties, minimale korrel);
  `GOAL_METRICS` in summary.js is een begin. Daarna een prototype: vraag → spec →
  validatie → één tegel, zonder opslag.
- **Raakt aan:** de Rapport-tab (een tegel kan een slide worden), de MCP-koppeling
  (dezelfde catalogus als tool) en de huidige chat ("Vraag de Agent").

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
