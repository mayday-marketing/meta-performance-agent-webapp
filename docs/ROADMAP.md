# Roadmap en todo

Open punten die bewust naar later zijn geschoven. Per punt: waarom het nodig is en
wat de eerste stap is. Afgewerkt → schrappen, niet laten staan.

## Data en exports

### Instagram-volgers als eigen export (Spotto, later voor alle klanten)
- **Waarom:** `followers_count` hoort bij Windsor's tabel `user_info` (profiel), niet
  bij de posts. In dezelfde export als de posts levert het per dag een extra rij
  zonder `media_id`/`timestamp`. Bij Spotto telde dat als 8 extra posts, en nu
  weigert het dashboard daardoor de hele Instagram-tab (lege verplichte velden).
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

## Snelheid

### Nachtelijke voorberekening per klant
- **Waarom:** een login bij Spotto kost ~20–33 s. De sheets veranderen één keer per
  dag, maar worden bij elke koude login opnieuw gelezen en ontleed. De Search
  Console-querytab (475.000 rijen) kost alleen al ~10 s.
- **Eerste stap:** meten met de `[tijd]`-regels welke blokken na de exportfixes nog
  traag zijn; pas dan beslissen of het een Vercel-cron + Runtime Cache/Blob wordt.

## Features

### Google Ads-leadweergave (Ads-pagina)
- **Waarom:** Spotto is een leadklant; `conversion_value` = 1 per lead, dus de
  platform-ROAS in de ROAS-tab zegt niets. Nodig: kosten per lead per campagne,
  impression share (gewogen naar vertoningen), zoekwoorden, zoektermen,
  conversieacties, apparaat. De datasheettabs bestaan al.
</content>
</invoke>
