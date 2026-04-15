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

function loadAgentPrompt() {
  const paths = [
    path.join(process.cwd(), 'agents', 'Meta-Performance_Agent.md'),
    path.join(process.cwd(), 'Meta-Performance_Agent.md'),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  if (process.env.AGENT_SYSTEM_PROMPT) return process.env.AGENT_SYSTEM_PROMPT;
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, clientId, token, clientContext, driveFiles, drivePeriod } = req.body || {};

  if (!verifyToken(token, clientId)) {
    return res.status(401).json({ error: 'Sessie verlopen. Meld opnieuw aan.' });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Anthropic API key niet geconfigureerd.' });
  }

  let systemPrompt = loadAgentPrompt();
  if (!systemPrompt) {
    return res.status(500).json({ error: 'Agent bestand niet gevonden. Zet Meta-Performance_Agent.md in de agents/ map.' });
  }
  if (clientContext?.trim()) {
    systemPrompt += '\n\n---\n\n## KLANTCONTEXT\n\n' + clientContext;
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Geen berichten ontvangen.' });
  }

  // If driveFiles are provided (server-side loaded from Drive),
  // build the first user message content with full file data
  let apiMessages = [...messages];

  if (driveFiles && driveFiles.length > 0 && drivePeriod) {
    // Build rich content array for the last user message
    const fileContent = [];

    // Add context files as text
    if (driveFiles.contextFiles?.length) {
      const ctxText = driveFiles.contextFiles
        .map(f => `## ${f.label}\n${f.content}`)
        .join('\n\n---\n\n');
      fileContent.push({ type: 'text', text: '## KLANTCONTEXT UIT GOOGLE DRIVE\n\n' + ctxText });
    }

    // Add data files
    for (const file of (driveFiles.files || [])) {
      if (file.contentType === 'pdf_base64') {
        fileContent.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: file.data }
        });
        fileContent.push({ type: 'text', text: `[Analytics PDF geladen: ${file.name}]` });
      } else if (file.contentType === 'csv_text') {
        fileContent.push({
          type: 'text',
          text: `[${file.type.replace('_', ' ').toUpperCase()}: ${file.name}]\n\`\`\`\n${file.data}\n\`\`\``
        });
      }
    }

    // Add the user's text message
    const lastMsg = messages[messages.length - 1];
    const userText = lastMsg?.content?.find?.(c => c.type === 'text')?.text
      || (typeof lastMsg?.content === 'string' ? lastMsg.content : '');
    if (userText) fileContent.push({ type: 'text', text: userText });

    // Replace last message with enriched version
    apiMessages = [
      ...messages.slice(0, -1),
      { role: 'user', content: fileContent }
    ];
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8096,
        system: systemPrompt,
        messages: apiMessages,
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json().catch(() => ({}));
      return res.status(anthropicRes.status).json({ error: err.error?.message || 'Anthropic API fout.' });
    }

    const data = await anthropicRes.json();
    const text = data.content?.[0]?.text || '';
    return res.status(200).json({ text });

  } catch (e) {
    return res.status(502).json({ error: 'Verbinding met Anthropic mislukt: ' + e.message });
  }
};
