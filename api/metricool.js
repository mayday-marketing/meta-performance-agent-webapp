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

// Dates arrive as JS Date strings or YYYY-MM-DD — convert to YYYYMMDD integer for Metricool
function toMetricoolDate(dateStr) {
  return dateStr.replace(/-/g, '');
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

  const { action, clientId, token, startDate, endDate } = req.body || {};

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
  const mcBlogId = client.metricool_blog_id || mcUserId;

  try {
    switch (action) {

      // Returns brand profile + blogId
      case 'getBrands': {
        const data = await mc(`/admin/simpleProfiles?blogId=${mcBlogId}`, mcToken, mcUserId);
        return res.status(200).json(data);
      }

      // Returns IG KPIs + FB KPIs for Overview page
      case 'getOverview': {
        const date = endDate ? toMetricoolDate(endDate) : '';
        const dateParam = date ? `&date=${date}` : '';
        const [ig, fb] = await Promise.all([
          mc(`/stats/values/instagram?blogId=${mcBlogId}${dateParam}`, mcToken, mcUserId)
            .catch(e => ({ error: e.message })),
          mc(`/stats/values/facebook?blogId=${mcBlogId}${dateParam}`, mcToken, mcUserId)
            .catch(e => ({ error: e.message })),
        ]);
        return res.status(200).json({ instagram: ig, facebook: fb });
      }

      // Returns IG posts + reels + FB posts for Library page
      case 'getPosts': {
        if (!startDate || !endDate) return res.status(400).json({ error: 'startDate en endDate vereist.' });
        const start = toMetricoolDate(startDate);
        const end = toMetricoolDate(endDate);
        const dateParams = `&start=${start}&end=${end}`;
        const [igPosts, igReels, fbPosts] = await Promise.all([
          mc(`/stats/instagram/posts?blogId=${mcBlogId}${dateParams}`, mcToken, mcUserId)
            .catch(e => ({ error: e.message })),
          mc(`/stats/instagram/reels?blogId=${mcBlogId}${dateParams}`, mcToken, mcUserId)
            .catch(e => ({ error: e.message })),
          mc(`/stats/facebook/posts?blogId=${mcBlogId}${dateParams}`, mcToken, mcUserId)
            .catch(e => ({ error: e.message })),
        ]);
        return res.status(200).json({ igPosts, igReels, fbPosts });
      }

      default:
        return res.status(400).json({ error: `Onbekende action: ${action}` });
    }
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
