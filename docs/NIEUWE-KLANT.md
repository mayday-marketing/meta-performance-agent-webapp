# Nieuwe klant opzetten

Volledige set-up van één klant in het meta-performance-dashboard. Werk de stappen
van boven naar beneden af; elke stap ontgrendelt iets in het dashboard en de
volgorde is niet vrijblijvend (stap 8 hangt aan 7, stap 12 aan 10).

Achtergrond bij de architectuur staat in [../CLAUDE.md](../CLAUDE.md). Dit
document is de handleiding, dat is de uitleg.

---

## 0 · Vooraf verzamelen

- Klantcode (kleine letters, dit wordt de login) + een sterk wachtwoord
- Windsor.ai: welke connectors gekoppeld zijn en het account-id per connector
- Google Drive: klantmap-id · Google Sheets: klantsheet-id + eventueel de
  Windsor-datasheet-id
- Merk: accentkleur (hex), logo-URL, GA4-property, Search Console-property
- Commercieel: brutomarge, lopende seizoenskorting, GA4-eventnaam van het
  hoofddoel

Het service-account waarmee alles gedeeld wordt:

```
performance-agent@performance-agent-493301.iam.gserviceaccount.com
```

---

## Checklist

- [ ] 1 · Klantcode gekozen
- [ ] 2 · Drive-klantmap volgens de mappenconventie
- [ ] 3 · Drive-map gedeeld met het service-account (Viewer)
- [ ] 4 · Contextbestanden in `00_AI-CONTEXT`
- [ ] 5 · Klantsheet met de tabs `Merkcontext`, `Config`, `Analysehistoriek`
- [ ] 6 · Klantsheet gedeeld met het service-account (Editor)
- [ ] 7 · Config-tab ingevuld
- [ ] 8 · Windsor-account-id's ingevuld (fail-closed!)
- [ ] 9 · Windsor-datasheet-export ingesteld
- [ ] 10 · Klant toegevoegd aan de `CLIENTS` env var in Vercel
- [ ] 11 · GEO-audit gedraaid en `geo-dashboard.json` in Drive
- [ ] 12 · Gedeployed
- [ ] 13 · Login getest
- [ ] 14 · Elke tab nagelopen tegen de bron
- [ ] 15 · Alleen URL + code + wachtwoord aan de klant gegeven

---

## 1 · Kies de klantcode

Kleine letters, geen spaties (bijvoorbeeld `merknaam`). Dit is tegelijk de sleutel
in de `CLIENTS` env var en wat de klant intypt bij het inloggen. `auth.js` zet de
ingetypte code altijd om naar lowercase.

## 2 · Maak de Drive-klantmap

De code zoekt op vaste paden; een afwijkende mapnaam betekent stilzwijgend geen
data. Zie `api/drive.js`.

```
<Klantmap>/
├── 00_AI-CONTEXT/
├── 01_MERK-STRATEGIE/
├── 03_MARKETING-STRATEGIE/
├── GEO/
└── 06_PERFORMANTIE/
    ├── 6.2_Benchmarks/
    ├── 6.3_Rapporten/
    │   └── Organische-Rapporten/
    │       └── Instagram/
    └── 6.4_Ruwe-Data/          (ook 6.4_Ruwe-data en 6.4_Ruwe_Data worden herkend)
```

Submappen van `6.4_Ruwe-Data` worden meegescand.

## 3 · Deel de map met het service-account

Rol **Viewer**. De map-id staat in de URL:
`drive.google.com/drive/folders/<ID>`.

## 4 · Leg de contextbestanden klaar

In `00_AI-CONTEXT` (of `01_MERK-STRATEGIE` / `03_MARKETING-STRATEGIE`). De code
herkent ze aan het nummer in de bestandsnaam, niet aan de rest van de naam:

| Nummer | Label |
|---|---|
| `0.1` | Merk-Brief |
| `0.2` | Do's & Don'ts |
| `0.3` | Woordenlijst |
| `1.3` | Concurrentieanalyse |
| `3.3` | Content Pijlers |

## 5 · Maak de klantsheet

Template: `CLIENTS/KLANTNAAM/06_PERFORMANTIE/Klant_Context_TEMPLATE.xlsx`.
Drie tabs, met exact deze namen:

| Tab | Vorm | Gebruikt door |
|---|---|---|
| `Merkcontext` | kolom A veld, B waarde, tot rij 40 | analyse + chat |
| `Config` | kolom A veld, B waarde, tot rij 60 | het hele dashboard |
| `Analysehistoriek` | kolommen A–F | de analyse schrijft hier bij |

De `Config`-tab hoef je niet met de hand op te bouwen. Het script hieronder zet
hem erin met alle veldnamen en toelichtingen al ingevuld; jij vult alleen de
waarden aan (stap 7). Het leest `CLIENTS` en de service-account-sleutel uit
`.env.local`, dus draai het **pas na stap 6 en 10**:

```bash
node scripts/add-config-tab.js --apply --only <klantcode>
```

Zonder `--apply` is het een droogloop die alleen toont wat er zou gebeuren. Een
bestaande `Config`-tab wordt nooit overschreven.

Waarden invullen kan ook vanaf de commandoregel, bijvoorbeeld als je meerdere
klanten tegelijk bijwerkt:

```bash
# bestaande rij vullen
node scripts/add-config-tab.js --apply --only <klantcode> --set "GA4 property=491908260"

# veld dat nog niet in de tab staat onderaan toevoegen
node scripts/add-config-tab.js --apply --only <klantcode> --add "Steunkleur=#fbe431"
```

`--set` slaat een veld over dat niet in de tab staat; `--add` zet het op de
eerste vrije rij en laat de bestaande indeling en opmaak met rust.

## 6 · Deel de klantsheet met het service-account

Rol **Editor** — nodig omdat `Analysehistoriek` beschreven wordt. Sheet-id uit
`docs.google.com/spreadsheets/d/<ID>/edit`.

> **Let op.** Sheets kent geen rechten per tab. Zolang deze spreadsheet niet met
> de klant gedeeld is, is de Config-tab afgeschermd. Wachtwoorden en API-sleutels
> horen hier daarom nooit in: die blijven in de `CLIENTS` env var.

## 7 · Vul de Config-tab in

Kolom A = veldnaam, kolom B = waarde, kolom C = toelichting (wordt niet
gelezen). `scripts/add-config-tab.js` zet vrijwel alle velden hieronder als
template in de tab; jij vult kolom B in. Veldnamen zijn hoofdletter-, spatie- en
accent-ongevoelig. Een waarde tussen `[ ]` of een `—` telt als niet ingevuld. Een
ongeldige waarde breekt niets: het veld valt weg en de reden komt terug als
waarschuwing.

**Huisstijl**

| Veld | Waarde |
|---|---|
| `Merknaam` | vrije tekst, max 60 tekens |
| `Accentkleur` | `#rrggbb` — de merkkleur. Moet 4,5:1 halen op de achtergrond |
| `Accenttekstkleur` | `#rrggbb` — alleen invullen als het accent die 4,5:1 níet haalt |
| `Steunkleur` (of `Tweede kleur`) | `#rrggbb` — tweede merkkleur, **alleen als vlakvulling** |
| `Logo URL` | https-URL, alleen van `drive.google.com`, `lh3.googleusercontent.com` of `mayday.marketing` |

De steunkleur is bedoeld voor kleuren die als tekst onbruikbaar zijn maar als
highlight-vlak prima werken — bij één klant haalt het geel `#fbe431` 1,23:1 op de
achtergrond, maar 13,46:1 met donkere tekst erop. Het dashboard zet hem daarom
alleen als achtergrond in, nooit als tekst-, reeks- of statuskleur. Heeft de
klant maar één merkkleur, laat het veld dan leeg.

Dit veld staat **niet** in de template die `add-config-tab.js` schrijft; voeg het
met de hand toe of met `--add` (zie stap 5).

**Kanalen — de sleutel is de Windsor-connector-slug**

| Veld | Ontgrendelt |
|---|---|
| `Instagram account` | Instagram organisch |
| `Meta ad account` | Meta Ads (`act_` mag ervoor staan) |
| `Facebook account` | Facebook organisch |
| `Klaviyo account` / `Mailerlite account` / `Convertkit account` | e-mailtab |
| `Google Ads account`, `TikTok ad account`, `Bing ad account`, `LinkedIn ad account`, `Pinterest ad account`, `Snapchat ad account`, `Amazon ads account` | dat kanaal in de ROAS-tab |

Een nieuw betaald kanaal vergt geen codewijziging: het verschijnt zodra hier een
account-id staat (zie `api/_channels.js`).

**Website-tab**

| Veld | Waarde |
|---|---|
| `GA4 property` | property-id (ook de omzetbron van de ROAS-tab) |
| `Search Console site` | `sc-domain:merk.be` of `https://www.merk.be/` — exact, inclusief slash |
| `Websitetype` | `webshop` of `leads`; leeg → afgeleid uit de data |
| `Conversiedoel` | GA4-eventnaam, bv. `generate_lead` of `property_form_submit` |
| `Conversiedoellabel` | hoe dat doel in de UI heet, max 40 tekens |

Zonder `Conversiedoel` toont de tab *alle* key events samen. Dat verschil is
groot — bij één klant 2.112 formulieren tegenover 72.004 key events — dus vul het
in als de klant één hoofddoel heeft.

**ROAS-tab**

| Veld | Waarde |
|---|---|
| `Brutomarge` | `45`, `45%`, `0,45` — alles wordt 0,45 |
| `Seizoenskorting` | idem; > 0 maakt het kortingsscenario actief |
| `Minimum ROAS` | getal, directe override van de berekende drempel |
| `Oordeel op` | `GA4` (default) of `Platform` |

Break-even = `(1 − korting) / (brutomarge − korting)`. Zonder `Brutomarge` is er
geen drempel en dus geen oordeel, maar blijven alle ROAS-cijfers staan.

**SEO-tab**

| Veld | Waarde |
|---|---|
| `SEO domein` | `merk.be` (protocol, www en pad gaan er automatisch af) |
| `SEO markt` | DataForSEO-locatienaam, bv. `Belgium` (default) |
| `SEO taal` | tweeletterige code, bv. `nl` (default) |
| `SEO keywords` | lijst gescheiden door komma, puntkomma of regeleinde |

De DataForSEO-inloggegevens staan **niet** in deze tab maar in de env var.

## 8 · Zet de Windsor-account-id's erin

De account-id's uit stap 7 doen het echte isolatiewerk. **Fail-closed:** zodra er
één account-id in de config staat, levert elke scopebare connector *zonder* id
een lege dataset — bewust, want anders zou zo'n connector álle klanten van het
gedeelde Windsor-account teruggeven.

Scopebare connectors: `instagram`, `facebook`, `facebook_organic`, `klaviyo`,
`mailerlite`, `googleanalytics4`, `searchconsole`, `tiktok`, `google_ads`,
`bing`, `linkedin`, `pinterest`, `snapchat`, `amazon_ads`.

Gevolg bij het opzetten: een vergeten GA4-property is geen "valt terug op alles",
maar een lege Website-tab. Loop de lijst dus af per gekoppelde connector.

## 9 · Zet de Windsor-datasheet-export op

Optioneel, maar het scheelt bij elk bezoek ~17 seconden op de Website-tab. Vijf
exporttaken naar één spreadsheet:

1. GA4 — per **dag**
2. GA4 — per **kanaal**
3. GA4 — per **landingspagina**
4. Search Console — per **dag**
5. Search Console — per **query**

De tabs worden op patroon herkend (bron + niveau), niet op naam, dus de standaard
exportnamen van Windsor volstaan. Deel de spreadsheet met het service-account
(Viewer) en noteer de id voor stap 10.

> **Deel een Windsor-datasheet nooit met een klant.** Windsor schrijft mislukte
> runs inclusief de volledige aanroep-URL — mét `api_key=` — naar de
> `Queries`-tab, en die sleutel is gedeeld over alle klanten.

## 10 · Voeg de klant toe aan `CLIENTS` in Vercel

Vercel → project → Settings → Environment Variables → `CLIENTS` (Sensitive).
Voeg één sleutel toe aan de JSON:

```json
"nieuweklant": {
  "password": "sterk-wachtwoord",
  "brandName": "Nieuwe Klant",
  "sheetId": "<klantsheet-id>",
  "driveFolderId": "<drive-map-id>",
  "dataSheetId": "<windsor-datasheet-id>",
  "windsor_api_key": "<mayday windsor key>",
  "email_connector": "klaviyo"
}
```

| Veld | Verplicht | Waarvoor |
|---|---|---|
| `password` | ja | login |
| `brandName` | nee | valt terug op de klantcode |
| `sheetId` | voor Config/Merkcontext/analyse | stap 5 |
| `driveFolderId` | voor Drive + GEO | stap 2 |
| `dataSheetId` | nee | stap 9 — hoort hier, nooit in de Config-tab |
| `windsor_api_key` | voor alle live data | Windsor |
| `windsor_accounts` | nee | fallback voor account-id's; de Config-tab wint |
| `email_connector` | nee | `klaviyo`, `mailerlite` of `convertkit`; anders geraden |
| `anthropic_api_key` | nee | eigen sleutel i.p.v. de gedeelde |
| `dataforseo_login` + `dataforseo_password` | nee | eigen DataForSEO-account |
| `metricool_token` + `metricool_user_id` (+ `metricool_blog_id`) | nee | klanten op Metricool i.p.v. Windsor |

`dataSheetId` staat bewust in de env var en niet in de Config-tab: die tab kan
met de klant gedeeld worden, en een sheet-id daaruit accepteren zou een klant
laten kiezen wiens data hij leest.

## 11 · GEO-baseline

Draai de `geo-visibility-audit`-skill en schrijf het resultaat weg als
`geo-dashboard.json` volgens [../agents/GEO_Dashboard_Schema.md](../agents/GEO_Dashboard_Schema.md).
Werkend voorbeeld: [../agents/geo-dashboard.example.json](../agents/geo-dashboard.example.json).

Het bestand mag in de klantmap zelf, in `GEO/` of in `00_AI-CONTEXT/` staan;
elke naam die matcht op `geo-dashboard*.json` telt, de nieuwste wint.
Percentages zijn getallen 0–100, geen fracties. Geen bestand = de tab toont wat
er moet gebeuren, nooit nullen en nooit demo-data.

## 12 · Deploy

Een gewijzigde env var wordt pas actief na een nieuwe deploy.

```bash
vercel --prod
```

Of in Vercel: Deployments → laatste deployment → Redeploy. `vercel` deployt de
**lokale** werkmap, dus push daarna (GitHub Desktop) zodat `main` niet afdrijft
van wat live staat.

## 13 · Test de login

Open de productie-URL, log in met de nieuwe klantcode en het wachtwoord.
Controleer in de sidebar dat **Windsor.ai** als live bron staat — dat komt uit
`hasWindsor` en bewijst dat `windsor_api_key` gelezen wordt.

## 14 · Loop elke tab na tegen de bron

| Tab | Waarop letten |
|---|---|
| Overzicht | IG-cijfers en Meta Ads-spend tegenover Ads Manager |
| Website | totalen tegenover GA4; check de voetnoot `sheet` of `api` |
| ROAS | break-even-drempel, actief scenario, kanalen zichtbaar |
| E-mail | juiste connector, niet leeg |
| SEO | volumes laden; rank-check kost ~€0,002 per keyword, één keer volstaat |
| GEO | baseline gevonden, datum klopt |
| Analyse | levert JSON én schrijft een regel in `Analysehistoriek` |
| Chat | antwoordt met de merkcontext erin |

## 15 · Lever op

Geef de klant **alleen** de dashboard-URL, de klantcode en het wachtwoord. Niet
de klantsheet (Config-tab), niet de Windsor-datasheet.

---

## Twee dingen die verwarring geven

- **De Config-tab is 10 minuten gecachet** per klant. Na een wijziging in de
  sheet duurt het dus even voor je ze in het dashboard ziet.
- **Ontbrekende data is onbekend, nooit nul.** Een lege tab betekent meestal een
  ontbrekend account-id (stap 8), geen kapotte koppeling. De waarschuwingen uit
  de Config-tab staan in de respons van `sheets.js action=config`.
