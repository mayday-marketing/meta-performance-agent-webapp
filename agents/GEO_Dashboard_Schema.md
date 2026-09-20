# geo-dashboard.json — schema voor de GEO-tab

De GEO-tab in het dashboard leest één bestand per klant: **`geo-dashboard.json`**
in de Drive-map van die klant. Dit document beschrijft dat bestand.
Werkend voorbeeld met echte cijfers: `geo-dashboard.example.json` hiernaast.

## Waarom een JSON en niet het audit-rapport zelf

De `geo-visibility-audit`-skill levert een markdown-rapport. Dat rapport is voor
mensen: twee echte audits (mayday en Just Jane, allebei 28-07-2026) hebben
verschillende koppen, verschillende tabelkolommen (`Runs` vs `Prompts`,
`Top competitor by SoV` vs `Top concurrent`), verschillende talen, en bij Just
Jane een extra baseline-tabel vóór de scorecard.

Een parser daarop faalt niet luid — hij geeft een verkeerd getal. Voor een
zichtbaarheidscijfer dat een klant te zien krijgt is dat het enige wat echt niet
mag. Vandaar: wie de audit draait, schrijft het resultaat één keer weg in dit
formaat. Dat is hetzelfde werk als de HTML-template per klant invullen, maar dan
machineleesbaar en één keer.

**Regel uit de handover blijft gelden: geen audit = geen cijfers.** Zonder
bestand toont de tab een uitleg, geen nullen en geen demo-data.

## Waar het bestand hoort

In de Drive-map van de klant (`CLIENTS[clientId].driveFolderId`), in deze
volgorde doorzocht:

1. de klantmap zelf
2. `GEO/`
3. `00_AI-CONTEXT/`

Elke bestandsnaam die matcht op `geo-dashboard*.json` telt mee; staan er
meerdere, dan wint de **laatst gewijzigde**. Zo kun je `2026-07-28_geo-dashboard.json`
laten staan naast een her-audit.

## Regels die de validator afdwingt

- **Percentages zijn getallen 0–100**, geen fracties. `15` is 15%. Velden heten
  daarom `...Pct`. Buiten dat bereik → veld valt weg met een waarschuwing.
- **Ontbrekend is onbekend, nooit nul.** Een weggelaten of ongeldig veld
  verdwijnt en de tab toont een streepje. Er wordt nooit een 0 ingevuld.
- **Onbekende velden worden genegeerd** — je mag eigen notities meeschrijven.
- Blokken zijn allemaal optioneel. Ontbreekt `prompts`, dan zegt die sub-tab dat
  er geen promptmatrix in dit auditbestand staat; de rest blijft werken.

## De blokken

### Kop

```json
{
  "brandName": "mayday marketing",
  "auditDate": "2026-07-28",
  "label": "Baseline (pre-launch)",
  "promptCount": 22,
  "passNote": "2 passes op de 11 High-prompts, 1 pass op Med/Low",
  "method": "22 buyer prompts, live via DataForSEO AI-optimization…"
}
```

`auditDate` moet `YYYY-MM-DD` zijn. Wijkt `promptCount` af van het aantal
prompts in de lijst, dan komt dat als waarschuwing terug — een deelmeting is
geldig, maar je wil het weten vóór een klant het ziet.

### `status` — de banner bovenaan

```json
{ "level": "blocked", "title": "Fase 0 — poort dicht", "text": "…" }
```

`level`: `blocked` (rood), `warn` (geel), `ok` (groen).

### `kpis` — de vier tegels

```json
[{ "label": "Mention rate · unbranded", "value": "0%", "tone": "bad",
   "delta": "nulmeting", "sub": "0/95 combinaties" }]
```

`value` is vrije tekst: het dashboard rekent hier niets, het toont wat de audit
gemeten heeft. `tone`: `good` | `bad` | `neutral`.

### `engines` — de scorecard

```json
[{ "name": "Gemini", "runs": 33, "mentionRatePct": 9, "shareOfVoicePct": 1,
   "descriptorAccuracyPct": 0, "topCompetitor": "HubSpot",
   "sourceType": "own-domain pages", "note": "14 how-to runs parametrisch" }]
```

`descriptorAccuracyPct` weglaten als de audit `n/a` zegt (geen mentions = niets
te beoordelen). Weglaten ≠ 0%.

### `byType` en `competitors`

```json
"byType":      [{ "type": "categorie", "ratePct": 0, "note": "0/6" }],
"competitors": [{ "name": "HubSpot", "engines": 5, "note": "top-mention overal" }]
```

`engines` bij een concurrent = op hoeveel engines die de top-mention is.

### `phases` — de zes fasen

```json
[{ "n": "0", "title": "Basis", "gate": "Poort: readiness ≥ 9/11", "here": true }]
```

Precies één fase met `"here": true`.

### `prompts` — de matrix

```json
[{ "n": 3, "text": "best membership for marketers who want to use AI",
   "type": "categorie", "priority": "High",
   "engines": { "ChatGPT": 0, "Claude": 0, "Perplexity": 0, "Gemini": 2, "AI Overviews": 0 } }]
```

Celwaarden:

| waarde | betekenis |
|---|---|
| `0` | niet genoemd |
| `1` | genoemd |
| `2` | genoemd maar **fout** beschreven |
| veld weggelaten of `null` | **niet gemeten** |

Die vierde toestand staat niet in de oorspronkelijke HTML-template maar is wel
nodig: in de Just Jane-audit is Gemini op 7 van de 20 prompts gemeten en de rest
niet. Zonder onderscheid telt 'niet gemeten' als 'niet genoemd' en zakt de
mention rate structureel te laag. De kolomkoppen van de matrix komen uit de
namen in `engines`.

### `readiness` — de technische checks

```json
[{ "check": "robots.txt laat AI-crawlers toe", "status": "fail", "note": "site niet bereikbaar" }]
```

`status`: `pass` | `fail` | `unknown`. De score bovenaan telt alleen `pass`
tegen het totaal, en `unknown` wordt apart genoemd — anders lijkt onmeetbaar
hetzelfde als gezakt.

### `actions` — de actiekaarten

```json
[{ "priority": "P1", "effort": "M", "skill": "grounding-page + geo-schema-entity",
   "title": "Site live + grounding page", "text": "…",
   "done": "5 engines noemen mayday.marketing eerst op brand-prompts." }]
```

### `sources` — de live laag

```json
{ "keyword": "AI marketing", "platform": "chat_gpt",
  "location": "United States", "language": "en" }
```

Dit stuurt de Sources-tab, die wél live bij DataForSEO ophaalt welke domeinen en
pagina's AI-antwoorden voeden. Het keyword staat hier vast en kan niet vanuit de
browser gewijzigd worden: elke pull kost ongeveer $0,10 op het gedeelde
DataForSEO-saldo. Het platform mag in de tab wel gewisseld worden tussen
`chat_gpt` en `google`.

**Let op de databases:** de Belgische database kent alleen platform `google`
(AI Overviews / AI Mode) en vereist een taalparameter. De ChatGPT-database
bestaat enkel voor VS/EN. Staat er `chat_gpt` met `location: "Belgium"`, dan
komt er niets terug.

### `previous` — vorige meting

```json
{ "auditDate": "2026-05-12", "kpis": [{ "label": "Mention rate · unbranded", "value": "0%" }] }
```

Alleen voor de vergelijkingsregel onder de KPI-tegels. Labels moeten exact
overeenkomen met die in `kpis`.
