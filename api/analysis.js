const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET = process.env.AUTH_SECRET || 'change-this-secret';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TOKEN_MAX_AGE_MS = 10 * 60 * 60 * 1000;

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

function loadAnalysisPrompt() {
  const paths = [
    path.join(process.cwd(), 'agents', 'Analysis_Agent.md'),
    path.join(process.cwd(), 'Analysis_Agent.md'),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  if (process.env.ANALYSIS_SYSTEM_PROMPT) return process.env.ANALYSIS_SYSTEM_PROMPT;
  return null;
}

// Repareer een afgekapte JSON-string: sluit een open string af en balanceer de nog
// openstaande { en [ haakjes. Vangt de meest voorkomende afkap-situatie (max_tokens-limiet)
// zodat een grotendeels-complete analyse alsnog bruikbaar is i.p.v. een harde fout.
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
  // verwijder een eventuele dangling komma vóór het sluiten
  out = out.replace(/,\s*$/, '');
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']';
  return out;
}

// Pull the first balanced JSON object out of the model response.
// Tolerates leading/trailing prose or markdown fences even though the prompt forbids them.
function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const first = text.indexOf('{');
  if (first < 0) return null;
  const last = text.lastIndexOf('}');
  if (last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch {}
  }
  // Laatste redmiddel: probeer een afgekapte JSON te repareren (balanceer haakjes/strings).
  try { return JSON.parse(repairTruncatedJson(text.slice(first))); } catch {}
  return null;
}

function validateAnalysis(a) {
  if (!a || typeof a !== 'object') return 'Geen JSON-object ontvangen.';
  if (typeof a.summary !== 'string' || !a.summary.trim()) return 'summary ontbreekt.';
  // winners/losers: streef naar 5 (tolerant 3–6 voor dunne datasets); recs blijft 2–3.
  for (const key of ['winners', 'losers']) {
    if (!Array.isArray(a[key])) return `${key} is geen array.`;
    if (a[key].length < 3 || a[key].length > 6) return `${key} moet 3 tot 6 items hebben.`;
  }
  if (!Array.isArray(a.recs)) return 'recs is geen array.';
  if (a.recs.length < 2 || a.recs.length > 3) return 'recs moet 2 of 3 items hebben.';
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { clientId, token, brandName, period, summary, clientContext, customBenchmarks } = req.body || {};

  if (!verifyToken(token, clientId)) {
    return res.status(401).json({ error: 'Sessie verlopen. Meld opnieuw aan.' });
  }
  // Per-klant Claude-key (optioneel, server-side) met terugval op de gedeelde mayday-key.
  let apiKey = ANTHROPIC_API_KEY;
  try {
    const clients = JSON.parse(process.env.CLIENTS || '{}');
    const clientKey = clients[String(clientId).toLowerCase()]?.anthropic_api_key;
    if (clientKey) apiKey = clientKey;
  } catch {}
  const usedClientKey = apiKey !== ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Anthropic API key niet geconfigureerd.' });
  }
  if (!summary || typeof summary !== 'object') {
    return res.status(400).json({ error: 'Geen dashboard-samenvatting ontvangen.' });
  }

  let systemPrompt = loadAnalysisPrompt();
  if (!systemPrompt) {
    return res.status(500).json({ error: 'Analysis prompt niet gevonden in agents/Analysis_Agent.md' });
  }
  if (clientContext?.trim()) {
    systemPrompt += '\n\n---\n\n## KLANTCONTEXT\n\n' + clientContext;
  }
  // Klantspecifieke benchmarks/targets uit Drive (6.2_Benchmarks). Aanwezig → de agent
  // vergelijkt tegen deze doelen i.p.v. enkel de periode-interne mediaan. Afwezig → standaard.
  if (customBenchmarks?.trim()) {
    systemPrompt += '\n\n---\n\n## EIGEN KLANT-BENCHMARKS\n\n'
      + 'De klant heeft eigen doelen/benchmarks aangeleverd. Behandel deze als gezaghebbende '
      + 'referentie: vergelijk posts, ads en KPIs expliciet met deze targets in winners/losers/recs '
      + '("boven/onder jullie doel van X"). Vul aan met de periode-interne benchmarks waar de klant '
      + 'geen eigen target voor opgaf.\n\n' + customBenchmarks;
  }

  const userMsg = [
    `Merk: ${brandName || clientId}`,
    `Periode: ${period?.startDate} t/m ${period?.endDate} (${period?.days} dagen)`,
    '',
    'Geaggregeerde dashboard-data:',
    '```json',
    JSON.stringify(summary, null, 2),
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
        max_tokens: 8192, // ruim genoeg voor 5 winners + 5 losers + recs (was 4096 → JSON kapte af)
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
    const parsed = extractJson(text);
    const validationError = validateAnalysis(parsed);
    if (validationError) {
      return res.status(502).json({ error: `Analyse-output ongeldig: ${validationError}`, raw: text.slice(0, 800) });
    }
    return res.status(200).json({ analysis: parsed });

  } catch (e) {
    return res.status(502).json({ error: 'Verbinding met Anthropic mislukt: ' + e.message });
  }
};
