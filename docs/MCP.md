# Het dashboard koppelen aan Claude (MCP)

Met deze koppeling vraagt Claude zelf de cijfers van het dashboard op, voor elke
klant. Je voert dan een strategisch gesprek ("waarom zakt de ROAS van Spotto,
en wat zou je volgende maand anders doen?") en Claude haalt de cijfers erbij
die het dashboard ook toont — dezelfde berekening, dezelfde drempels.

Achtergrond en de regels voor ontwikkelaars staan in [../CLAUDE.md](../CLAUDE.md)
onder 'MCP-koppeling'. Dit document is de handleiding.

**Stand V2 (06-10-2026):** alleen lezen. Het mayday-team koppelt via Claude
Code met een agency-sleutel (alle klanten). Een klant koppelt in claude.ai of
Cowork door in te loggen met zijn klantcode en wachtwoord (alleen dat merk) —
zie 'Per klant: koppelen in claude.ai'.

---

## Wat Claude kan opvragen

| Tool | Wat |
|---|---|
| `list_clients` | Alle klanten en welke bronnen gekoppeld zijn |
| `get_dashboard` | Social en Meta Ads: KPI's, beste en slechtste posts, advertenties |
| `get_roas` | Blended ROAS, break-even, oordeel per kanaal en campagne |
| `get_google_ads` | Google Ads: kosten per conversie, conversieacties, vertoningsaandeel, zoektermen, apparaten |
| `get_website` | GA4 en Search Console |
| `get_goals` | Doelen uit de tab Doelen, met stand en status |
| `get_brand_context` | Merkcontext uit de klantsheet en Drive |
| `get_geo` | De laatste AI-zichtbaarheidsmeting |

Betaalde opvragingen (SEO-posities, GEO-bronnen) zitten er bewust niet in: die
kosten per keer geld op het gedeelde DataForSEO-saldo.

---

## Eenmalig: de koppeling aanzetten (beheerder)

1. Maak per persoon een sleutel. Open Terminal en typ:

   ```bash
   openssl rand -hex 32
   ```

   Kopieer de uitkomst (64 tekens). Doe dit opnieuw voor elke persoon.
2. Ga naar [vercel.com](https://vercel.com) → project
   **meta-performance-agent-webapp** → **Settings** → **Environment Variables**.
3. Klik **Add New**.
4. Vul bij **Key** in: `MCP_AGENCY_KEYS`
5. Vul bij **Value** een lijst in met per persoon een naam en een sleutel:

   ```json
   {"jantien":"<sleutel van stap 1>","collega":"<andere sleutel>"}
   ```

   De naam verschijnt in de log, zodat je later één persoon kunt intrekken.
   Een sleutel korter dan 32 tekens wordt genegeerd.
6. Vink bij **Environments** alleen **Production** aan.
7. Zet **Sensitive** aan en klik **Save**.
8. Ga naar **Deployments**, klik op de bovenste productie-deployment → menu
   **⋯** → **Redeploy**. Een nieuwe variabele werkt pas na een nieuwe deploy.
9. Aanrader: ga naar **Firewall** → **Add Rule** en maak een rate limit op het
   pad `/api/mcp` (bijvoorbeeld 120 verzoeken per minuut per IP). De functie
   heeft zelf ook een rem, maar alleen per instantie.

Zonder `MCP_AGENCY_KEYS` werkt geen enkele agency-sleutel. Dat is zo bedoeld:
dan staat die toegang dicht.

---

## Per persoon: koppelen in Claude Code

1. Vraag de beheerder om jouw sleutel. Stuur hem nooit via e-mail of Slack in
   platte tekst; gebruik een wachtwoordmanager.
2. Open Terminal en typ, met je eigen sleutel in plaats van `<sleutel>`:

   ```bash
   claude mcp add --transport http --scope user mayday https://dashboard.mayday.marketing/api/mcp --header "Authorization: Bearer <sleutel>"
   ```

   `--scope user` maakt de koppeling beschikbaar in al je projecten.
3. Start Claude Code opnieuw.
4. Typ `/mcp` en controleer dat **mayday** op *connected* staat.
5. Vraag bijvoorbeeld: *"Welke klanten zitten deze maand onder hun break-even?"*

---

## Goede vragen om mee te beginnen

- "Vergelijk de ROAS van alle webshopklanten deze maand, op GA4 én platformomzet."
- "Wat zijn bij BAJA de drie advertenties die het meeste opleveren, en waarom?"
- "Ligt Spotto op schema voor zijn kwartaaldoelen?"
- "Welke posts van de laatste 28 dagen presteren boven hun bucket, en wat
  hebben die gemeen?"
- "Hoe staat de AI-zichtbaarheid van Just Jane ten opzichte van de vorige meting?"

---

## Per klant: koppelen in claude.ai of Cowork

De klant logt in met dezelfde klantcode en hetzelfde wachtwoord als op het
dashboard. Claude ziet daarna alleen de cijfers van dat ene merk.

**Eenmalig per klant (beheerder):**

1. Ga naar [vercel.com](https://vercel.com) → project
   **meta-performance-agent-webapp** → **Settings** → **Environment Variables**.
2. Zoek `MCP_OAUTH_CLIENTS`. Bestaat hij niet, klik dan **Add New** en vul bij
   **Key** `MCP_OAUTH_CLIENTS` in.
3. Zet bij **Value** de klantcodes die mogen koppelen, komma-gescheiden, in
   kleine letters. Bijvoorbeeld: `senja` of `senja,spotto`.
4. Vink bij **Environments** alleen **Production** aan en klik **Save**.
5. Ga naar **Deployments**, klik op de bovenste productie-deployment → menu
   **⋯** → **Redeploy**.

Een klant die niet in de lijst staat, krijgt na het inloggen de melding dat
koppelen voor zijn merk nog niet openstaat.

**Koppelen (de klant of jij, in claude.ai):**

1. Open [claude.ai](https://claude.ai) en klik linksonder op je naam →
   **Settings** → **Connectors**.
2. Klik **Add custom connector**.
3. Vul bij **Name** in: `mayday dashboard`.
4. Vul bij **URL** het adres van het merk in, met de klantcode op het einde:

   ```
   https://dashboard.mayday.marketing/api/mcp/senja
   ```

5. Klik **Add** en daarna **Connect**. Er opent een inlogscherm van mayday
   marketing; de klantcode staat al ingevuld.
6. Typ het wachtwoord van het dashboard en klik **Inloggen en koppelen**.
7. Terug in claude.ai staat de connector op *connected*. Zet hem in een gesprek
   aan via het menu **Search and tools**.

De koppeling blijft 90 dagen geldig zolang hij gebruikt wordt; daarna vraagt
claude.ai opnieuw om in te loggen.

**Eén klant ontkoppelen:** zet in de env var `CLIENTS` bij die klant
`"mcp_min_ts": <huidig tijdstip in ms>` (Terminal: `node -e "console.log(Date.now())"`)
en redeploy. Elk eerder uitgegeven token van die klant is dan ongeldig. Of haal
de klantcode uit `MCP_OAUTH_CLIENTS`. **Iedereen ontkoppelen:** zet
`MCP_MIN_TS` op hetzelfde tijdstip.

---

## Als het niet werkt

| Melding | Oorzaak | Oplossing |
|---|---|---|
| 503 · niet geconfigureerd | `AUTH_SECRET` ontbreekt in deze omgeving | `AUTH_SECRET` zetten en redeployen |
| 401 · ongeldige sleutel | Sleutel verkeerd overgenomen, ingetrokken, of `MCP_AGENCY_KEYS` ontbreekt | Stap 2 tot 8 van de beheerder; koppeling opnieuw toevoegen |
| "Koppelen met Claude staat voor dit merk nog niet open" | Klantcode staat niet in `MCP_OAUTH_CLIENTS` | Toevoegen en redeployen |
| "Deze koppeling hoort bij een ander merk" | Ingelogd met een andere klantcode dan in de URL | Connector met de juiste klantcode in de URL toevoegen |
| "Te veel mislukte pogingen" | Tien foute wachtwoorden vanaf hetzelfde adres | Een kwartier wachten |
| "De bron antwoordde niet op tijd" | Eerste opvraging van een periode is traag | Even wachten en opnieuw vragen; daarna komt het uit de cache |
| Onbekende klant | Klantcode verkeerd | Laat Claude eerst `list_clients` aanroepen |

Koppeling verwijderen:

```bash
claude mcp remove mayday --scope user
```

**Iemand intrekken:** haal zijn naam en sleutel uit `MCP_AGENCY_KEYS` in Vercel
en doe een redeploy (stap 8).

**Noodrem:** voeg in Vercel `MCP_DISABLED` = `1` toe en redeploy. Alles antwoordt
dan 503 tot je hem weer weghaalt.
