# seo-dashboard.json — vastgelegde meting voor de SEO-tab

De SEO-tab draait normaal **live op DataForSEO**. Ligt er een
**`seo-dashboard.json`** in de Drive-map van de klant, dan komen volumes en
posities uit dat bestand en gaat er geen enkele call de deur uit. Dit document
beschrijft dat bestand. Werkend voorbeeld: `CLIENTS/SENJA-DEMO/SEO/` in Drive.

## Waarom het bestaat

Twee gevallen waarin de live-laag niet kan of niet hoort:

1. **Demo- en showcase-omgevingen.** Het domein bestaat niet, dus elke
   rank-check komt leeg terug en de tab lijkt stuk terwijl hij werkt. Bovendien
   kost elke demo geld op het gedeelde DataForSEO-saldo.
2. **Een klant zonder DataForSEO-koppeling die wél een uitgevoerde
   keywordanalyse heeft liggen.** Die analyse is een meting met een datum — net
   als de GEO-baseline.

Het is hetzelfde patroon als `geo-dashboard.json`: *wie de meting doet, schrijft
hem één keer machineleesbaar weg.* De app verzint niets.

## Voorrang, en waarom die kant op

**Bestand aanwezig = bestand wint.** Geen DataForSEO-calls, kosten €0. Wie een
vastgelegde meting neerlegt zegt daarmee: deze tab draait op dit bestand. Een
tab die stilzwijgend heen en weer schakelt tussen twee bronnen is niet uit te
leggen aan een klant en kost per ongeluk geld. Bestand weghalen (of hernoemen
zodat het niet meer op `seo-dashboard*.json` matcht) zet de tab weer live.

De respons krijgt `origin: "drive"` en `settings.source: "drive"`, plus
`settings.measuredAt` en `settings.sourceFile`.

## Waar het bestand hoort

In de Drive-map van de klant (`CLIENTS[clientId].driveFolderId`), in deze
volgorde doorzocht:

1. de klantmap zelf
2. `SEO/`
3. `00_AI-CONTEXT/`

Elke naam die matcht op `seo-dashboard*.json` telt mee; staan er meerdere, dan
wint de **laatst gewijzigde**. Zo mag `2026-03-12_seo-dashboard.json` blijven
staan naast een hermeting.

## Regels die de validator afdwingt

- **Ontbrekend is onbekend, nooit nul.** Een weggelaten of ongeldig veld
  verdwijnt; de tabel toont een streepje. Er wordt nooit een 0 ingevuld.
- **Keywords worden net zo gesaneerd als de aanvraag** (kleine letters,
  witruimte samengevat, max 80 tekens). Anders matcht een rij uit het bestand
  niet op de keywordlijst uit de Config-tab.
- **Onbekende velden worden genegeerd** — eigen notities mogen mee.
- Een keyword uit de Config-tab dat **niet** in het bestand staat, komt terug
  als lege rij: volume `—`, positie `?`. Dat is een kansen-keyword, geen fout.

## Het bestand

```json
{
  "brandName": "SENJA",
  "domain": "senja.be",
  "location": "Belgium",
  "language": "nl",
  "measuredAt": "2026-09-19",
  "label": "Vastgelegde meting — demo-dataset",
  "depth": 20,
  "method": "Hoe deze cijfers tot stand kwamen…",
  "keywords": [
    {
      "keyword": "magnesiumbisglycinaat",
      "volume": 2400,
      "competition": "MEDIUM",
      "competitionIndex": 47,
      "cpc": 0.82,
      "lowBid": 0.28,
      "highBid": 1.46,
      "monthly": { "2025-09": 2000, "2025-10": 2200, "2026-08": 2600 },
      "rank": { "pos": 12, "abs": 14, "url": "https://senja.be/learn/which-magnesium", "title": "…" }
    }
  ]
}
```

| veld | betekenis |
|---|---|
| `domain` · `location` · `language` | vullen de Config-tab **aan**, overschrijven hem nooit. De klantsheet blijft de baas. |
| `measuredAt` | `YYYY-MM-DD`. Wordt de meetdatum van volumes én posities. |
| `depth` | tot welke positie er gekeken is (standaard 20). Daarboven bestaat 'een positie' niet. |
| `volume` | gemiddeld aantal zoekopdrachten per maand in die markt en taal. |
| `competition` | `HIGH` · `MEDIUM` · `LOW` — over adverteerders, niet over organische moeilijkheid. |
| `monthly` | array `[{month, volume}]` **of** object `{"2026-01": 1300}`. Beide mogen; met de hand bijwerken is makkelijker in de objectvorm. Minder dan 6 maanden = geen trend, de tab toont een streepje. |

### `rank` — drie toestanden

| schrijfwijze | betekenis | in de tabel |
|---|---|---|
| `{ "pos": 7, "abs": 9, "url": …, "title": … }` | gemeten, staat op 7 | `#7` |
| `{ "pos": null, "note": "gemiddeld 33.7" }` | gemeten, staat **niet** in de top `depth` | `—` |
| geen `rank`-veld | **niet gemeten** | `?` |

Het verschil tussen de tweede en de derde is het hele punt: 'staat er niet bij'
is een meetresultaat, 'nooit naar gekeken' niet. `abs` mag weg; hij wordt dan
gelijk aan `pos`. Een `abs` kleiner dan `pos` wordt gecorrigeerd — absolute
positie telt advertenties en snippets mee en kan dus nooit lager liggen.

## Code

- `api/_seodata.js` — Drive lezen, valideren, 5 minuten cachen.
- `api/seo.js` — voorrangsregel en de twee acties (`volumes`, `ranks`).

De respons heeft exact dezelfde vorm als de live-laag, dus de frontend hoeft
niets te weten van deze bron.
