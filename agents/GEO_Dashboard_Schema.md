# geo-dashboard.json — schema voor de GEO-tab (v2, het 2+3+1-model)

De GEO-tab leest één bestand per klant: **`geo-dashboard.json`** in de Drive-map
van die klant. Dit document beschrijft dat bestand. Een minimaal, fictief
voorbeeld staat in `geo-dashboard.example.json` hiernaast.

## Het principe: alle merkdata in het bestand, niets in de code

De code van de app kent geen enkel merk. Merknaam, domein, de bevroren
concurrentieset, de promptset, de acties en de metingen staan allemaal in het
bestand van de klant. Twee klanten verschillen dus alleen in hun bestand.

En: **het bestand bevat ruwe runs, geen percentages.** De app rekent mention
rates, de zes blokken, deltas en share of voice zelf uit. Een tegel kan zo nooit
iets anders zeggen dan de matrix eronder, en een hand-ingevuld percentage kan
niet afwijken van wat er gemeten is.

**Geen audit = geen cijfers.** Zonder bestand, of zonder volledige meting, toont
de tab een uitleg — nooit nullen of demo-data.

## Waar het bestand hoort

In de Drive-map van de klant (`CLIENTS[clientId].driveFolderId`), in deze
volgorde doorzocht: de klantmap zelf, `GEO/`, `00_AI-CONTEXT/`. Elke naam die
matcht op `geo-dashboard*.json` telt mee; de **laatst gewijzigde** wint.

Een nieuwe meting voeg je toe aan `measurements` in hetzelfde bestand. Nooit een
oude meting wijzigen: dat is de historiek waar de deltas op rusten.

## Het model

| Groep | Blok | Gemeten door |
|---|---|---|
| 🔒 Fundamenten (blokkerend) | Leesbaarheid | `checks` van de meting · op orde vanaf 8/10 geslaagd |
| | Herkenning | prompts `brand` + `brandSplit` · op orde vanaf 80% juist herkende brand-runs |
| 🏛 Vindbaarheid (parallel) | Categorie | prompts `category` |
| | Expertise | prompts `how-to` + `problem` |
| | Vertrouwen | `externalCitations` van de meting |
| 📈 Uitkomst | Voorkeur | prompts `comparison` + share of voice · trend vanaf 2 metingen |

De drempels (8/10 en 80%) zijn voor elk merk gelijk en staan in de code
(`GEO_T` in `app.js`), niet in het bestand.

## De blokken

### Merk en methode

```json
{
  "schemaVersion": 2,
  "brand": { "name": "Voorbeeldmerk", "domain": "voorbeeldmerk.be", "descriptor": "…" },
  "label": "Baseline",
  "method": "20 koopvragen, live via DataForSEO op 5 engines …",
  "passNote": "2 passes op prioriteit hoog, 1 op middel/laag — bij elke meting gelijk"
}
```

`brand.domain` voedt de live-lagen: de bronnen-pull sluit antwoorden met dit
domein uit, en de ongeplande vermeldingen zoeken op dit domein. Ontbreekt het,
dan valt de app terug op `SEO domein` in de Config-tab. Het request levert nooit
een domein aan.

### `engines`

```json
[{ "id": "chatgpt", "name": "ChatGPT" }, { "id": "aio", "name": "AI Overviews" }]
```

`id` is de sleutel in `runs` en `brandSplit`. Gebruik `chatgpt`, `claude`,
`perplexity`, `gemini` voor die vier: het AI-verkeer uit GA4 wordt op die id's
gekoppeld voor de naar verkeer gewogen mention rate.

### `competitors` — de bevroren share-of-voice-set

```json
["Concurrent A", "Concurrent B", "Concurrent C"]
```

Komt uit `<merk>_geo-config.md`, sectie Competitors → *share-of-voice set*. Vast
vanaf de baseline: wijzig je de set, dan is share of voice tussen metingen niet
meer vergelijkbaar. Merken in `brandCounts` buiten deze set worden genegeerd
(met een waarschuwing).

### `prompts` — de vaste vragenset

```json
[{ "n": 1, "text": "beste … voor …", "type": "category", "priority": "High" }]
```

`type`: `category` | `comparison` | `how-to` | `problem` | `brand`
(Nederlands mag ook: `categorie`, `vergelijking`, `probleem`, `merk`). Een
onbekend type telt in geen enkel blok mee en komt als waarschuwing terug.

### `actions`

```json
[{ "priority": "hoog", "effort": "middel", "how": "pagina herschrijven",
   "moves": ["Categorie"], "title": "…", "text": "…", "done": "…" },
 { "ongoing": true, "how": "maandmeting", "moves": ["meet alle 6 blokken"], "title": "…" }]
```

Klanttaal: `hoog/middel/laag`, `klein/middel/groot`, geen skillnamen in `how`.
`moves` = de blokken die de actie beweegt.

### `sources` — de live bronnenlaag

```json
{ "keyword": "…", "platform": "google", "location": "Belgium", "language": "nl" }
```

Het keyword staat vast (het DataForSEO-saldo is gedeeld); de tab mag alleen het
platform wisselen. **LLM Mentions kent `chat_gpt` alleen voor VS/Engels** — de
tab waarschuwt vóór de call. De vaste vragenset in een andere markt meten gaat
via de ChatGPT-scraper en LLM-responses: dat is de kwartaalmeting, niet deze laag.

### `measurements` — de historiek

```json
[{
  "date": "2026-07-28", "kind": "full", "note": "pre-launch",
  "calloutNote": "Site serveerde geen content op auditdatum …",
  "runs": { "chatgpt": { "1": [0, 0], "20": [0, 0] }, "gemini": { "21": [2] } },
  "runCount": 132,
  "brandCounts": { "Voorbeeldmerk": 2, "Concurrent A": 53 },
  "brandSplit": [{ "engine": "gemini", "prompt": 21, "pass": 1,
                   "class": "correct_entity_wrong_description", "evidence": "…" }],
  "checks": [{ "check": "robots.txt laat AI-crawlers toe", "status": "fail", "note": "…" }],
  "ownCitations": 0, "externalCitations": 0,
  "matrixNote": "…", "checksNote": "…"
}]
```

- `kind`: `full` (volledige vragenset, per kwartaal, ≈ €37 bij 2 passes) of
  `light` (goedkope maandsignalen). De laatste `full` is de huidige stand, de
  `full` daarvoor de vorige stand.
- `runs[engine][prompt]` = één toestand **per pass**: `0` niet genoemd, `1`
  genoemd en juist omschreven, `2` genoemd maar fout omschreven. Ontbreekt een
  prompt of engine → **niet gemeten**; dat telt nergens mee, en zeker niet als
  'niet genoemd'. Een cel telt als genoemd zodra één pass het merk noemt.
- `brandCounts`: per merk in de set, het aantal runs dat het merk noemt (één keer
  per run). `runCount` = het aantal runs met antwoordtekst waarover geteld is.
- `brandSplit`: één rij per run op de brand-prompts. `class`:
  `correct_entity` · `correct_entity_wrong_description` · `namesake` ·
  `invented` · `generic_no_entity`. Dit is het cijfer achter 'branded x%'.
- `checks.status`: `pass` | `fail` | `unknown`. Onmeetbaar is geen gezakte check;
  de score telt alleen `pass`.

## Hoe je een meting maakt

1. Draai de `geo-visibility-audit`; de ruwe runs komen in `GEO/<merk>/raw/`.
2. Zet ze om naar een gestructureerde export (`<datum>_audit-structured.json`:
   runs met `maydayState`/`brands`, `brandSplit`) — één keer, gecontroleerd tegen
   de samenvatting van de audit.
3. Voeg er één meting mee toe aan `measurements`. De rest van het bestand
   (merk, set, prompts) verandert niet tussen metingen.

## Oud formaat (v1)

Bestanden zonder `schemaVersion` of `measurements` (met `kpis`, `phases`,
`competitors` als telling) worden nog ingelezen en omgezet: de promptmatrix,
checks en acties blijven werken, share of voice en de naamkaping-split
ontbreken, en de tab zegt dat met een waarschuwing. Schrijf ze om naar v2.
