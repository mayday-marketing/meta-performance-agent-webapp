const crypto = require('crypto');

const SECRET = process.env.AUTH_SECRET;
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

async function mc(path, mcToken, mcUserId, timeoutMs = 25000) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${sep}userId=${mcUserId}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'X-Mc-Auth': mcToken },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Metricool ${res.status}: ${text.slice(0, 300)}`);
    }
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Metricool timeout (${timeoutMs}ms): ${path}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function safeCall(promise, label) {
  return promise.catch((e) => {
    console.error(`[metricool] ${label || ''} failed:`, e.message);
    return { __error: e.message };
  });
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

      // One-shot dashboard fetch: posts (current + previous period) + ad campaigns.
      // All KPIs are derived client-side from posts data.
      case 'getDashboard': {
        if (!startDate || !endDate) return res.status(400).json({ error: 'startDate en endDate vereist.' });
        const start = toMetricoolDate(startDate);
        const end = toMetricoolDate(endDate);

        // Previous period = same length window ending one day before startDate.
        const startMs = Date.parse(startDate);
        const endMs = Date.parse(endDate);
        const windowMs = endMs - startMs;
        const prevStartDate = new Date(startMs - windowMs - 86400000).toISOString().slice(0, 10);
        const prevEndDate = new Date(startMs - 86400000).toISOString().slice(0, 10);
        const prevStart = toMetricoolDate(prevStartDate);
        const prevEnd = toMetricoolDate(prevEndDate);

        const cur = `&start=${start}&end=${end}`;
        const prv = `&start=${prevStart}&end=${prevEnd}`;

        const [
          igPosts, igReels, fbPosts,
          igPostsPrev, igReelsPrev, fbPostsPrev,
        ] = await Promise.all([
          safeCall(mc(`/stats/instagram/posts?blogId=${mcBlogId}${cur}`, mcToken, mcUserId), 'ig-posts'),
          safeCall(mc(`/stats/instagram/reels?blogId=${mcBlogId}${cur}`, mcToken, mcUserId), 'ig-reels'),
          safeCall(mc(`/stats/facebook/posts?blogId=${mcBlogId}${cur}`, mcToken, mcUserId), 'fb-posts'),
          safeCall(mc(`/stats/instagram/posts?blogId=${mcBlogId}${prv}`, mcToken, mcUserId), 'ig-posts-prev'),
          safeCall(mc(`/stats/instagram/reels?blogId=${mcBlogId}${prv}`, mcToken, mcUserId), 'ig-reels-prev'),
          safeCall(mc(`/stats/facebook/posts?blogId=${mcBlogId}${prv}`, mcToken, mcUserId), 'fb-posts-prev'),
        ]);

        return res.status(200).json({
          period: { startDate, endDate, prevStartDate, prevEndDate },
          posts: { igPosts, igReels, fbPosts },
          postsPrev: { igPosts: igPostsPrev, igReels: igReelsPrev, fbPosts: fbPostsPrev },
        });
      }

      // Separate slow endpoint — fetched async after dashboard renders so trage
      // ads-call het hoofdscherm niet blokkeert. Eigen 50s timeout.
      case 'getAdsCampaigns': {
        if (!startDate || !endDate) return res.status(400).json({ error: 'startDate en endDate vereist.' });
        const start = toMetricoolDate(startDate);
        const end = toMetricoolDate(endDate);
        try {
          const data = await mc(
            `/stats/facebookads/campaigns?blogId=${mcBlogId}&start=${start}&end=${end}`,
            mcToken, mcUserId, 50000
          );
          return res.status(200).json({ adsCampaigns: data });
        } catch (e) {
          console.error('[metricool] ads-campaigns failed:', e.message);
          return res.status(200).json({ adsCampaigns: [], error: e.message });
        }
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
