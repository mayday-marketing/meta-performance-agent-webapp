// Duiding bij een performance-presentatie. Eén call voor de hele deck in plaats
// van één per blok: goedkoper, en een samenvatting die met dezelfde blik naar
// alle blokken kijkt kan niet iets anders beweren dan de losse duidingen.
//
// De cijfers komen uit de slides zelf (report.js leest ze uit de gerenderde
// HTML), dus deze functie haalt zelf niets op. Ze heeft ook geen resource-id
// nodig: het enige wat per klant verschilt is de Claude-key, en die komt uit
// CLIENTS[clientId] na verificatie van het token.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET = process.env.AUTH_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TOKEN_MAX_AGE_MS = 10 * 60 * 60 * 1000;

const MAX_BLOCKS = 40;

function verifyToken(token, clientId) {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length < 3) return false;
    const sig = parts.pop();
    const [tClientId, ts] = parts;
    if (tClientId !== clientId.toLowerCase()) return false;
    const payload = `${tClientId}:${ts}`;
    const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    if (Date.now() - parseInt(ts, 10) > TOKEN_MAX_AGE_MS) return false;
    return true;
  } catch { return false; }
}

function loadPrompt() {
  const p = path.join(process.cwd(), 'agents', 'Report_Agent.md');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  if (process.env.REPORT_SYSTEM_PROMPT) return process.env.REPORT_SYSTEM_PROMPT;
  return null;
}

// Zelfde aanpak als analysis.js: het model hoort kale JSON te geven, maar een
// codehek of een afgekapte staart mag geen hele presentatie kosten.
function repairTruncatedJson(s) {
  let inStr = false, esc = false;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
  }
  let out = s;
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, '');
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']';
  return out;
}

function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const first = text.indexOf('{');
  if (first < 0) return null;
  const last = text.lastIndexOf('}');
  if (last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch {}
  }
  try { return JSON.parse(repairTruncatedJson(text.slice(first))); } catch {}
  return null;
}

// Alleen vorm afdwingen, niet volledigheid: een deck met duiding bij tien van
// de twaalf blokken is bruikbaar, een harde fout is dat niet.
function clean(parsed, ids) {
  if (!parsed || typeof parsed !== 'object') return null;
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  if (!summary) return null;
  const known = new Set(ids);
  const blocks = {};
  const raw = parsed.blocks && typeof parsed.blocks === 'object' ? parsed.blocks : {};
  for (const [id, v] of Object.entries(raw)) {
    if (!known.has(id) || !v || typeof v !== 'object') continue;
    const caption = typeof v.caption === 'string' ? v.caption.trim() : '';
    const bullets = Array.isArray(v.bullets)
      ? v.bullets.filter(b => typeof b === 'string' && b.trim()).map(b => b.trim()).slice(0, 3)
      : [];
    if (caption || bullets.length) blocks[id] = { caption, bullets };
  }
  return { summary, blocks };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { clientId, token, brandName, period, blocks, clientContext, template, templateName } = req.body || {};

  if (!verifyToken(token, clientId)) {
    return res.status(401).json({ error: 'Sessie verlopen. Meld opnieuw aan.' });
  }
  if (!Array.isArray(blocks) || !blocks.length) {
    return res.status(400).json({ error: 'Geen blokken ontvangen om te duiden.' });
  }

  // Per-klant Claude-key (optioneel, server-side) met terugval op de gedeelde
  // mayday-key. Zelfde patroon als chat.js en analysis.js.
  let apiKey = ANTHROPIC_API_KEY;
  try {
    const clients = JSON.parse(process.env.CLIENTS || '{}');
    const clientKey = clients[String(clientId).toLowerCase()]?.anthropic_api_key;
    if (clientKey) apiKey = clientKey;
  } catch {}
  const usedClientKey = apiKey !== ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Anthropic API key niet geconfigureerd.' });

  let systemPrompt = loadPrompt();
  if (!systemPrompt) {
    return res.status(500).json({ error: 'Report prompt niet gevonden in agents/Report_Agent.md' });
  }
  if (clientContext?.trim()) {
    systemPrompt += '\n\n---\n\n## KLANTCONTEXT\n\n' + clientContext;
  }
  // Rapportsjabloon van deze klant (Drive, via 'Rapportlink' in de Config-tab).
  // Gezaghebbend boven de standaardaanpak: het beschrijft hoe déze klant zijn
  // rapport leest — welke secties, welke definities, welke toon. Maar het is een
  // vorm, geen bron: de cijfers komen uit de slides van déze periode, nooit uit
  // de voorbeelden in het sjabloon. Dat onderscheid staat er expliciet bij,
  // anders schrijft het model de voorbeeldcijfers over.
  if (typeof template === 'string' && template.trim()) {
    systemPrompt += '\n\n---\n\n## RAPPORTSJABLOON VAN DEZE KLANT\n\n'
      + `Hieronder staat ${templateName ? `'${String(templateName).slice(0, 120)}'` : 'het sjabloon'}: `
      + 'een eerder rapport van deze klant dat vastlegt hoe zijn rapportage eruitziet.\n\n'
      + 'VOLG HIERVAN: de indeling en volgorde van onderwerpen, de toon, het '
      + 'woordgebruik, en vooral de definities en meetregels die erin staan '
      + '(welke bron waarvoor geldt, wat wel en niet opgeteld mag worden, welke '
      + 'claims verboden zijn).\n\n'
      + 'NEEM HIERUIT GEEN ENKEL GETAL OVER. De cijfers in dit sjabloon horen bij '
      + 'een andere periode. Alles wat je noemt komt uit de slides die je in het '
      + 'bericht krijgt. Staat er in het sjabloon een cijfer waar de slides niets '
      + 'over zeggen, dan laat je het weg.\n\n'
      + template;
  }

  const trimmed = blocks.slice(0, MAX_BLOCKS);
  const ids = trimmed.map(b => b.id);

  const userMsg = [
    `Merk: ${brandName || clientId}`,
    `Periode: ${period?.startDate} t/m ${period?.endDate} (${period?.days} dagen)`,
    '',
    'De slides in deze presentatie, met de cijfers die er werkelijk op staan:',
    '```json',
    JSON.stringify({ period, blocks: trimmed }, null, 2),
    '```',
    '',
    'Geef enkel de JSON-output volgens het voorgeschreven schema.',
  ].join('\n');

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json().catch(() => ({}));
      const base = err.error?.message || 'Anthropic API fout.';
      const hint = usedClientKey && [400, 401, 403].includes(anthropicRes.status)
        ? ' (controleer de Claude API-key en credits van deze klant)'
        : '';
      return res.status(anthropicRes.status).json({ error: base + hint });
    }

    const data = await anthropicRes.json();
    const text = data.content?.[0]?.text || '';
    const report = clean(extractJson(text), ids);
    if (!report) {
      return res.status(502).json({ error: 'Duiding ongeldig: geen bruikbare JSON ontvangen.', raw: text.slice(0, 800) });
    }
    return res.status(200).json({ report });

  } catch (e) {
    return res.status(502).json({ error: 'Verbinding met Anthropic mislukt: ' + e.message });
  }
};
