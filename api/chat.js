const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET = process.env.AUTH_SECRET || 'change-this-secret';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TOKEN_MAX_AGE_MS = 10 * 60 * 60 * 1000; // 10 hours

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
  } catch {
    return false;
  }
}

function loadAgentPrompt() {
  // Try local agents/ folder first, then root
  const paths = [
    path.join(process.cwd(), 'agents', 'Meta-Performance_Agent.md'),
    path.join(process.cwd(), 'Meta-Performance_Agent.md'),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  // Fallback to env var if file not present
  if (process.env.AGENT_SYSTEM_PROMPT) return process.env.AGENT_SYSTEM_PROMPT;
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, clientId, token, clientContext } = req.body || {};

  if (!verifyToken(token, clientId)) {
    return res.status(401).json({ error: 'Sessie verlopen. Meld opnieuw aan.' });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Anthropic API key niet geconfigureerd.' });
  }

  // Load agent system prompt
  let systemPrompt = loadAgentPrompt();
  if (!systemPrompt) {
    return res.status(500).json({ error: 'Agent bestand niet gevonden. Zet Meta-Performance_Agent.md in de agents/ map.' });
  }

  // Append client context from Google Sheets if available
  if (clientContext && clientContext.trim()) {
    systemPrompt += '\n\n---\n\n## KLANTCONTEXT (geladen uit Google Sheets — Merkcontext tab)\n\n' + clientContext;
  }

  // Validate messages array
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Geen berichten ontvangen.' });
  }

  // Call Anthropic API with streaming
  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        stream: true,
      }),
    });
  } catch (e) {
    return res.status(502).json({ error: 'Verbinding met Anthropic mislukt.' });
  }

  if (!anthropicRes.ok) {
    const err = await anthropicRes.json().catch(() => ({}));
    return res.status(anthropicRes.status).json({ error: err.error?.message || 'Anthropic API fout.' });
  }

  // Stream response back to client
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');

  const reader = anthropicRes.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    // Client disconnected — normal
  } finally {
    res.end();
  }
};
