/* ==========================================================
   Social Performance Agent — App logic
   Stap 3: echte auth + live Metricool data voor Overview
   ========================================================== */

(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const fmt = {
    int: (n) => Math.round(n).toLocaleString("nl-NL"),
    k: (n) => {
      if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
      return String(Math.round(n));
    },
    pct: (n) => n.toFixed(1) + "%",
    dateNL: (d) => d.toLocaleDateString("nl-NL", { day: "numeric", month: "short" }),
    dateISO: (d) => d.toISOString().slice(0, 10),
  };

  /* ---------- Performance classifier config (single source of truth) ----------
     Zowel classifyPerformance() als renderMethodology() lezen hieruit, zodat
     de code en de klantuitleg automatisch synchroon blijven. */
  const PERFORMANCE_CONFIG = {
    thresholds: { good: 1.2, bad: 0.7 },   // ratio t.o.v. bucket-mediaan
    minBucketSize: 3,                       // < 3 posts in bucket → label "n/a"
    // Gewichten per content-type. engagement = engagement_lite, save = save_rate,
    // watchTime = watch_time_ratio (schaal-onafhankelijk t.o.v. bucket-mediaan).
    formulas: {
      photo:    { engagement: 0.5, save: 0.5, watchTime: 0 },
      carousel: { engagement: 0.3, save: 0.7, watchTime: 0 },
      reel:     { engagement: 0.2, save: 0.1, watchTime: 0.7 },
      fbVideo:  { engagement: 0.3, save: 0.1, watchTime: 0.6 },
      story:    { engagement: 0.4, save: 0.0, watchTime: 0, reachShare: 0.6 },
    },
    // Fallback voor reels/video's zonder watch-time data (oudere posts).
    fallback: { engagement: 0.7, save: 0.3, watchTime: 0 },
  };

  const state = {
    session: null,                    // { token, clientId, brandName, hasMetricool, hasDrive }
    page: "overview",
    libraryView: "grid",
    libraryFilter: "all",
    librarySearch: "",
    librarySort: { key: "date", dir: "desc" },
    chatMessages: [],
    period: { start: null, end: null },
    overview: null,                   // populated by fetchOverview()
    overviewLoading: false,
    overviewError: null,
    analysisCache: {},                // { [periodKey]: { summary, winners, losers, recs } }
    analysisLoading: false,
    analysisError: null,
    analysisGenId: 0,                 // guard tegen out-of-order responses bij periode-wissel
  };

  /* ---------- Session persistence ---------- */

  const SESSION_KEY = "spa.session.v1";

  function saveSession(s) {
    state.session = s;
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {}
  }
  function loadSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) state.session = JSON.parse(raw);
    } catch {}
    return state.session;
  }
  function clearSession() {
    state.session = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch {}
  }

  /* ---------- API helpers ---------- */

  async function apiPost(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const msg = data?.error || `Fout ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function metricoolCall(action, extra = {}) {
    if (!state.session) throw new Error("Niet ingelogd");
    return apiPost("/api/metricool", {
      action,
      clientId: state.session.clientId,
      token: state.session.token,
      ...extra,
    });
  }

  function windsorCall(action, extra = {}) {
    if (!state.session) throw new Error("Niet ingelogd");
    return apiPost("/api/windsor", {
      action,
      clientId: state.session.clientId,
      token: state.session.token,
      ...extra,
    });
  }

  /* ---------- Screen flow ---------- */

  function showScreen(id) {
    $$(".screen").forEach((s) => s.classList.toggle("on", s.id === id));
    if (id === "app-screen") initDashboard();
  }
  window.showScreen = showScreen;

  function chooseSource(type) {
    if (type === "handmatig") {
      showScreen("manual-screen");
      hydrateManualContext();
    } else {
      showScreen("app-screen");
    }
  }
  window.chooseSource = chooseSource;

  /* ---------- Brand context (handmatige flow) ---------- */

  function countWords(s) {
    const trimmed = (s || "").trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
  }

  function updateSidebarContext() {
    const pill = $("#sidebar-context");
    const count = $("#sidebar-context-count");
    if (!pill || !count) return;
    const ctx = state.session?.clientContext || "";
    const n = countWords(ctx);
    if (n > 0) {
      count.textContent = `${n} woord${n === 1 ? "" : "en"}`;
      pill.style.display = "";
    } else {
      pill.style.display = "none";
    }
  }

  function updateManualContextCount() {
    const ta = $("#manual-context");
    const out = $("#manual-context-count");
    if (!ta || !out) return;
    const n = countWords(ta.value);
    out.textContent = n > 0 ? `${n} woord${n === 1 ? "" : "en"} · auto-saved` : "";
  }

  function hydrateManualContext() {
    const ta = $("#manual-context");
    if (!ta) return;
    ta.value = state.session?.clientContext || "";
    updateManualContextCount();
  }

  function bindManualContext() {
    const ta = $("#manual-context");
    if (!ta) return;
    ta.addEventListener("input", updateManualContextCount);
    ta.addEventListener("blur", () => {
      if (!state.session) return;
      state.session.clientContext = ta.value.trim();
      saveSession(state.session);
      updateSidebarContext();
      updateManualContextCount();
    });
  }

  function logout() {
    clearSession();
    state.overview = null;
    state.overviewError = null;
    state.analysisCache = {};
    state.analysisLoading = false;
    state.analysisError = null;
    state.chatMessages = [];
    dashboardInited = false;
    $("#brand-input").value = "";
    $("#code-input").value = "";
    $("#source-brand").textContent = "—";
    setLoginError("");
    showScreen("login-screen");
  }
  window.logout = logout;

  /* ---------- Login ---------- */

  function setLoginError(msg) {
    let el = $("#login-error");
    if (!el) {
      el = document.createElement("div");
      el.id = "login-error";
      el.style.cssText = "color:#c0392b; font-size:12px; margin-top:8px; min-height:16px;";
      $("#login-button").insertAdjacentElement("beforebegin", el);
    }
    el.textContent = msg || "";
  }

  async function login(e) {
    if (e && e.preventDefault) e.preventDefault();
    const clientId = $("#brand-input").value.trim();
    const password = $("#code-input").value.trim();
    if (!clientId || !password) {
      setLoginError("Vul zowel klantcode als wachtwoord in.");
      return;
    }

    const btn = $("#login-button");
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "Bezig…";
    setLoginError("");

    try {
      const data = await apiPost("/api/auth", { clientId, password });
      saveSession({
        token: data.token,
        clientId: data.clientId,
        brandName: data.brandName,
        sheetId: data.sheetId,
        hasMetricool: !!data.hasMetricool,
        hasDrive: !!data.hasDrive,
        hasWindsor: !!data.hasWindsor,
      });
      $("#source-brand").textContent = data.brandName;
      $("#sidebar-brand").textContent = `Klant: ${data.brandName}`;
      $("#sidebar-brand-sub").textContent = data.hasMetricool ? "Connected · Metricool live" : "Connected";
      updateSidebarContext();
      const ctxLabel = $("#chat-context-label");
      if (ctxLabel) ctxLabel.textContent = `Online · context: ${data.brandName}`;

      // Skip source-screen if either automatic source is available for this client.
      if (data.hasMetricool || data.hasDrive) {
        showScreen("app-screen");
      } else {
        $("#source-brand").textContent = data.brandName;
        showScreen("source-screen");
      }
    } catch (err) {
      setLoginError(err.message || "Inloggen mislukt.");
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
  window.login = login;

  /* ---------- Dashboard init ---------- */

  let dashboardInited = false;
  function initDashboard() {
    if (dashboardInited) return;
    dashboardInited = true;

    // Default range: last 90 days ending today.
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 89);
    state.period.start = fmt.dateISO(start);
    state.period.end = fmt.dateISO(today);
    $$(".date-filter input[type=date]")[0].value = state.period.start;
    $$(".date-filter input[type=date]")[1].value = state.period.end;
    bindDateFilter();
    bindPeriodToggle();

    renderLibrary();
    renderAnalysis();
    renderConnectors();   // dynamisch o.b.v. session (Blok D)
    renderMethodology();  // statische pagina o.b.v. PERFORMANCE_CONFIG (Blok E)
    renderChat();
    bindNav();
    bindChatPanel();

    // Live Overview — fetch + render.
    refreshOverview();
  }

  function bindNav() {
    $$(".nav-link").forEach((btn) => {
      if (btn.dataset.page) {
        btn.onclick = () => switchPage(btn.dataset.page);
      }
    });
  }

  function bindPeriodToggle() {
    const buttons = $$(".period-toggle button");
    const setPeriod = (days, label) => {
      const today = new Date();
      const start = new Date(today);
      start.setDate(start.getDate() - (days - 1));
      state.period.start = fmt.dateISO(start);
      state.period.end = fmt.dateISO(today);
      $$(".date-filter input[type=date]")[0].value = state.period.start;
      $$(".date-filter input[type=date]")[1].value = state.period.end;
      buttons.forEach(b => b.classList.toggle("on", b.dataset.days === String(days)));
      refreshOverview();
    };
    const presets = [
      { label: "90 dagen", days: 90 },
      { label: "30 dagen", days: 30 },
      { label: "7 dagen", days: 7 },
    ];
    buttons.forEach((btn, i) => {
      const p = presets[i];
      if (!p) return;
      btn.textContent = p.label;
      btn.dataset.days = String(p.days);
      btn.onclick = () => setPeriod(p.days, p.label);
    });
  }

  function switchPage(page) {
    state.page = page;
    $$(".nav-link").forEach((l) => l.classList.toggle("on", l.dataset.page === page));
    $$(".dash-page").forEach((p) => p.style.display = p.id === `page-${page}` ? "block" : "none");
    const titles = {
      overview:    { title: "Overview",    crumbs: ["Dashboard", "Overview"] },
      library:     { title: "Library",     crumbs: ["Dashboard", "Library"] },
      analysis:    { title: "Analysis",    crumbs: ["Dashboard", "Analysis"] },
      methodology: { title: "Methodology", crumbs: ["Dashboard", "Methodology"] },
    };
    const t = titles[page] || titles.overview;
    $(".page-title").textContent = t.title;
    $(".crumbs").innerHTML = t.crumbs.map((c, i) =>
      i === 0 ? `<span>${c}</span>` : `<span class="sep">/</span><span>${c}</span>`
    ).join("");
  }

  function bindDateFilter() {
    const inputs = $$(".date-filter input[type=date]");
    let timer;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const s = inputs[0].value;
        const e = inputs[1].value;
        if (!s || !e || s > e) return;
        state.period.start = s;
        state.period.end = e;
        $$(".period-toggle button").forEach(b => b.classList.remove("on"));
        refreshOverview();
      }, 400);
    };
    inputs.forEach((inp) => { inp.onchange = onChange; });
  }

  /* ---------- Overview: fetch + render ---------- */

  let adsFetchId = 0;

  async function refreshOverview() {
    // Een periode-wissel invalideert elke lopende analyse-generatie.
    state.analysisGenId++;
    state.analysisLoading = false;
    state.analysisError = null;

    // Windsor-flow voor klanten met windsor_api_key — voorrang boven Metricool.
    if (state.session?.hasWindsor) {
      return refreshOverviewWindsor();
    }

    if (!state.session?.hasMetricool) {
      state.overviewError = "Voor deze klant is geen Metricool- of Windsor-koppeling geconfigureerd.";
      renderOverview();
      renderAnalysis();
      return;
    }
    state.overviewLoading = true;
    state.overviewError = null;
    renderOverview();
    renderAnalysis();

    // Cancel any in-flight ads fetch from previous period.
    adsFetchId++;

    try {
      const raw = await metricoolCall("getDashboard", {
        startDate: state.period.start,
        endDate: state.period.end,
      });
      state.overview = transformDashboard(raw, null); // ads still loading
      state.overview._rawDashboard = raw;
      state.overviewLoading = false;
      renderOverview();
      renderAnalysis();

      // Fire ads-campaigns async — don't block dashboard.
      refreshAdsCampaigns(state.period.start, state.period.end);
    } catch (err) {
      state.overviewLoading = false;
      state.overviewError = err.message || "Onbekende fout bij laden Metricool-data.";
      if (err.status === 401) {
        clearSession();
        setTimeout(() => showScreen("login-screen"), 600);
      }
      renderOverview();
      renderAnalysis();
    }
  }

  async function refreshAdsCampaigns(startDate, endDate) {
    const myId = ++adsFetchId;
    try {
      const result = await metricoolCall("getAdsCampaigns", { startDate, endDate });
      if (myId !== adsFetchId) return; // outdated fetch — discard
      if (!state.overview?._rawDashboard) return;
      const dashboardRaw = state.overview._rawDashboard;
      const ads = arrayOrEmpty(result.adsCampaigns);
      state.overview = transformDashboard(dashboardRaw, ads);
      state.overview._rawDashboard = dashboardRaw;
      renderOverview(); // Re-render all panels: KPIs, trend, channel mix, top posts, cadence

    } catch (err) {
      if (myId !== adsFetchId) return;
      // Silent fail — keep ads-line at 0, no user-facing error.
      console.warn("[ads] fetch failed:", err.message);
      if (state.overview) {
        state.overview.adsLoading = false;
        renderTrendChart();
      }
    }
  }

  /* ---------- Metricool → app shape ---------- */

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function safeUrl(s) {
    // Block javascript:, data: (except images), and weird schemes.
    if (!s) return "";
    const lower = s.toLowerCase().trim();
    if (lower.startsWith("javascript:") || lower.startsWith("vbscript:")) return "";
    return s.replace(/["'<>]/g, "");
  }

  function safe(obj) { return (obj && !obj.__error) ? obj : {}; }
  function pick(obj, ...keys) {
    const o = safe(obj);
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "number" && !Number.isNaN(v)) return v;
    }
    return 0;
  }
  function pickStr(obj, ...keys) {
    const o = safe(obj);
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.length) return v;
    }
    return "";
  }

  const TYPE_LABELS = {
    FEED_CAROUSEL_ALBUM: "Carrousel",
    CAROUSEL_ALBUM: "Carrousel",
    CAROUSEL: "Carrousel",
    GRAPH_IMAGE: "Foto",
    IMAGE: "Foto",
    PHOTO: "Foto",
    GRAPH_VIDEO: "Video",
    VIDEO: "Video",
    REELS: "Reel",
    REEL: "Reel",
    STORY: "Story",
    STATUS: "Status",
    LINK: "Link",
    SHARE: "Share",
    EVENT: "Event",
  };
  function friendlyType(raw, fallback) {
    if (!raw) return fallback;
    const k = String(raw).toUpperCase();
    return TYPE_LABELS[k] || fallback;
  }

  function normalizePost(raw, platform, defaultType) {
    if (!raw || typeof raw !== "object") return null;
    // Prefer numeric Unix-ms timestamp (locale-safe); fall back to string dates.
    const ts = pick(raw, "timestamp");
    const published = ts || raw.created || raw.published || raw.publishedAt || raw.start || raw.date;
    const date = published ? new Date(published) : null;
    // Ad-campaign specific: active period [start, stop]. Posts will have these as 0.
    const startMs = pick(raw, "start");
    const stopMs = pick(raw, "stop") || pick(raw, "updated");
    const reach = pick(raw, "reach", "impressionsUnique");
    const impressions = pick(raw, "impressions");
    const likes = pick(raw, "likes", "reactions");
    const comments = pick(raw, "comments");
    const shares = pick(raw, "shares");
    const saves = pick(raw, "saved", "saves");
    const clicks = pick(raw, "clicks", "linkclicks");
    const views = pick(raw, "videoviews", "videoViews", "impressions");
    const interactions = pick(raw, "interactions") || (likes + comments + shares + saves);
    const engagementRaw = pick(raw, "engagement");
    // Metricool returns engagement either as fraction (0.05) or as pct (5.0). Heuristic:
    const engagement = engagementRaw > 1
      ? engagementRaw
      : (reach ? (interactions / reach) * 100 : 0);
    const ctr = reach ? (clicks / reach) * 100 : 0;
    // IG: content. FB: text. Other fallbacks for safety.
    const captionRaw = pickStr(raw, "content", "text", "caption", "name", "description", "title", "message", "firstcomment");
    const caption = captionRaw ? captionRaw.replace(/\s+/g, " ").trim() : "—";
    const thumb = pickStr(raw, "imageUrl", "image", "thumbnail", "picture", "fullPicture", "mediaUrl");
    const url = pickStr(raw, "url", "permalinkUrl", "permalink", "link");
    const rawType = pickStr(raw, "type", "mediaType", "mediaProductType");
    const type = friendlyType(rawType, defaultType);
    // Gem. kijktijd in seconden — Metricool exposeert dit doorgaans niet (→ 0),
    // defensief opgevangen voor het geval een endpoint het wél meelevert.
    const avgWatchTime = pick(raw, "avgwatchtime", "averageWatchTime", "videoAvgTimeWatched");

    return {
      id: pickStr(raw, "id", "postId") || url || `${platform}-${published || Math.random()}`,
      platform, type,
      date, dateLabel: date ? fmt.dateNL(date) : "—",
      startMs, stopMs,
      reach, impressions, likes, comments, shares, saves, clicks, views,
      interactions, engagement, ctr,
      avgWatchTime,
      caption, thumb, url,
    };
  }

  // Pro-rata reach voor ads-campagnes binnen een datumbereik.
  // Een campagne die van mrt 2025 tot mei 2026 liep krijgt voor een feb-mei 2026 window
  // alleen het deel reach toegekend dat met het window overlapt.
  function adsReachInRange(campaigns, rangeStartMs, rangeEndMs) {
    let total = 0;
    for (const c of campaigns) {
      if (!c.startMs || !c.stopMs || c.stopMs <= c.startMs) continue;
      const overlapStart = Math.max(c.startMs, rangeStartMs);
      const overlapEnd = Math.min(c.stopMs, rangeEndMs);
      if (overlapEnd <= overlapStart) continue;
      const totalMs = c.stopMs - c.startMs;
      const overlapMs = overlapEnd - overlapStart;
      total += (c.reach || 0) * (overlapMs / totalMs);
    }
    return Math.round(total);
  }

  function aggregatePosts(posts) {
    return posts.reduce((acc, p) => {
      acc.reach += p.reach || 0;
      acc.clicks += p.clicks || 0;
      acc.interactions += p.interactions || 0;
      acc.count += 1;
      return acc;
    }, { reach: 0, clicks: 0, interactions: 0, count: 0 });
  }

  function arrayOrEmpty(x) { return Array.isArray(x) ? x : []; }

  /* ---------- Performance classifier (Blok A) ----------
     Wijst per organic post een Good/Average/Bad/n-a-label toe, op basis van een
     multi-score vergeleken met de mediaan van dezelfde (platform × type)-bucket
     in de geselecteerde periode. Leest gewichten/thresholds uit PERFORMANCE_CONFIG.
     Zet labels in-place op de post-objecten; ads worden overgeslagen (andere KPI's). */

  function formulaKeyFor(post) {
    const t = (post.type || "").toLowerCase();
    if (t.startsWith("carrousel") || t.startsWith("carousel")) return "carousel";
    if (t.startsWith("foto") || t.startsWith("photo")) return "photo";
    if (t.startsWith("reel")) return "reel";
    if (t.startsWith("story")) return "story";
    if (t.startsWith("video")) return post.platform === "fb" ? "fbVideo" : "reel"; // IG-video → reel-formule
    return "photo"; // "Post"/"Status"/"Link" e.d. → foto-achtige content
  }

  // engagement_lite — saves bewust NIET meegerekend (dubbeltelling met save_rate vermijden).
  function engagementLite(p) {
    return p.reach ? ((p.likes || 0) + (p.comments || 0) + (p.shares || 0)) / p.reach * 100 : 0;
  }
  function saveRate(p) {
    return p.reach ? (p.saves || 0) / p.reach * 100 : 0;
  }
  function median(nums) {
    const arr = nums.filter(n => typeof n === "number" && !Number.isNaN(n)).sort((a, b) => a - b);
    if (!arr.length) return 0;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }

  function bucketLabel(platform, formulaKey) {
    const plat = { ig: "IG", fb: "FB" }[platform] || (platform || "").toUpperCase();
    const type = { photo: "foto's", carousel: "carrousels", reel: "reels", fbVideo: "video's", story: "stories" }[formulaKey] || formulaKey;
    return `${plat}-${type}`;
  }

  function classifyPerformance(allPosts) {
    const { thresholds, minBucketSize, fallback } = PERFORMANCE_CONFIG;

    // 1. Groepeer in (platform × formule-type)-buckets — ads overslaan.
    const buckets = {};
    for (const p of allPosts) {
      if (!p || p.platform === "ads") continue;
      const fk = formulaKeyFor(p);
      const key = `${p.platform}::${fk}`;
      (buckets[key] = buckets[key] || []).push(p);
    }

    for (const key of Object.keys(buckets)) {
      const posts = buckets[key];
      const fk = key.split("::")[1];
      const f = PERFORMANCE_CONFIG.formulas[fk] || PERFORMANCE_CONFIG.formulas.photo;
      const label = bucketLabel(key.split("::")[0], fk);

      // Noemer voor watch_time_ratio: mediaan avg-kijktijd over posts mét watch-data.
      const medianWatch = median(posts.map(p => p.avgWatchTime || 0).filter(v => v > 0));

      // 2. Multi-score per post.
      const scored = posts.map(p => {
        const eng = engagementLite(p);
        const sav = saveRate(p);
        const hasWatch = f.watchTime > 0 && medianWatch > 0 && (p.avgWatchTime || 0) > 0;
        const wtr = hasWatch ? (p.avgWatchTime / medianWatch) : 0;
        // Edge case: watch-gewogen type zonder watch-data → fallback-formule voor die post.
        const w = (f.watchTime > 0 && !hasWatch) ? fallback : f;
        const score = eng * (w.engagement || 0) + sav * (w.save || 0) + wtr * (w.watchTime || 0);
        return { p, score };
      });

      // 3. Benchmark = mediaan van de bucket-scores.
      const medianScore = median(scored.map(s => s.score));
      const tooSmall = posts.length < minBucketSize;

      for (const s of scored) {
        s.p.perfScore = +s.score.toFixed(3);
        s.p.perfBucket = label;
        if (tooSmall || !medianScore) {
          s.p.performance = null;   // "n/a"
          s.p.perfRatio = null;
          continue;
        }
        const ratio = s.score / medianScore;
        s.p.perfRatio = +ratio.toFixed(2);
        s.p.performance = ratio >= thresholds.good ? "Good" : (ratio < thresholds.bad ? "Bad" : "Average");
      }
    }
    return allPosts;
  }

  function transformDashboard(raw, adsCampaignsRaw) {
    const igPosts = arrayOrEmpty(raw.posts?.igPosts).map(p => normalizePost(p, "ig", "Post"));
    const igReels = arrayOrEmpty(raw.posts?.igReels).map(p => normalizePost(p, "ig", "Reel"));
    const fbPosts = arrayOrEmpty(raw.posts?.fbPosts).map(p => normalizePost(p, "fb", "Post"));
    const ads = arrayOrEmpty(adsCampaignsRaw).map(c => normalizePost(c, "ads", "Campagne"));

    const allPosts = [...igPosts, ...igReels, ...fbPosts].filter(Boolean);
    classifyPerformance(allPosts); // zet post.performance in-place (Blok A)
    const adsCampaigns = ads.filter(Boolean);

    // Previous period posts — used for true period-over-period deltas.
    const igPostsPrev = arrayOrEmpty(raw.postsPrev?.igPosts).map(p => normalizePost(p, "ig", "Post"));
    const igReelsPrev = arrayOrEmpty(raw.postsPrev?.igReels).map(p => normalizePost(p, "ig", "Reel"));
    const fbPostsPrev = arrayOrEmpty(raw.postsPrev?.fbPosts).map(p => normalizePost(p, "fb", "Post"));
    const allPostsPrev = [...igPostsPrev, ...igReelsPrev, ...fbPostsPrev].filter(Boolean);

    // All KPIs derive from posts data — internally consistent with the trend chart.
    const curAgg = aggregatePosts(allPosts);
    const prvAgg = aggregatePosts(allPostsPrev);

    // Pro-rata ads reach for both periods so the delta blijft apples-to-apples.
    const periodStartMs = new Date(raw.period.startDate).getTime();
    const periodEndMs = new Date(raw.period.endDate).getTime() + 86400000 - 1;
    const prevStartMs = new Date(raw.period.prevStartDate).getTime();
    const prevEndMs = new Date(raw.period.prevEndDate).getTime() + 86400000 - 1;
    const adsReachCur = adsReachInRange(adsCampaigns, periodStartMs, periodEndMs);
    const adsReachPrv = adsReachInRange(adsCampaigns, prevStartMs, prevEndMs);

    const erCur = curAgg.reach ? (curAgg.interactions / curAgg.reach) * 100 : 0;
    const erPrv = prvAgg.reach ? (prvAgg.interactions / prvAgg.reach) * 100 : 0;

    const kpis = [
      buildKpi("Totale reach", curAgg.reach + adsReachCur, prvAgg.reach + adsReachPrv, fmt.k, "pct"),
      buildKpi("Engagement rate", erCur, erPrv, (n) => fmt.pct(n), "pp"),
      buildKpi("Posts gepubliceerd", curAgg.count, prvAgg.count, (n) => String(n), "pct"),
      buildKpi("Clicks", curAgg.clicks, prvAgg.clicks, fmt.k, "pct"),
    ];

    // Sparklines: 12 weekly buckets of reach per KPI where applicable.
    const weeks = enumerateWeeks(raw.period.startDate, raw.period.endDate, 12);
    const weekReach = weeks.map(w => sumPostsField(allPosts, w, "reach"));
    const weekInteractions = weeks.map(w => sumPostsField(allPosts, w, "interactions"));
    const weekER = weeks.map((w, i) => weekReach[i] ? (weekInteractions[i] / weekReach[i]) * 100 : 0);
    const weekPostsCount = weeks.map(w => countPostsInWeek(allPosts, w));
    const weekClicks = weeks.map(w => sumPostsField(allPosts, w, "clicks"));

    kpis[0].spark = weekReach;
    kpis[1].spark = weekER;
    kpis[2].spark = weekPostsCount;
    kpis[3].spark = weekClicks;

    // Trend chart — wider weekly buckets across the full period (let's aim for ~13-17 buckets).
    const trendWeeks = enumerateWeeks(raw.period.startDate, raw.period.endDate);
    const trendIG = trendWeeks.map(w => sumPostsField([...igPosts, ...igReels].filter(Boolean), w, "reach"));
    const trendFB = trendWeeks.map(w => sumPostsField(fbPosts.filter(Boolean), w, "reach"));
    const trendAds = trendWeeks.map(w => adsReachInWeek(adsCampaigns, w));

    const timeseries = {
      weeks: trendWeeks.map((w, i) => `wk ${i + 1}`),
      series: [
        { label: "Instagram", color: "#ff683b", values: trendIG },
        { label: "Facebook", color: "#351f69", values: trendFB },
        { label: "Meta Ads", color: "#1f9b8a", values: trendAds },
      ],
    };

    // Channel mix — independent of week-bucketing. Real period totals.
    const igReach = [...igPosts, ...igReels].filter(Boolean).reduce((s, p) => s + (p.reach || 0), 0);
    const fbReach = fbPosts.filter(Boolean).reduce((s, p) => s + (p.reach || 0), 0);
    const adsReach = adsReachCur; // reuse from KPI calc above
    const totalChannelReach = igReach + fbReach + adsReach || 1;
    const channels = [
      { label: "Instagram", color: "#ff683b", value: Math.round((igReach / totalChannelReach) * 100) },
      { label: "Facebook",  color: "#351f69", value: Math.round((fbReach / totalChannelReach) * 100) },
      { label: "Meta Ads",  color: "#1f9b8a", value: Math.round((adsReach / totalChannelReach) * 100) },
    ];

    // Top posts (top 5 by engagement, organic only — ads excluded per architectuur)
    const topPosts = [...allPosts]
      .sort((a, b) => b.engagement - a.engagement)
      .slice(0, 5)
      .map((p, i) => {
        const cleanUrl = safeUrl(p.thumb);
        const isHttp = cleanUrl && cleanUrl.startsWith("http");
        return {
          id: p.id,
          caption: p.caption,
          type: p.type,
          platform: p.platform,
          date: p.dateLabel,
          engagement: p.engagement.toFixed(1) + "%",
          imageUrl: isHttp ? cleanUrl : null,
          fallbackBg: gradientFor(i),
        };
      });

    // Cadence: 7 days × 13 weeks heatmap of post counts.
    const cadenceWeeks = enumerateWeeks(raw.period.startDate, raw.period.endDate, 13);
    const cadence = [];
    for (let d = 0; d < 7; d++) {
      const row = [];
      for (let w = 0; w < cadenceWeeks.length; w++) {
        row.push(allPosts.filter(p => p.date && p.date.getDay() === ((d + 1) % 7) && inWeek(p.date, cadenceWeeks[w])).length);
      }
      cadence.push(row);
    }

    return {
      kpis,
      timeseries,
      channels,
      topPosts,
      cadenceWeeks,
      cadence,
      allPosts,
      adsCampaigns,
      adsLoading: !adsCampaignsRaw,
      _raw: raw,
    };
  }

  /* ---------- Windsor → app shape ---------- */

  function normalizeWindsorIgPost(raw) {
    if (!raw || typeof raw !== "object") return null;
    const date = raw.timestamp ? new Date(raw.timestamp) : null;
    const reach = Number(raw.media_reach) || 0;
    const likes = Number(raw.media_like_count) || 0;
    const comments = Number(raw.media_comments_count) || 0;
    const shares = Number(raw.media_shares) || 0;
    const saves = Number(raw.media_saved) || 0;
    const views = Number(raw.media_views) || 0;
    const engagementFromApi = Number(raw.media_engagement) || 0;
    const interactions = engagementFromApi || (likes + comments + shares + saves);
    const engagement = reach ? (interactions / reach) * 100 : 0;
    const captionRaw = typeof raw.media_caption === "string" ? raw.media_caption : "";
    const caption = captionRaw ? captionRaw.replace(/\s+/g, " ").trim() : "—";
    const rawType = raw.media_product_type || raw.media_type;
    const type = friendlyType(rawType, "Post");
    // Windsor levert reel-kijktijd in milliseconden → omzetten naar seconden.
    const avgWatchTime = Number(raw.media_reel_avg_watch_time) > 0
      ? Number(raw.media_reel_avg_watch_time) / 1000
      : 0;
    return {
      id: String(raw.media_id || `ig-${raw.timestamp || Math.random()}`),
      platform: "ig",
      type,
      date,
      dateLabel: date ? fmt.dateNL(date) : "—",
      startMs: 0, stopMs: 0,
      reach, impressions: views, likes, comments, shares, saves,
      clicks: 0, views,
      interactions, engagement, ctr: 0,
      avgWatchTime,
      caption,
      thumb: typeof raw.media_thumbnail_url === "string" ? raw.media_thumbnail_url
           : typeof raw.media_url === "string" ? raw.media_url : "",
      url: typeof raw.media_permalink === "string" ? raw.media_permalink : "",
    };
  }

  // Windsor levert Meta-actiestatistieken soms als platte scalar (suffix _video_view),
  // soms als action-breakdown array: [{action_type:"video_view", value:"2459"}].
  // Number([{…}]) → NaN → stilletjes 0 (precies de bug die de retentiecurve liet
  // verdwijnen). Deze helper haalt het getal uit beide vormen.
  function numFromAction(v) {
    if (v == null) return 0;
    if (Array.isArray(v)) {
      const hit = v.find(a => a && (a.action_type === "video_view" || a.action_type == null)) || v[0];
      return Number(hit && hit.value) || 0;
    }
    return Number(v) || 0;
  }

  function normalizeWindsorAdRow(raw) {
    if (!raw || typeof raw !== "object") return null;
    return {
      date: raw.date ? new Date(raw.date) : null,
      adId: String(raw.ad_id || ""),
      adName: String(raw.ad_name || ""),
      campaignId: String(raw.campaign_id || ""),
      campaignName: String(raw.campaign_name || ""),
      thumb: typeof raw.image_url === "string" ? raw.image_url : "",
      // Creative-type (geverifieerde Windsor-velden) — bepaalt het getoonde ad-type.
      igMediaType: String(raw.effective_instagram_media__media_type || ""),
      igProductType: String(raw.effective_instagram_media__media_product_type || ""),
      objectType: String(raw.object_type || ""),
      reach: Number(raw.reach) || 0,
      impressions: Number(raw.impressions) || 0,
      clicks: Number(raw.clicks) || 0,
      spend: Number(raw.spend) || 0,
      // Engagement op ad-niveau — geverifieerde Windsor-veldnamen (actions_*).
      likes:    Number(raw.actions_post_reaction) || 0,
      comments: Number(raw.actions_comment) || 0,
      shares:   Number(raw.actions_post) || 0,
      saves:    Number(raw.actions_onsite_conversion_post_save) || 0,
      // Video-retentie (Blok F) — geverifieerde veldnamen (suffix _video_view).
      // numFromAction vangt zowel de scalar- als de nested-array-vorm op, zodat een
      // veldnaam- of Windsor-gedragswijziging de curve niet opnieuw stil op 0 zet.
      vp25:   numFromAction(raw.video_p25_watched_actions_video_view ?? raw.video_p25_watched_actions),
      vp50:   numFromAction(raw.video_p50_watched_actions_video_view ?? raw.video_p50_watched_actions),
      vp75:   numFromAction(raw.video_p75_watched_actions_video_view ?? raw.video_p75_watched_actions),
      vp95:   numFromAction(raw.video_p95_watched_actions_video_view ?? raw.video_p95_watched_actions),
      vp100:  numFromAction(raw.video_p100_watched_actions_video_view ?? raw.video_p100_watched_actions),
      vplays: numFromAction(raw.video_play_actions_video_view ?? raw.video_play_actions),
    };
  }

  function sumAdsRowsInWeek(adsRows, week) {
    return adsRows.reduce((s, r) => {
      if (!r?.date) return s;
      return s + (inWeek(r.date, week) ? (r.reach || 0) : 0);
    }, 0);
  }

  // Aggregeer Windsor daily ads-rows tot pseudo-posts voor de Library (Blok B + Q2).
  // Werkt zowel op ad-niveau (heeft adId → één card per advertentie) als op
  // campagne-niveau (fallback wanneer de ad-level fetch faalt → één card per campagne).
  // Reach wordt gesommeerd over dagen (consistent met de KPI-berekening hierboven;
  // dit overschat unieke reach licht — bekende beperking van daily rows).
  // Leid het getoonde ad-type af uit de creative-velden. IG-velden zijn het meest
  // specifiek (Reel/Carrousel/Foto/Video); object_type is de FB-zijde fallback;
  // als laatste redmiddel onderscheidt video-afspeeldata Video van Foto.
  function adCreativeType(g) {
    const pt = (g.igProductType || "").toUpperCase(); // FEED / REELS / STORY
    const mt = (g.igMediaType || "").toUpperCase();    // IMAGE / VIDEO / CAROUSEL_ALBUM
    const ot = (g.objectType || "").toUpperCase();     // VIDEO / PHOTO / SHARE / STATUS
    if (pt === "REELS") return "Reel";
    if (pt === "STORY") return "Story";
    if (mt === "CAROUSEL_ALBUM") return "Carrousel";
    if (mt === "VIDEO") return "Video";
    if (mt === "IMAGE") return "Foto";
    if (ot === "VIDEO") return "Video";
    if (ot === "PHOTO") return "Foto";
    if (ot === "SHARE" || ot === "STATUS") return "Post";
    if ((g.vplays || 0) > 0) return "Video";
    return "Advertentie"; // type onbekend → neutrale fallback
  }

  function aggregateWindsorAds(adsRows) {
    const groups = {};
    for (const r of adsRows) {
      if (!r) continue;
      const isAd = !!r.adId;
      const id = isAd ? r.adId : (r.campaignId || r.campaignName || "onbekend");
      const g = groups[id] || (groups[id] = {
        id, isAd,
        name: isAd ? (r.adName || id) : (r.campaignName || id),
        campaign: r.campaignName || "", thumb: "",
        igMediaType: "", igProductType: "", objectType: "",
        reach: 0, impressions: 0, clicks: 0, spend: 0, lastDate: null,
        likes: 0, comments: 0, shares: 0, saves: 0,
        vp25: 0, vp50: 0, vp75: 0, vp95: 0, vp100: 0, vplays: 0,
      });
      g.reach += r.reach || 0;
      g.impressions += r.impressions || 0;
      g.clicks += r.clicks || 0;
      g.spend += r.spend || 0;
      g.likes += r.likes || 0; g.comments += r.comments || 0;
      g.shares += r.shares || 0; g.saves += r.saves || 0;
      g.vp25 += r.vp25 || 0; g.vp50 += r.vp50 || 0; g.vp75 += r.vp75 || 0;
      g.vp95 += r.vp95 || 0; g.vp100 += r.vp100 || 0; g.vplays += r.vplays || 0;
      if (!g.campaign && r.campaignName) g.campaign = r.campaignName;
      if (!g.thumb && r.thumb) g.thumb = r.thumb;
      // Creative-type is constant per advertentie — eerste niet-lege waarde volstaat.
      if (!g.igMediaType && r.igMediaType) g.igMediaType = r.igMediaType;
      if (!g.igProductType && r.igProductType) g.igProductType = r.igProductType;
      if (!g.objectType && r.objectType) g.objectType = r.objectType;
      if (r.date && (!g.lastDate || r.date > g.lastDate)) g.lastDate = r.date;
    }
    return Object.values(groups).map(g => {
      const ctr = g.impressions ? (g.clicks / g.impressions) * 100 : 0;
      const interactions = g.likes + g.comments + g.shares + g.saves;
      const engagement = g.reach ? (interactions / g.reach) * 100 : 0;
      // Retentiecurve (Blok F): percentage van video-plays dat elk checkpoint haalt.
      const retention = g.vplays > 0 ? {
        p3:  100, // ~start; Meta levert geen apart 3s-checkpoint op deze breakdown
        p25: Math.round((g.vp25 / g.vplays) * 100),
        p50: Math.round((g.vp50 / g.vplays) * 100),
        p75: Math.round((g.vp75 / g.vplays) * 100),
        p95: Math.round(((g.vp95 || g.vp100) / g.vplays) * 100),
      } : null;
      return {
        id: `ads-${g.id}`,
        platform: "ads",
        isAd: g.isAd,                          // robuuste ad-vs-campagne-vlag (los van de label-string)
        type: g.isAd ? adCreativeType(g) : "Campagne",
        subtitle: g.isAd ? g.campaign : "",   // campagne als context-subregel bij ad-cards
        date: g.lastDate,
        dateLabel: g.lastDate ? fmt.dateNL(g.lastDate) : "—",
        startMs: 0, stopMs: 0,
        reach: g.reach, impressions: g.impressions,
        likes: g.likes, comments: g.comments, shares: g.shares, saves: g.saves,
        clicks: g.clicks, views: g.vplays,
        interactions, engagement, ctr,
        avgWatchTime: 0, spend: g.spend,
        retention,
        caption: g.name, thumb: g.thumb, url: "",
      };
    });
  }

  function transformWindsorDashboard(raw) {
    const igPostsRaw = arrayOrEmpty(raw.instagram?.data);
    const adsRowsRaw = arrayOrEmpty(raw.ads?.data);    // campagne-niveau (reach voor trend/KPI)
    const adsAdRaw = arrayOrEmpty(raw.adsAd?.data);    // ad-niveau (per advertentie, indien gelukt)

    const igPosts = igPostsRaw.map(normalizeWindsorIgPost).filter(Boolean);
    const adsRows = adsRowsRaw.map(normalizeWindsorAdRow).filter(Boolean);
    const adsAdRows = adsAdRaw.map(normalizeWindsorAdRow).filter(Boolean);

    const allPosts = igPosts; // FB organic via Windsor nog niet gewired
    classifyPerformance(allPosts); // zet post.performance in-place (Blok A)
    // Library: per advertentie zodra de ad-level fetch rijen gaf; anders fallback per campagne.
    const adsCampaigns = aggregateWindsorAds(adsAdRows.length ? adsAdRows : adsRows);

    const curAgg = aggregatePosts(allPosts);
    const adsReachCur = adsRows.reduce((s, r) => s + (r.reach || 0), 0);
    const adsClicksCur = adsRows.reduce((s, r) => s + (r.clicks || 0), 0);

    const erCur = curAgg.reach ? (curAgg.interactions / curAgg.reach) * 100 : 0;

    const kpis = [
      buildKpi("Totale reach", curAgg.reach + adsReachCur, null, fmt.k, "pct"),
      buildKpi("Engagement rate", erCur, null, (n) => fmt.pct(n), "pp"),
      buildKpi("Posts gepubliceerd", curAgg.count, null, (n) => String(n), "pct"),
      buildKpi("Clicks", curAgg.clicks + adsClicksCur, null, fmt.k, "pct"),
    ];

    const startDate = raw.period.startDate;
    const endDate = raw.period.endDate;

    // KPI sparklines
    const sparkWeeks = enumerateWeeks(startDate, endDate, 12);
    kpis[0].spark = sparkWeeks.map(w => sumPostsField(allPosts, w, "reach") + sumAdsRowsInWeek(adsRows, w));
    const weekER = sparkWeeks.map(w => {
      const r = sumPostsField(allPosts, w, "reach");
      const i = sumPostsField(allPosts, w, "interactions");
      return r ? (i / r) * 100 : 0;
    });
    kpis[1].spark = weekER;
    kpis[2].spark = sparkWeeks.map(w => countPostsInWeek(allPosts, w));
    kpis[3].spark = sparkWeeks.map(w => sumPostsField(allPosts, w, "clicks") + adsRows.reduce((s, r) => s + (r.date && inWeek(r.date, w) ? (r.clicks || 0) : 0), 0));

    // Trend chart
    const trendWeeks = enumerateWeeks(startDate, endDate);
    const trendIG = trendWeeks.map(w => sumPostsField(igPosts, w, "reach"));
    const trendFB = trendWeeks.map(_ => 0); // geen FB organic via Windsor in deze iteratie
    const trendAds = trendWeeks.map(w => sumAdsRowsInWeek(adsRows, w));
    const timeseries = {
      weeks: trendWeeks.map((w, i) => `wk ${i + 1}`),
      series: [
        { label: "Instagram", color: "#ff683b", values: trendIG },
        { label: "Facebook",  color: "#351f69", values: trendFB },
        { label: "Meta Ads",  color: "#1f9b8a", values: trendAds },
      ],
    };

    // Channel mix
    const igReach = trendIG.reduce((s, v) => s + v, 0);
    const fbReach = 0;
    const adsReach = adsReachCur;
    const totalChannelReach = igReach + fbReach + adsReach || 1;
    const channels = [
      { label: "Instagram", color: "#ff683b", value: Math.round((igReach / totalChannelReach) * 100) },
      { label: "Facebook",  color: "#351f69", value: 0 },
      { label: "Meta Ads",  color: "#1f9b8a", value: Math.round((adsReach / totalChannelReach) * 100) },
    ];

    // Top posts (organic IG, top 5 op engagement-rate)
    const topPosts = [...allPosts]
      .sort((a, b) => b.engagement - a.engagement)
      .slice(0, 5)
      .map((p, i) => {
        const cleanUrl = safeUrl(p.thumb);
        const isHttp = cleanUrl && cleanUrl.startsWith("http");
        return {
          id: p.id,
          caption: p.caption,
          type: p.type,
          platform: p.platform,
          date: p.dateLabel,
          engagement: p.engagement.toFixed(1) + "%",
          imageUrl: isHttp ? cleanUrl : null,
          fallbackBg: gradientFor(i),
        };
      });

    // Cadence
    const cadenceWeeks = enumerateWeeks(startDate, endDate, 13);
    const cadence = [];
    for (let d = 0; d < 7; d++) {
      const row = [];
      for (let w = 0; w < cadenceWeeks.length; w++) {
        row.push(allPosts.filter(p => p.date && p.date.getDay() === ((d + 1) % 7) && inWeek(p.date, cadenceWeeks[w])).length);
      }
      cadence.push(row);
    }

    return {
      kpis,
      timeseries,
      channels,
      topPosts,
      cadenceWeeks,
      cadence,
      allPosts,
      adsCampaigns, // geaggregeerde campagne-cards uit daily rows (Blok B)
      adsLoading: false, // Windsor levert ads in dezelfde call → geen aparte wachttijd
      _raw: raw,
      _source: "windsor",
    };
  }

  async function refreshOverviewWindsor() {
    state.overviewLoading = true;
    state.overviewError = null;
    renderOverview();
    if (typeof renderAnalysis === "function") renderAnalysis();

    try {
      const raw = await windsorCall("getDashboard", {
        startDate: state.period.start,
        endDate: state.period.end,
      });
      state.overview = transformWindsorDashboard(raw);
      state.overviewLoading = false;
      // Surfacing: lege staat met een verborgen connector-fout → toon de echte reden
      // i.p.v. een misleidend "geen data". Helpt grote-bereik-problemen diagnosticeren.
      const igErr = raw?.errors?.instagram;
      const hasAnyData = state.overview.allPosts.length > 0 || state.overview.adsCampaigns.length > 0;
      // Blokkeer alleen als er NIETS binnenkwam (geen organic én geen ads). Een ads-only
      // klant (zoals woody) krijgt een IG-400 die we negeren zolang er ads-data is.
      if (igErr && !hasAnyData) {
        state.overview = null;
        state.overviewError = `Windsor kon geen data ophalen voor dit bereik: ${igErr}`;
      }
      // Ads-fouten niet stil opslokken: ad-level faalt → fallback naar campagne-niveau.
      // De echte reden helpt de juiste ad-level veldnamen te bepalen.
      if (raw?.errors?.adsAd) console.warn("[windsor] ad-level ads fetch faalde, val terug op campagne-niveau:", raw.errors.adsAd);
      if (raw?.errors?.ads)   console.warn("[windsor] campagne-ads fetch faalde:", raw.errors.ads);
      renderOverview();
      if (typeof renderAnalysis === "function") renderAnalysis();
    } catch (err) {
      state.overviewLoading = false;
      state.overviewError = err.message || "Onbekende fout bij laden Windsor-data.";
      if (err.status === 401) {
        clearSession();
        setTimeout(() => showScreen("login-screen"), 600);
      }
      renderOverview();
      if (typeof renderAnalysis === "function") renderAnalysis();
    }
  }

  function buildKpi(label, current, previous, formatter, deltaUnit) {
    const delta = previous != null && previous > 0
      ? deltaUnit === "pp"
        ? (current - previous)
        : ((current - previous) / previous) * 100
      : null;
    return {
      label,
      value: formatter(current),
      delta: delta != null ? Math.abs(delta) : null,
      direction: delta == null ? null : (delta >= 0 ? "up" : "down"),
      vs: "vs vorige periode",
      unit: deltaUnit,
      spark: [],
    };
  }

  function enumerateWeeks(startISO, endISO, force) {
    const start = new Date(startISO);
    const end = new Date(endISO);
    const totalDays = Math.max(1, Math.round((end - start) / 86400000) + 1);
    const bucketCount = force || Math.max(4, Math.min(17, Math.ceil(totalDays / 7)));
    const bucketSize = totalDays / bucketCount;
    const weeks = [];
    for (let i = 0; i < bucketCount; i++) {
      const ws = new Date(start.getTime() + Math.floor(i * bucketSize) * 86400000);
      const we = new Date(start.getTime() + (Math.floor((i + 1) * bucketSize) - 1) * 86400000);
      weeks.push({ num: i + 1, start: ws, end: we });
    }
    return weeks;
  }
  function inWeek(date, week) {
    return date >= week.start && date <= new Date(week.end.getTime() + 86400000 - 1);
  }
  function sumPostsField(posts, week, field) {
    return posts.reduce((s, p) => s + (p.date && inWeek(p.date, week) ? (p[field] || 0) : 0), 0);
  }
  function countPostsInWeek(posts, week) {
    return posts.reduce((s, p) => s + (p.date && inWeek(p.date, week) ? 1 : 0), 0);
  }
  function adsReachInWeek(campaigns, week) {
    // Day after week.end to make the range inclusive of the last day.
    const endMs = week.end.getTime() + 86400000 - 1;
    return adsReachInRange(campaigns, week.start.getTime(), endMs);
  }

  function gradientFor(i) {
    const palette = [
      "linear-gradient(135deg, #ff683b, #351f69)",
      "linear-gradient(135deg, #351f69, #1f9b8a)",
      "linear-gradient(135deg, #1f9b8a, #ff683b)",
      "linear-gradient(135deg, #6a3bff, #ff683b)",
      "linear-gradient(135deg, #ff683b, #6a3bff)",
    ];
    return palette[i % palette.length];
  }

  /* ---------- Overview render ---------- */

  function sparkPath(values, w, h, pad = 2) {
    const min = Math.min(...values), max = Math.max(...values);
    const span = (max - min) || 1;
    const stepX = (w - pad*2) / Math.max(1, values.length - 1);
    return values.map((v, i) => {
      const x = pad + i * stepX;
      const y = pad + (h - pad*2) * (1 - (v - min) / span);
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(" ");
  }
  function sparkArea(values, w, h, pad = 2) {
    return `${sparkPath(values, w, h, pad)} L${w-pad},${h-pad} L${pad},${h-pad} Z`;
  }
  function renderSpark(values, color) {
    if (!values || values.length < 2) return "";
    const w = 160, h = 38;
    const id = "spk" + Math.random().toString(36).slice(2, 8);
    return `
      <svg class="spark" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.32"/>
            <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="${sparkArea(values, w, h)}" fill="url(#${id})"/>
        <path d="${sparkPath(values, w, h)}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  }

  function renderOverview() {
    renderKpis();
    renderTrendChart();
    renderChannelMix();
    renderTopPosts();
    renderCadence();
    renderLibrary();
  }

  function renderKpis() {
    const root = $("#kpi-grid");
    if (state.overviewLoading) {
      root.innerHTML = Array(4).fill(`
        <div class="kpi-card skeleton">
          <div class="skel-line" style="width:60%; height:11px;"></div>
          <div class="skel-line" style="width:50%; height:28px; margin-top:14px;"></div>
          <div class="skel-line" style="width:75%; height:11px; margin-top:10px;"></div>
          <div class="skel-line" style="width:100%; height:38px; margin-top:14px;"></div>
        </div>
      `).join("");
      return;
    }
    if (state.overviewError) {
      root.innerHTML = `<div class="panel" style="grid-column:1/-1;">
        <p style="color:#c0392b; margin:0;">${state.overviewError}</p>
        <button class="btn" style="margin-top:10px;" onclick="window.__refreshOverview()">Opnieuw proberen</button>
      </div>`;
      return;
    }
    const ov = state.overview;
    if (!ov) { root.innerHTML = ""; return; }

    const colors = ["var(--accent)", "#6a3bff", "var(--accent-2)", "#1f9b8a"];
    root.innerHTML = ov.kpis.map((k, i) => {
      const color = colors[i % colors.length];
      const accentHex = color.startsWith("var")
        ? (getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ff683b")
        : color;
      let deltaHtml = `<div class="delta"><span class="vs">—</span></div>`;
      if (k.direction) {
        const arrow = k.direction === "up" ? "↑" : "↓";
        const dv = k.unit === "pp" ? `${k.delta.toFixed(1)}pp` : `${k.delta.toFixed(1)}%`;
        deltaHtml = `<div class="delta ${k.direction}">${arrow} ${dv} <span class="vs">${k.vs}</span></div>`;
      }
      return `
        <div class="kpi-card">
          <div class="label"><span class="dot" style="background:${color}"></span>${k.label}</div>
          <div class="value">${k.value}</div>
          ${deltaHtml}
          ${renderSpark(k.spark, accentHex)}
        </div>
      `;
    }).join("");
  }

  function renderTrendChart() {
    const node = $("#trend-chart");
    const legend = $("#trend-legend");
    if (state.overviewLoading || !state.overview) {
      node.innerHTML = `<div class="skel-line" style="height:260px; border-radius:14px;"></div>`;
      legend.innerHTML = "";
      return;
    }
    const ts = state.overview.timeseries;
    const w = 760, h = 260;
    const padL = 36, padR = 12, padT = 10, padB = 26;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const all = ts.series.flatMap(s => s.values).concat([0]);
    const rawMax = Math.max(...all);
    const max = rawMax > 0 ? Math.ceil(rawMax / 1000) * 1000 : 100;
    const stepX = innerW / Math.max(1, ts.weeks.length - 1);
    const xAt = (i) => padL + i * stepX;
    const yAt = (v) => padT + innerH * (1 - v / max);

    let grid = "", ylabels = "";
    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
      const v = max * (i / ySteps);
      const y = yAt(v);
      grid += `<line x1="${padL}" x2="${w - padR}" y1="${y}" y2="${y}" stroke="currentColor" stroke-opacity="0.08"/>`;
      ylabels += `<text x="${padL - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="currentColor" opacity="0.5">${fmt.k(v)}</text>`;
    }
    let xlabels = "";
    ts.weeks.forEach((wk, i) => {
      if (i % Math.max(1, Math.ceil(ts.weeks.length / 5)) === 0 || i === ts.weeks.length - 1) {
        xlabels += `<text x="${xAt(i)}" y="${h - 8}" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55">${wk}</text>`;
      }
    });

    let paths = "";
    ts.series.forEach((s, idx) => {
      if (!s.values.some(v => v > 0)) return;
      const pts = s.values.map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(2)},${yAt(v).toFixed(2)}`).join(" ");
      const areaPath = `${pts} L${xAt(s.values.length - 1)},${yAt(0)} L${xAt(0)},${yAt(0)} Z`;
      const gid = `g${idx}_${Math.random().toString(36).slice(2,6)}`;
      paths += `
        <defs>
          <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${s.color}" stop-opacity="0.22"/>
            <stop offset="100%" stop-color="${s.color}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="${areaPath}" fill="url(#${gid})"/>
        <path d="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      `;
      const li = s.values.length - 1;
      paths += `<circle cx="${xAt(li)}" cy="${yAt(s.values[li])}" r="3.5" fill="${s.color}" stroke="var(--surface)" stroke-width="1.5"/>`;
    });

    node.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="xMidYMid meet" style="display:block;">
        ${grid}${ylabels}${xlabels}${paths}
      </svg>
    `;
    const adsLoading = state.overview.adsLoading;
    legend.innerHTML = ts.series.map(s => {
      const suffix = (s.label === "Meta Ads" && adsLoading) ? ` <em style="opacity:0.55; font-style:normal;">· laden…</em>` : "";
      return `<span class="item"><span class="swatch" style="background:${s.color}"></span>${s.label}${suffix}</span>`;
    }).join("");
  }

  function renderChannelMix() {
    const root = $("#channel-mix");
    if (!state.overview) { root.innerHTML = ""; return; }
    root.innerHTML = state.overview.channels.map(c => `
      <div class="channel-row">
        <div class="label"><span class="swatch" style="background:${c.color}"></span>${c.label}</div>
        <div class="pct">${c.value}%</div>
        <div class="channel-bar"><div class="fill" style="width:${c.value}%; background:${c.color}"></div></div>
      </div>
    `).join("");
  }

  function renderTopPosts() {
    const root = $("#top-posts");
    if (!state.overview) { root.innerHTML = ""; return; }
    const list = state.overview.topPosts;
    if (!list.length) {
      root.innerHTML = `<p class="muted" style="margin:0;">Geen posts in deze periode.</p>`;
      return;
    }
    root.innerHTML = list.map((p, i) => `
      <div class="top-post" data-post="${escapeHtml(p.id)}">
        <div class="post-thumb thumb-pattern" style="background:${p.fallbackBg}">
          ${p.imageUrl ? `<img class="post-thumb-img" src="${escapeHtml(p.imageUrl)}" referrerpolicy="no-referrer" loading="lazy" alt="" onerror="this.style.display='none'">` : ""}
          <span class="glyph">${i + 1}</span>
          ${p.type === "Reel" ? `<span class="play-icon">▶</span>` : ""}
        </div>
        <div class="meta">
          <div class="caption">${escapeHtml(p.caption)}</div>
          <div class="submeta">
            <span>${escapeHtml(p.type)}</span><span>·</span><span>${p.date}</span><span>·</span><span>${platformShort(p.platform)}</span>
          </div>
        </div>
        <div class="stat">
          <div class="n">${p.engagement}</div>
          <div class="l">Engage</div>
        </div>
      </div>
    `).join("");
  }

  function renderCadence() {
    const root = $("#cadence");
    if (!state.overview) { root.innerHTML = ""; return; }
    const days = ["Ma", "Di", "Wo", "Do", "Vr", "Za", "Zo"];
    const cad = state.overview.cadence;
    const weeks = state.overview.cadenceWeeks;
    const cols = weeks.length;

    let html = `<div></div>`;
    for (let w = 0; w < cols; w++) {
      html += `<div class="day-label" style="font-size:9px;">${w % 4 === 0 ? `wk ${w + 1}` : ""}</div>`;
    }
    days.forEach((day, i) => {
      html += `<div class="day-label">${day}</div>`;
      for (let w = 0; w < cols; w++) {
        const v = cad[i][w] || 0;
        html += `<div class="cell" data-v="${v}" title="${day} wk ${w + 1}: ${v} posts"></div>`;
      }
    });
    root.innerHTML = html;
    root.style.gridTemplateColumns = `40px repeat(${cols}, 1fr)`;
  }

  // Expose retry for inline error button
  window.__refreshOverview = refreshOverview;

  /* ---------- Library (live data uit getDashboard) ---------- */

  function platformLabel(p) { return { ig: "Instagram", fb: "Facebook", ads: "Meta Ads" }[p] || p; }
  function platformShort(p) { return { ig: "IG", fb: "FB", ads: "ADS" }[p] || (p || "").toUpperCase(); }

  // Tab-key per platform & type
  function librarySourceOf(post) {
    if (post.platform === "ig") return post.type === "Reel" ? "ig-reels" : "ig-posts";
    if (post.platform === "fb") return "fb-posts";
    if (post.platform === "ads") return "ads";
    return "other";
  }

  function getLibraryAllPosts() {
    if (!state.overview) return [];
    const organic = arrayOrEmpty(state.overview.allPosts);
    const ads = arrayOrEmpty(state.overview.adsCampaigns);
    return [...organic, ...ads];
  }

  function getLibraryFilterDefs() {
    const all = getLibraryAllPosts();
    const count = (key) => all.filter(p => librarySourceOf(p) === key).length;
    const defs = [
      { key: "all",      label: "Alle",            count: all.length },
      { key: "ig-posts", label: "Instagram posts", count: count("ig-posts") },
      { key: "ig-reels", label: "Instagram reels", count: count("ig-reels") },
      { key: "fb-posts", label: "Facebook posts",  count: count("fb-posts") },
      { key: "ads",      label: "Meta Ads",        count: count("ads") },
    ];
    // Verberg chips zonder data (count 0) — "Alle" blijft altijd staan.
    return defs.filter(f => f.key === "all" || f.count > 0);
  }

  function sortLibrary(list, key, dir) {
    const sign = dir === "asc" ? 1 : -1;
    return list.slice().sort((a, b) => {
      let av = a[key], bv = b[key];
      // Dates compare numerically; strings localeCompare; numbers subtract.
      if (av instanceof Date) av = av.getTime();
      if (bv instanceof Date) bv = bv.getTime();
      if (av == null && bv == null) return 0;
      if (av == null) return 1;            // nulls always last
      if (bv == null) return -1;
      if (typeof av === "string") return av.localeCompare(bv) * sign;
      return (av - bv) * sign;
    });
  }

  // Label komt nu uit de bucketed classifier (classifyPerformance), gezet op de post.
  function computePerformance(post) {
    if (!post || post.platform === "ads") return null; // ads: geen organic-classifier
    return post.performance || null;                    // null → "n/a" in de UI
  }

  // Tooltip die het "waarom" achter het label toont (per spec).
  function perfTooltip(post) {
    if (!post || post.perfRatio == null) {
      return "Te weinig vergelijkbare posts in deze periode voor een betrouwbaar oordeel.";
    }
    return `Score ${post.perfRatio.toFixed(2)}× benchmark voor ${post.perfBucket || "deze content"} → ${post.performance}`;
  }

  function getFilteredLibrary() {
    let list = getLibraryAllPosts();
    if (state.libraryFilter !== "all") {
      list = list.filter(p => librarySourceOf(p) === state.libraryFilter);
    }
    const q = (state.librarySearch || "").trim().toLowerCase();
    if (q) {
      list = list.filter(p => (p.caption || "").toLowerCase().includes(q));
    }
    return sortLibrary(list, state.librarySort.key, state.librarySort.dir);
  }

  function performanceExplanation(level) {
    const brand = state.session?.brandName || "de klant";
    if (level === "Good")    return `Deze post doet het beter dan ${brand}s gemiddelde. Houd dit format aan en bouw voort op dezelfde contentstijl.`;
    if (level === "Average") return `Deze post zit rond de klantbenchmark. Er is voldoende engagement om mee te werken, maar de eerste 3 seconden kunnen sterker.`;
    if (level === "Bad")     return `Deze post presteert duidelijk onder ${brand}s benchmark. Begin bij de hook en het format.`;
    return "Deze performantie-indicator vergelijkt de post met de klantbenchmark.";
  }

  function findLibraryPost(id) {
    return getLibraryAllPosts().find(p => String(p.id) === String(id)) || null;
  }

  function openPerformanceChat(level, post) {
    toggleChatPanel(true);
    const why = post ? `<br><span class="muted">${escapeHtml(perfTooltip(post))}</span>` : "";
    pushBot({ text: `<strong>${level}</strong> — ${performanceExplanation(level)}${why}` });
  }

  // Open de IG/FB-permalink van een post in een nieuw tabblad.
  function openPostLink(id) {
    const post = findLibraryPost(id);
    const url = post && safeUrl(post.url);
    if (url && url.startsWith("http")) window.open(url, "_blank", "noopener");
  }

  function bindLibraryInteractions() {
    $$("#lib-results th.sortable").forEach((th) => {
      th.onclick = () => {
        const field = th.dataset.sort;
        if (!field) return;
        if (state.librarySort.key === field) {
          state.librarySort.dir = state.librarySort.dir === "desc" ? "asc" : "desc";
        } else {
          state.librarySort.key = field;
          state.librarySort.dir = "desc";
        }
        renderLibrary();
      };
    });
    // Klik op een card/rij → open permalink. Posts zonder url krijgen geen pointer.
    $$("#lib-results .lib-card, #lib-results tbody tr[data-post]").forEach((el) => {
      const post = findLibraryPost(el.dataset.post);
      const hasUrl = post && safeUrl(post.url).startsWith("http");
      if (!hasUrl) return;
      el.style.cursor = "pointer";
      el.onclick = (e) => {
        if (e.target.closest(".perf-button")) return; // perf-knop heeft eigen actie
        openPostLink(el.dataset.post);
      };
    });
    $$("#lib-results .perf-button").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        openPerformanceChat(btn.dataset.performance, findLibraryPost(btn.dataset.post));
      };
    });
  }

  function libThumb(post, idx, opts = {}) {
    const fallback = gradientFor(idx);
    const cleanUrl = safeUrl(post.thumb);
    const isHttp = cleanUrl && cleanUrl.startsWith("http");
    const imgClass = opts.imgClass || "post-thumb-img";
    const imgHtml = isHttp
      ? `<img class="${imgClass}" src="${escapeHtml(cleanUrl)}" referrerpolicy="no-referrer" loading="lazy" alt="" onerror="this.style.display='none'">`
      : "";
    return { bg: fallback, imgHtml };
  }

  function renderLibraryGrid(list) {
    if (!list.length) return renderLibraryEmpty();
    return `<div class="lib-grid">${list.map((p, i) => {
      const t = libThumb(p, i);
      return `
      <article class="lib-card" data-post="${escapeHtml(p.id)}">
        <div class="thumb thumb-pattern" style="background:${t.bg}">
          ${t.imgHtml}
          <div class="pill-row">
            <span class="pill">${platformShort(p.platform)} · ${escapeHtml(p.type)}</span>
            <span class="pill engage">${(p.engagement || 0).toFixed(1)}%</span>
          </div>
        </div>
        <div class="body">
          <div class="caption">${escapeHtml(p.caption)}</div>
          <div class="meta"><span>${escapeHtml(p.dateLabel)}</span><span>·</span><span>${escapeHtml(p.type)}</span>${p.subtitle ? `<span>·</span><span>${escapeHtml(p.subtitle)}</span>` : ""}</div>
          <div class="stats">
            <div class="s"><div class="n">${fmt.k(p.reach)}</div><div class="l">Reach</div></div>
            <div class="s"><div class="n">${(p.engagement || 0).toFixed(1)}%</div><div class="l">Engage</div></div>
            <div class="s"><div class="n">${(p.ctr || 0).toFixed(1)}%</div><div class="l">CTR</div></div>
          </div>
        </div>
      </article>`;
    }).join("")}</div>`;
  }

  // Watch / Retention-cel (Blok F):
  //  - Meta Ads-video met curve → de 5-blok retentiecurve
  //  - Reel / IG-video / FB-video met kijktijd → gem. kijktijd in seconden
  //  - overige content → "—"
  function renderWatchRetentionCell(p) {
    if (p.platform === "ads" && p.retention) return renderRetentionBlocks(p.retention);
    if ((p.avgWatchTime || 0) > 0) {
      return `<span title="Gemiddelde kijktijd">${p.avgWatchTime.toFixed(1)}s</span>`;
    }
    return `<span class="muted">—</span>`;
  }

  function renderRetentionBlocks(retention) {
    // Organic IG/FB exposeert geen percentile-retentie (Instagram Graph API/Windsor
    // leveren dit niet). Voor Meta Ads-video's komt de curve via de facebook-connector.
    if (!retention) return `<div class="retention-row">${Array(5).fill('<span class="block inactive"></span>').join('')}</div>`;
    const checkpoints = [
      { label: '3s',  value: retention.p3,  threshold: 3 },
      { label: '25%', value: retention.p25, threshold: 25 },
      { label: '50%', value: retention.p50, threshold: 50 },
      { label: '75%', value: retention.p75, threshold: 75 },
      { label: '95%', value: retention.p95, threshold: 95 },
    ];
    return `<div class="retention-row">${checkpoints.map(cp =>
      `<span class="block ${cp.value >= cp.threshold ? 'active' : 'inactive'}" title="${cp.label}: ${cp.value}%"></span>`
    ).join('')}</div>`;
  }

  function renderBenchmarkRow(list) {
    if (!list.length) return '';
    const avg = (field) => Math.round(list.reduce((sum, item) => sum + (item[field] || 0), 0) / list.length);
    const avgPerf = list.reduce((sum, item) => sum + (item.engagement || 0), 0) / list.length;
    const filterLabel = getLibraryFilterDefs().find(f => f.key === state.libraryFilter)?.label || "Alle";
    const platformName = state.libraryFilter === 'all' ? 'Globaal gemiddelde' : `${filterLabel} gemiddelde`;
    return `<tr class="benchmark-row">
      <td>CLIENT BENCHMARK — ${escapeHtml(platformName)}</td><td></td><td></td><td></td>
      <td class="right">${fmt.int(avg('views'))}</td>
      <td class="right">${fmt.int(avg('reach'))}</td>
      <td class="right">${fmt.int(avg('likes'))}</td>
      <td class="right">${fmt.int(avg('comments'))}</td>
      <td class="right">${fmt.int(avg('shares'))}</td>
      <td class="right">${fmt.int(avg('saves'))}</td>
      <td></td>
      <td class="right">${avgPerf.toFixed(1)}%</td>
      <td></td><td></td>
    </tr>`;
  }

  function sortArrow(field) {
    if (state.librarySort.key !== field) return "";
    return `<span class="sort-arrow">${state.librarySort.dir === "asc" ? "↑" : "↓"}</span>`;
  }

  function renderLibraryTable(list) {
    if (!list.length) return renderLibraryEmpty();
    return `<div class="lib-table"><table>
      <thead><tr>
        <th>Post</th>
        <th class="sortable" data-sort="platform">Platform${sortArrow("platform")}</th>
        <th class="sortable" data-sort="type">Type${sortArrow("type")}</th>
        <th class="sortable" data-sort="date">Datum${sortArrow("date")}</th>
        <th class="right sortable" data-sort="views">Views${sortArrow("views")}</th>
        <th class="right sortable" data-sort="reach">Reach${sortArrow("reach")}</th>
        <th class="right sortable" data-sort="likes">Likes${sortArrow("likes")}</th>
        <th class="right sortable" data-sort="comments">Comments${sortArrow("comments")}</th>
        <th class="right sortable" data-sort="shares">Shares${sortArrow("shares")}</th>
        <th class="right sortable" data-sort="saves">Saves${sortArrow("saves")}</th>
        <th class="right">Watch / Retention</th>
        <th class="right sortable" data-sort="engagement">Engage${sortArrow("engagement")}</th>
        <th class="right sortable" data-sort="ctr">CTR${sortArrow("ctr")}</th>
        <th class="right">Performantie</th>
      </tr></thead>
      <tbody>
        ${renderBenchmarkRow(list)}
        ${list.map((p, i) => {
          const t = libThumb(p, i, { imgClass: "row-thumb-img" });
          const performance = computePerformance(p);
          const perfHtml = performance
            ? `<button class="perf-button ${performance.toLowerCase()}" data-performance="${performance}" data-post="${escapeHtml(p.id)}" title="${escapeHtml(perfTooltip(p))}">${performance}</button>`
            : `<span class="muted" title="${escapeHtml(perfTooltip(p))}">n/a</span>`;
          return `
          <tr data-post="${escapeHtml(p.id)}">
            <td><span class="row-thumb thumb-pattern" style="background:${t.bg}">${t.imgHtml}</span><span class="row-caption">${escapeHtml(p.caption)}${p.subtitle ? ` <span class="muted">· ${escapeHtml(p.subtitle)}</span>` : ""}</span></td>
            <td><span class="platform-tag ${p.platform}">${platformLabel(p.platform)}</span></td>
            <td>${escapeHtml(p.type)}</td>
            <td>${escapeHtml(p.dateLabel)}</td>
            <td class="right">${fmt.int(p.views)}</td>
            <td class="right">${fmt.int(p.reach)}</td>
            <td class="right">${fmt.int(p.likes)}</td>
            <td class="right">${fmt.int(p.comments)}</td>
            <td class="right">${fmt.int(p.shares)}</td>
            <td class="right">${fmt.int(p.saves)}</td>
            <td class="right">${renderWatchRetentionCell(p)}</td>
            <td class="right">${(p.engagement || 0).toFixed(1)}%</td>
            <td class="right">${(p.ctr || 0).toFixed(1)}%</td>
            <td class="right">${perfHtml}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table></div>`;
  }

  function renderLibraryEmpty() {
    const q = (state.librarySearch || "").trim();
    const msg = q
      ? `Geen posts gevonden voor “${escapeHtml(q)}”.`
      : "Geen posts in deze periode. Pas de datumfilter aan of controleer je connector-instellingen.";
    return `<div class="panel" style="text-align:center; padding:48px 24px;">
      <p class="muted" style="margin:0;">${msg}</p>
    </div>`;
  }

  function renderLibrarySkeleton() {
    return `<div class="lib-grid">${Array(8).fill(`
      <article class="lib-card skeleton">
        <div class="thumb skel-line" style="aspect-ratio:1; border-radius:0;"></div>
        <div class="body">
          <div class="skel-line" style="width:80%; height:11px;"></div>
          <div class="skel-line" style="width:50%; height:9px; margin-top:6px;"></div>
        </div>
      </article>
    `).join("")}</div>`;
  }

  function renderLibrary() {
    const filtersEl = $("#lib-filters");
    const resultsEl = $("#lib-results");
    const countEl   = $("#lib-count");
    const sortEl    = $("#lib-sort");
    if (!filtersEl || !resultsEl) return;

    // Sidebar-badge volgt het werkelijke aantal posts (was hardcoded "14").
    const navBadge = $('.nav-link[data-page="library"] .badge');
    if (navBadge) {
      const total = getLibraryAllPosts().length;
      if (total > 0) { navBadge.textContent = total; navBadge.style.display = ""; }
      else navBadge.style.display = "none";
    }

    // Filter chips — derived counts from live data.
    const defs = getLibraryFilterDefs();
    // Actief filter wees naar een chip die nu verborgen is (0 data) → reset naar "Alle".
    if (!defs.some(f => f.key === state.libraryFilter)) state.libraryFilter = "all";
    filtersEl.innerHTML = defs.map(f => `
      <button class="chip ${state.libraryFilter === f.key ? "on" : ""}" data-filter="${f.key}">
        ${f.label} <span class="count">${f.count}</span>
      </button>
    `).join("");
    $$("#lib-filters .chip").forEach(b => {
      b.addEventListener("click", () => {
        state.libraryFilter = b.dataset.filter;
        renderLibrary();
      });
    });

    // Sort dropdown — sync to current state, default desc op key-change.
    if (sortEl) {
      sortEl.value = state.librarySort.key;
      sortEl.onchange = (e) => {
        state.librarySort.key = e.target.value;
        state.librarySort.dir = "desc";
        renderLibrary();
      };
    }

    // Caption-search (toolbar-node blijft bestaan tussen renders → focus blijft).
    const searchEl = $("#lib-search");
    if (searchEl) {
      searchEl.oninput = (e) => {
        state.librarySearch = e.target.value;
        renderLibrary();
      };
    }
    $$("#lib-view-toggle button").forEach(b => {
      b.classList.toggle("on", b.dataset.view === state.libraryView);
      b.onclick = () => { state.libraryView = b.dataset.view; renderLibrary(); };
    });

    // Loading / error states (overview owns het foutbericht — library toont enkel skeleton/lege staat).
    if (state.overviewError && !state.overview) {
      resultsEl.innerHTML = `<div class="panel"><p class="muted" style="margin:0;">Library is niet beschikbaar zolang het dashboard niet laadt.</p></div>`;
      if (countEl) countEl.textContent = "—";
      return;
    }
    if (state.overviewLoading || !state.overview) {
      resultsEl.innerHTML = renderLibrarySkeleton();
      if (countEl) countEl.textContent = "…";
      return;
    }

    const list = getFilteredLibrary();
    resultsEl.innerHTML = state.libraryView === "grid"
      ? renderLibraryGrid(list)
      : renderLibraryTable(list);
    if (countEl) countEl.textContent = `${list.length} posts`;
    bindLibraryInteractions();
  }

  /* ---------- Connectors-paneel (Blok D, dynamisch o.b.v. session) ---------- */

  function renderConnectors() {
    const el = $("#connectors-list");
    if (!el) return;
    const s = state.session || {};
    const rows = [];
    if (s.hasWindsor) rows.push({ label: "Windsor.ai", live: true });
    if (s.hasMetricool && !s.hasWindsor) rows.push({ label: "Metricool", live: true });
    // Meta Ads komt mee via beide bronnen (Windsor facebook-connector of Metricool).
    if (s.hasWindsor || s.hasMetricool) rows.push({ label: "Meta Ads", live: true });
    rows.push({ label: "Google Drive", live: !!s.hasDrive }); // Live indien gekoppeld, anders Soon

    el.innerHTML = rows.map(r => {
      const badge = r.live
        ? `<span class="badge" style="background:rgba(47,143,95,0.16); color:var(--good);">Live</span>`
        : `<span class="badge">Soon</span>`;
      return `<button class="nav-link" disabled style="opacity:0.7; cursor:default;">
        <span class="icon">${r.live ? "◉" : "◌"}</span>
        <span>${escapeHtml(r.label)}</span>
        ${badge}
      </button>`;
    }).join("");
  }

  /* ---------- Methodology-tab (Blok E) ---------- */

  // Beschrijft per actieve databron welke platforms/velden beschikbaar zijn en wat ontbreekt.
  function dataCoverage() {
    const s = state.session || {};
    if (s.hasWindsor) {
      return {
        sources: ["Windsor.ai"],
        platforms: ["Instagram (organic)", "Meta Ads (per advertentie)"],
        present: ["Caption, type, datum", "Reach, views, likes, comments, shares, saves", "Engagement", "Gem. kijktijd (reels)", "Meta Ads per advertentie: reach, clicks, spend, CTR, retentiecurve"],
        missing: [
          ["Facebook organic", "Connector-slug nog niet bevestigd in Windsor — tijdelijk niet opgehaald."],
          ["Retentiecurve organic", "Instagram's API exposeert dit niet voor organic content; alleen gem. kijktijd is beschikbaar."],
          ["KPI-delta's vs vorige periode", "Vereist een tweede fetch voor de vorige periode — volgt in een latere stap."],
        ],
      };
    }
    if (s.hasMetricool) {
      return {
        sources: ["Metricool"],
        platforms: ["Instagram (organic)", "Facebook (organic)", "Meta Ads (campagne-niveau)"],
        present: ["Caption, type, datum", "Reach, likes, comments, shares, saves", "Engagement, CTR", "Meta Ads: reach, clicks (campagne-niveau)"],
        missing: [
          ["Gem. kijktijd / retentie", "Niet beschikbaar via de Metricool dashboard-endpoints."],
          ["Ad-level analyse", "Alleen campagne-niveau; ad-level inzicht komt via de chat-agent (Meta Ads MCP)."],
        ],
      };
    }
    return {
      sources: ["Handmatige upload"],
      platforms: ["Afhankelijk van de geüploade CSV's"],
      present: ["Velden zoals aangeleverd in de CSV-export"],
      missing: [["Live data", "Handmatige flow gebruikt geüploade bestanden in plaats van een live koppeling."]],
    };
  }

  function renderMethodology() {
    const root = $("#methodology-content");
    if (!root) return;
    const cfg = PERFORMANCE_CONFIG;
    const brand = state.session?.brandName || "de klant";
    const pct = (n) => Math.round(n * 100) + "%";

    // Formule-tabel — getallen komen rechtstreeks uit de config; reden is redactioneel.
    const typeMeta = {
      photo:    { label: "Foto",             reason: "Foto's draaien om directe interactie en bewaren." },
      carousel: { label: "Carrousel",        reason: "Carrousels worden vooral bewaard om later terug te kijken." },
      reel:     { label: "Reel / IG-video",  reason: "Bij video weegt kijktijd het zwaarst — blijven mensen kijken?" },
      fbVideo:  { label: "Facebook video",   reason: "Idem als Reels, met iets meer gewicht op directe interactie." },
      story:    { label: "Story",            reason: "Stories worden zelden bewaard; bereik-aandeel telt mee." },
    };
    const formulaRows = Object.keys(cfg.formulas).map(k => {
      const f = cfg.formulas[k];
      const m = typeMeta[k] || { label: k, reason: "" };
      const parts = [];
      if (f.engagement) parts.push(`${pct(f.engagement)} engagement`);
      if (f.save) parts.push(`${pct(f.save)} saves`);
      if (f.watchTime) parts.push(`${pct(f.watchTime)} kijktijd`);
      if (f.reachShare) parts.push(`${pct(f.reachShare)} bereik-aandeel`);
      return `<tr>
        <td><strong>${m.label}</strong></td>
        <td>${parts.join(" · ")}</td>
        <td class="muted">${m.reason}</td>
      </tr>`;
    }).join("");

    const cov = dataCoverage();
    const coverageHtml = `
      <section class="panel" style="margin-top: var(--grid-gap);">
        <h2 class="panel-title">Welke data wordt opgehaald</h2>
        <p class="panel-sub" style="margin-bottom:14px;">Verbonden bron(nen): <strong>${cov.sources.map(escapeHtml).join(", ")}</strong></p>
        <div class="method-grid">
          <div>
            <div class="method-subhead">Platforms</div>
            <ul class="method-list">${cov.platforms.map(p => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
            <div class="method-subhead" style="margin-top:16px;">Beschikbare velden</div>
            <ul class="method-list">${cov.present.map(p => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
          </div>
          <div>
            <div class="method-subhead">Wat (nog) ontbreekt</div>
            <ul class="method-list muted-list">${cov.missing.map(([t, d]) => `<li><strong>${escapeHtml(t)}</strong> — ${escapeHtml(d)}</li>`).join("")}</ul>
          </div>
        </div>
      </section>`;

    root.innerHTML = `
      <section class="panel">
        <h2 class="panel-title">Hoe we posts beoordelen</h2>
        <p class="narrative-body" style="margin-top:8px;">
          Performance-labels worden berekend op basis van een multi-score per post-type,
          vergeleken met het gemiddelde van hetzelfde post-type van ${escapeHtml(brand)} in de
          geselecteerde periode. Zo vergelijken we appels met appels — een Reel alleen met andere Reels.
        </p>
      </section>

      <section class="panel" style="margin-top: var(--grid-gap);">
        <h2 class="panel-title">Good / Average / Bad</h2>
        <div class="method-thresholds">
          <div class="thr good"><div class="thr-val">≥ ${cfg.thresholds.good}×</div><div class="thr-lbl">Good</div><div class="muted">minstens ${Math.round((cfg.thresholds.good - 1) * 100)}% boven het format-gemiddelde</div></div>
          <div class="thr avg"><div class="thr-val">${cfg.thresholds.bad}–${cfg.thresholds.good}×</div><div class="thr-lbl">Average</div><div class="muted">binnen de normale variatie</div></div>
          <div class="thr bad"><div class="thr-val">&lt; ${cfg.thresholds.bad}×</div><div class="thr-lbl">Bad</div><div class="muted">duidelijk onder gemiddeld</div></div>
        </div>
      </section>

      <section class="panel" style="margin-top: var(--grid-gap);">
        <h2 class="panel-title">Score-formule per content-type</h2>
        <div class="lib-table" style="margin-top:12px;"><table>
          <thead><tr><th>Type</th><th>Weging</th><th>Waarom</th></tr></thead>
          <tbody>${formulaRows}</tbody>
        </table></div>
      </section>

      <section class="panel" style="margin-top: var(--grid-gap);">
        <h2 class="panel-title">De variabelen</h2>
        <ul class="method-list" style="margin-top:10px;">
          <li><strong>Engagement</strong> — likes, comments en shares ten opzichte van het bereik. Saves tellen hier niet mee (die zitten apart).</li>
          <li><strong>Saves</strong> — hoe vaak een post bewaard is ten opzichte van het bereik. Een sterk signaal dat content waardevol genoeg is om terug te vinden.</li>
          <li><strong>Kijktijd</strong> — de gemiddelde kijktijd van een video vergeleken met andere video's van dezelfde soort in deze periode.</li>
        </ul>
      </section>

      <section class="panel" style="margin-top: var(--grid-gap);">
        <h2 class="panel-title">Eerlijke vergelijking & grenzen</h2>
        <ul class="method-list" style="margin-top:10px;">
          <li>We vergelijken ${escapeHtml(brand)}s IG-Reels alleen met andere IG-Reels van ${escapeHtml(brand)} — niet met je foto's en niet met andere klanten.</li>
          <li>Minder dan ${cfg.minBucketSize} posts van een type in de periode? Dan tonen we <strong>n/a</strong> — te weinig vergelijkingsmateriaal voor een eerlijk oordeel.</li>
          <li>Reels zonder kijktijd-data (oudere posts) vallen terug op een engagement- en saves-score.</li>
          <li>Ads krijgen géén Good/Average/Bad — paid heeft andere KPI's (CPM, ROAS) en een eigen dynamiek.</li>
          <li>Pure bereik-groei is op zichzelf geen kwaliteitsindicator; verschillen in algoritme-distributie kunnen scores beïnvloeden.</li>
        </ul>
      </section>

      ${coverageHtml}
    `;
  }

  /* ---------- Analysis (stap 5) ---------- */

  function analysisPeriodKey() {
    return `${state.period.start}|${state.period.end}`;
  }

  function periodDays() {
    const s = new Date(state.period.start), e = new Date(state.period.end);
    return Math.max(1, Math.round((e - s) / 86400000) + 1);
  }

  function periodLabelShort() {
    const s = new Date(state.period.start), e = new Date(state.period.end);
    return `${fmt.dateNL(s)} – ${fmt.dateNL(e)}`;
  }

  // Aggregeer overview-data tot een compacte JSON voor de LLM.
  // We sturen géén ruwe posts-array (te duur in tokens) — wel groeperingen,
  // top/bottom-uittreksels en samenvattingen die het patroon vasthouden.
  function buildAnalysisSummary() {
    const ov = state.overview;
    if (!ov) return null;
    const posts = arrayOrEmpty(ov.allPosts);
    const ads = arrayOrEmpty(ov.adsCampaigns);

    const groupBy = (arr, keyFn) => {
      const m = {};
      for (const p of arr) {
        const k = keyFn(p);
        if (!k) continue;
        if (!m[k]) m[k] = { count: 0, totalReach: 0, totalInteractions: 0, totalEngagement: 0, withEngagement: 0 };
        m[k].count += 1;
        m[k].totalReach += p.reach || 0;
        m[k].totalInteractions += p.interactions || 0;
        if (p.engagement) { m[k].totalEngagement += p.engagement; m[k].withEngagement += 1; }
      }
      const out = {};
      for (const k of Object.keys(m)) {
        const g = m[k];
        out[k] = {
          count: g.count,
          totalReach: Math.round(g.totalReach),
          avgReach: g.count ? Math.round(g.totalReach / g.count) : 0,
          avgEngagement: g.withEngagement ? +(g.totalEngagement / g.withEngagement).toFixed(2) : 0,
        };
      }
      return out;
    };

    const slimPost = (p) => ({
      caption: (p.caption || "").slice(0, 140),
      platform: p.platform,
      type: p.type,
      date: p.dateLabel,
      reach: p.reach || 0,
      engagement: +(p.engagement || 0).toFixed(2),
      likes: p.likes || 0,
      comments: p.comments || 0,
      shares: p.shares || 0,
      saves: p.saves || 0,
      // Classifier-output (Blok A) — door de agent te gebruiken als voor-geclassificeerd signaal.
      performance: p.performance || null,      // "Good" | "Average" | "Bad" | null (=n/a)
      perfRatio: p.perfRatio != null ? p.perfRatio : null, // ratio t.o.v. bucket-mediaan
      perfBucket: p.perfBucket || null,        // bv. "Instagram · Reel"
    });

    const byEngagement = [...posts].filter(p => p.reach >= 100).sort((a, b) => b.engagement - a.engagement);
    const byReach = [...posts].sort((a, b) => b.reach - a.reach);
    const top10 = byEngagement.slice(0, 10).map(slimPost);
    const bottom5 = byEngagement.slice(-5).reverse().map(slimPost);

    const days = ["Zo", "Ma", "Di", "Wo", "Do", "Vr", "Za"];
    const dayCounts = Array(7).fill(0);
    for (const p of posts) {
      if (p.date instanceof Date) dayCounts[p.date.getDay()] += 1;
    }
    const busiestIdx = dayCounts.indexOf(Math.max(...dayCounts));
    const quietestIdx = dayCounts.indexOf(Math.min(...dayCounts.filter(v => v >= 0)));

    // Classifier-signaal (Blok A) — per bucket de Good/Average/Bad-verdeling, plus
    // expliciete over- en onderpresteerders. De agent hoeft niets te herrekenen.
    const buckets = {};
    for (const p of posts) {
      const b = p.perfBucket;
      if (!b) continue;
      const bd = buckets[b] || (buckets[b] = { bucket: b, count: 0, good: 0, average: 0, bad: 0, na: 0 });
      bd.count += 1;
      if (p.performance === "Good") bd.good += 1;
      else if (p.performance === "Average") bd.average += 1;
      else if (p.performance === "Bad") bd.bad += 1;
      else bd.na += 1;
    }
    const performanceBreakdown = Object.values(buckets).sort((a, b) => b.count - a.count);

    const rated = posts.filter(p => p.perfRatio != null);
    const overperformers = rated
      .filter(p => p.performance === "Good")
      .sort((a, b) => b.perfRatio - a.perfRatio)
      .slice(0, 5).map(slimPost);
    const underperformers = rated
      .filter(p => p.performance === "Bad")
      .sort((a, b) => a.perfRatio - b.perfRatio)
      .slice(0, 5).map(slimPost);

    return {
      kpis: ov.kpis.map(k => ({
        label: k.label,
        value: k.value,
        delta: k.delta != null ? +k.delta.toFixed(2) : null,
        direction: k.direction,
        unit: k.unit,
      })),
      channels: ov.channels.map(c => ({ label: c.label, sharePct: c.value })),
      byPlatform: groupBy(posts, p => ({ ig: "Instagram", fb: "Facebook" })[p.platform]),
      byType: groupBy(posts, p => p.type),
      cadence: {
        totalPosts: posts.length,
        postsPerWeek: +((posts.length / Math.max(1, periodDays() / 7))).toFixed(1),
        postsPerDay: days.map((d, i) => ({ day: d, count: dayCounts[i] })),
        busiestDay: days[busiestIdx],
        quietestDay: days[quietestIdx],
      },
      topPostsByEngagement: top10,
      bottomPostsByEngagement: bottom5,
      topPostsByReach: byReach.slice(0, 5).map(slimPost),
      // Classifier-signaal (Blok A): verdeling per bucket + concrete over/onderpresteerders.
      performanceBreakdown,
      overperformers,
      underperformers,
      ads: buildAdsSummary(ads),
    };
  }

  // Per-ad/paid samenvatting (Blok 2). Onderscheidt campagne- en ad-niveau, en neemt
  // retentie alleen mee als de curve echt gevuld is (anders niets — geen fake data).
  function buildAdsSummary(ads) {
    const slimAd = (a) => {
      const out = {
        name: (a.caption || "").slice(0, 100),
        level: a.isAd ? "ad" : "campaign",
        adType: a.isAd ? a.type : null,   // Reel / Carrousel / Foto / Video / Post
        campaign: a.subtitle || null,
        reach: a.reach || 0,
        impressions: a.impressions || 0,
        clicks: a.clicks || 0,
        ctr: +(a.ctr || 0).toFixed(2),
        engagement: +(a.engagement || 0).toFixed(2),
        spend: a.spend != null ? +(a.spend).toFixed(2) : null,
      };
      // Retentie alleen meesturen als de curve daadwerkelijk gevuld is (zie task_3c228fd4).
      if (a.retention && a.retention.p50 != null) {
        out.retention = {
          p25: a.retention.p25, p50: a.retention.p50,
          p75: a.retention.p75, p95: a.retention.p95,
        };
      }
      return out;
    };

    const adLevel = ads.filter(a => a.isAd);
    const byEng = (arr) => [...arr].filter(a => (a.reach || 0) >= 100).sort((x, y) => (y.engagement || 0) - (x.engagement || 0));
    const engAds = byEng(adLevel);

    return {
      level: adLevel.length ? "ad" : "campaign",  // welk granulariteitsniveau de data heeft
      campaignCount: ads.length,
      totalReach: ads.reduce((s, a) => s + (a.reach || 0), 0),
      totalSpend: +(ads.reduce((s, a) => s + (a.spend || 0), 0)).toFixed(2),
      topByReach: [...ads].sort((a, b) => (b.reach || 0) - (a.reach || 0)).slice(0, 3).map(slimAd),
      bestAdsByEngagement: engAds.slice(0, 3).map(slimAd),
      // Alleen los meesturen als er genoeg ads zijn om best/worst te onderscheiden.
      worstAdsByEngagement: engAds.length > 4 ? engAds.slice(-3).reverse().map(slimAd) : [],
    };
  }

  async function generateAnalysis() {
    if (!state.overview) return;
    const key = analysisPeriodKey();
    const myId = ++state.analysisGenId;
    state.analysisLoading = true;
    state.analysisError = null;
    renderAnalysis();

    const summary = buildAnalysisSummary();
    if (!summary) {
      state.analysisLoading = false;
      state.analysisError = "Geen data om te analyseren.";
      renderAnalysis();
      return;
    }

    try {
      const result = await apiPost("/api/analysis", {
        clientId: state.session.clientId,
        token: state.session.token,
        brandName: state.session.brandName,
        period: {
          startDate: state.period.start,
          endDate: state.period.end,
          days: periodDays(),
        },
        summary,
        clientContext: state.session.clientContext || "",
      });
      if (myId !== state.analysisGenId) return; // outdated — gebruiker wisselde periode
      state.analysisCache[key] = result.analysis;
      state.analysisLoading = false;
      state.analysisError = null;
      renderAnalysis();
    } catch (err) {
      if (myId !== state.analysisGenId) return;
      state.analysisLoading = false;
      state.analysisError = err.message || "Onbekende fout bij genereren analyse.";
      if (err.status === 401) {
        clearSession();
        setTimeout(() => showScreen("login-screen"), 600);
      }
      renderAnalysis();
    }
  }
  window.__generateAnalysis = generateAnalysis;

  function renderAnalysisEmpty(html) {
    return `<div class="panel" style="text-align:center; padding:48px 24px;">${html}</div>`;
  }

  function renderAnalysisInsights(a) {
    const summaryBlock = a.summary ? `
      <section class="panel analysis-narrative" style="margin-bottom: var(--grid-gap);">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Analyse · ${escapeHtml(periodLabelShort())}</h2>
            <div class="panel-sub">Door de Agent gegenereerd · ${periodDays()} dagen</div>
          </div>
          <button class="btn tiny" onclick="window.__generateAnalysis()">↻ Regenereren</button>
        </div>
        <div class="narrative-body">${escapeHtml(a.summary)}</div>
      </section>` : "";

    const insightItem = (it, deltaDir) => {
      const cleanDelta = (it.delta || "").trim();
      return `
        <div class="insight-item">
          ${deltaDir && cleanDelta ? `<div class="delta ${deltaDir}">${escapeHtml(cleanDelta)}</div>` : ""}
          <div class="heading">${escapeHtml(it.heading || "")}</div>
          <div class="body">${escapeHtml(it.body || "")}</div>
          ${it.tag ? `<div class="tag">${escapeHtml(it.tag)}</div>` : ""}
        </div>`;
    };

    const winners = arrayOrEmpty(a.winners);
    const losers = arrayOrEmpty(a.losers);
    const recs = arrayOrEmpty(a.recs);

    return `
      ${summaryBlock}
      <div class="insight-grid">
        <div class="insight-card win">
          <div class="head"><span class="pill">Wat werkt</span><h3>Winners</h3></div>
          <div class="insight-list">
            ${winners.map(w => insightItem(w, "up")).join("")}
          </div>
        </div>
        <div class="insight-card lose">
          <div class="head"><span class="pill">Onder presteert</span><h3>Losers</h3></div>
          <div class="insight-list">
            ${losers.map(w => insightItem(w, "down")).join("")}
          </div>
        </div>
        <div class="insight-card rec">
          <div class="head"><span class="pill">Aanbevelingen</span><h3>Next steps</h3></div>
          <div class="insight-list">
            ${recs.map(w => insightItem(w, null)).join("")}
          </div>
        </div>
      </div>`;
  }

  function renderAnalysisLoadingSkeleton() {
    const card = `
      <div class="insight-card">
        <div class="head"><div class="skel-line" style="width:80px; height:14px;"></div><div class="skel-line" style="width:120px; height:18px;"></div></div>
        <div class="insight-list">
          ${Array(2).fill(`
            <div class="insight-item">
              <div class="skel-line" style="width:60%; height:12px;"></div>
              <div class="skel-line" style="width:90%; height:11px; margin-top:8px;"></div>
              <div class="skel-line" style="width:75%; height:11px; margin-top:4px;"></div>
            </div>`).join("")}
        </div>
      </div>`;
    return `
      <section class="panel" style="margin-bottom: var(--grid-gap);">
        <div class="skel-line" style="width:40%; height:18px;"></div>
        <div class="skel-line" style="width:90%; height:12px; margin-top:14px;"></div>
        <div class="skel-line" style="width:70%; height:12px; margin-top:6px;"></div>
      </section>
      <div class="insight-grid">${card}${card}${card}</div>`;
  }

  function renderAnalysis() {
    const root = $("#analysis-content");
    if (!root) return;

    // Manual-flow klanten: geen dashboard-databron (Windsor noch Metricool), dus geen analyse.
    // Drive levert enkel merkcontext, geen posts — analyse draait op dashboard-data.
    if (state.session && !state.session.hasMetricool && !state.session.hasWindsor) {
      root.innerHTML = renderAnalysisEmpty(`
        <p class="muted" style="margin:0 0 12px;">Analyse op basis van dashboard-data is beschikbaar voor klanten met een Windsor.ai- of Metricool-koppeling.</p>
        <p class="muted" style="margin:0; font-size:13px;">Voor handmatig geüploade CSV's: gebruik de chat-agent voor een ad-hoc analyse.</p>
        <button class="btn primary" style="margin-top:18px;" onclick="window.toggleChat()">Open de Agent →</button>
      `);
      return;
    }

    // Overview-fout — kunnen geen analyse maken zonder data.
    if (state.overviewError && !state.overview) {
      root.innerHTML = renderAnalysisEmpty(`
        <p class="muted" style="margin:0;">Analyse is niet beschikbaar zolang het dashboard niet laadt.</p>
        <p class="muted" style="margin:8px 0 0; font-size:13px;">${escapeHtml(state.overviewError)}</p>
      `);
      return;
    }

    // Wachten op dashboard-data.
    if (state.overviewLoading || !state.overview) {
      root.innerHTML = renderAnalysisEmpty(`<p class="muted" style="margin:0;">Wachten op dashboard-data…</p>`);
      return;
    }

    const postsCount = arrayOrEmpty(state.overview.allPosts).length;
    if (postsCount === 0) {
      root.innerHTML = renderAnalysisEmpty(`<p class="muted" style="margin:0;">Geen posts in deze periode om te analyseren.</p>`);
      return;
    }

    // LLM-generatie bezig.
    if (state.analysisLoading) {
      root.innerHTML = renderAnalysisLoadingSkeleton();
      return;
    }

    // Cache-hit voor huidige periode → toon resultaat.
    const cached = state.analysisCache[analysisPeriodKey()];
    if (cached) {
      root.innerHTML = renderAnalysisInsights(cached);
      return;
    }

    // Fout bij laatste generatie.
    if (state.analysisError) {
      root.innerHTML = renderAnalysisEmpty(`
        <p style="color:#c0392b; margin:0;">${escapeHtml(state.analysisError)}</p>
        <button class="btn primary" style="margin-top:14px;" onclick="window.__generateAnalysis()">Opnieuw proberen</button>
      `);
      return;
    }

    // Empty state — gebruiker moet expliciet de analyse triggeren.
    root.innerHTML = `
      <div class="panel" style="text-align:center; padding:56px 24px;">
        <div style="font-family:var(--font-serif); font-size:22px; color:var(--text); margin-bottom:8px;">Analyse genereren?</div>
        <p class="muted" style="margin:0 auto 22px; max-width:520px;">
          De Agent leest ${postsCount} posts en eventuele campagnes uit deze periode (${escapeHtml(periodLabelShort())}) en levert winners, losers en concrete aanbevelingen. Duurt zo'n 5 seconden.
        </p>
        <button class="btn primary" onclick="window.__generateAnalysis()">
          Genereer analyse voor ${escapeHtml(periodLabelShort())} →
        </button>
      </div>`;
  }

  /* ---------- Chat panel (mock, stap 6) ---------- */

  function renderChat() {
    $("#chat-body").innerHTML = "";
    $("#chat-prompts").innerHTML = DATA.prompts.map(p => `<button class="chat-prompt" data-prompt="${p}">${p}</button>`).join("");
    $$("#chat-prompts .chat-prompt").forEach(b => { b.onclick = () => sendUserMsg(b.dataset.prompt); });
    $("#chat-form").onsubmit = (e) => {
      e.preventDefault();
      const v = $("#chat-input-field").value.trim();
      if (!v) return;
      $("#chat-input-field").value = "";
      sendUserMsg(v);
    };
    if (state.chatMessages.length === 0) {
      pushBot({ text: `Hoi! Ik ben je <strong>Performance Agent</strong>. Ik kan vragen beantwoorden over je content en groei. Probeer een prompt hieronder, of stel je eigen vraag.` });
    } else {
      // Re-render bestaande geschiedenis in de DOM
      for (const m of state.chatMessages) appendMsg(m.role === "bot" ? "bot" : "user", m.text, m.stats);
    }
  }
  function pushUser(text) { state.chatMessages.push({ role: "user", text }); appendMsg("user", text); }
  function pushBot(payload) { state.chatMessages.push({ role: "bot", ...payload }); appendMsg("bot", payload.text, payload.stats); }
  function appendMsg(role, text, stats) {
    const body = $("#chat-body");
    const wrap = document.createElement("div");
    wrap.className = `msg ${role}`;
    let stubs = "";
    if (stats) {
      stubs = `<div class="meta-stats">${stats.map(s => `<span class="stat-chip"><span class="n">${s.n}</span><span class="l">${s.l}</span></span>`).join("")}</div>`;
    }
    wrap.innerHTML = `<div class="author">${role === "user" ? "Jij" : "Agent"}</div><div class="bubble">${text}${stubs}</div>`;
    body.appendChild(wrap);
    body.scrollTop = body.scrollHeight;
    return wrap;
  }
  function appendTyping() {
    const body = $("#chat-body");
    const wrap = document.createElement("div");
    wrap.className = "msg bot typing-msg";
    wrap.innerHTML = `<div class="author">Agent</div><div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div>`;
    body.appendChild(wrap);
    body.scrollTop = body.scrollHeight;
    return wrap;
  }
  async function sendUserMsg(text) {
    if (!state.session?.token) return;
    pushUser(text);
    const inputField = $("#chat-input-field");
    const submitBtn = $("#chat-form button[type='submit']");
    if (inputField) inputField.disabled = true;
    if (submitBtn) submitBtn.disabled = true;
    const typing = appendTyping();

    // Anthropic verwacht: eerste message met role "user". Onze welcome zit als
    // "bot" vooraan in state.chatMessages — die slaan we over tot we de eerste user-turn hebben.
    const apiMessages = [];
    let started = false;
    for (const m of state.chatMessages) {
      if (!started && m.role === "bot") continue;
      started = true;
      apiMessages.push({ role: m.role === "bot" ? "assistant" : "user", content: m.text });
    }

    try {
      const data = await apiPost("/api/chat", {
        messages: apiMessages,
        clientId: state.session.clientId,
        token: state.session.token,
        clientContext: state.session.clientContext || "",
      });
      typing.remove();
      pushBot({ text: data.text || "Geen antwoord ontvangen." });
    } catch (err) {
      typing.remove();
      pushBot({ text: `<em>Er ging iets mis: ${escapeHtml(err.message || "onbekende fout")}</em>` });
      if (err.status === 401) {
        clearSession();
        setTimeout(() => showScreen("login-screen"), 600);
      }
    } finally {
      if (inputField) { inputField.disabled = false; inputField.focus(); }
      if (submitBtn) submitBtn.disabled = false;
    }
  }
  function bindChatPanel() {
    $("#chat-toggle-btn").addEventListener("click", () => toggleChatPanel(true));
    $("#chat-close-btn").addEventListener("click", () => toggleChatPanel(false));
  }
  function toggleChatPanel(open) {
    const panel = $("#chat-panel");
    const toggleBtn = $("#chat-toggle-btn");
    if (open === undefined) open = panel.classList.contains("collapsed");
    panel.classList.toggle("collapsed", !open);
    toggleBtn.classList.toggle("hidden", open);
  }
  window.toggleChat = () => toggleChatPanel();

  /* ---------- Tweaks panel ---------- */

  function bindTweaks() {
    window.addEventListener("message", (e) => {
      const data = e.data || {};
      if (data.type === "__activate_edit_mode") openTweaks();
      else if (data.type === "__deactivate_edit_mode") closeTweaks();
    });
    window.parent.postMessage({ type: "__edit_mode_available" }, "*");
    const t = window.TWEAK_DEFAULTS;
    setAccent(t.accent); setDensity(t.density); setTheme(t.theme);
    $$("[data-tweak-accent]").forEach(b => { b.onclick = () => { setAccent(b.dataset.tweakAccent); persist({ accent: b.dataset.tweakAccent }); }; });
    $$("[data-tweak-density]").forEach(b => { b.onclick = () => { setDensity(b.dataset.tweakDensity); persist({ density: b.dataset.tweakDensity }); }; });
    $$("[data-tweak-theme]").forEach(b => { b.onclick = () => { setTheme(b.dataset.tweakTheme); persist({ theme: b.dataset.tweakTheme }); }; });
    $("#tweaks-close").onclick = () => { closeTweaks(); window.parent.postMessage({ type: "__edit_mode_dismissed" }, "*"); };
  }
  function openTweaks() { $("#tweaks-panel").classList.add("on"); }
  function closeTweaks() { $("#tweaks-panel").classList.remove("on"); }
  function persist(edits) { window.parent.postMessage({ type: "__edit_mode_set_keys", edits }, "*"); }
  function setAccent(v) { document.documentElement.setAttribute("data-accent", v); $$("[data-tweak-accent]").forEach(b => b.classList.toggle("on", b.dataset.tweakAccent === v)); if (dashboardInited && state.overview) renderOverview(); }
  function setDensity(v) { document.documentElement.setAttribute("data-density", v); $$("[data-tweak-density]").forEach(b => b.classList.toggle("on", b.dataset.tweakDensity === v)); }
  function setTheme(v) { document.documentElement.setAttribute("data-theme", v); $$("[data-tweak-theme]").forEach(b => b.classList.toggle("on", b.dataset.tweakTheme === v)); if (dashboardInited && state.overview) renderOverview(); }

  /* ---------- Boot ---------- */

  function bindLogin() {
    const loginBtn = $("#login-button");
    if (loginBtn) loginBtn.addEventListener("click", login);
    const form = $("#code-input");
    if (form) form.addEventListener("keypress", (e) => { if (e.key === "Enter") login(e); });
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindLogin();
    bindTweaks();
    bindManualContext();

    const existing = loadSession();
    if (existing && existing.token) {
      $("#sidebar-brand").textContent = `Klant: ${existing.brandName}`;
      $("#sidebar-brand-sub").textContent = existing.hasMetricool ? "Connected · Metricool live" : "Connected";
      updateSidebarContext();
      if (existing.hasMetricool || existing.hasDrive) {
        showScreen("app-screen");
      } else {
        $("#source-brand").textContent = existing.brandName;
        showScreen("source-screen");
      }
    } else {
      showScreen("login-screen");
    }
  });

})();
