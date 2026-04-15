# Just Jane — Performance Agent Web App
**Versie:** 1.0 · April 2026 · Just Jane Marketing

---

## Bestandsstructuur

```
performance-agent-webapp/
├── index.html                    ← Chat interface (Just Jane branding)
├── api/
│   ├── auth.js                   ← Login endpoint
│   ├── chat.js                   ← Anthropic API proxy (streaming)
│   └── sheets.js                 ← Google Sheets lezen & schrijven
├── agents/
│   ├── LEES_MIJ.txt
│   └── Meta-Performance_Agent.md ← Zelf toevoegen (zie stap 1)
├── .env.example                  ← Template voor omgevingsvariabelen
├── .gitignore                    ← Beveiligt sleutels en agent
├── vercel.json                   ← Deployment configuratie
└── README.md                     ← Dit bestand
```

---

## Installatie — stap voor stap

### Stap 1 — Agent bestand toevoegen

Kopieer `Meta-Performance_Agent.md` naar de `agents/` map.
Dit bestand staat in `.gitignore` en gaat dus NIET naar GitHub.

### Stap 2 — .env bestand aanmaken

Kopieer `.env.example` naar `.env` en vul alle waarden in:

```bash
cp .env.example .env
```

Vul in `.env`:
- `ANTHROPIC_API_KEY` — van console.anthropic.com
- `AUTH_SECRET` — willekeurige lange string (gebruik een wachtwoordmanager)
- `CLIENTS` — JSON met klantcodes, wachtwoorden en Sheet IDs
- `GOOGLE_SERVICE_ACCOUNT_KEY` — inhoud van performance-agent-key.json

**CLIENTS format:**
```json
{
  "spotto": {
    "password": "kies-een-sterk-wachtwoord",
    "sheetId": "1abc...xyz",
    "brandName": "Spotto"
  },
  "andereklant": {
    "password": "ander-wachtwoord",
    "sheetId": "1def...uvw",
    "brandName": "Andere Klant"
  }
}
```

**sheetId** vind je in de URL van de Google Sheet:
`https://docs.google.com/spreadsheets/d/[SHEET_ID]/edit`

### Stap 3 — GitHub repository aanmaken

1. Ga naar github.com → New repository
2. Naam: `performance-agent-webapp`
3. Visibility: **Private** (verplicht)
4. Upload alle bestanden (ZONDER `.env` — staat in .gitignore)

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/jouw-account/performance-agent-webapp.git
git push -u origin main
```

### Stap 4 — Vercel deployment

1. Ga naar vercel.com → New Project
2. Importeer je GitHub repository
3. Klik **Deploy** (instellingen hoef je niet te wijzigen)

### Stap 5 — Environment variables instellen in Vercel

1. Ga in Vercel naar je project → **Settings** → **Environment Variables**
2. Voeg toe (één voor één):
   - `ANTHROPIC_API_KEY`
   - `AUTH_SECRET`
   - `CLIENTS`
   - `GOOGLE_SERVICE_ACCOUNT_KEY`
3. Klik **Save**
4. Ga naar **Deployments** → klik op laatste deployment → **Redeploy**

### Stap 6 — Testen

1. Open de Vercel URL (bv. `https://performance-agent-webapp.vercel.app`)
2. Log in met een klantcode en wachtwoord uit je CLIENTS config
3. Upload een test PDF + CSV
4. Type "start analyse" en bevestig elke stap met "continue"

### Stap 7 — Eigen domein (optioneel)

1. Vercel → Settings → Domains
2. Voeg toe: `agent.mayday.marketing`
3. Volg de DNS-instructies bij je domeinbeheerder

---

## Nieuwe klant toevoegen

1. Maak een Klant_Context Google Sheet aan (gebruik `Klant_Context_JustJane.xlsx` als template)
2. Deel de Sheet met het service account:
   `performance-agent@performance-agent-493301.iam.gserviceaccount.com` → Editor
3. Voeg de klant toe aan de `CLIENTS` env var in Vercel
4. Redeploy

---

## Technische stack

| Onderdeel | Tool |
|---|---|
| Frontend | HTML + Vanilla JS |
| Backend | Vercel serverless functions (Node.js) |
| AI | Anthropic API — claude-sonnet-4-20250514 |
| Database | Google Sheets via REST API |
| Auth | HMAC-signed tokens |
| Hosting | Vercel (gratis tier) |

---

## Kosten

| Onderdeel | Kost |
|---|---|
| Vercel hosting | €0 |
| Google Sheets API | €0 |
| Anthropic API | ~€0,15–0,20 per analyse-run |
| Domein (optioneel) | ~€12/jaar |

---

## Veiligheid

- `.env` bestand staat in `.gitignore` — gaat NOOIT naar GitHub
- `Meta-Performance_Agent.md` staat in `.gitignore` — intellectueel eigendom afgeschermd
- `GOOGLE_SERVICE_ACCOUNT_KEY` staat als env var in Vercel, nooit in code
- Tokens verlopen automatisch na 10 uur
- Alle API calls zijn server-side — API keys zijn nooit zichtbaar in de browser

---

*Just Jane Marketing · Vertrouwelijk · v1.0 · April 2026*
