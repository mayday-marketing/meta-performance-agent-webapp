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

  const state = {
    session: null,                    // { token, clientId, brandName, hasMetricool, hasDrive }
    page: "overview",
    libraryView: "grid",
    libraryFilter: "all",
    librarySort: { key: "reach", dir: "desc" },
    chatMessages: [],
    period: { start: null, end: null },
    overview: null,                   // populated by fetchOverview()
    overviewLoading: false,
    overviewError: null,
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

  /* ---------- Screen flow ---------- */

  function showScreen(id) {
    $$(".screen").forEach((s) => s.classList.toggle("on", s.id === id));
    if (id === "app-screen") initDashboard();
  }
  window.showScreen = showScreen;

  function chooseSource(type) {
    if (type === "handmatig") {
      showScreen("manual-screen");
    } else {
      showScreen("app-screen");
    }
  }
  window.chooseSource = chooseSource;

  function logout() {
    clearSession();
    state.overview = null;
    state.overviewError = null;
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
      });
      $("#source-brand").textContent = data.brandName;
      $("#sidebar-brand").textContent = `Klant: ${data.brandName}`;
      $("#sidebar-brand-sub").textContent = data.hasMetricool ? "Connected · Metricool live" : "Connected";
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

    // Library + Analysis still use mock — render once.
    renderLibrary();
    renderAnalysis();
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
      overview: { title: "Overview", crumbs: ["Dashboard", "Overview"] },
      library:  { title: "Library",  crumbs: ["Dashboard", "Library"] },
      analysis: { title: "Analysis", crumbs: ["Dashboard", "Analysis"] }
    };
    const t = titles[page];
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

  async function refreshOverview() {
    if (!state.session?.hasMetricool) {
      state.overviewError = "Voor deze klant is geen Metricool-koppeling geconfigureerd.";
      renderOverview();
      return;
    }
    state.overviewLoading = true;
    state.overviewError = null;
    renderOverview();

    try {
      const raw = await metricoolCall("getDashboard", {
        startDate: state.period.start,
        endDate: state.period.end,
      });
      state.overview = transformDashboard(raw);
      state.overviewLoading = false;
      renderOverview();
    } catch (err) {
      state.overviewLoading = false;
      state.overviewError = err.message || "Onbekende fout bij laden Metricool-data.";
      if (err.status === 401) {
        // Session expired — bounce to login.
        clearSession();
        setTimeout(() => showScreen("login-screen"), 600);
      }
      renderOverview();
    }
  }

  /* ---------- Metricool → app shape ---------- */

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

  function normalizePost(raw, platform, defaultType) {
    if (!raw || typeof raw !== "object") return null;
    const published = raw.published || raw.created || raw.publishedAt || raw.start || raw.date;
    const date = published ? new Date(published) : null;
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
    const caption = pickStr(raw, "text", "caption", "name", "description", "title") || "—";
    const thumb = pickStr(raw, "imageUrl", "image", "thumbnail", "picture");
    const url = pickStr(raw, "url", "permalink");
    const type = pickStr(raw, "type") || defaultType;

    return {
      id: pickStr(raw, "id") || url || `${platform}-${published || Math.random()}`,
      platform, type,
      date, dateLabel: date ? fmt.dateNL(date) : "—",
      reach, impressions, likes, comments, shares, saves, clicks, views,
      interactions, engagement, ctr,
      caption, thumb, url,
    };
  }

  function arrayOrEmpty(x) { return Array.isArray(x) ? x : []; }

  function transformDashboard(raw) {
    const igPosts = arrayOrEmpty(raw.posts?.igPosts).map(p => normalizePost(p, "ig", "Post"));
    const igReels = arrayOrEmpty(raw.posts?.igReels).map(p => normalizePost(p, "ig", "Reel"));
    const fbPosts = arrayOrEmpty(raw.posts?.fbPosts).map(p => normalizePost(p, "fb", "Post"));
    const ads = arrayOrEmpty(raw.adsCampaigns).map(c => normalizePost(c, "ads", "Campagne"));

    const allPosts = [...igPosts, ...igReels, ...fbPosts].filter(Boolean);
    const adsCampaigns = ads.filter(Boolean);

    // KPI snapshots
    const cur = raw.current || {};
    const prv = raw.previous || {};

    const reachCur = pick(cur.instagram, "reach", "impressionsUnique") + pick(cur.facebook, "reach", "impressionsUnique");
    const reachPrv = pick(prv.instagram, "reach", "impressionsUnique") + pick(prv.facebook, "reach", "impressionsUnique");

    const clicksCur = pick(cur.instagram, "linkClicks", "clicks", "profileClicks") + pick(cur.facebook, "clicks", "linkclicks");
    const clicksPrv = pick(prv.instagram, "linkClicks", "clicks", "profileClicks") + pick(prv.facebook, "clicks", "linkclicks");

    // Engagement rate fallback: derive from posts in current window.
    const totalInteractions = allPosts.reduce((s, p) => s + p.interactions, 0);
    const totalPostReach = allPosts.reduce((s, p) => s + p.reach, 0);
    const erCur = totalPostReach ? (totalInteractions / totalPostReach) * 100 : 0;
    // Previous period engagement rate from snapshot fields if present.
    const erPrvFromValues = pick(prv.instagram, "engagement", "engagementRate", "engagement_rate");
    const erPrv = erPrvFromValues > 1 ? erPrvFromValues : (erPrvFromValues > 0 ? erPrvFromValues * 100 : 0);

    const postsCur = allPosts.length;
    // No reliable "previous posts count" without another fetch — leave delta absent.

    const kpis = [
      buildKpi("Totale reach", reachCur, reachPrv, fmt.k, "pct"),
      buildKpi("Engagement rate", erCur, erPrv, (n) => fmt.pct(n), "pp"),
      buildKpi("Posts gepubliceerd", postsCur, null, (n) => String(n), "pct"),
      buildKpi("Clicks", clicksCur, clicksPrv, fmt.k, "pct"),
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
    const trendAds = trendWeeks.map(w => sumAdsReachInWeek(adsCampaigns, w));

    const timeseries = {
      weeks: trendWeeks.map((w, i) => `wk ${i + 1}`),
      series: [
        { label: "Instagram", color: "#ff683b", values: trendIG },
        { label: "Facebook", color: "#351f69", values: trendFB },
        { label: "Meta Ads", color: "#1f9b8a", values: trendAds },
      ],
    };

    // Channel mix
    const igReach = trendIG.reduce((s, v) => s + v, 0);
    const fbReach = trendFB.reduce((s, v) => s + v, 0);
    const adsReach = trendAds.reduce((s, v) => s + v, 0);
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
      .map((p, i) => ({
        id: p.id,
        caption: p.caption,
        type: p.type,
        date: p.dateLabel,
        engagement: p.engagement.toFixed(1) + "%",
        thumb: p.thumb || gradientFor(i),
      }));

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
      _raw: raw,
    };
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
  function sumAdsReachInWeek(campaigns, week) {
    let total = 0;
    for (const c of campaigns) {
      if (!c.date) continue;
      const cStart = c.date;
      // No reliable end date; assume single-week attribution at start.
      if (inWeek(cStart, week)) total += c.reach || 0;
    }
    return total;
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
    legend.innerHTML = ts.series.map(s =>
      `<span class="item"><span class="swatch" style="background:${s.color}"></span>${s.label}</span>`
    ).join("");
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
      <div class="top-post" data-post="${p.id}">
        <div class="post-thumb thumb-pattern" style="background:${p.thumb}">
          <span class="glyph">${i + 1}</span>
          ${p.type === "Reel" ? `<span class="play-icon">▶</span>` : ""}
        </div>
        <div class="meta">
          <div class="caption">${p.caption}</div>
          <div class="submeta">
            <span>${p.type}</span><span>·</span><span>${p.date}</span><span>·</span><span>IG</span>
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

  /* ---------- Library (mock, stap 4) ---------- */

  function platformLabel(p) { return { ig: "Instagram", fb: "Facebook", ads: "Meta Ads" }[p]; }
  function platformShort(p) { return { ig: "IG", fb: "FB", ads: "ADS" }[p]; }

  function getFilteredLibrary() {
    let list = DATA.library.slice();
    if (state.libraryFilter !== "all") list = list.filter(p => p.platform === state.libraryFilter);
    const dir = state.librarySort.dir === "asc" ? 1 : -1;
    const field = state.librarySort.key;
    list.sort((a, b) => {
      const av = a[field], bv = b[field];
      if (av == null) return 1 * dir;
      if (bv == null) return -1 * dir;
      if (typeof av === "string") return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });
    return list;
  }

  function performanceExplanation(level) {
    const brand = state.session?.brandName || "de klant";
    if (level === "Good")    return `Deze post doet het beter dan ${brand}s gemiddelde. Houd dit format aan en bouw voort op dezelfde contentstijl.`;
    if (level === "Average") return `Deze post zit rond de klantbenchmark. Er is voldoende engagement om mee te werken, maar de eerste 3 seconden kunnen sterker.`;
    if (level === "Bad")     return `Deze post presteert duidelijk onder ${brand}s benchmark. Begin bij de hook en het format.`;
    return "Deze performantie-indicator vergelijkt de post met de klantbenchmark.";
  }

  function openPerformanceChat(level) {
    toggleChatPanel(true);
    pushBot({ text: `<strong>${level}</strong> — ${performanceExplanation(level)}` });
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
    $$("#lib-results .perf-button").forEach((btn) => {
      btn.onclick = () => openPerformanceChat(btn.dataset.performance);
    });
  }

  function renderLibraryGrid(list) {
    return `<div class="lib-grid">${list.map(p => `
      <article class="lib-card" data-post="${p.id}">
        <div class="thumb thumb-pattern" style="background:${p.thumb}; aspect-ratio: 1;">
          <div class="pill-row">
            <span class="pill">${platformShort(p.platform)} · ${p.type}</span>
            <span class="pill engage">${p.engagement.toFixed(1)}%</span>
          </div>
        </div>
        <div class="body">
          <div class="caption">${p.caption}</div>
          <div class="meta"><span>${p.date}</span><span>·</span><span>${p.type}</span></div>
          <div class="stats">
            <div class="s"><div class="n">${fmt.k(p.reach)}</div><div class="l">Reach</div></div>
            <div class="s"><div class="n">${p.engagement.toFixed(1)}%</div><div class="l">Engage</div></div>
            <div class="s"><div class="n">${p.ctr.toFixed(1)}%</div><div class="l">CTR</div></div>
          </div>
        </div>
      </article>
    `).join("")}</div>`;
  }

  function renderRetentionBlocks(retention) {
    if (!retention) return `<div class="retention-row">${Array(5).fill('<span class="block inactive"></span>').join('')}</div>`;
    const checkpoints = [
      { label: '3s', value: retention.p3, threshold: 3 },
      { label: '25%', value: retention.p25, threshold: 25 },
      { label: '50%', value: retention.p50, threshold: 50 },
      { label: '75%', value: retention.p75, threshold: 75 },
      { label: '95%', value: retention.p95, threshold: 95 }
    ];
    return `<div class="retention-row">${checkpoints.map(cp =>
      `<span class="block ${cp.value >= cp.threshold ? 'active' : 'inactive'}" title="${cp.label}: ${cp.value}%"></span>`
    ).join('')}</div>`;
  }

  function renderBenchmarkRow(list) {
    if (!list.length) return '';
    const avg = (field) => Math.round(list.reduce((sum, item) => sum + (item[field] || 0), 0) / list.length);
    const avgPerf = list.reduce((sum, item) => sum + (item.engagement || 0), 0) / list.length;
    const platformName = state.libraryFilter === 'all' ? 'Globaal gemiddelde' : `${platformLabel(state.libraryFilter)} gemiddelde`;
    return `<tr class="benchmark-row">
      <td>CLIENT BENCHMARK — ${platformName}</td><td></td><td></td><td></td>
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

  function renderLibraryTable(list) {
    return `<div class="lib-table"><table>
      <thead><tr>
        <th>Post</th>
        <th class="sortable" data-sort="platform">Platform</th>
        <th class="sortable" data-sort="type">Type</th>
        <th class="sortable" data-sort="date">Datum</th>
        <th class="right sortable" data-sort="views">Views</th>
        <th class="right sortable" data-sort="reach">Reach</th>
        <th class="right sortable" data-sort="likes">Likes</th>
        <th class="right sortable" data-sort="comments">Comments</th>
        <th class="right sortable" data-sort="shares">Shares</th>
        <th class="right sortable" data-sort="saves">Saves</th>
        <th class="right">Retention</th>
        <th class="right sortable" data-sort="engagement">Engage</th>
        <th class="right sortable" data-sort="ctr">CTR</th>
        <th class="right">Performantie</th>
      </tr></thead>
      <tbody>
        ${renderBenchmarkRow(list)}
        ${list.map(p => `
          <tr data-post="${p.id}">
            <td><span class="row-thumb thumb-pattern" style="background:${p.thumb}"></span><span class="row-caption">${p.caption}</span></td>
            <td><span class="platform-tag ${p.platform}">${platformLabel(p.platform)}</span></td>
            <td>${p.type}</td>
            <td>${p.dateRange || p.date}</td>
            <td class="right">${fmt.int(p.views)}</td>
            <td class="right">${fmt.int(p.reach)}</td>
            <td class="right">${fmt.int(p.likes)}</td>
            <td class="right">${fmt.int(p.comments)}</td>
            <td class="right">${fmt.int(p.shares)}</td>
            <td class="right">${fmt.int(p.saves)}</td>
            <td class="right">${renderRetentionBlocks(p.retention)}</td>
            <td class="right">${p.engagement.toFixed(1)}%</td>
            <td class="right">${p.ctr.toFixed(1)}%</td>
            <td class="right"><button class="perf-button ${p.performance ? p.performance.toLowerCase() : ''}" data-performance="${p.performance || 'Average'}">${p.performance || 'n/a'}</button></td>
          </tr>
        `).join("")}
      </tbody>
    </table></div>`;
  }

  function renderLibrary() {
    $("#lib-filters").innerHTML = DATA.libraryFilters.map(f => `
      <button class="chip ${state.libraryFilter === f.key ? "on" : ""}" data-filter="${f.key}">
        ${f.label} <span class="count">${f.count}</span>
      </button>
    `).join("");
    $$("#lib-filters .chip").forEach(b => {
      b.addEventListener("click", () => { state.libraryFilter = b.dataset.filter; renderLibrary(); });
    });
    $("#lib-sort").value = state.librarySort.key;
    $("#lib-sort").onchange = (e) => { state.librarySort.key = e.target.value; renderLibrary(); };
    $$("#lib-view-toggle button").forEach(b => {
      b.classList.toggle("on", b.dataset.view === state.libraryView);
      b.onclick = () => { state.libraryView = b.dataset.view; renderLibrary(); };
    });
    const list = getFilteredLibrary();
    $("#lib-results").innerHTML = state.libraryView === "grid"
      ? renderLibraryGrid(list)
      : renderLibraryTable(list);
    $("#lib-count").textContent = `${list.length} posts`;
    bindLibraryInteractions();
  }

  /* ---------- Analysis (mock, stap 5) ---------- */

  function renderAnalysis() {
    const ins = DATA.insights;
    $("#analysis-content").innerHTML = `
      <div class="insight-grid">
        <div class="insight-card win">
          <div class="head"><span class="pill">Wat werkt</span><h3>Winners</h3></div>
          <div class="insight-list">
            ${ins.winners.map(w => `
              <div class="insight-item">
                <div class="delta up">${w.delta}</div>
                <div class="heading">${w.heading}</div>
                <div class="body">${w.body}</div>
                <div class="tag">${w.tag}</div>
              </div>`).join("")}
          </div>
        </div>
        <div class="insight-card lose">
          <div class="head"><span class="pill">Onder presteert</span><h3>Losers</h3></div>
          <div class="insight-list">
            ${ins.losers.map(w => `
              <div class="insight-item">
                <div class="delta down">${w.delta}</div>
                <div class="heading">${w.heading}</div>
                <div class="body">${w.body}</div>
                <div class="tag">${w.tag}</div>
              </div>`).join("")}
          </div>
        </div>
        <div class="insight-card rec">
          <div class="head"><span class="pill">Aanbevelingen</span><h3>Next steps</h3></div>
          <div class="insight-list">
            ${ins.recs.map(w => `
              <div class="insight-item">
                <div class="heading">${w.heading}</div>
                <div class="body">${w.body}</div>
                <div class="tag">${w.tag}</div>
              </div>`).join("")}
          </div>
        </div>
      </div>
    `;
  }

  /* ---------- Chat panel (mock, stap 6) ---------- */

  function renderChat() {
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
  function sendUserMsg(text) {
    pushUser(text);
    const typing = appendTyping();
    setTimeout(() => {
      typing.remove();
      pushBot({ text: `Chat-agent komt in stap 6. Voor nu reageer ik niet op data. (Je vroeg: <em>${text}</em>)` });
    }, 600);
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

    const existing = loadSession();
    if (existing && existing.token) {
      $("#sidebar-brand").textContent = `Klant: ${existing.brandName}`;
      $("#sidebar-brand-sub").textContent = existing.hasMetricool ? "Connected · Metricool live" : "Connected";
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
