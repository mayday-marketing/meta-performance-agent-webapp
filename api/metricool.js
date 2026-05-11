const crypto = require('crypto');

const SECRET = process.env.AUTH_SECRET || 'change-this-secret';
const TOKEN_MAX_AGE_MS = 10 * 60 * 60 * 1000;
const BASE = 'https://app.metricool.com/api';

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

async function mc(path, mcToken, mcUserId) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${sep}userId=${mcUserId}`;
  const res = await fetch(url, { headers: { 'X-Mc-Auth': mcToken } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Metricool ${res.status}: ${text}`);
  }
  return res.json();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, clientId, token, blogId, startDate, endDate } = req.body || {};

  if (!verifyToken(token, clientId)) {
    return res.status(401).json({ error: 'Sessie verlopen. Meld opnieuw aan.' });
  }

  let clients;
  try {
    clients = JSON.parse(process.env.CLIENTS || '{}');
  } catch {
    return res.status(500).json({ error: 'Serverconfiguratie fout.' });
  }

  const client = clients[clientId.toLowerCase()];
  if (!client?.metricool_token || !client?.metricool_user_id) {
    return res.status(400).json({ error: 'Geen Metricool-koppeling voor deze klant.' });
  }

  const mcToken = client.metricool_token;
  const mcUserId = client.metricool_user_id;

  try {
    switch (action) {

      case 'getBrands': {
        const data = await mc(`/admin/simpleProfiles?blogId=${mcUserId}`, mcToken, mcUserId);
        return res.status(200).json(data);
      }

      case 'getOverview': {
        if (!blogId) return res.status(400).json({ error: 'blogId vereist.' });
        if (!startDate || !endDate) return res.status(400).json({ error: 'startDate en endDate vereist.' });
        const base = `?blogId=${blogId}&init=${startDate}&end=${endDate}`;
        const [ig, fb] = await Promise.all([
          mc(`/v2/analytics/instagram${base}`, mcToken, mcUserId).catch(e => ({ error: e.message })),
          mc(`/v2/analytics/facebook${base}`, mcToken, mcUserId).catch(e => ({ error: e.message })),
        ]);
        return res.status(200).json({ instagram: ig, facebook: fb });
      }

      case 'getPosts': {
        if (!blogId) return res.status(400).json({ error: 'blogId vereist.' });
        if (!startDate || !endDate) return res.status(400).json({ error: 'startDate en endDate vereist.' });
        const base = `?blogId=${blogId}&init=${startDate}&end=${endDate}`;
        const [igPosts, fbPosts] = await Promise.all([
          mc(`/v2/analytics/instagram/reels${base}`, mcToken, mcUserId).catch(e => ({ error: e.message })),
          mc(`/v2/analytics/facebook/posts${base}`, mcToken, mcUserId).catch(e => ({ error: e.message })),
        ]);
        return res.status(200).json({ instagram: igPosts, facebook: fbPosts });
      }

      default:
        return res.status(400).json({ error: `Onbekende action: ${action}` });
    }
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
