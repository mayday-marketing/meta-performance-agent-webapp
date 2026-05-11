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

function safeCall(promise) {
  return promise.catch((e) => ({ __error: e.message }));
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

      case 'getBrands': {
        const data = await mc(`/admin/simpleProfiles?blogId=${mcBlogId}`, mcToken, mcUserId);
        return res.status(200).json(data);
      }

      // One-shot dashboard fetch: current + previous KPI snapshots, posts in period,
      // and ad campaigns. Runs all requests in parallel.
      case 'getDashboard': {
        if (!startDate || !endDate) return res.status(400).json({ error: 'startDate en endDate vereist.' });
        const start = toMetricoolDate(startDate);
        const end = toMetricoolDate(endDate);

        // Previous period = same length window ending one day before startDate.
        const startMs = Date.parse(startDate);
        const endMs = Date.parse(endDate);
        const windowMs = endMs - startMs;
        const prevEndDate = new Date(startMs - 86400000).toISOString().slice(0, 10);
        const prevEnd = toMetricoolDate(prevEndDate);

        const dateRange = `&start=${start}&end=${end}`;

        const [
          igCurrent, fbCurrent,
          igPrevious, fbPrevious,
          igPosts, igReels, fbPosts,
          adsCampaigns,
        ] = await Promise.all([
          safeCall(mc(`/stats/values/instagram?blogId=${mcBlogId}&date=${end}`, mcToken, mcUserId)),
          safeCall(mc(`/stats/values/facebook?blogId=${mcBlogId}&date=${end}`, mcToken, mcUserId)),
          safeCall(mc(`/stats/values/instagram?blogId=${mcBlogId}&date=${prevEnd}`, mcToken, mcUserId)),
          safeCall(mc(`/stats/values/facebook?blogId=${mcBlogId}&date=${prevEnd}`, mcToken, mcUserId)),
          safeCall(mc(`/stats/instagram/posts?blogId=${mcBlogId}${dateRange}`, mcToken, mcUserId)),
          safeCall(mc(`/stats/instagram/reels?blogId=${mcBlogId}${dateRange}`, mcToken, mcUserId)),
          safeCall(mc(`/stats/facebook/posts?blogId=${mcBlogId}${dateRange}`, mcToken, mcUserId)),
          safeCall(mc(`/stats/facebookads/campaigns?blogId=${mcBlogId}${dateRange}`, mcToken, mcUserId)),
        ]);

        return res.status(200).json({
          period: { startDate, endDate, prevStartDate: new Date(startMs - windowMs - 86400000).toISOString().slice(0, 10), prevEndDate },
          current: { instagram: igCurrent, facebook: fbCurrent },
          previous: { instagram: igPrevious, facebook: fbPrevious },
          posts: { igPosts, igReels, fbPosts },
          adsCampaigns,
        });
      }

      case 'getOverview': {
        const date = endDate ? toMetricoolDate(endDate) : '';
        const dateParam = date ? `&date=${date}` : '';
        const [ig, fb] = await Promise.all([
          safeCall(mc(`/stats/values/instagram?blogId=${mcBlogId}${dateParam}`, mcToken, mcUserId)),
          safeCall(mc(`/stats/values/facebook?blogId=${mcBlogId}${dateParam}`, mcToken, mcUserId)),
        ]);
        return res.status(200).json({ instagram: ig, facebook: fb });
      }

      case 'getPosts': {
        if (!startDate || !endDate) return res.status(400).json({ error: 'startDate en endDate vereist.' });
        const start = toMetricoolDate(startDate);
        const end = toMetricoolDate(endDate);
        const dateParams = `&start=${start}&end=${end}`;
        const [igPosts, igReels, fbPosts] = await Promise.all([
          safeCall(mc(`/stats/instagram/posts?blogId=${mcBlogId}${dateParams}`, mcToken, mcUserId)),
          safeCall(mc(`/stats/instagram/reels?blogId=${mcBlogId}${dateParams}`, mcToken, mcUserId)),
          safeCall(mc(`/stats/facebook/posts?blogId=${mcBlogId}${dateParams}`, mcToken, mcUserId)),
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
