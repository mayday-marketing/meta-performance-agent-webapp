#!/usr/bin/env node
/* ==========================================================
   set-client-field.js — velden in de CLIENTS env var wijzigen
   ==========================================================
   Leest CLIENTS uit .env.local, past velden aan en schrijft het resultaat naar
   een bestand met rechten 0600, klaar om met `vercel env add --force` terug te
   zetten. De waarde zelf wordt NOOIT geprint: je ziet alleen welk veld van welke
   klant verandert, en bij een geheim veld alleen of het gevuld is.

   Gebruik:
     node scripts/set-client-field.js baja.dataSheetId=1abc… justjane.dataSheetId=1xyz…
     node scripts/set-client-field.js --out /pad/naar/clients.json  …

   Waarom scripten i.p.v. met de hand in het tekstvak van Vercel: die JSON bevat
   alle klantwachtwoorden op één regel. Eén komma verkeerd en elke klant kan niet
   meer inloggen — en dat is precies hoe spotto's sheet-id ooit in het veld
   driveFolderId terechtkwam.
   ========================================================== */

const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx !== -1 ? args[outIdx + 1] : path.join(os.tmpdir(), 'clients-new.json');
const edits = args.filter(a => a.includes('=') && a.includes('.') && !a.startsWith('--'));

if (!edits.length) {
  console.error('Geef minstens één wijziging op, bv: baja.dataSheetId=1abc…');
  process.exit(1);
}

// Hergebruik de tolerante env-parser uit het andere script.
const helperSrc = fs.readFileSync(path.join(__dirname, 'add-config-tab.js'), 'utf8');
const body = helperSrc.slice(helperSrc.indexOf('function rawAfterKey'), helperSrc.indexOf('/* ---------- Google auth'));
const loadEnv = new Function('fs', 'path', '__dirname', 'DEBUG', 'ENV_FILE', body + '; return loadEnv();');
const { clients } = loadEnv(fs, path, __dirname, false, null);

if (!clients || !Object.keys(clients).length) {
  console.error('CLIENTS niet gevonden of leeg.');
  process.exit(1);
}

const before = JSON.stringify(clients);
const GEHEIM = /password|key|secret|token/i;

for (const edit of edits) {
  const eq = edit.indexOf('=');
  const pad = edit.slice(0, eq);
  const waarde = edit.slice(eq + 1);
  const [klant, veld] = pad.split('.');

  if (!clients[klant]) { console.error(`Klant '${klant}' bestaat niet in CLIENTS.`); process.exit(1); }

  const oud = clients[klant][veld];
  clients[klant][veld] = waarde;

  const toon = (v) => v == null ? '(ontbrak)' : (GEHEIM.test(veld) ? '(gevuld)' : v);
  console.log(`  ${klant}.${veld}`);
  console.log(`      ${toon(oud)}  →  ${GEHEIM.test(veld) ? '(gevuld)' : waarde}`);
}

// Veiligheidscontrole: geen klant mag verdwijnen of velden verliezen.
const na = JSON.parse(JSON.stringify(clients));
const voor = JSON.parse(before);
for (const k of Object.keys(voor)) {
  if (!na[k]) { console.error(`Klant ${k} is verdwenen — afgebroken.`); process.exit(1); }
  for (const f of Object.keys(voor[k])) {
    if (!(f in na[k])) { console.error(`Veld ${k}.${f} is verdwenen — afgebroken.`); process.exit(1); }
  }
}

const json = JSON.stringify(clients);
JSON.parse(json);   // moet rond te parsen zijn

fs.writeFileSync(OUT, json, { mode: 0o600 });
console.log(`\nKlanten: ${Object.keys(clients).length} · ${json.length} tekens geschreven naar:`);
console.log(`  ${OUT}`);
console.log('\nTerugzetten naar Vercel (per omgeving):');
for (const env of ['production', 'preview', 'development']) {
  console.log(`  vercel env add CLIENTS ${env} --force --yes < ${OUT}`);
}
console.log('\nDaarna opruimen:  rm ' + OUT);
