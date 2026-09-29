# Het dashboard koppelen aan Claude (MCP)

Met deze koppeling vraagt Claude zelf de cijfers van het dashboard op, voor elke
klant. Je voert dan een strategisch gesprek ("waarom zakt de ROAS van Spotto,
en wat zou je volgende maand anders doen?") en Claude haalt de cijfers erbij
die het dashboard ook toont — dezelfde berekening, dezelfde drempels.

Achtergrond en de regels voor ontwikkelaars staan in [../CLAUDE.md](../CLAUDE.md)
onder 'MCP-koppeling'. Dit document is de handleiding.

**Stand V1 (26-09-2026):** alleen lezen, voor het mayday-team, via Claude Code.
Klanten zelf koppelen via claude.ai komt in V2 (inloggen met OAuth).

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

Zonder `MCP_AGENCY_KEYS` antwoordt de koppeling altijd "niet geconfigureerd".
Dat is zo bedoeld: dan staat hij dicht.

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

## Als het niet werkt

| Melding | Oorzaak | Oplossing |
|---|---|---|
| 503 · niet geconfigureerd | `MCP_AGENCY_KEYS` ontbreekt of is ongeldig | Stap 2 tot 8 van de beheerder |
| 401 · ongeldige sleutel | Sleutel verkeerd overgenomen of ingetrokken | Koppeling verwijderen en opnieuw toevoegen |
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
