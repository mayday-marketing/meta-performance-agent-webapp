/* ==========================================================
   mayday marketing Performance Dashboard — App logic
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
    driveContext: null,               // { clientId, files: [{label, content}] } — merkcontext voor de chat (cache per klant)
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
    email: null,                      // ruwe getEmail-respons voor de huidige periode
    emailLoading: false,
    emailError: null,
    emailKey: null,                   // periodeKey waarvoor email geladen is (lazy refresh)
    emailOverlays: { open: true, click: false, revenue: true, rev_rcpt: false }, // aan/uit overlay-lijnen
    emailSort: { key: null, dir: "desc" }, // sorteer-state e-mailtabellen (null = default per tabel)
    // ROAS-tab — eigen periode (month-to-date), los van de dashboardperiode.
    roas: null,                       // getRoas-respons: { current, previous, channels, targets, ... }
    roasLoading: false,
    roasError: null,
    roasKey: null,                    // klant+periode waarvoor roas geladen is (lazy refresh)
    roasPeriod: "mtd",                // 'mtd' | 'prevmonth' | '30d'
    roasRevenueMode: null,            // omzetdefinitie voor kaarten + oordeel; null = volg 'Oordeel op' uit de Config-tab
    // Live overschrijving van de break-even-parameters uit de Config-tab. null =
    // configwaarde gebruiken. Bewust niet in sessionStorage: dit is een scenario,
    // geen instelling.
    roasInputs: { grossMargin: null, seasonalDiscount: null, activeScenario: null },
    // Website-tab — volgt WEL de dashboardperiode uit de topbar.
    website: null,                    // getWebsite-respons: { current, previous, yearAgo, website, ... }
    websiteLoading: false,
    websiteError: null,
    websiteKey: null,                 // klant+periode waarvoor de tab geladen is (lazy refresh)
    websiteCompare: "prev",           // 'prev' (vorige periode) | 'yoy' (vorig jaar)
    websiteTab: "overzicht",          // actief sub-blad van de Website-tab
    roasTab: "blended",               // actief sub-blad van de ROAS-tab
    bronnenTab: "bronnen",            // actief sub-blad van de Bronnen-tab
    websiteLandingQuery: "",          // zoekterm in de landingspagina-tabel (alleen deze sessie)
    // SEO-tab — eigen keywordlijst, géén periode (zoekvolume is een maandcijfer).
    seo: null,                        // volumes-respons: { items, keywords, cost, ... }
    seoLoading: false,
    seoError: null,
    seoSettings: null,                // domein, markt, taal, limieten uit api/seo.js
    seoKeywords: null,                // effectieve lijst; null = nog niet bekend (volgt de Config-tab)
    seoRanks: null,                   // ranks-respons: { ranks, domain, cost, ... }
    seoRanksLoading: false,
    seoRanksError: null,
    seoSort: { key: "volume", dir: "desc" },
    // GEO-tab — AI-zichtbaarheid. De baseline is een audit met een eigen datum,
    // dus geen periode uit de topbar. Alleen de Sources-laag is live.
    geo: null,                        // gevalideerde baseline uit geo-dashboard.json
    geoLoading: false,
    geoError: null,
    geoMeta: null,                    // bestandsnaam, waarschuwingen, waar gezocht is
    geoTab: "overzicht",              // overzicht | prompts | sources | website | acties
    geoSources: null,                 // live DataForSEO-mentions
    geoSourcesLoading: false,
    geoSourcesError: null,
    geoSourcesPlatform: null,         // null = volg het auditbestand
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
    resetBrandConfig();
    // De state leegmaken is niet genoeg: de DOM houdt de HTML van de vorige
    // klant vast tot díé tab opnieuw getekend wordt, en dat gebeurt pas bij een
    // bezoek. Hier en niet in logout(), want een verlopen sessie (401) komt
    // alleen langs clearSession — en dat pad moet net zo schoon zijn.
    clearRenderedData();
    // report.js houdt zijn eigen state buiten `state`: gekozen blokken,
    // opgehaalde ROAS, duiding, slides, design system.
    if (window.__report) window.__report.reset();
    // Terug naar false, zodat de volgende login initDashboard opnieuw draait en
    // dus weer op Overview begint in plaats van op de laatst bekeken pagina.
    dashboardInited = false;
  }

  /* ---------- Merkconfig (Config-tab in de klantsheet) ---------- */

  // Accent, logo en merknaam komen server-side uit de Config-tab. De waarden zijn daar
  // al gevalideerd (hex-regex + https-host-allowlist), en we zetten ze via setProperty /
  // .src — nooit via innerHTML, zodat sheetinhoud geen markup kan injecteren.

  function hexToRgbTriplet(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
    return m ? `${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}` : null;
  }


  // Kleuren afleiden uit het merkaccent (§ rapportstijl). Eén regel doet het echte
  // werk: de datakleur wordt naar inkt gemengd tot ze leesbaar is op het papier —
  // een licht merkaccent (geel, lime) verdwijnt anders als reekskleur, en in dark
  // mode is een donker accent op #121212 net zo onleesbaar. Al het andere hangt
  // daaraan vast, dus een klant levert één hexcode en het hele rapport volgt.
  const DERIVED_PROPS = ["--accent-data", "--s2", "--panel", "--panel-grid",
                         "--panel-axis", "--strip", "--on-accent", "--marker"];

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h.split("").map(c => c + c).join("");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function relLum(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return 0;
    const [r, g, b] = rgb.map(v => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function mixHex(a, b, p) {
    const x = hexToRgb(a), y = hexToRgb(b);
    if (!x || !y) return a;
    return "#" + x.map((v, i) =>
      Math.round(v + (y[i] - v) * p).toString(16).padStart(2, "0")).join("");
  }

  function deriveBrandTokens(accent, dark) {
    if (!hexToRgb(accent)) return null;
    const paper = dark ? "#121212" : "#faf9f7";
    const ink = dark ? "#e6e1e5" : "#1a1a1a";
    const surface = dark ? "#1e1e1e" : "#ffffff";

    let data = accent, step = 0;
    while (step < 0.9 && (dark ? relLum(data) < 0.34 : relLum(data) > 0.22)) {
      step += 0.05;
      data = mixHex(accent, ink, step);
    }

    // Een licht accent kan geen witte tekst dragen, en mag als decoratieve stip
    // juist wél zijn eigen kleur houden.
    const lightBrand = relLum(accent) > 0.32;
    const panel = mixHex(data, dark ? surface : paper, dark ? 0.84 : 0.91);

    return {
      "--accent-data": data,
      "--s2": mixHex(data, dark ? ink : "#ffffff", 0.45),
      "--panel": panel,
      "--panel-grid": mixHex(data, panel, 0.76),
      "--panel-axis": mixHex(data, panel, 0.58),
      "--strip": mixHex(data, paper, 0.95),
      "--on-accent": lightBrand ? "#1a1a1a" : "#ffffff",
      "--marker": lightBrand ? accent : mixHex(accent, dark ? surface : paper, 0.7)
    };
  }

  // Opnieuw afleiden voor het actieve thema. Wordt ook na een themawissel gebeld,
  // want de formules hebben een ander eindpunt in dark mode.
  function applyDerivedTokens(accent) {
    const root = document.documentElement;
    DERIVED_PROPS.forEach(prop => root.style.removeProperty(prop));
    // Zonder klantaccent (loginscherm, klant zonder Config-accent) toch afleiden
    // van de standaard: anders blijft #400745 in dark mode de onleesbare datakleur.
    const hex = accent || state.session?.brand?.accent
      || getComputedStyle(root).getPropertyValue("--accent").trim();
    if (!hex) return;
    const tokens = deriveBrandTokens(hex, root.getAttribute("data-theme") === "dark");
    if (!tokens) return;
    Object.keys(tokens).forEach(k => root.style.setProperty(k, tokens[k]));
  }

  // Inline props weghalen: anders blijft het accent van klant A staan als klant B
  // geen eigen accent heeft (uitloggen → inloggen in hetzelfde tabblad).
  function resetBrandConfig() {
    const root = document.documentElement;
    ["--accent", "--accent-text", "--support", "--heat"].concat(DERIVED_PROPS)
      .forEach(prop => root.style.removeProperty(prop));
    const logo = $("#brand-logo");
    if (logo) { logo.hidden = true; logo.removeAttribute("src"); }
    const naam = $("#sidebar-brand-name");
    if (naam) { naam.textContent = "Dashboard"; naam.hidden = false; }
  }

  function applyBrandConfig(cfg) {
    resetBrandConfig();
    if (!cfg) return;

    const root = document.documentElement;
    if (cfg.accent) {
      root.style.setProperty("--accent", cfg.accent);
      root.style.setProperty("--accent-text", cfg.accentText || cfg.accent);
      const rgb = hexToRgbTriplet(cfg.accent);
      if (rgb) root.style.setProperty("--heat", rgb);
      applyDerivedTokens(cfg.accent);
    }
    // Steunkleur is een vulkleur, geen tekstkleur: de CSS gebruikt hem alleen als
    // achtergrond, altijd met --fg erop.
    if (cfg.support) root.style.setProperty("--support", cfg.support);

    const logo = $("#brand-logo");
    if (logo && cfg.logoUrl) {
      logo.src = cfg.logoUrl;
      logo.alt = cfg.brandName || state.session?.brandName || "";
      logo.hidden = false;
    }

    if (cfg.brandName) {
      const sb = $("#sidebar-brand");
      if (sb) sb.textContent = `Klant: ${cfg.brandName}`;
      // Naam bovenaan alleen tonen als er geen logo is — twee keer hetzelfde merk
      // boven elkaar zetten leest als een fout.
      const naam = $("#sidebar-brand-name");
      if (naam) { naam.textContent = cfg.brandName; naam.hidden = !!cfg.logoUrl; }
    }
  }

  async function fetchBrandConfig() {
    const s = state.session;
    if (!s || !s.token || !s.clientId) return null;
    try {
      const qs = new URLSearchParams({ action: "config", clientId: s.clientId, token: s.token });
      const res = await fetch(`/api/sheets?${qs.toString()}`);
      if (!res.ok) return null;
      const data = await res.json();
      if (Array.isArray(data?.warnings) && data.warnings.length) {
        console.warn("[config]", data.warnings.join(" · "));
      }
      const cfg = data?.config || null;
      if (!cfg) return null;
      // In de sessie bewaren zodat een reload meteen in de merkkleur opent.
      state.session.brand = cfg;
      saveSession(state.session);
      applyBrandConfig(cfg);
      return cfg;
    } catch {
      return null;
    }
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
      // Body meegeven: een 400 draagt soms bruikbare context (de SEO-tab haalt er
      // de instellingen uit om te kunnen uitleggen wát er ontbreekt).
      err.data = data;
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
    // E-mailstate wissen bij logout — anders lekt de vorige klant z'n e-maildata door.
    state.email = null;
    state.emailKey = null;
    state.emailError = null;
    state.emailLoading = false;
    state.roas = null;
    state.roasKey = null;
    state.roasError = null;
    state.roasLoading = false;
    state.roasInputs = { grossMargin: null, seasonalDiscount: null, activeScenario: null };
    state.roasRevenueMode = null;
    state.website = null;
    state.websiteKey = null;
    state.websiteError = null;
    state.websiteLoading = false;
    state.websiteLandingQuery = "";
    // SEO-state wissen: de keywordlijst van klant A hoort niet in de tab van klant B.
    // De lijst zelf staat per klant in localStorage en wordt bij het inloggen opnieuw
    // geladen (zie seoFetch).
    state.seo = null;
    state.seoError = null;
    state.seoLoading = false;
    state.seoSettings = null;
    state.seoKeywords = null;
    state.seoRanks = null;
    state.seoRanksError = null;
    state.seoRanksLoading = false;
    // GEO-state wissen: een auditbestand hoort bij één klant.
    state.geo = null;
    state.geoError = null;
    state.geoLoading = false;
    state.geoMeta = null;
    state.geoTab = "overzicht";
    state.geoSources = null;
    state.geoSourcesError = null;
    state.geoSourcesLoading = false;
    state.geoSourcesPlatform = null;
    state.chatMessages = [];
    $("#brand-input").value = "";
    $("#code-input").value = "";
    $("#source-brand").textContent = "—";
    setLoginError("");
    showScreen("login-screen");
  }
  window.logout = logout;

  // Elk element dat data van één klant toont. Staat er een nieuw id bij een
  // nieuwe tab, zet het hier ook neer — anders lekt die tab bij een
  // klantwissel zichtbaar door.
  const RENDER_TARGETS = [
    "#kpi-grid", "#trend-chart", "#trend-legend", "#channel-mix", "#cadence",
    "#top-posts", "#lib-results", "#analysis-content", "#website-content",
    "#seo-content", "#geo-content", "#roas-content", "#email-content",
    "#report-content", "#chat-body",
  ];

  function clearRenderedData() {
    for (const sel of RENDER_TARGETS) {
      const el = $(sel);
      if (el) el.innerHTML = "";
    }
  }

  /* ---------- Login ---------- */

  function setLoginError(msg) {
    let el = $("#login-error");
    if (!el) {
      el = document.createElement("div");
      el.id = "login-error";
      el.style.cssText = "color:var(--negative); font-size:12px; margin-top:8px; min-height:16px;";
      $("#login-button").insertAdjacentElement("beforebegin", el);
    }
    el.textContent = msg || "";
  }

  async function login(e) {
    if (e && e.preventDefault) e.preventDefault();
    const clientId = $("#brand-input").value.trim();
    const password = $("#code-input").value.trim();
    if (!clientId || !password) {
      if (!clientId) $("#brand-input").setAttribute("aria-invalid", "true");
      if (!password) $("#code-input").setAttribute("aria-invalid", "true");
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

      // Merkconfig vóór de eerste dashboardpaint, zodat het scherm niet eerst in de
      // standaardkleur opent. Faalt nooit hard — dan blijven de defaults staan.
      await fetchBrandConfig();

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

    // Altijd op Overview beginnen. Zonder dit blijft de pagina staan waar de
    // vórige gebruiker was — inclusief wat daar getekend stond.
    switchPage("overview");

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
      state.emailKey = null; // e-mail-cache verloopt bij periode-wissel
      if (state.page === "email") refreshEmail();
      state.websiteKey = null;
      if (state.page === "website") websiteFetch();
      // De Rapport-tab heeft een eigen opgehaalde set (ROAS, duiding, slides)
      // die aan deze periode hangt; die moet mee verlopen.
      if (window.__report) window.__report.periodChanged();
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

  // Pagina's met een eigen rapportkop dragen hun titel zelf; dan verdwijnt de
  // topbar-titel, anders staan er twee koppen van 40px boven elkaar.
  const REPORT_PAGES = new Set(["overview", "website", "roas", "bronnen"]);

  function switchPage(page) {
    state.page = page;
    document.documentElement.setAttribute("data-report", REPORT_PAGES.has(page) ? "on" : "off");
    $$(".nav-link").forEach((l) => l.classList.toggle("on", l.dataset.page === page));
    $$(".dash-page").forEach((p) => p.style.display = p.id === `page-${page}` ? "block" : "none");
    const titles = {
      overview:    { title: "Overview",    crumbs: ["Dashboard", "Overview"] },
      library:     { title: "Library",     crumbs: ["Dashboard", "Library"] },
      analysis:    { title: "Analysis",    crumbs: ["Dashboard", "Analysis"] },
      email:       { title: "E-mail",      crumbs: ["Dashboard", "E-mail"] },
      website:     { title: "Website",     crumbs: ["Dashboard", "Website"] },
      seo:         { title: "SEO",         crumbs: ["Dashboard", "SEO"] },
      geo:         { title: "GEO",         crumbs: ["Dashboard", "GEO"] },
      roas:        { title: "ROAS",        crumbs: ["Dashboard", "ROAS"] },
      report:      { title: "Rapport",     crumbs: ["Dashboard", "Rapport"] },
      methodology: { title: "Methodology", crumbs: ["Dashboard", "Methodology"] },
      bronnen:     { title: "Bronnen",     crumbs: ["Dashboard", "Bronnen"] },
    };
    const t = titles[page] || titles.overview;
    $(".page-title").textContent = t.title;
    $(".crumbs").innerHTML = t.crumbs.map((c, i) =>
      i === 0 ? `<span>${c}</span>` : `<span class="sep">/</span><span>${c}</span>`
    ).join("");
    // E-mail wordt lui geladen bij het eerste bezoek (en opnieuw na periode-wissel).
    if (page === "email" && typeof refreshEmail === "function") refreshEmail();
    // ROAS heeft een eigen periode (month-to-date) en wordt daarom niet door de
    // dashboard-periodewissel ververst, alleen bij het eerste bezoek.
    if (page === "roas" && typeof roasFetch === "function") roasFetch();
    // Website volgt de dashboardperiode en wordt lui geladen (en opnieuw na een
    // periodewissel, zie bindPeriodToggle/bindDateFilter).
    if (page === "website" && typeof websiteFetch === "function") websiteFetch();
    // SEO heeft een eigen keywordlijst en géén periode: zoekvolume is een
    // maandcijfer. Lui laden, en daarna alleen op verzoek verversen.
    if (page === "seo" && typeof seoFetch === "function") seoFetch();
    // GEO leest een auditbestand uit Drive; ook lui, en ook zonder periode.
    if (page === "geo" && typeof geoFetch === "function") geoFetch();
    // Rapport heeft een eigen periode en haalt zelf op wat de gekozen blokken
    // nodig hebben; hier alleen de configurator tekenen.
    if (window.__report) (page === "report" ? window.__report.open() : window.__report.close());
    // Bronnen leest alleen wat de app al weet; geen eigen fetch.
    if (page === "bronnen") renderBronnen();
  }

  // Spring vanuit de Analyse naar een specifieke advertentie in de Library: filter op
  // Meta Ads, render, scroll naar de rij/kaart en licht 'm even op.
  function goToAd(adId) {
    state.libraryFilter = "ads";
    switchPage("library");
    if (typeof renderLibrary === "function") renderLibrary();
    setTimeout(() => {
      const sel = (window.CSS && CSS.escape) ? CSS.escape(adId) : adId;
      const el = document.querySelector(`#page-library [data-post="${sel}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.style.transition = "background-color .4s";
      const orig = el.style.backgroundColor;
      el.style.backgroundColor = "var(--accent-10)"; // accent-tint, werkt op tr én card
      setTimeout(() => { el.style.backgroundColor = orig; }, 2200);
    }, 120);
  }
  window.__goToAd = goToAd;

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
        state.emailKey = null; // e-mail-cache verloopt bij periode-wissel
        if (state.page === "email") refreshEmail();
        state.websiteKey = null;
        if (state.page === "website") websiteFetch();
        if (window.__report) window.__report.periodChanged();
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

  // Aparte classifier voor Meta Ads — paid heeft andere dynamiek dan organic, dus niet de
  // engagement/save/watch-formule. AUTOMATISCH: heeft de ads-set conversies (purchases > 0)
  // → scoor op ROAS (return on ad spend); anders op efficiëntie (CTR/CPM). Eén bucket (ads
  // vs ads), ratio t.o.v. de mediaan, met dezelfde thresholds/minBucketSize als de organic-
  // classifier (PERFORMANCE_CONFIG → één source of truth). Zet performance/perfRatio/
  // perfBucket/perfBasis in-place; degradeert veilig naar n/a als er te weinig of geen data is.
  function classifyAdsPerformance(ads) {
    const list = (ads || []).filter(a => a && a.platform === "ads");
    if (!list.length) return ads;
    const { thresholds, minBucketSize } = PERFORMANCE_CONFIG;

    const hasConversions = list.some(a => (a.purchases || 0) > 0);
    const basis = hasConversions ? "ROAS" : "Efficiëntie (CTR/CPM)";
    const rawScore = (a) => {
      if (hasConversions) return a.roas != null ? a.roas : 0; // spend zonder return → 0 = zwak
      return (a.cpm > 0) ? (a.ctr || 0) / a.cpm : 0;          // hoge CTR + lage CPM = efficiënt
    };

    const scored = list.map(a => ({ a, score: rawScore(a) }));
    const med = median(scored.map(s => s.score).filter(v => v > 0));
    const tooSmall = list.length < minBucketSize;
    for (const s of scored) {
      s.a.perfScore = +s.score.toFixed(3);
      s.a.perfBucket = `Meta Ads · ${basis}`;
      s.a.perfBasis = basis;
      if (tooSmall || !med) { s.a.performance = null; s.a.perfRatio = null; continue; }
      const ratio = s.score / med;
      s.a.perfRatio = +ratio.toFixed(2);
      s.a.performance = ratio >= thresholds.good ? "Good" : (ratio < thresholds.bad ? "Bad" : "Average");
    }
    return ads;
  }

  function transformDashboard(raw, adsCampaignsRaw) {
    const igPosts = arrayOrEmpty(raw.posts?.igPosts).map(p => normalizePost(p, "ig", "Post"));
    const igReels = arrayOrEmpty(raw.posts?.igReels).map(p => normalizePost(p, "ig", "Reel"));
    const fbPosts = arrayOrEmpty(raw.posts?.fbPosts).map(p => normalizePost(p, "fb", "Post"));
    const ads = arrayOrEmpty(adsCampaignsRaw).map(c => normalizePost(c, "ads", "Campagne"));

    const allPosts = [...igPosts, ...igReels, ...fbPosts].filter(Boolean);
    classifyPerformance(allPosts); // zet post.performance in-place (Blok A)
    const adsCampaigns = ads.filter(Boolean);
    classifyAdsPerformance(adsCampaigns); // paid-classifier (ROAS of CTR/CPM, automatisch)

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
        { label: "Instagram", values: trendIG },
        { label: "Facebook", values: trendFB },
        { label: "Meta Ads", values: trendAds },
      ],
    };

    // Channel mix — independent of week-bucketing. Real period totals.
    const igReach = [...igPosts, ...igReels].filter(Boolean).reduce((s, p) => s + (p.reach || 0), 0);
    const fbReach = fbPosts.filter(Boolean).reduce((s, p) => s + (p.reach || 0), 0);
    const adsReach = adsReachCur; // reuse from KPI calc above
    const totalChannelReach = igReach + fbReach + adsReach || 1;
    const channels = [
      { label: "Instagram", color: "var(--accent-100)", value: Math.round((igReach / totalChannelReach) * 100) },
      { label: "Facebook",  color: "var(--chart-3)", value: Math.round((fbReach / totalChannelReach) * 100) },
      { label: "Meta Ads",  color: "var(--chart-4)", value: Math.round((adsReach / totalChannelReach) * 100) },
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

  // Facebook Organic pagina-post → post-shape. reach = post_impressions_unique, reacties/comments/
  // shares uit de geverifieerde FB-organic velden. FB heeft geen "saves".
  function normalizeWindsorFbPost(raw) {
    if (!raw || typeof raw !== "object") return null;
    const date = raw.post_created_time ? new Date(raw.post_created_time) : null;
    const reach = Number(raw.post_impressions_unique) || 0;
    const impressions = Number(raw.post_impressions) || 0;
    const likes = Number(raw.post_reactions_total) || 0;   // alle reacties (like/love/…)
    const comments = Number(raw.post_comments_total) || 0;
    const shares = Number(raw.post_activity_by_action_type_share) || 0;
    const views = Number(raw.post_video_views) || 0;
    const interactions = likes + comments + shares;
    const engagement = reach ? (interactions / reach) * 100 : 0;
    const captionRaw = typeof raw.post_message === "string" ? raw.post_message : "";
    const caption = captionRaw ? captionRaw.replace(/\s+/g, " ").trim() : "—";
    const type = friendlyType(raw.type || raw.media_type, "Post");
    return {
      id: String(raw.post_id || `fb-${raw.post_created_time || Math.random()}`),
      platform: "fb",
      type,
      date,
      dateLabel: date ? fmt.dateNL(date) : "—",
      startMs: 0, stopMs: 0,
      reach, impressions, likes, comments, shares, saves: 0,
      clicks: 0, views,
      interactions, engagement, ctr: 0,
      avgWatchTime: 0,
      caption,
      thumb: typeof raw.full_picture === "string" ? raw.full_picture : "",
      url: typeof raw.permalink_url === "string" ? raw.permalink_url : "",
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
      // Conversies — voor ROAS (waarde) en CAC (aantal). 0 als de klant niet trackt.
      purchases:     numFromAction(raw.actions_purchase) + numFromAction(raw.actions_omni_purchase),
      purchaseValue: numFromAction(raw.action_values_purchase) + numFromAction(raw.action_values_omni_purchase),
      leads:         numFromAction(raw.actions_lead),
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
        purchases: 0, purchaseValue: 0, leads: 0,
      });
      g.reach += r.reach || 0;
      g.impressions += r.impressions || 0;
      g.clicks += r.clicks || 0;
      g.spend += r.spend || 0;
      g.likes += r.likes || 0; g.comments += r.comments || 0;
      g.shares += r.shares || 0; g.saves += r.saves || 0;
      g.vp25 += r.vp25 || 0; g.vp50 += r.vp50 || 0; g.vp75 += r.vp75 || 0;
      g.vp95 += r.vp95 || 0; g.vp100 += r.vp100 || 0; g.vplays += r.vplays || 0;
      g.purchases += r.purchases || 0; g.purchaseValue += r.purchaseValue || 0; g.leads += r.leads || 0;
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
      const cpm = g.impressions ? (g.spend / g.impressions) * 1000 : 0;
      const interactions = g.likes + g.comments + g.shares + g.saves;
      const engagement = g.reach ? (interactions / g.reach) * 100 : 0;
      // Paid-conversiemetrics. CAC = spend / #acquisities (purchases indien aanwezig, anders
      // leads — "automatisch"). ROAS = aankoopwaarde / spend. null als er geen conversiedata is.
      const conversions = g.purchases > 0 ? g.purchases : g.leads;
      const cac = (g.spend > 0 && conversions > 0) ? g.spend / conversions : null;
      const roas = (g.spend > 0 && g.purchaseValue > 0) ? g.purchaseValue / g.spend : null;
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
        interactions, engagement, ctr, cpm,
        avgWatchTime: 0, spend: g.spend,
        // Paid-conversiemetrics (null = geen data → UI toont "—").
        purchases: g.purchases, purchaseValue: g.purchaseValue, leads: g.leads,
        cac, roas, conversions: conversions || 0,
        retention,
        caption: g.name, thumb: g.thumb, url: "",
      };
    });
  }

  function transformWindsorDashboard(raw) {
    const igPostsRaw = arrayOrEmpty(raw.instagram?.data);
    const fbOrgRaw = arrayOrEmpty(raw.fbOrganic?.data); // Facebook organic pagina-posts
    const adsRowsRaw = arrayOrEmpty(raw.ads?.data);    // campagne-niveau (reach voor trend/KPI)
    const adsAdRaw = arrayOrEmpty(raw.adsAd?.data);    // ad-niveau (per advertentie, indien gelukt)

    const igPosts = igPostsRaw.map(normalizeWindsorIgPost).filter(Boolean);
    const fbPosts = fbOrgRaw.map(normalizeWindsorFbPost).filter(Boolean);
    const adsRows = adsRowsRaw.map(normalizeWindsorAdRow).filter(Boolean);
    const adsAdRows = adsAdRaw.map(normalizeWindsorAdRow).filter(Boolean);

    const allPosts = [...igPosts, ...fbPosts]; // IG + FB organic
    classifyPerformance(allPosts); // zet post.performance in-place (Blok A)
    // Library: per advertentie zodra de ad-level fetch rijen gaf; anders fallback per campagne.
    const adsCampaigns = aggregateWindsorAds(adsAdRows.length ? adsAdRows : adsRows);
    classifyAdsPerformance(adsCampaigns); // paid-classifier (ROAS of CTR/CPM, automatisch)

    const curAgg = aggregatePosts(allPosts);
    const adsReachCur = adsRows.reduce((s, r) => s + (r.reach || 0), 0);
    const adsClicksCur = adsRows.reduce((s, r) => s + (r.clicks || 0), 0);

    const erCur = curAgg.reach ? (curAgg.interactions / curAgg.reach) * 100 : 0;

    // VERGELIJKINGSPERIODE — getDashboard stuurt hem mee sinds de datasheet ook
    // de vorige periode kan leveren. Kwam er niets terug (API-klant met een
    // trage connector, of een sheet die niet zo ver terugloopt), dan blijft het
    // null en zegt de kaart 'geen vergelijkbare vorige periode' — nooit nul.
    const prev = raw.previous || {};
    const prevIg = arrayOrEmpty(prev.instagram?.data).map(normalizeWindsorIgPost).filter(Boolean);
    const prevFb = arrayOrEmpty(prev.fbOrganic?.data).map(normalizeWindsorFbPost).filter(Boolean);
    const prevAdsRows = arrayOrEmpty(prev.ads?.data).map(normalizeWindsorAdRow).filter(Boolean);
    const heeftVergelijking = prevIg.length || prevFb.length || prevAdsRows.length;
    const prvAgg = heeftVergelijking ? aggregatePosts([...prevIg, ...prevFb]) : null;
    const adsReachPrv = prevAdsRows.reduce((s, r) => s + (r.reach || 0), 0);
    const adsClicksPrv = prevAdsRows.reduce((s, r) => s + (r.clicks || 0), 0);
    const erPrv = prvAgg && prvAgg.reach ? (prvAgg.interactions / prvAgg.reach) * 100 : null;

    const kpis = [
      buildKpi("Totale reach", curAgg.reach + adsReachCur,
        prvAgg ? prvAgg.reach + adsReachPrv : null, fmt.k, "pct"),
      buildKpi("Engagement rate", erCur, erPrv, (n) => fmt.pct(n), "pp"),
      buildKpi("Posts gepubliceerd", curAgg.count, prvAgg ? prvAgg.count : null, (n) => String(n), "pct"),
      buildKpi("Clicks", curAgg.clicks + adsClicksCur,
        prvAgg ? prvAgg.clicks + adsClicksPrv : null, fmt.k, "pct"),
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
    const trendFB = trendWeeks.map(w => sumPostsField(fbPosts, w, "reach"));
    const trendAds = trendWeeks.map(w => sumAdsRowsInWeek(adsRows, w));
    const timeseries = {
      weeks: trendWeeks.map((w, i) => `wk ${i + 1}`),
      series: [
        { label: "Instagram", values: trendIG },
        { label: "Facebook", values: trendFB },
        { label: "Meta Ads", values: trendAds },
      ],
    };

    // Channel mix
    const igReach = trendIG.reduce((s, v) => s + v, 0);
    const fbReach = fbPosts.reduce((s, p) => s + (p.reach || 0), 0);
    const adsReach = adsReachCur;
    const totalChannelReach = igReach + fbReach + adsReach || 1;
    const channels = [
      { label: "Instagram", color: "var(--accent-100)", value: Math.round((igReach / totalChannelReach) * 100) },
      { label: "Facebook",  color: "var(--chart-3)", value: Math.round((fbReach / totalChannelReach) * 100) },
      { label: "Meta Ads",  color: "var(--chart-4)", value: Math.round((adsReach / totalChannelReach) * 100) },
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
      adLevelWindow: raw.adLevelWindow || null, // venster dat de ad-detail dekt (Hobby-cap)
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

  // §4 van de design-system-briefing: een KPI-tegel zonder vergelijking mag niet.
  // Een kaal getal is niet te beoordelen — de lezer vult dan zelf een referentie in.
  // Daarom onderscheiden we vier toestanden in plaats van 'delta of streepje':
  //
  //   delta  vorige periode > 0  → pijl + percentage, semantische kleur
  //   flat   niets veranderd     → ±0% in neutraal grijs, nooit groen
  //   new    vorige was 0, nu >0 → 'nieuw'; groei vanaf nul is geen percentage
  //   empty  beide periodes 0    → 'geen activiteit'; er ís gemeten, er was niets
  //   none   geen vorige periode → 'geen vergelijking', met reden in de voetnoot
  //
  // `delta` en `direction` houden hun oude betekenis, zodat buildAnalysisSummary
  // en de analyse-agent ongewijzigd blijven werken.
  function buildKpi(label, current, previous, formatter, deltaUnit) {
    let state = "none";
    let delta = null;

    if (previous != null && previous > 0) {
      delta = deltaUnit === "pp" ? (current - previous) : ((current - previous) / previous) * 100;
      state = Math.abs(delta) < 0.05 ? "flat" : "delta";
    } else if (previous === 0) {
      // Vorige periode is gemeten en was nul — dat is iets anders dan geen data.
      state = current > 0 ? "new" : "empty";
    }

    return {
      label,
      value: formatter(current),
      delta: delta != null ? Math.abs(delta) : null,
      direction: delta == null ? null : (delta >= 0 ? "up" : "down"),
      state,
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
    // Neutrale, palette-gestuurde thumbnail-fallbacks (var() werkt in style-attribuut).
    // Decoratie, geen data: daarom accenttinten en geen chartkleuren. Kleur hoort
    // in dit systeem betekenis te dragen — een thumbnail-fallback draagt er geen.
    const palette = [
      "linear-gradient(135deg, var(--accent-25), var(--accent-50))",
      "linear-gradient(135deg, var(--accent-50), var(--accent-25))",
      "linear-gradient(135deg, var(--accent-10), var(--accent-50))",
      "linear-gradient(135deg, var(--accent-50), var(--accent-75))",
      "linear-gradient(135deg, var(--accent-25), var(--accent-75))",
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
    // Uniforme renderer (charts.js) i.p.v. hand-gerolde SVG.
    return window.Charts ? Charts.sparkline(values, color) : "";
  }

  function renderOverview() {
    renderReportHead();
    renderDatastamp();
    renderKpis();
    renderTrendChart();
    renderCallouts();
    renderChannelMix();
    renderTopPosts();
    renderCadence();
    renderAdsTable();
    renderLibrary();
  }


  /* ==========================================================
     Bronnen — welke data dit dashboard gebruikt
     ==========================================================
     Deze pagina doet géén eigen fetch: hij leest wat de app al in handen heeft.
     Dat heeft één gevolg dat expliciet moet zijn: een tab die je nog niet hebt
     geopend, is 'nog niet opgehaald' — niet 'niet geconfigureerd'. Onbekend is
     iets anders dan afwezig, en dat verschil bepaalt of je gaat zoeken.

     Er staan bewust geen id's in beeld. Eén service-account en één DataForSEO-
     sleutel bedienen álle klanten, dus een sheet- of map-id op het scherm is een
     risico en geen hulpmiddel.
     ========================================================== */

  const BRON_TABS = [
    { key: "bronnen", label: "Bronnen" },
    { key: "dekking", label: "Dekking" },
    { key: "toegang", label: "Toegang" },
  ];

  window.__bronTab = (k) => { state.bronnenTab = k; renderBronnen(); };

  function bronKaart(o) {
    const led = o.staat === "ok" ? "fresh" : (o.staat === "wacht" ? "aging" : "stale");
    const rijen = (o.rijen || []).map(([k, v]) =>
      `<div style="display:flex; justify-content:space-between; gap:14px; padding:6px 0;
        border-top:1px solid var(--border); font-size:12px; line-height:1.5;">
        <span style="color:var(--fg-muted); flex:none;">${escapeHtml(k)}</span>
        <span style="text-align:right;">${v}</span>
      </div>`).join("");
    return `<div class="kpi-card" style="gap:0;">
      <div style="display:flex; align-items:center; gap:9px; margin-bottom:4px;">
        <span class="led ${led}" aria-hidden="true" style="width:8px; height:8px; border-radius:50%;
          background:var(${o.staat === "ok" ? "--positive" : o.staat === "wacht" ? "--warning" : "--negative"});"></span>
        <span style="font-size:14px; font-weight:600;">${escapeHtml(o.naam)}</span>
      </div>
      <p style="margin:0 0 12px 17px; font-size:11.5px; color:var(--fg-muted); line-height:1.5;">${escapeHtml(o.rol)}</p>
      ${rijen}
      <p style="margin:13px 0 0; padding-top:11px; border-top:1px solid var(--border);
        font-size:11.5px; color:var(--fg-muted); line-height:1.55;">
        <b style="color:var(--fg); font-weight:600;">Niet:</b> ${escapeHtml(o.niet)}</p>
    </div>`;
  }

  function renderBronnen() {
    const root = $("#bronnen-content");
    if (!root) return;
    const tab = state.bronnenTab || "bronnen";
    const s = state.session || {};
    const w = state.website, r = state.roas;
    const nogNiet = `<span style="color:var(--fg-muted);">nog niet opgehaald</span>`;

    const kaarten = [];

    kaarten.push(bronKaart({
      naam: "Windsor.ai — live", staat: s.hasWindsor ? "ok" : "uit",
      rol: "Advertentie- en kanaaldata rechtstreeks uit de API",
      rijen: [
        ["Voedt", "Overzicht, ROAS"],
        ["Periode", escapeHtml(periodLabel() || "—")],
        ["Advertenties", state.overview ? (state.overview.adsLoading ? "laden…" : `${(state.overview.adsCampaigns || []).length} campagnes`) : nogNiet],
      ],
      niet: "advertenties per stuk over meer dan 35 dagen — Meta loopt dan vast.",
    }));

    const ds = w?.dataSheet;
    kaarten.push(bronKaart({
      naam: "Windsor-datasheet", staat: !w ? "wacht" : (ds?.used ? "ok" : (ds?.configured ? "wacht" : "uit")),
      rol: "Nachtelijke export, per tabblad gelezen",
      rijen: [
        ["Voedt", "Website: kanalen, bronnen, dagreeks"],
        ["Ingesteld", !w ? nogNiet : (ds?.configured ? "ja" : "nee, alles gaat live")],
        ["Gebruikt", !w ? nogNiet : (ds?.used ? "ja, voor deze periode" : "nee — zie Dekking")],
      ],
      niet: "unieke gebruikers — die zijn niet over dagen op te tellen.",
    }));

    const dc = state.driveContext;
    kaarten.push(bronKaart({
      naam: "Google Drive — kennisbank", staat: s.hasDrive ? (dc ? "ok" : "wacht") : "uit",
      rol: "Merkcontext en ruwe bestanden voor de AI",
      rijen: [
        ["Voedt", "AI-analyse en de chat"],
        ["Gekoppeld", s.hasDrive ? "ja" : "nee"],
        ["Bestanden", dc ? `${(dc.files || []).length} in het geheugen` : nogNiet],
      ],
      niet: "cijfers voor het dashboard — alleen context voor de agents.",
    }));

    const brand = s.brand;
    kaarten.push(bronKaart({
      naam: "Klantsheet", staat: brand ? "ok" : "wacht",
      rol: "Instellingen die het dashboard vormgeven",
      rijen: [
        ["Config", brand ? "merkkleur, logo, account-id's, drempels" : nogNiet],
        ["Merkkleur", brand?.accent ? `<span style="display:inline-block; width:10px; height:10px; border-radius:3px;
            background:var(--accent); vertical-align:middle;"></span> uit de Config-tab` : "standaard"],
        ["Merknaam", escapeHtml(s.brandName || "—")],
      ],
      niet: "meetdata — geen enkel cijfer op het scherm komt hieruit.",
    }));

    const seoAan = state.seo || state.seoSettings;
    kaarten.push(bronKaart({
      naam: "DataForSEO", staat: state.seoError || state.geoSourcesError ? "uit" : (seoAan ? "ok" : "wacht"),
      rol: "Zoekvolumes, posities en AI-vermeldingen",
      rijen: [
        ["Voedt", "SEO, en Sources in GEO"],
        ["Keywords", state.seo ? `${(state.seo.items || []).length} met data` : nogNiet],
        ["Posities", state.seoRanks ? "opgehaald" : "alleen op knopdruk"],
      ],
      niet: "automatisch verversen — elke positiecheck kost geld.",
    }));

    const an = Object.keys(state.analysisCache || {}).length;
    kaarten.push(bronKaart({
      naam: "De twee AI-agents", staat: "ok",
      rol: "Analyse eenmalig, chat eenmalig, geen gereedschap",
      rijen: [
        ["Analyse", an ? `${an} periode${an === 1 ? "" : "s"} in het geheugen` : "nog niet gedraaid"],
        ["Chat", `${(state.chatMessages || []).length} berichten deze sessie`],
        ["Context", "het samengevatte dashboard plus de Drive-context"],
      ],
      niet: "zelf data ophalen — ze zien alleen wat wij meesturen.",
    }));

    root.innerHTML = subtabBar(BRON_TABS, tab, "__bronTab", datastampHtml(state.period?.end, "Periode t/m"))
      + `<div class="report-head">
          <p class="eyebrow">Databronnen · ${escapeHtml(new Date().toLocaleString("nl-NL", { dateStyle: "long", timeStyle: "short" }))}</p>
          <h2 class="report-title">Elk cijfer op dit dashboard komt uit <b>één van deze zes bronnen</b></h2>
          <p class="report-lede">Wat elke bron voedt, hoe vers hij is, en waarvoor hij níet dient. Deze pagina leest
          alleen wat de app al heeft: een tab die je nog niet opende staat op <i>nog niet opgehaald</i> — dat is iets
          anders dan niet geconfigureerd.</p>
        </div>`
      + subpane("bronnen", tab,
          `<div class="bron-grid">${kaarten.join("")}</div>` + renderBronnenConnectors())
      + subpane("dekking", tab, renderBronnenDekking())
      + subpane("toegang", tab, renderBronnenToegang());
  }

  function renderBronnenConnectors() {
    const r = state.roas;
    const ov = state.overview;
    const rijen = [];
    const rij = (conn, waarvoor, account, laatste, kleur, staat) => rijen.push(`<tr>
      <td style="font-family:var(--font-mono); font-size:11.5px;">${escapeHtml(conn)}</td>
      <td>${escapeHtml(waarvoor)}</td>
      <td style="color:var(--fg-muted);">${escapeHtml(account)}</td>
      <td>${escapeHtml(laatste)}</td>
      <td><span style="color:${kleur}; font-weight:600;">${escapeHtml(staat)}</span></td>
    </tr>`);

    // Alleen de laatste vier tekens van een account: genoeg om te herkennen,
    // te weinig om ergens anders te gebruiken.
    const mask = (v) => {
      const t = String(v || "");
      return t.length > 4 ? "••••" + t.slice(-4) : (t || "—");
    };

    if (ov) {
      rij("instagram", "Instagram organiek", "uit de Config-tab",
        state.period?.end || "—", "var(--positive)", "gekoppeld");
      const camps = (ov.adsCampaigns || []).length;
      rij("facebook", "Meta Ads", "uit de Config-tab", state.period?.end || "—",
        camps ? "var(--positive)" : "var(--warning)", camps ? "gekoppeld" : "geen campagnes");
    }
    if (r && r.channels && r.current) {
      for (const c of r.channels) {
        const d = (r.current.channels || {})[c.key] || {};
        const heeftSpend = (d.spend || 0) > 0;
        const geenOmzet = d.platformRevenueAvailable === false && d.ga4Available === false;
        rij(c.key, c.label, heeftSpend ? mask(d.accountId) : "—",
          heeftSpend ? (state.period?.end || "—") : "—",
          !heeftSpend ? "var(--fg-muted)" : (geenOmzet ? "var(--warning)" : "var(--positive)"),
          !heeftSpend ? "niet geconfigureerd" : (geenOmzet ? "geen omzetveld" : "gekoppeld"));
      }
    }
    if (!rijen.length) {
      return `<p class="source-line" style="margin-top:22px;">Open eerst het Overzicht of de ROAS-tab; deze pagina leest
        wat die tabs hebben opgehaald en verzint niets bij.</p>`;
    }
    return `<div class="report-table">
      <table>
        <thead><tr><th>Connector</th><th>Waarvoor</th><th>Account</th><th>Laatste data</th><th>Status</th></tr></thead>
        <tbody>${rijen.join("")}</tbody>
      </table>
    </div>
    <p class="source-line">Een kanaal verschijnt zodra er een account-id voor in de Config-tab staat. Van een account
    staan alleen de laatste vier tekens in beeld.</p>`;
  }

  function renderBronnenDekking() {
    const w = state.website;
    if (!w) {
      return `<p class="source-line">Open eerst de Website-tab: de dekkingscontrole gebeurt daar, per tabblad van de datasheet.</p>`;
    }
    const cov = w.current?.sheetCoverage || {};
    const labels = {
      ga4Daily: "Google Analytics 4 — dag", ga4Channel: "GA4 — kanalen",
      ga4Landing: "GA4 — landingspagina's", gscDaily: "Search Console — dag",
      gscQuery: "Search Console — zoekopdrachten",
    };
    const blokken = Object.entries(labels).map(([k, label]) => {
      const c = cov[k];
      if (!c) return "";
      const pct = (c.days != null && c.expected) ? Math.round((c.days / c.expected) * 100) : (c.ok ? 100 : 0);
      const tekst = c.ok
        ? `${c.days != null ? `${c.days} van de ${c.expected} dagen` : "volledig"} · ${c.rows != null ? `${c.rows} rijen` : ""}`
        : escapeHtml(c.reason || "niet gebruikt");
      return `<div style="margin-bottom:14px;">
        <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px;">
          <span style="font-size:12.5px; font-weight:600;">${escapeHtml(label)}</span>
          <span style="font-size:11.5px; color:var(--fg-muted);">${tekst}</span>
        </div>
        <div style="display:flex; height:14px; border-radius:4px; overflow:hidden; gap:1px; background:var(--surface-strong);">
          <span style="width:${pct}%; background:var(--s2);"></span>
          ${pct < 100 ? `<span style="flex-grow:1; background:var(--negative-bg);"></span>` : ""}
        </div>
      </div>`;
    }).join("");

    return `<div class="report-split">
      <div>
        <p class="eyebrow">Dekking</p>
        <h2 class="report-title" style="font-size:25px;">Niet alleen begin en eind — <b>ook de gaten ertussen</b></h2>
        <div class="chart-tub" style="margin-top:18px; padding-bottom:8px;">${blokken || `<p class="source-line" style="margin:0;">Geen datasheet ingesteld voor deze klant.</p>`}</div>
        <p class="source-line">Een lopende backfill levert losse dagen over een jaar: eerste en laatste dag zien er dan
        goed uit terwijl de helft ontbreekt, en het totaal zou stilzwijgend te laag worden. Daarom wordt dag per dag geteld,
        met een marge per bron — GA4 twee dagen, Search Console vier.</p>
      </div>
      <div class="callouts">
        ${callout("info", "↗", "Waarom dit bestaat",
          `Een sheet-tab lezen duurt 0,3 tot 2,3 seconden; een koude API-aanroep over 90 dagen bijna 18 seconden met
           13 tot 21 aanroepen. De sheet wordt alleen gebruikt als hij de hele periode dekt.`)}
        ${callout("watch", "!", "Deel een datasheet nooit met een klant",
          `Windsor schrijft mislukte runs inclusief de volledige aanroep-URL naar de Queries-tab, mét API-sleutel.
           Die sleutel is gedeeld over meerdere klanten.`)}
      </div>
    </div>`;
  }

  function renderBronnenToegang() {
    const s = state.session || {};
    const ses = s.ts ? new Date(Number(s.ts)) : null;
    const verloopt = ses ? new Date(ses.getTime() + 10 * 3600 * 1000) : null;
    return `<div class="report-split">
      <div>
        <p class="eyebrow">Toegang</p>
        <h2 class="report-title" style="font-size:25px;">Wie dit dashboard ziet, en <b>hoe lang</b></h2>
        <div class="report-table" style="margin-top:18px;">
          <table><tbody>
            <tr><td>Klant</td><td>${escapeHtml(s.brandName || "—")}</td></tr>
            <tr><td>Klantcode</td><td>${escapeHtml(s.clientId || "—")}</td></tr>
            <tr><td>Sessie verloopt</td><td>${verloopt ? escapeHtml(verloopt.toLocaleString("nl-NL", { dateStyle: "short", timeStyle: "short" })) : "binnen 10 uur"}</td></tr>
            <tr><td>Windsor gekoppeld</td><td>${s.hasWindsor ? "ja" : "nee"}</td></tr>
            <tr><td>Metricool gekoppeld</td><td>${s.hasMetricool ? "ja" : "nee"}</td></tr>
            <tr><td>Drive gekoppeld</td><td>${s.hasDrive ? "ja" : "nee"}</td></tr>
          </tbody></table>
        </div>
      </div>
      <div class="callouts">
        ${callout("watch", "!", "Wat hier bewust niet staat",
          `Geen sheet-id's, map-id's of sleutels. Eén service-account en één API-sleutel bedienen álle klanten,
           dus een id op het scherm is een risico en geen hulpmiddel.`)}
        ${callout("info", "↗", "Hoe de sessie werkt",
          `Inloggen levert een token dat tien uur geldig is en aan deze klantcode vastzit. Het staat in
           <b>sessionStorage</b>, dus een nieuw tabblad vraagt opnieuw om inloggen.`)}
      </div>
    </div>`;
  }

  /* ---------- Rapportkop, stempel en callouts ----------
     De kop is een bewering, dus die wordt uit de cijfers afgeleid en niet uit een
     vaste tekst. Datzelfde geldt voor de callouts: ze staan op berekende feiten
     (grootste beweger, ontbrekende vergelijking, het advertentievenster), niet op
     een LLM-tekst. De analyse-agent kan ze later vullen; dan komt er per callout
     een bron bij te staan.
     ---------------------------------------------------------------------- */

  function periodLabel() {
    const p = state.period || {};
    if (!p.start || !p.end) return "";
    const d = (iso) => {
      const [y, m, dd] = iso.split("-").map(Number);
      const maand = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"][m - 1];
      return `${dd} ${maand}`;
    };
    return `${d(p.start)} – ${d(p.end)} ${p.end.slice(0, 4)}`;
  }

  // Organisch = IG + FB, betaald = Meta Ads. Eerste helft van de reeks tegen de
  // tweede: dat is de enige vergelijking die binnen één periode eerlijk is.
  function trendSplit() {
    const ts = state.overview?.timeseries;
    if (!ts || !ts.series?.length) return null;
    const som = (label) => ts.series.find(x => x.label === label)?.values || [];
    const org = ts.weeks.map((_, i) => (som("Instagram")[i] || 0) + (som("Facebook")[i] || 0));
    const paid = ts.weeks.map((_, i) => som("Meta Ads")[i] || 0);
    // Gemiddelde per week, niet de som: bij een oneven aantal weken zit er één
    // week meer in de tweede helft, en dan toont een vlakke reeks +17%.
    const helften = (arr) => {
      const mid = Math.floor(arr.length / 2);
      if (mid < 1) return null;
      const gem = (xs) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0);
      return { a: gem(arr.slice(0, mid)), b: gem(arr.slice(mid)) };
    };
    // Een percentage op een bijna-nul basis is geen cijfer maar een artefact:
    // een campagne die halverwege start geeft +2194% en dat zegt niets. Onder de
    // drempel geven we daarom geen groeipercentage terug, maar de vlag 'gestart'.
    // Boven een verviervoudiging zegt een percentage niets meer: +1866% klinkt
    // precies maar betekent 'begon bijna op nul'. Onder een vijfde van de tweede
    // helft geven we daarom een aandeel in plaats van groei.
    const groei = (h) => {
      if (!h) return { pct: null, gestart: false };
      if (!h.a || h.a < h.b * 0.2) return { pct: null, gestart: h.b > 0 };
      return { pct: (h.b - h.a) / h.a, gestart: false };
    };
    const ho = helften(org), hp = helften(paid);
    return {
      org: groei(ho), paid: groei(hp),
      orgTotaal: org.reduce((a, b) => a + b, 0),
      paidTotaal: paid.reduce((a, b) => a + b, 0),
    };
  }

  // Koppen krijgen hele procenten: één decimaal suggereert een precisie die een
  // weekbundeling niet heeft.
  function pctKop(v) {
    if (v == null) return null;
    // Meer dan verdubbeld: dan is een factor leesbaarder dan een percentage.
    if (v >= 1) return (1 + v).toFixed(1).replace(".", ",") + "× zo hoog";
    return (v >= 0 ? "+" : "−") + Math.abs(Math.round(v * 100)) + "%";
  }

  // 'daalt met −7%' leest als een dubbele ontkenning; na een werkwoord dat de
  // richting al zegt hoort het getal zonder teken.
  function pctAbs(v) {
    if (v == null) return null;
    return Math.abs(Math.round(v * 100)) + "%";
  }

  function renderReportHead() {
    const eyebrow = $("#ov-eyebrow"), kop = $("#ov-conclusion"), lede = $("#ov-lede");
    if (!kop) return;
    const per = periodLabel();
    if (eyebrow) eyebrow.textContent = `Instagram, Facebook & Meta Ads${per ? ` · ${per}` : ""}`;

    if (state.overviewLoading) { kop.textContent = "Cijfers worden opgehaald…"; if (lede) lede.textContent = ""; return; }
    if (state.overviewError || !state.overview) {
      kop.textContent = "De cijfers van deze periode zijn niet opgehaald";
      if (lede) lede.textContent = state.overviewError || "";
      return;
    }

    const t = trendSplit();
    let tekst = "Bereik en betrokkenheid over deze periode";
    if (t) {
      const vlak = (v) => v != null && Math.abs(v) < 0.05;
      const totaal = t.orgTotaal + t.paidTotaal;
      const deelBetaald = totaal ? Math.round((t.paidTotaal / totaal) * 100) : 0;

      if (t.paid.gestart) {
        // Betaald kwam er halverwege bij: dan is een aandeel eerlijker dan groei.
        tekst = `Betaald bereik kwam er halverwege bij en <b>levert nu ${deelBetaald}% van het totaal</b>`;
      } else if (t.paid.pct != null && vlak(t.org.pct)) {
        tekst = `Betaald bereik ${t.paid.pct >= 0 ? "groeit" : "daalt"} met ${pctAbs(t.paid.pct)}, <b>organisch staat vlak</b>`;
      } else if (t.paid.pct != null && t.org.pct != null) {
        const sterkste = t.paid.pct >= t.org.pct ? "betaald" : "organisch";
        tekst = `Organisch ${pctKop(t.org.pct)}, betaald ${pctKop(t.paid.pct)} — <b>${sterkste} trekt de periode</b>`;
      } else if (t.org.pct != null) {
        tekst = `Organisch bereik ${t.org.pct >= 0 ? "stijgt" : "daalt"} met <b>${pctAbs(t.org.pct)}</b> in de tweede helft`;
      } else if (totaal) {
        tekst = `<b>${fmt.k(totaal)} bereik</b> in deze periode, waarvan ${deelBetaald}% betaald`;
      }
    }
    kop.innerHTML = tekst;
    if (lede) {
      lede.textContent = "Reach per week, per kanaal. De tweede helft van de periode tegen de eerste — "
        + "dat is de enige vergelijking die binnen één periode klopt.";
    }
  }

  function renderDatastamp() {
    const el = $("#ov-stamp");
    if (!el) return;
    const eind = state.period?.end;
    if (!eind || state.overviewLoading || !state.overview) { el.hidden = true; return; }
    const dagen = Math.max(0, Math.round((Date.now() - new Date(eind + "T12:00:00").getTime()) / 86400000));
    const led = dagen <= 1 ? "fresh" : (dagen <= 7 ? "aging" : "stale");
    const hoeOud = dagen === 0 ? "vandaag bijgewerkt" : (dagen === 1 ? "gisteren bijgewerkt" : `${dagen} dagen oud`);
    el.hidden = false;
    el.innerHTML = `<span class="led ${led}" aria-hidden="true"></span>`
      + `<span><b>Data t/m ${escapeHtml(eind.split("-").reverse().join("-"))}</b> — ${hoeOud}</span>`;
  }

  function callout(toon, glyph, titel, tekst, extra) {
    return `<div class="callout-card ${toon}">
      <div class="ct"><span class="glyph" aria-hidden="true">${glyph}</span>${escapeHtml(titel)}</div>
      <div>${tekst}</div>${extra || ""}
    </div>`;
  }

  function renderCallouts() {
    const root = $("#ov-callouts");
    if (!root) return;
    if (state.overviewLoading || !state.overview) { root.innerHTML = ""; return; }
    const ov = state.overview;
    const kaarten = [];

    // Wat werkt: de KPI met de sterkste stijging, of de grootste reeks.
    const stijgers = (ov.kpis || []).filter(k => k.state === "delta" && k.direction === "up");
    stijgers.sort((a, b) => (b.delta || 0) - (a.delta || 0));
    const t = trendSplit();
    if (stijgers.length) {
      const k = stijgers[0];
      kaarten.push(callout("good", "+", "Wat werkt",
        `<b>${escapeHtml(k.label)}</b> staat op ${escapeHtml(String(k.value))} — `
        + `${k.delta.toFixed(1).replace(".", ",")}${k.unit === "pp" ? "pp" : "%"} hoger dan ${escapeHtml(k.vs || "de vorige periode")}.`));
    } else if (t && t.paidTotaal) {
      const deel = Math.round((t.paidTotaal / (t.paidTotaal + t.orgTotaal)) * 100);
      kaarten.push(callout("good", "+", "Wat werkt",
        `Betaald levert <b>${deel}%</b> van het totale bereik in deze periode.`));
    }

    // Waar we op letten: de meetvoorbehouden die we kennen.
    const zonderVergelijking = (ov.kpis || []).filter(k => k.state === "none").length;
    const let_op = [];
    if (zonderVergelijking) {
      let_op.push(`<b>${zonderVergelijking} van de ${ov.kpis.length} cijfers</b> heeft geen vergelijkbare vorige periode, `
        + `dus daar staat geen verandering bij. Kies een kortere periode om wél te kunnen vergelijken.`);
    }
    if (ov.adsLoading) {
      let_op.push("De advertentiecijfers laden nog; de reeks Meta Ads kan nog veranderen.");
    }
    if (t && t.org.pct != null && t.org.pct < -0.05) {
      let_op.push(`Organisch bereik zakt met <b>${pctAbs(t.org.pct)}</b> in de tweede helft van de periode.`);
    }
    if (t && t.paid.gestart) {
      let_op.push(`Betaald bereik startte pas in de tweede helft van deze periode, dus een groeipercentage `
        + `zou hier een artefact zijn. Daarom staat er een aandeel.`);
    }
    if (let_op.length) {
      kaarten.push(callout("watch", "!", "Waar we op letten", let_op.join("<br><br>")));
    }

    // Wat je ziet: uitleg bij de grafiek ernaast.
    kaarten.push(callout("info", "↗", "Wat je ziet",
      `De grafiek bundelt per week, niet per dag — dagpieken vallen daarmee weg, de trend blijft. `
      + `Instagram en Facebook zijn organisch bereik, Meta Ads is betaald. Eén eenheid, dus één as.`));

    // De agent: dit was 'Insight van de week'.
    kaarten.push(callout("good", "✦", "Vraag het de agent",
      "Een doorgewinterde analyse van deze periode — inclusief de posts en campagnes die hierboven niet passen.",
      `<button class="btn primary" onclick="window.toggleChat()">Open de agent →</button>`));

    root.innerHTML = kaarten.join("")
      + `<p class="callout-foot">Reach van organisch en betaald mag je niet optellen: dezelfde persoon kan in beide zitten. `
      + `De kanaal-mix op het blad Publicaties toont het aandeel, niet de som.</p>`;
  }

  function renderAdsTable() {
    const root = $("#ads-table");
    const kop = $("#ads-conclusion");
    if (!root) return;
    const ov = state.overview;
    const camps = (ov?.adsCampaigns || []).filter(c => c && (c.spend || c.reach || c.impressions));
    if (!ov || state.overviewLoading) {
      root.innerHTML = `<div class="skel-line" style="height:200px; border-radius:14px;"></div>`;
      return;
    }
    if (!camps.length) {
      if (kop) kop.textContent = ov.adsLoading ? "Advertenties worden opgehaald…" : "Geen advertenties in deze periode";
      root.innerHTML = `<p class="source-line">${ov.adsLoading
        ? "De campagnes laden nog."
        : "Er liep geen Meta Ads-campagne in deze periode, of het advertentieaccount staat niet in de Config-tab."}</p>`;
      return;
    }
    const spend = camps.reduce((a, c) => a + (c.spend || 0), 0);
    const rev = camps.reduce((a, c) => a + (c.revenue || 0), 0);
    const metKosten = camps.filter(c => (c.spend || 0) > 0).length;
    if (kop) {
      kop.innerHTML = rev
        ? `€ ${fmt.int(Math.round(spend))} aan advertenties bracht <b>€ ${fmt.int(Math.round(rev))}</b> op`
        : `<b>${camps.length} campagnes</b> in deze periode, samen € ${fmt.int(Math.round(spend))}`;
    }
    camps.sort((a, b) => (b.spend || 0) - (a.spend || 0));
    const rijen = camps.slice(0, 12).map(c => {
      const roas = c.roas != null && c.spend > 0 ? c.roas : null;
      const oordeel = c.performance === "Good" ? `<span class="pos">sterk</span>`
        : (c.performance === "Bad" ? `<span class="neg">zwak</span>`
        : (c.performance ? "gemiddeld" : `<span style="color:var(--fg-muted);">te klein</span>`));
      return `<tr>
        <td>${escapeHtml(c.name || "—")}</td>
        <td>€ ${fmt.int(Math.round(c.spend || 0))}</td>
        <td>${fmt.int(c.impressions || c.reach || 0)}</td>
        <td>${c.ctr != null ? c.ctr.toFixed(2).replace(".", ",") + "%" : "—"}</td>
        <td>${roas != null ? roas.toFixed(1).replace(".", ",") + "×" : "—"}</td>
        <td>${oordeel}</td>
      </tr>`;
    }).join("");
    root.innerHTML = `<div class="report-table">
      <table>
        <thead><tr>
          <th>Campagne</th><th>Kosten</th><th>Vertoningen</th><th>CTR</th><th>ROAS</th><th>Oordeel</th>
        </tr></thead>
        <tbody>${rijen}</tbody>
      </table>
    </div>
    <p class="source-line">Bron: Windsor.ai, connector <b>facebook</b> (Meta Ads) · ${camps.length} campagnes, ${metKosten} met kosten`
      + `${camps.length > 12 ? ` · de twaalf met de hoogste kosten staan hier` : ""}. `
      + `Het oordeel vergelijkt binnen deze periode tegen de mediaan; bij minder dan vijf campagnes zegt dat te weinig.</p>`;
  }

  function bindOverviewTabs() {
    const bar = $("#ov-subtabs");
    if (!bar) return;
    bar.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-ovtab]");
      if (!btn) return;
      const naam = btn.dataset.ovtab;
      $$("#ov-subtabs [data-ovtab]").forEach(b => {
        const on = b === btn;
        b.classList.toggle("on", on);
        b.setAttribute("aria-selected", String(on));
      });
      $$("[data-ovpane]").forEach(p => p.classList.toggle("on", p.dataset.ovpane === naam));
    });
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
        <p style="color:var(--negative); margin:0;">${escapeHtml(state.overviewError)}</p>
        <button class="btn" style="margin-top:10px;" onclick="window.__refreshOverview()">Opnieuw proberen</button>
      </div>`;
      return;
    }
    const ov = state.overview;
    if (!ov) { root.innerHTML = ""; return; }

    // KPI-accenten uit de palette-tokens (--kpi-1..4). Dot gebruikt var() in het
    // style-attribuut; de sparkline (SVG-attribuut) krijgt de opgeloste hex.
    const kpiVars = ["--kpi-1", "--kpi-2", "--kpi-3", "--kpi-4"];
    root.innerHTML = ov.kpis.map((k, i) => {
      const cvar = kpiVars[i % kpiVars.length];
      const sparkHex = window.Charts ? Charts.cssVar(cvar, "#400745") : "#400745";
      // Nooit een kaal streepje: ontbrekende vergelijking is informatie, en die
      // hoort uitgeschreven te worden in plaats van weggelaten.
      let deltaHtml;
      if (k.state === "delta") {
        const arrow = k.direction === "up" ? "↑" : "↓";
        const nl = (n) => n.toFixed(1).replace(".", ",");
        // Meer dan verdubbeld: een factor leest beter dan '289,3%'. Zelfde regel
        // als in de conclusiekop, zodat kaart en kop hetzelfde zeggen.
        const dv = k.unit === "pp"
          ? `${nl(k.delta)}pp`
          : (k.delta >= 100 && k.direction === "up"
              ? `${nl(1 + k.delta / 100)}× zo hoog`
              : `${nl(k.delta)}%`);
        const pijl = (k.delta >= 100 && k.direction === "up" && k.unit !== "pp") ? "" : arrow + " ";
        deltaHtml = `<div class="delta ${k.direction}">${pijl}${dv} <span class="vs">${k.vs}</span></div>`;
      } else if (k.state === "flat") {
        const dv = k.unit === "pp" ? "0,0pp" : "0,0%";
        deltaHtml = `<div class="delta flat">± ${dv} <span class="vs">${k.vs}</span></div>`;
      } else if (k.state === "empty") {
        deltaHtml = `<div class="delta none">geen activiteit <span class="vs">in beide periodes</span></div>`;
      } else if (k.state === "new") {
        deltaHtml = `<div class="delta new">nieuw <span class="vs">vorige periode geen data</span></div>`;
      } else {
        // Geen vergelijking: dan zegt de regel welke periode je ziet. Waaróm er geen
        // vergelijking is staat één keer in de callout, niet vier keer onder elkaar.
        deltaHtml = `<div class="delta none">${escapeHtml(periodLabel())}</div>`;
      }
      return `
        <div class="kpi-card">
          <div class="label"><span class="dot" style="background:var(${cvar})"></span>${k.label}</div>
          <div class="value">${k.value}</div>
          ${deltaHtml}
          ${renderSpark(k.spark, sparkHex)}
        </div>
      `;
    }).join("");

    // Vijfde kaart: wat er aan advertenties liep. Alleen als er campagnes zijn —
    // een kaart met een nul erin suggereert dat er gemeten is.
    const camps = (ov.adsCampaigns || []).filter(c => c && (c.spend || c.impressions || c.reach));
    if (camps.length) {
      const spend = camps.reduce((a, c) => a + (c.spend || 0), 0);
      // Windsor's campagnerijen hebben geen statusveld (gecontroleerd op de live
      // respons), dus '0 actief' zou een bewering zijn over iets wat we niet
      // meten. Wél meetbaar: hoeveel campagnes er kosten maakten.
      const metKosten = camps.filter(c => (c.spend || 0) > 0).length;
      root.insertAdjacentHTML("beforeend", `
        <div class="kpi-card">
          <div class="label"><span class="dot" style="background:var(--accent-data)"></span>Campagnes</div>
          <div class="value">${camps.length}</div>
          <div class="delta none">${metKosten} met kosten · € ${fmt.int(Math.round(spend))} totaal</div>
        </div>
      `);
    }
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
    // Uniforme renderer (charts.js). Kleur per séérie-index vastzetten (--series-1/2/3)
    // zodat IG/FB/Ads hun tint houden ook als een lege reeks wordt weggefilterd.
    const specSeries = ts.series
      .map((s, idx) => ({ label: s.label, values: s.values, kind: "area", color: Charts.seriesColor(idx) }))
      .filter(s => s.values.some(v => v > 0));
    Charts.render(node, {
      width: 760, height: 260, x: ts.weeks,
      series: specSeries,
      leftFormat: (v) => Charts.fmt.k(v),
      maxXLabels: 5,
    });
    const src = $("#trend-source");
    if (src) {
      src.innerHTML = `Bron: Windsor.ai, connectoren <b>instagram</b> en <b>facebook</b> · `
        + `${ts.weeks.length} weken, gebundeld per week`;
    }
    const adsLoading = state.overview.adsLoading;
    legend.innerHTML = ts.series.map((s, idx) => {
      const suffix = (s.label === "Meta Ads" && adsLoading) ? ` <em style="opacity:0.55; font-style:normal;">· laden…</em>` : "";
      return `<span class="item"><span class="swatch" style="background:${Charts.seriesColor(idx)}"></span>${s.label}${suffix}</span>`;
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
    if (!post) return null;
    return post.performance || null; // null → "n/a"; ads krijgen label via classifyAdsPerformance
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

  function renderBenchmarkRow(list, showPaid) {
    if (!list.length) return '';
    const avg = (field) => Math.round(list.reduce((sum, item) => sum + (item[field] || 0), 0) / list.length);
    const sum = (field) => list.reduce((s, item) => s + (item[field] || 0), 0);
    const avgPerf = list.reduce((sum, item) => sum + (item.engagement || 0), 0) / list.length;
    const filterLabel = getLibraryFilterDefs().find(f => f.key === state.libraryFilter)?.label || "Alle";
    const platformName = state.libraryFilter === 'all' ? 'Globaal gemiddelde' : `${filterLabel} gemiddelde`;

    // Paid-totalen → afgeleide ratio's (account-niveau, correcter dan gemiddelde-van-ratio's).
    let paidCells = "", ctrCell = "<td></td>";
    if (showPaid) {
      const totSpend = sum('spend'), totImpr = sum('impressions'), totVal = sum('purchaseValue'), totConv = sum('conversions');
      const bCpm  = totImpr ? (totSpend / totImpr) * 1000 : 0;
      const bRoas = (totSpend > 0 && totVal > 0) ? totVal / totSpend : null;
      const bCac  = (totSpend > 0 && totConv > 0) ? totSpend / totConv : null;
      const bCtr  = totImpr ? (sum('clicks') / totImpr) * 100 : 0;
      ctrCell = `<td class="right">${bCtr.toFixed(1)}%</td>`;
      paidCells = `
      <td class="right" title="Totale ad spend deze periode">€${fmt.int(totSpend)}</td>
      <td class="right">€${bCpm.toFixed(2)}</td>
      <td class="right">${bCac != null ? `€${bCac.toFixed(2)}` : "—"}</td>
      <td class="right">${bRoas != null ? `${bRoas.toFixed(2)}×` : "—"}</td>`;
    }

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
      ${ctrCell}
      ${paidCells}
      <td></td>
    </tr>`;
  }

  function sortArrow(field) {
    if (state.librarySort.key !== field) return "";
    return `<span class="sort-arrow">${state.librarySort.dir === "asc" ? "↑" : "↓"}</span>`;
  }

  function renderLibraryTable(list) {
    if (!list.length) return renderLibraryEmpty();
    // Paid-kolommen (Spend/CPM/CAC/ROAS) enkel onder het Meta Ads-filter — anders zou de
    // tabel voor organic vol "—" staan en onnodig breed worden.
    const showPaid = state.libraryFilter === "ads";
    const paidHead = showPaid ? `
        <th class="right">Spend</th>
        <th class="right">CPM</th>
        <th class="right">CAC</th>
        <th class="right">ROAS</th>` : "";
    const paidCells = (p) => showPaid ? `
            <td class="right">€${fmt.int(p.spend)}</td>
            <td class="right">€${(p.cpm || 0).toFixed(2)}</td>
            <td class="right">${p.cac != null ? `€${p.cac.toFixed(2)}` : "—"}</td>
            <td class="right">${p.roas != null ? `${p.roas.toFixed(2)}×` : "—"}</td>` : "";
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
        <th class="right sortable" data-sort="ctr">CTR${sortArrow("ctr")}</th>${paidHead}
        <th class="right">Performantie</th>
      </tr></thead>
      <tbody>
        ${renderBenchmarkRow(list, showPaid)}
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
            <td class="right">${(p.ctr || 0).toFixed(1)}%</td>${paidCells(p)}
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

    // Hobby-interim: advertentie-detail dekt een korter venster dan de selectie → meld het
    // wanneer het Meta Ads-filter actief is, zodat de cijfers niet misleiden.
    const win = state.overview.adLevelWindow;
    const adNote = (win && state.libraryFilter === "ads")
      ? `<div class="panel" style="padding:10px 14px; margin-bottom:12px; font-size:13px;" class="muted">
           <strong>Let op:</strong> advertentie-detail toont de laatste ${win.maxDays} dagen (${win.startDate} → ${win.endDate}).
           Voor exacte aansluiting op een langere periode: kies een kortere datumrange. (Tijdelijke beperking — zie data-pipeline op de roadmap.)
         </div>`
      : "";

    const list = getFilteredLibrary();
    resultsEl.innerHTML = adNote + (state.libraryView === "grid"
      ? renderLibraryGrid(list)
      : renderLibraryTable(list));
    if (countEl) countEl.textContent = `${list.length} posts`;
    bindLibraryInteractions();
  }

  /* ---------- Connectors-paneel (Blok D, dynamisch o.b.v. session) ---------- */

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
          ["KPI-delta's vs vorige periode", "Even lange periode direct ervoor. Organisch bereik, interacties, publicaties en kliks; niet op advertentieniveau. Uit de datasheet als die ver genoeg terugloopt, anders live."],
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
          <li>Meta Ads krijgen een <strong>eigen</strong> Good/Average/Bad — niet de organic-formule. We schakelen automatisch: draaien je ads op conversies, dan scoren we op <strong>ROAS</strong> (return on ad spend); zonder conversie-tracking op <strong>efficiëntie (CTR/CPM)</strong>. Advertenties worden onderling vergeleken (ads vs ads), met dezelfde ${cfg.thresholds.good}× / ${cfg.thresholds.bad}×-grenzen.</li>
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
    // Zonder Overview is er nog steeds context: de SEO-, GEO- en Websitetab
    // kunnen wél geladen zijn. Die hoorden de agent altijd al te bereiken, maar
    // deze functie gaf hier `null` terug en stuurde dus helemaal niets mee —
    // waarop de agent terecht antwoordde dat hij geen data had.
    if (!ov) {
      const partial = {
        website: buildWebsiteSummary(),
        seo: buildSeoSummary(),
        geo: buildGeoSummary(),
      };
      return Object.values(partial).some(v => v != null) ? partial : null;
    }
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
      // Websitecijfers meesturen zodra de Website-tab geladen is. Zonder die tab
      // is er geen websitedata in het geheugen; dan blijft dit weg i.p.v. nullen
      // te sturen die de agent als 'geen verkeer' zou lezen.
      website: buildWebsiteSummary(),
      // SEO en GEO meesturen zodra die tabs geladen zijn. Net als bij website:
      // niet geladen = weglaten, niet nullen sturen.
      seo: buildSeoSummary(),
      geo: buildGeoSummary(),
    };
  }

  // Compacte samenvatting van de SEO-tab. Zoekvolume is marktvraag, positie is
  // onze plek daarin — de agent moet die twee uit elkaar kunnen houden, dus
  // beide staan er per keyword bij. 'niet gemeten' (geen rank) en 'buiten de
  // top N' (rank met pos null) blijven verschillend; dat onderscheid weggooien
  // zou de agent laten concluderen dat een keyword niet rankt terwijl er nooit
  // naar gekeken is.
  function buildSeoSummary() {
    const items = arrayOrEmpty(state.seo && state.seo.items);
    if (!items.length) return null;
    const s = state.seoSettings || {};
    const ranks = (state.seoRanks && state.seoRanks.ranks) || {};
    const depth = (state.seoRanks && state.seoRanks.depth) || 20;

    const withVolume = items.filter(i => i.volume != null);
    const trendOf = (monthly) => {
      const m = arrayOrEmpty(monthly).filter(x => x && x.volume != null);
      if (m.length < 6) return null;
      const last = m.slice(-3).reduce((a, x) => a + x.volume, 0) / 3;
      const prev = m.slice(-6, -3).reduce((a, x) => a + x.volume, 0) / 3;
      return prev ? +(((last - prev) / prev) * 100).toFixed(1) : null;
    };

    const keywords = items.map(i => {
      const r = ranks[i.keyword];
      return {
        keyword: i.keyword,
        volume: i.volume,
        competition: i.competition,
        cpc: i.cpc,
        trend3mPct: trendOf(i.monthly),
        // drie toestanden, bewust niet samengevoegd
        position: !r ? "niet gemeten" : (r.pos == null ? `buiten de top ${depth}` : r.pos),
        url: r && r.url ? r.url : null,
      };
    }).sort((a, b) => (b.volume || 0) - (a.volume || 0));

    return {
      domain: s.domain || null,
      market: s.location || null,
      language: s.language || null,
      // Waar deze cijfers vandaan komen en wanneer ze gemeten zijn — zodat de
      // agent weet of hij naar een live meting of een vastgelegde kijkt.
      source: s.source || "api",
      measuredAt: s.measuredAt || null,
      depth,
      totals: {
        keywords: items.length,
        keywordsWithVolume: withVolume.length,
        monthlyVolume: withVolume.reduce((a, i) => a + i.volume, 0),
        measuredPositions: Object.keys(ranks).length,
        inTopN: Object.values(ranks).filter(r => r && r.pos != null).length,
      },
      keywords: keywords.slice(0, 40),
    };
  }

  // Compacte samenvatting van de GEO-tab (AI-zichtbaarheid). Een audit is een
  // momentopname met een datum en een methode; die twee gaan mee, anders kan de
  // agent een half jaar oude meting als 'de stand van vandaag' presenteren.
  function buildGeoSummary() {
    const g = state.geo;
    if (!g) return null;
    return {
      auditDate: g.auditDate || null,
      label: g.label || null,
      promptCount: g.promptCount != null ? g.promptCount : null,
      method: g.method || null,
      status: g.status ? { level: g.status.level, title: g.status.title } : null,
      kpis: arrayOrEmpty(g.kpis).map(k => ({ label: k.label, value: k.value, delta: k.delta })),
      engines: arrayOrEmpty(g.engines).map(e => ({
        name: e.name, runs: e.runs, mentionRatePct: e.mentionRatePct,
        shareOfVoicePct: e.shareOfVoicePct, topCompetitor: e.topCompetitor,
      })),
      byType: arrayOrEmpty(g.byType).map(t => ({ type: t.type, ratePct: t.ratePct })),
      competitors: arrayOrEmpty(g.competitors).map(c => ({ name: c.name, engines: c.engines })),
      phase: (arrayOrEmpty(g.phases).find(p => p.here) || {}).title || null,
      readiness: arrayOrEmpty(g.readiness).map(c => ({ check: c.check, status: c.status })),
      actions: arrayOrEmpty(g.actions).slice(0, 5).map(a => ({
        priority: a.priority, title: a.title, effort: a.effort,
      })),
      previous: g.previous || null,
    };
  }

  // Compacte samenvatting van de Website-tab voor de analyse-agent en de chat.
  // Alleen de cijfers waar een uitspraak op te baseren is; geen lange lijsten.
  function buildWebsiteSummary() {
    const w = state.website;
    if (!w || !w.current) return null;
    const t = w.current.totals;
    const prev = w.previous ? w.previous.totals : null;
    const goal = webGoal();
    const round = (n, d = 2) => (n == null || !isFinite(n)) ? null : +n.toFixed(d);

    return {
      period: w.period,
      comparePeriod: w.comparePeriod,
      siteType: w.website.type,
      goal: { label: goal.label, event: w.website.goalEvent, measured: goal.on },
      totals: {
        sessions: t.sessions,
        users: t.users,
        newUserShare: round(t.newUserShare, 3),
        engagementRate: round(t.engagementRate, 3),
        avgEngagementTimeSec: round(t.avgEngagementTime, 0),
        conversions: goal.valueOf(t),
        conversionRate: round(goal.rateOf(t), 4),
        revenue: round(t.revenue, 2),
        transactions: t.transactions,
        aov: round(t.aov, 2),
      },
      previousTotals: prev ? {
        sessions: prev.sessions,
        engagementRate: round(prev.engagementRate, 3),
        conversions: goal.valueOf(prev),
        conversionRate: round(goal.rateOf(prev), 4),
        revenue: round(prev.revenue, 2),
      } : null,
      channels: (w.current.channels || []).slice(0, 8).map(c => ({
        channel: c.channel,
        sessions: c.sessions,
        engagementRate: round(c.engagementRate, 3),
        conversions: goal.rowOf(c),
        conversionRate: round(c.conversionRate, 4),
        revenue: round(c.revenue, 2),
      })),
      topLandingPages: (w.current.landingPages || []).slice(0, 8).map(p => ({
        page: p.page, sessions: p.sessions,
        engagementRate: round(p.engagementRate, 3),
        conversionRate: round(p.conversionRate, 4),
      })),
      search: w.current.search.available ? {
        clicks: w.current.search.clicks,
        impressions: w.current.search.impressions,
        ctr: round(w.current.search.ctr, 4),
        position: round(w.current.search.position, 1),
        topQueries: (w.current.queries || []).slice(0, 8).map(q => ({
          query: q.query, clicks: q.clicks, impressions: q.impressions, position: round(q.position, 1),
        })),
        quickWins: (w.current.quickWins || []).slice(0, 8).map(q => ({
          query: q.query, impressions: q.impressions, clicks: q.clicks, position: round(q.position, 1),
        })),
      } : null,
      funnel: (w.current.funnel && w.current.funnel.available) ? w.current.funnel : null,
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
        cpm: +(a.cpm || 0).toFixed(2),
        engagement: +(a.engagement || 0).toFixed(2),
        spend: a.spend != null ? +(a.spend).toFixed(2) : null,
        // Conversiemetrics — null als de klant niet trackt (agent: dan niet over ROAS/CAC claimen).
        roas: a.roas != null ? +a.roas.toFixed(2) : null,
        cac: a.cac != null ? +a.cac.toFixed(2) : null,
        purchases: a.purchases || 0,
        leads: a.leads || 0,
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

    // Account-niveau paid-totalen → afgeleide ratio's (correcter dan gemiddelde-van-ratio's).
    const tSpend = ads.reduce((s, a) => s + (a.spend || 0), 0);
    const tImpr  = ads.reduce((s, a) => s + (a.impressions || 0), 0);
    const tVal   = ads.reduce((s, a) => s + (a.purchaseValue || 0), 0);
    const tConv  = ads.reduce((s, a) => s + (a.conversions || 0), 0);
    const tClicks = ads.reduce((s, a) => s + (a.clicks || 0), 0);

    return {
      level: adLevel.length ? "ad" : "campaign",  // welk granulariteitsniveau de data heeft
      campaignCount: ads.length,
      totalReach: ads.reduce((s, a) => s + (a.reach || 0), 0),
      totalSpend: +tSpend.toFixed(2),
      paidTotals: {
        spend: +tSpend.toFixed(2),
        cpm: tImpr ? +((tSpend / tImpr) * 1000).toFixed(2) : null,
        ctr: tImpr ? +((tClicks / tImpr) * 100).toFixed(2) : null,
        roas: (tSpend > 0 && tVal > 0) ? +(tVal / tSpend).toFixed(2) : null,
        cac: (tSpend > 0 && tConv > 0) ? +(tSpend / tConv).toFixed(2) : null,
        conversions: tConv,
      },
      topByReach: [...ads].sort((a, b) => (b.reach || 0) - (a.reach || 0)).slice(0, 3).map(slimAd),
      bestAdsByEngagement: engAds.slice(0, 3).map(slimAd),
      // Alleen los meesturen als er genoeg ads zijn om best/worst te onderscheiden.
      worstAdsByEngagement: engAds.length > 4 ? engAds.slice(-3).reverse().map(slimAd) : [],
    };
  }

  // Haalt de eigen klant-benchmarks op uit Drive (06_PERFORMANTIE/6.2_Benchmarks).
  // Volledig best-effort: zonder Drive-koppeling of bij elke fout → "" (standaardanalyse).
  async function fetchCustomBenchmarks() {
    if (!state.session?.hasDrive) return "";
    try {
      const qs = new URLSearchParams({
        action: "analysis-benchmarks",
        clientId: state.session.clientId,
        token: state.session.token,
      });
      const res = await fetch(`/api/drive?${qs.toString()}`);
      if (!res.ok) return "";
      const data = await res.json();
      return data?.found && data.content ? data.content : "";
    } catch {
      return "";
    }
  }

  // Haalt de merk-/strategie-contextbestanden uit Drive op voor de chat-agent.
  // Gecachet per klant (clientId) zodat we het niet elke chat-turn opnieuw ophalen én
  // zodat context van klant A nooit naar klant B lekt bij een sessiewissel.
  async function fetchDriveContext() {
    const cid = state.session?.clientId;
    if (!cid || !state.session?.hasDrive) return [];
    if (state.driveContext?.clientId === cid) return state.driveContext.files;
    try {
      const qs = new URLSearchParams({
        action: "context",
        clientId: cid,
        token: state.session.token,
      });
      const res = await fetch(`/api/drive?${qs.toString()}`);
      const files = res.ok ? ((await res.json())?.contextFiles || []) : [];
      state.driveContext = { clientId: cid, files };
      return files;
    } catch {
      state.driveContext = { clientId: cid, files: [] };
      return [];
    }
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

    // Klantspecifieke benchmarks uit Drive (06_PERFORMANTIE/6.2_Benchmarks). Non-fataal:
    // niet gevonden / geen Drive / fout → lege string → standaardanalyse.
    const customBenchmarks = await fetchCustomBenchmarks();

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
        customBenchmarks,
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

  // Deterministische ads-ranking (uit classifyAdsPerformance) — los van de LLM-analyse.
  // Best 5 + slechtst 5 advertenties, met klikbare titel die naar de Library-ad springt.
  function renderAnalysisAdsRanking() {
    const ads = arrayOrEmpty(state.overview?.adsCampaigns).filter(a => a && a.platform === "ads" && a.perfScore != null);
    if (ads.length < 3) return ""; // te weinig advertenties om zinvol te ranken
    const sorted = [...ads].sort((x, y) => (y.perfScore || 0) - (x.perfScore || 0));
    const basis = sorted[0].perfBasis || "Efficiëntie (CTR/CPM)";
    const best = sorted.slice(0, 5);
    const worst = ads.length > 5 ? sorted.slice(-5).reverse() : [];

    const metricLine = (a) => a.roas != null
      ? `ROAS ${a.roas.toFixed(2)}× · spend €${fmt.int(a.spend)}`
      : `CTR ${(a.ctr || 0).toFixed(1)}% · CPM €${(a.cpm || 0).toFixed(2)}`;

    const adItem = (a) => {
      const perf = a.performance
        ? `<span class="perf-button ${a.performance.toLowerCase()}" style="cursor:default;">${a.performance}</span>`
        : `<span class="muted">n/a</span>`;
      const t = libThumb(a, 0, { imgClass: "row-thumb-img" });
      return `
        <div style="display:flex; gap:10px; align-items:center; padding:8px 0; border-bottom:1px solid var(--border, #f0e6ee);">
          <span class="row-thumb thumb-pattern" style="background:${t.bg}; flex:0 0 auto;">${t.imgHtml}</span>
          <div style="flex:1; min-width:0;">
            <button onclick="window.__goToAd('${escapeHtml(a.id)}')" title="Ga naar deze advertentie in de Library"
              style="background:none; border:none; padding:0; margin:0; color:var(--accent-data); font-weight:600; cursor:pointer; text-align:left; text-decoration:underline;">
              ${escapeHtml((a.caption || "").slice(0, 70) || "Advertentie")}
            </button>
            <div class="muted" style="font-size:12px; margin-top:2px;">${metricLine(a)}</div>
          </div>
          <div style="flex:0 0 auto;">${perf}</div>
        </div>`;
    };

    const worstCol = worst.length ? `
        <div class="insight-card lose">
          <div class="head"><span class="pill">Slechtst presterend</span><h3>Bottom ${worst.length} ads</h3></div>
          <div class="insight-list">${worst.map(adItem).join("")}</div>
        </div>` : "";

    return `
      <section style="margin-top: var(--grid-gap);">
        <div class="panel-sub" style="margin-bottom:8px;">Advertentie-ranking · basis: ${escapeHtml(basis)} · klik een titel om naar de advertentie te springen</div>
        <div class="insight-grid">
          <div class="insight-card win">
            <div class="head"><span class="pill">Best presterend</span><h3>Top ${best.length} ads</h3></div>
            <div class="insight-list">${best.map(adItem).join("")}</div>
          </div>
          ${worstCol}
        </div>
      </section>`;
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

    // Deterministische ads-ranking — onafhankelijk van de LLM-analyse, dus altijd tonen
    // zodra er ads zijn (ook bij fout/laden/vóór generatie).
    const adsRank = renderAnalysisAdsRanking();

    const postsCount = arrayOrEmpty(state.overview.allPosts).length;
    if (postsCount === 0 && !adsRank) {
      root.innerHTML = renderAnalysisEmpty(`<p class="muted" style="margin:0;">Geen posts in deze periode om te analyseren.</p>`);
      return;
    }

    // LLM-generatie bezig.
    if (state.analysisLoading) {
      root.innerHTML = renderAnalysisLoadingSkeleton() + adsRank;
      return;
    }

    // Cache-hit voor huidige periode → toon resultaat.
    const cached = state.analysisCache[analysisPeriodKey()];
    if (cached) {
      root.innerHTML = renderAnalysisInsights(cached) + adsRank;
      return;
    }

    // Fout bij laatste generatie.
    if (state.analysisError) {
      root.innerHTML = renderAnalysisEmpty(`
        <p style="color:var(--negative); margin:0;">${escapeHtml(state.analysisError)}</p>
        <button class="btn primary" style="margin-top:14px;" onclick="window.__generateAnalysis()">Opnieuw proberen</button>
      `) + adsRank;
      return;
    }

    // Empty state — gebruiker moet expliciet de analyse triggeren.
    root.innerHTML = `
      <div class="panel" style="text-align:center; padding:56px 24px;">
        <div style="font-size:22px; color:var(--fg); margin-bottom:8px;">Analyse genereren?</div>
        <p class="muted" style="margin:0 auto 22px; max-width:520px;">
          De Agent leest ${postsCount} posts en eventuele campagnes uit deze periode (${escapeHtml(periodLabelShort())}) en levert winners, losers en concrete aanbevelingen. Duurt zo'n 5 seconden.
        </p>
        <button class="btn primary" onclick="window.__generateAnalysis()">
          Genereer analyse voor ${escapeHtml(periodLabelShort())} →
        </button>
      </div>` + adsRank;
  }

  /* ---------- E-mail (live: ConvertKit / Klaviyo via Windsor) ---------- */

  function refreshEmail() {
    if (!state.session) return;
    // Sleutel per klant ÉN periode — anders deelt een andere klant met dezelfde periode
    // dezelfde cache-hit en zie je de verkeerde e-maildata.
    const key = `${state.session.clientId}|${analysisPeriodKey()}`;
    if (state.emailLoading) return;
    if (state.email && state.emailKey === key) { renderEmail(); return; }
    if (!state.session.hasWindsor) { renderEmail(); return; } // geen Windsor → geen e-mail-bron

    state.emailLoading = true;
    state.emailError = null;
    state.email = null;
    state.emailKey = key;
    renderEmail();

    windsorCall("getEmail", { startDate: state.period.start, endDate: state.period.end })
      .then(res => {
        if (state.emailKey !== key) return; // periode gewisseld tijdens fetch
        state.email = res;
        state.emailLoading = false;
        renderEmail();
      })
      .catch(err => {
        if (state.emailKey !== key) return;
        state.emailLoading = false;
        state.emailError = err.message || "Onbekende fout bij laden e-maildata.";
        if (err.status === 401) { clearSession(); setTimeout(() => showScreen("login-screen"), 600); }
        renderEmail();
      });
  }
  window.__refreshEmail = refreshEmail;

  // Windsor geeft rates soms als fractie (0–1), soms als percentage — defensief: ≤1 → ×100.
  function emailPct(v) {
    const n = Number(v);
    if (!isFinite(n)) return "—";
    return (n <= 1 ? n * 100 : n).toFixed(1) + "%";
  }
  function emailDate(s) { try { return fmt.dateNL(new Date(s)); } catch { return s || "—"; } }

  window.__emailSort = (key) => {
    if (state.emailSort.key === key) state.emailSort.dir = state.emailSort.dir === "desc" ? "asc" : "desc";
    else { state.emailSort.key = key; state.emailSort.dir = "desc"; }
    renderEmail();
  };

  // Generieke sorteerbare e-mailtabel. cols: [{key,label,align,val(x),cell(x)}].
  // val() levert de sorteerwaarde (string → alfabetisch, anders numeriek).
  function renderEmailTable(rows, cols, defaultKey) {
    const activeKey = (state.emailSort.key && cols.some(c => c.key === state.emailSort.key)) ? state.emailSort.key : defaultKey;
    const dir = (state.emailSort.key === activeKey) ? state.emailSort.dir : "desc";
    const col = cols.find(c => c.key === activeKey) || cols[0];
    const sign = dir === "asc" ? 1 : -1;
    const sorted = [...rows].sort((a, b) => {
      const av = col.val(a), bv = col.val(b);
      if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * sign;
      return ((av || 0) - (bv || 0)) * sign;
    });
    const arrow = (k) => activeKey === k ? `<span class="sort-arrow">${dir === "asc" ? "↑" : "↓"}</span>` : "";
    const thead = cols.map(c => `<th class="${c.align === "right" ? "right " : ""}sortable" onclick="window.__emailSort('${c.key}')">${escapeHtml(c.label)}${arrow(c.key)}</th>`).join("");
    const body = sorted.map(x => `<tr>${cols.map(c => `<td class="${c.align === "right" ? "right" : ""}">${c.cell(x)}</td>`).join("")}</tr>`).join("");
    return `<div class="lib-table"><table><thead><tr>${thead}</tr></thead><tbody>${body}</tbody></table></div>`;
  }
  function emailKpiCard(label, value) {
    return `<div class="panel" style="padding:16px 18px;"><div class="muted" style="font-size:12px;">${escapeHtml(label)}</div>
      <div class="value small" style="margin-top:4px;">${value}</div></div>`;
  }

  function renderEmail() {
    const root = $("#email-content");
    if (!root) return;
    if (!state.session?.hasWindsor) {
      root.innerHTML = renderAnalysisEmpty(`<p class="muted" style="margin:0;">E-mail-data is beschikbaar voor klanten met een Windsor-koppeling (ConvertKit of Klaviyo).</p>`);
      return;
    }
    if (state.emailLoading) {
      root.innerHTML = renderAnalysisEmpty(`<p class="muted" style="margin:0;">E-maildata laden…</p>`);
      return;
    }
    if (state.emailError) {
      root.innerHTML = renderAnalysisEmpty(`<p style="color:var(--negative); margin:0;">${escapeHtml(state.emailError)}</p>
        <button class="btn primary" style="margin-top:14px;" onclick="window.__refreshEmail()">Opnieuw proberen</button>`);
      return;
    }
    const e = state.email;
    if (!e || !e.connector) {
      root.innerHTML = renderAnalysisEmpty(`<p class="muted" style="margin:0;">Geen e-mailconnector (ConvertKit of Klaviyo) gekoppeld voor deze klant.</p>`);
      return;
    }
    root.innerHTML = e.connector === "klaviyo" ? renderEmailKlaviyo(e)
      : e.connector === "mailerlite" ? renderEmailMailerLite(e)
      : renderEmailConvertKit(e);
  }

  window.__emailToggleOverlay = (k) => { state.emailOverlays[k] = !state.emailOverlays[k]; renderEmail(); };

  // Generieke dual-axis lijngrafiek: één vaste lijn (linkeras) + aan/uit-knopbare overlay-lijnen
  // (rechteras). Overlays binnen één grafiek delen dezelfde eenheid (chart 1 = %, chart 2 = €),
  // dus de rechteras is consistent; hij schaalt naar de actieve overlays.
  // opts: { id, title, sub, points:[{label, fixed, ov:{key:val}}], fixedLabel, fixedColor, fixedFmt,
  //         overlays:[{key,label,color,fmt,dashed}] }
  // Rendert een charts.js-spec naar een SVG-string (charts.js is imperatief: het
  // schrijft in element.innerHTML). Zo kunnen we de uniforme renderer gebruiken in
  // functies die HTML als string teruggeven.
  function chartSvg(spec) {
    if (!window.Charts) return "";
    const d = document.createElement("div");
    Charts.render(d, spec);
    return d.innerHTML;
  }

  function renderEmailDualChart(opts) {
    const pts = opts.points;
    if (!pts.length) return "";
    const activeOv = opts.overlays.filter(o => state.emailOverlays[o.key]);

    // Bouw de charts.js-spec: vaste reeks (links, area) + actieve overlays (rechts,
    // bar of line). Uniforme renderer → nette assen (niceMax) + palette-kleuren.
    const series = [{
      label: opts.fixedLabel,
      values: pts.map(p => p.fixed),
      kind: "area",
      axis: "left",
      color: opts.fixedColor,
    }];
    for (const o of activeOv) {
      series.push({
        label: o.label,
        values: pts.map(p => p.ov[o.key] || 0),
        kind: opts.overlayStyle === "bar" ? "bar" : "line",
        axis: "right",
        color: o.color,
      });
    }
    const svg = chartSvg({
      width: 760, height: 260,
      x: pts.map(p => p.label),
      series,
      leftFormat: opts.fixedFmt,
      rightFormat: activeOv[0] ? activeOv[0].fmt : undefined,
      maxXLabels: 6,
    });

    const toggle = opts.overlays.map(o => `<button class="btn tiny ${state.emailOverlays[o.key] ? "primary" : ""}" onclick="window.__emailToggleOverlay('${o.key}')">${escapeHtml(o.label)}</button>`).join(" ");
    const legend = `<span class="item"><span class="swatch" style="background:${opts.fixedColor}"></span>${escapeHtml(opts.fixedLabel)}</span>`
      + activeOv.map(o => `<span class="item"><span class="swatch" style="background:${o.color}"></span>${escapeHtml(o.label)}</span>`).join("");

    return `
      <section class="panel" style="margin-bottom:var(--grid-gap);">
        <div class="panel-header">
          <div><h2 class="panel-title">${escapeHtml(opts.title)}</h2><div class="panel-sub">${escapeHtml(opts.sub)}</div></div>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">${toggle}</div>
        </div>
        <div style="margin-top:10px;">${svg}</div>
        <div class="legend" style="margin-top:8px;">${legend}</div>
      </section>`;
  }

  // Bouwt de twee Klaviyo-grafieken: (1) ontvangers + open/click per campagne,
  // (2) verzonden e-mails + omzet/omzet-per-ontvanger per dag.
  function renderEmailCharts(rows) {
    const rate = (x, k) => { let v = Number(x[k]) || 0; return v <= 1 ? v * 100 : v; };
    const campPts = [...rows].filter(x => x.sent_at)
      .sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at))
      .map(x => ({
        label: emailDate(x.sent_at),
        fixed: Number(x.campaign_report_recipients) || 0,
        ov: { open: rate(x, "campaign_report_open_rate"), click: rate(x, "campaign_report_click_rate") },
      }));

    const byDay = {};
    for (const x of rows) {
      if (!x.sent_at) continue;
      const day = String(x.sent_at).slice(0, 10);
      const d = byDay[day] || (byDay[day] = { recipients: 0, revenue: 0 });
      d.recipients += Number(x.campaign_report_recipients) || 0;
      d.revenue += Number(x.campaign_report_conversion_value) || 0;
    }
    const dayPts = Object.keys(byDay).sort().map(day => {
      const d = byDay[day];
      return { label: emailDate(day), fixed: d.recipients, ov: { revenue: d.revenue, rev_rcpt: d.recipients ? d.revenue / d.recipients : 0 } };
    });

    const chart1 = renderEmailDualChart({
      id: "eng", title: "Ontvangers & engagement", sub: "Per campagne (oud → nieuw) · klik open/click rate aan of uit",
      points: campPts, fixedLabel: "Ontvangers", fixedColor: Charts.cssVar("--series-2"), fixedFmt: (v) => fmt.k(v),
      overlays: [
        { key: "open", label: "Open rate", color: Charts.cssVar("--series-3"), fmt: (v) => v.toFixed(0) + "%" },
        { key: "click", label: "Click rate", color: Charts.cssVar("--series-1"), fmt: (v) => v.toFixed(1) + "%", dashed: true },
      ],
    });
    const chart2 = renderEmailDualChart({
      id: "rev", title: "Verzonden e-mails & omzet per dag", sub: "Per dag · klik omzet / omzet per ontvanger aan of uit",
      points: dayPts, fixedLabel: "Verzonden e-mails", fixedColor: Charts.cssVar("--series-2"), fixedFmt: (v) => fmt.k(v),
      overlayStyle: "bar",
      overlays: [
        { key: "revenue", label: "Omzet", color: Charts.cssVar("--series-3"), fmt: (v) => "€" + fmt.k(v) },
        { key: "rev_rcpt", label: "Omzet / ontvanger", color: Charts.cssVar("--series-1"), fmt: (v) => "€" + v.toFixed(2), dashed: true },
      ],
    });
    return chart1 + chart2;
  }

  function renderEmailKlaviyo(e) {
    const rows = arrayOrEmpty(e.campaigns?.data);
    const err = e.errors?.campaigns;
    if (err) return renderAnalysisEmpty(`<p style="color:var(--negative);margin:0;">Klaviyo: ${escapeHtml(err)}</p>
      <button class="btn primary" style="margin-top:14px;" onclick="window.__refreshEmail()">Opnieuw proberen</button>`);
    if (!rows.length) return renderAnalysisEmpty(`<p class="muted" style="margin:0;">Geen e-mailcampagnes in deze periode.</p>`);

    const num = (x, k) => Number(x[k]) || 0;
    const totRcpt = rows.reduce((s, x) => s + num(x, "campaign_report_recipients"), 0);
    const totRev = rows.reduce((s, x) => s + num(x, "campaign_report_conversion_value"), 0);
    const wAvg = (k) => totRcpt ? rows.reduce((s, x) => s + num(x, k) * num(x, "campaign_report_recipients"), 0) / totRcpt : 0;

    const win = e.window;
    const note = win?.capped
      ? `<div class="panel-sub" style="margin-bottom:10px;">Toont de laatste ${win.maxDays} dagen (${win.startDate} → ${win.endDate}) — Klaviyo is traag over langere periodes. Definitieve oplossing: de data-pipeline.</div>`
      : "";

    const cols = [
      { key: "campaign", label: "Campagne", align: "left", val: x => (x.campaign || "").toLowerCase(), cell: x => escapeHtml((x.campaign || "").slice(0, 60) || "—") },
      { key: "sent", label: "Verzonden", align: "left", val: x => new Date(x.sent_at || 0).getTime(), cell: x => emailDate(x.sent_at) },
      { key: "recipients", label: "Ontvangers", align: "right", val: x => num(x, "campaign_report_recipients"), cell: x => fmt.int(num(x, "campaign_report_recipients")) },
      { key: "open", label: "Open rate", align: "right", val: x => Number(x.campaign_report_open_rate) || 0, cell: x => emailPct(x.campaign_report_open_rate) },
      { key: "click", label: "Click rate", align: "right", val: x => Number(x.campaign_report_click_rate) || 0, cell: x => emailPct(x.campaign_report_click_rate) },
      { key: "revenue", label: "Omzet", align: "right", val: x => num(x, "campaign_report_conversion_value"), cell: x => "€" + fmt.int(num(x, "campaign_report_conversion_value")) },
      { key: "rev_rcpt", label: "€/ontvanger", align: "right", val: x => num(x, "campaign_report_revenue_per_recipient"), cell: x => "€" + num(x, "campaign_report_revenue_per_recipient").toFixed(2) },
    ];

    return `
      ${note}
      <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:var(--grid-gap); margin-bottom:var(--grid-gap);">
        ${emailKpiCard("Campagnes", fmt.int(rows.length))}
        ${emailKpiCard("Ontvangers (totaal)", fmt.int(totRcpt))}
        ${emailKpiCard("Gem. open rate", emailPct(wAvg("campaign_report_open_rate")))}
        ${emailKpiCard("E-mail-omzet", "€" + fmt.int(totRev))}
      </div>
      ${renderEmailCharts(rows)}
      <section class="panel">
        <div class="panel-header">
          <div><h2 class="panel-title">E-mailcampagnes</h2><div class="panel-sub">Klaviyo · klik een kolom om te sorteren</div></div>
          <button class="btn tiny" onclick="window.__refreshEmail()">↻ Verversen</button>
        </div>
        ${renderEmailTable(rows, cols, "revenue")}
      </section>`;
  }

  // MailerLite — campagne-performance zit genest in campaigns__stats (object). We pakken sent/
  // opens/clicks/rates uit; geen omzet (die geeft MailerLite niet). Weergave à la Klaviyo.
  function renderEmailMailerLite(e) {
    const raw = arrayOrEmpty(e.campaigns?.data);
    const err = e.errors?.campaigns;
    if (err) return renderAnalysisEmpty(`<p style="color:var(--negative);margin:0;">MailerLite: ${escapeHtml(err)}</p>
      <button class="btn primary" style="margin-top:14px;" onclick="window.__refreshEmail()">Opnieuw proberen</button>`);

    // stats-object uitpakken (kan object of JSON-string zijn); rate-velden zijn {float,string}.
    const readStats = (x) => { let s = x.campaigns__stats; if (typeof s === "string") { try { s = JSON.parse(s); } catch { s = null; } } return s || null; };
    const rateOf = (v) => v == null ? 0 : (typeof v === "object" ? Number(v.float) || 0 : Number(v) || 0);
    const rows = raw.map(x => {
      const st = readStats(x);
      if (!st) return null; // draft/ready zonder stats overslaan
      return {
        name: x.campaigns__name || "—",
        sent_at: x.campaigns__finished_at || x.campaigns__created_at || null,
        recipients: Number(st.sent) || 0,
        openRate: rateOf(st.open_rate),         // 0–1
        clickRate: rateOf(st.click_rate),       // 0–1
        unsubRate: rateOf(st.unsubscribe_rate), // 0–1
      };
    }).filter(Boolean);
    if (!rows.length) return renderAnalysisEmpty(`<p class="muted" style="margin:0;">Geen verzonden e-mailcampagnes in deze periode.</p>`);

    const totRcpt = rows.reduce((s, x) => s + x.recipients, 0);
    const wAvg = (k) => totRcpt ? rows.reduce((s, x) => s + x[k] * x.recipients, 0) / totRcpt : 0;

    // Grafiek (ontvangers vast + open/click toggle) — hergebruikt de dual-axis renderer.
    const chartPts = [...rows].filter(x => x.sent_at)
      .sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at))
      .map(x => ({ label: emailDate(x.sent_at), fixed: x.recipients, ov: { open: x.openRate * 100, click: x.clickRate * 100 } }));
    const chart = renderEmailDualChart({
      id: "ml", title: "Ontvangers & engagement", sub: "Per campagne (oud → nieuw) · klik open/click rate aan of uit",
      points: chartPts, fixedLabel: "Ontvangers",
      fixedColor: Charts.cssVar("--accent-data", "#400745"), fixedFmt: (v) => fmt.k(v),
      overlays: [
        { key: "open", label: "Open rate", color: Charts.cssVar("--s2", "#9c7e9e"), fmt: (v) => v.toFixed(0) + "%" },
        { key: "click", label: "Click rate", color: Charts.cssVar("--chart-3", "#0072b2"), fmt: (v) => v.toFixed(1) + "%", dashed: true },
      ],
    });

    const cols = [
      { key: "name", label: "Campagne", align: "left", val: x => (x.name || "").toLowerCase(), cell: x => escapeHtml((x.name || "").slice(0, 60) || "—") },
      { key: "sent", label: "Verzonden", align: "left", val: x => new Date(x.sent_at || 0).getTime(), cell: x => emailDate(x.sent_at) },
      { key: "recipients", label: "Ontvangers", align: "right", val: x => x.recipients, cell: x => fmt.int(x.recipients) },
      { key: "open", label: "Open rate", align: "right", val: x => x.openRate, cell: x => emailPct(x.openRate) },
      { key: "click", label: "Click rate", align: "right", val: x => x.clickRate, cell: x => emailPct(x.clickRate) },
      { key: "unsub", label: "Unsub rate", align: "right", val: x => x.unsubRate, cell: x => emailPct(x.unsubRate) },
    ];

    return `
      <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:var(--grid-gap); margin-bottom:var(--grid-gap);">
        ${emailKpiCard("Campagnes", fmt.int(rows.length))}
        ${emailKpiCard("Ontvangers (totaal)", fmt.int(totRcpt))}
        ${emailKpiCard("Gem. open rate", emailPct(wAvg("openRate")))}
        ${emailKpiCard("Gem. click rate", emailPct(wAvg("clickRate")))}
      </div>
      ${chart}
      <section class="panel">
        <div class="panel-header">
          <div><h2 class="panel-title">E-mailcampagnes</h2><div class="panel-sub">MailerLite · klik een kolom om te sorteren</div></div>
          <button class="btn tiny" onclick="window.__refreshEmail()">↻ Verversen</button>
        </div>
        ${renderEmailTable(rows, cols, "sent")}
      </section>`;
  }

  function renderEmailConvertKit(e) {
    const broadcasts = arrayOrEmpty(e.broadcasts?.data);
    const subs = arrayOrEmpty(e.subscribers?.data);
    const bErr = e.errors?.broadcasts, sErr = e.errors?.subscribers;
    if (bErr && sErr) return renderAnalysisEmpty(`<p style="color:var(--negative);margin:0;">ConvertKit: ${escapeHtml(bErr)}</p>
      <button class="btn primary" style="margin-top:14px;" onclick="window.__refreshEmail()">Opnieuw proberen</button>`);

    const byState = subs.reduce((m, x) => { const k = x.subscribers__state || "onbekend"; m[k] = (m[k] || 0) + 1; return m; }, {});
    const active = byState.active || 0;
    const stateChips = Object.entries(byState).map(([k, v]) => `<span class="pill">${escapeHtml(k)}: ${v}</span>`).join(" ");
    const bcCols = [
      { key: "subject", label: "Onderwerp", align: "left", val: x => (x.broadcasts__subject || "").toLowerCase(), cell: x => escapeHtml((x.broadcasts__subject || "").slice(0, 90) || "—") },
      { key: "date", label: "Verzonden", align: "left", val: x => new Date(x.broadcasts__created_at || 0).getTime(), cell: x => emailDate(x.broadcasts__created_at) },
    ];

    return `
      <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:var(--grid-gap); margin-bottom:var(--grid-gap);">
        ${emailKpiCard("Nieuwe subscribers (periode)", fmt.int(subs.length))}
        ${emailKpiCard("Waarvan actief", fmt.int(active))}
        ${emailKpiCard("Broadcasts verzonden", fmt.int(broadcasts.length))}
      </div>
      <section class="panel" style="margin-bottom:var(--grid-gap);">
        <div class="panel-header">
          <div><h2 class="panel-title">Subscribers per status</h2><div class="panel-sub">ConvertKit</div></div>
          <button class="btn tiny" onclick="window.__refreshEmail()">↻ Verversen</button>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">${stateChips || '<span class="muted">Geen subscriber-data.</span>'}</div>
        <p class="muted" style="font-size:12px; margin-top:12px;">ConvertKit levert via Windsor geen open-/click-metrics — daarom tonen we lijstgroei en verzonden broadcasts. Engagement-cijfers vereisen een andere bron of de data-pipeline.</p>
      </section>
      <section class="panel">
        <div class="panel-header"><div><h2 class="panel-title">Verzonden broadcasts</h2><div class="panel-sub">${broadcasts.length} in deze periode · klik een kolom om te sorteren</div></div></div>
        ${broadcasts.length ? renderEmailTable(broadcasts, bcCols, "date") : `<p class="muted" style="margin:0;">Geen broadcasts in deze periode.</p>`}
      </section>`;
  }

  /* ---------- ROAS (blended MER + per betaald kanaal, via Windsor) ----------
     Deze tab heeft bewust een EIGEN periodekiezer: ROAS wordt per kalendermaand
     opgevolgd (month-to-date), niet over de vrije dashboardperiode. De
     vergelijking is standaard dezelfde periode vorig jaar — dezelfde opzet als de
     MTD-kolommen in de WOODY-sheet waar deze tab op gemodelleerd is.

     Twee ROAS-definities staan naast elkaar, nooit opgeteld:
       GA4-ROAS      = GA4 purchase_revenue (last click) / spend
       platform-ROAS = door het kanaal zelf geclaimde omzet / spend
     De blended ROAS (MER) is totale webshopomzet / totale advertentiekosten. */

  const ROAS_PERIODS = [
    { key: "mtd", label: "Deze maand" },
    { key: "prevmonth", label: "Vorige maand" },
    { key: "30d", label: "30 dagen" },
  ];

  const MONTHS_NL = ["januari", "februari", "maart", "april", "mei", "juni",
    "juli", "augustus", "september", "oktober", "november", "december"];

  // Datums als string opbouwen i.p.v. via toISOString(): een lokale middernacht
  // valt in UTC+2 op de dág ervoor, wat de MTD-grens een dag zou verschuiven.
  const pad2 = (n) => String(n).padStart(2, "0");
  const ymd = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;
  const lastDayOf = (y, m) => new Date(y, m + 1, 0).getDate();

  function roasRange(key) {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    if (key === "prevmonth") {
      const py = m === 0 ? y - 1 : y, pm = m === 0 ? 11 : m - 1;
      return { start: ymd(py, pm, 1), end: ymd(py, pm, lastDayOf(py, pm)), label: `${MONTHS_NL[pm]} ${py}` };
    }
    if (key === "30d") {
      const s = new Date(y, m, d - 29, 12);
      return {
        start: ymd(s.getFullYear(), s.getMonth(), s.getDate()),
        end: ymd(y, m, d),
        label: "laatste 30 dagen",
      };
    }
    return { start: ymd(y, m, 1), end: ymd(y, m, d), label: `1–${d} ${MONTHS_NL[m]} ${y}` };
  }

  // Zelfde dagen, één jaar eerder. 29 februari bestaat niet elk jaar → terugvallen
  // op de laatste dag van die maand i.p.v. stil doorschuiven naar 1 maart.
  function roasCompareRange(range) {
    const shift = (iso) => {
      const [y, m, d] = iso.split("-").map(Number);
      const py = y - 1, pm = m - 1;
      return ymd(py, pm, Math.min(d, lastDayOf(py, pm)));
    };
    return { start: shift(range.start), end: shift(range.end) };
  }

  function roasFetch() {
    if (!state.session) return;
    const range = roasRange(state.roasPeriod);
    const cmp = roasCompareRange(range);
    const key = `${state.session.clientId}|${state.roasPeriod}|${range.start}|${range.end}`;
    if (state.roasLoading) return;
    if (state.roas && state.roasKey === key) { renderRoas(); return; }
    if (!state.session.hasWindsor) { renderRoas(); return; }

    state.roasLoading = true;
    state.roasError = null;
    state.roas = null;
    state.roasKey = key;
    renderRoas();

    windsorCall("getRoas", {
      startDate: range.start, endDate: range.end,
      compareStartDate: cmp.start, compareEndDate: cmp.end,
    })
      .then((res) => {
        if (state.roasKey !== key) return; // periode gewisseld tijdens fetch
        state.roas = res;
        state.roasLoading = false;
        renderRoas();
      })
      .catch((err) => {
        if (state.roasKey !== key) return;
        state.roasLoading = false;
        state.roasError = err.message || "Onbekende fout bij laden ROAS-data.";
        if (err.status === 401) { clearSession(); setTimeout(() => showScreen("login-screen"), 600); }
        renderRoas();
      });
  }
  window.__refreshRoas = () => { state.roas = null; state.roasKey = null; roasFetch(); };
  window.__roasPeriod = (k) => { state.roasPeriod = k; roasFetch(); };

  /* ---------- Break-even ---------- */

  // Effectieve break-even-parameters: Config-tab als basis, live invoer van de
  // gebruiker daarbovenop. De live waarden blijven in het geheugen van deze sessie
  // (scenario's doorrekenen) en worden niet naar de sheet teruggeschreven.
  function roasParams() {
    const cfg = state.roas?.roasConfig || {};
    const o = state.roasInputs;
    const val = (k) => (o[k] != null ? o[k] : (typeof cfg[k] === "number" ? cfg[k] : null));
    const discount = val("seasonalDiscount");
    return {
      grossMargin: val("grossMargin"),
      seasonalDiscount: discount,
      // Loopt er een seizoenskorting, dan is díé de drempel — anders volle prijs.
      // Met één klik om te zetten, zonder de sheet aan te passen.
      activeScenario: o.activeScenario || ((discount != null && discount > 0) ? "season" : "full"),
      minRoasOverride: typeof cfg.minRoas === "number" ? cfg.minRoas : null,
      fromConfig: {
        grossMargin: typeof cfg.grossMargin === "number",
        seasonalDiscount: typeof cfg.seasonalDiscount === "number",
      },
    };
  }

  // Break-even ROAS = (1 − korting) / (brutomarge − korting). Zelfde formule als
  // server-side in _config.js roasTargets(); hier client-side herhaald zodat de
  // live invoer meteen doorrekent zonder round-trip.
  function roasScenarios(p) {
    const m = p.grossMargin;
    if (m == null) return [];
    const defs = [{ key: "full", label: "Volle prijs", discount: 0 }];
    if (typeof p.seasonalDiscount === "number" && p.seasonalDiscount > 0) {
      defs.push({ key: "season", label: "Seizoenskorting", discount: p.seasonalDiscount });
    }
    return defs.map(w => {
      const margin = m - w.discount;
      return {
        ...w,
        netMargin: margin,
        breakEven: margin > 0 ? (1 - w.discount) / margin : null,
        loss: margin <= 0,
      };
    });
  }

  // De drempel waartegen kanalen en campagnes beoordeeld worden: 'Minimum ROAS'
  // uit de Config-tab wint, anders de break-even van het actieve scenario.
  function roasMinTarget() {
    const p = roasParams();
    if (p.minRoasOverride) return { value: p.minRoasOverride, source: "Minimum ROAS (Config-tab)" };
    const scenarios = roasScenarios(p);
    const active = scenarios.find(w => w.key === p.activeScenario) || scenarios[0];
    if (!active) return { value: null, source: null };
    if (active.loss) return { value: null, source: `${active.label} — geen marge over`, loss: true };
    return { value: active.breakEven, source: `break-even ${active.label.toLowerCase()}` };
  }

  window.__roasInput = (field, raw) => {
    const s = String(raw).replace("%", "").replace(",", ".").trim();
    if (s === "") { state.roasInputs[field] = null; renderRoas(); return; }
    let n = parseFloat(s);
    if (!isFinite(n)) return;
    if (n > 1) n = n / 100;
    state.roasInputs[field] = Math.max(0, Math.min(1, n));
    renderRoas();
  };
  window.__roasScenario = (k) => { state.roasInputs.activeScenario = k; renderRoas(); };
  window.__roasResetInputs = () => {
    state.roasInputs = { grossMargin: null, seasonalDiscount: null, activeScenario: null };
    renderRoas();
  };
  // Actieve omzetdefinitie: een expliciete keuze van de gebruiker wint, anders
  // 'Oordeel op' uit de Config-tab, anders GA4. Per klant instelbaar omdat het
  // antwoord afhangt van de trackingkwaliteit — zie renderRoasFootnote().
  function roasMode() {
    if (state.roasRevenueMode) return state.roasRevenueMode;          // expliciete keuze wint
    // Zonder GA4-property levert de GA4-modus alleen streepjes op; dan is de
    // platformomzet de enige bron die er is.
    if (state.roas && state.roas.hasGa4 === false) return "platform";
    return state.roas?.roasConfig?.verdictSource || "ga4";
  }
  function roasConfigMode() { return state.roas?.roasConfig?.verdictSource || null; }

  window.__roasRevenueMode = (m) => { state.roasRevenueMode = m; renderRoas(); };

  /* ---------- Formatters + verdict ---------- */

  const roasFmt = {
    eur: (n) => "€ " + Math.round(n || 0).toLocaleString("nl-NL"),
    // null = niet gemeten (geen GA4-property, connector zonder omzetveld). Bewust
    // een streepje: '€ 0' leest als 'niets verdiend' en dat is iets heel anders.
    eurOrDash: (n) => (n == null ? "—" : "€ " + Math.round(n).toLocaleString("nl-NL")),
    ratio: (n) => (n == null || !isFinite(n)) ? "—" : n.toFixed(2).replace(".", ",") + "×",
    pct: (n) => (n == null || !isFinite(n)) ? "—" : (n * 100).toFixed(0) + "%",
    delta: (cur, prev) => {
      if (prev == null || !isFinite(prev) || prev === 0 || cur == null || !isFinite(cur)) return null;
      return (cur - prev) / prev;
    },
  };

  // Zowel spend als omzet moeten een getal zijn: ontbrekende platformomzet (null)
  // gedeeld door spend gaf eerder 0,00× — wat 'niets verdiend' suggereert terwijl
  // we simpelweg niets meten.
  const safeRoas = (rev, spend) => (spend > 0 && rev != null && isFinite(rev) ? rev / spend : null);

  // Oordeel t.o.v. de minimum-ROAS. De marges rond de drempel zijn bewust ruim:
  // onder 0,8× break-even is het verlies structureel, boven 1,3× is er ruimte om
  // te schalen. Daartussen is bijsturen zinvoller dan aan/uit zetten.
  function roasVerdict(roas, minRoas, spend, minSpend) {
    if (spend < minSpend) return { key: "nodata", label: "Te weinig spend", tone: "mute", advice: "Nog geen oordeel — te weinig besteed om betrouwbaar te meten." };
    if (roas == null) return { key: "nodata", label: "Geen data", tone: "mute", advice: "Geen omzet gemeten op dit kanaal." };
    if (minRoas == null) return { key: "unknown", label: "Geen doel", tone: "mute", advice: "Vul brutomarge in om een break-even te berekenen." };
    if (roas < minRoas * 0.8) return { key: "off", label: "Uitzetten", tone: "bad", advice: "Structureel onder break-even — pauzeren of grondig herzien." };
    if (roas < minRoas) return { key: "fix", label: "Bijsturen", tone: "warn", advice: "Net onder break-even — bied, doelgroep of creatie bijstellen." };
    if (roas > minRoas * 1.3) return { key: "scale", label: "Schalen", tone: "good", advice: "Ruim boven break-even — budget verhogen kan uit." };
    return { key: "hold", label: "Houden", tone: "ok", advice: "Boven break-even, maar zonder marge om te schalen." };
  }

  function roasBadge(v) {
    const colors = {
      good: "background:var(--positive-bg); color:var(--positive);",
      ok: "background:var(--surface-strong); color:var(--fg);",
      warn: "background:var(--warning-bg); color:var(--warning);",
      bad: "background:var(--negative-bg); color:var(--negative);",
      mute: "background:var(--surface-mute); color:var(--fg-muted);",
    };
    return `<span class="badge" style="${colors[v.tone] || colors.mute}">${escapeHtml(v.label)}</span>`;
  }

  function roasDeltaHtml(cur, prev, label) {
    const d = roasFmt.delta(cur, prev);
    if (d == null) return `<div class="delta"><span class="vs">geen vergelijking</span></div>`;
    const dir = d >= 0 ? "up" : "down";
    return `<div class="delta ${dir}">${d >= 0 ? "↑" : "↓"} ${(Math.abs(d) * 100).toFixed(1)}% <span class="vs">${escapeHtml(label)}</span></div>`;
  }

  /* ---------- Render ---------- */

  function renderRoas() {
    const root = $("#roas-content");
    if (!root) return;

    if (!state.session?.hasWindsor) {
      root.innerHTML = renderAnalysisEmpty(`<p class="muted" style="margin:0;">De ROAS-tab draait op Windsor-data. Voor deze klant is geen Windsor-koppeling geconfigureerd.</p>`);
      return;
    }
    const periodBar = renderRoasPeriodBar();
    if (state.roasLoading) {
      root.innerHTML = periodBar + renderAnalysisEmpty(`<p class="muted" style="margin:0;">ROAS-data laden…</p>`);
      return;
    }
    if (state.roasError) {
      root.innerHTML = periodBar + renderAnalysisEmpty(`<p style="color:var(--negative); margin:0;">${escapeHtml(state.roasError)}</p>
        <button class="btn primary" style="margin-top:14px;" onclick="window.__refreshRoas()">Opnieuw proberen</button>`);
      return;
    }
    const r = state.roas;
    if (!r) { root.innerHTML = periodBar; return; }

    if (!r.hasGa4 && (!r.channels || !r.channels.length)) {
      root.innerHTML = periodBar + renderAnalysisEmpty(`
        <p class="muted" style="margin:0 0 10px;">Nog geen bronnen gekoppeld voor deze tab.</p>
        <p class="muted" style="margin:0; font-size:12px;">Zet in de <strong>Config-tab</strong> van de klantsheet minstens een <em>GA4 property</em> (voor de omzet) en één ad-account (bv. <em>Meta ad-account</em>) klaar.</p>`);
      return;
    }

    const tab = state.roasTab || "blended";
    const dagen = r.current?.daily || [];
    const laatste = dagen.length ? dagen[dagen.length - 1].date : null;

    root.innerHTML = subtabBar(ROAS_TABS, tab, "__roasTab", datastampHtml(laatste, "Data"))
      + renderRoasHead()
      + periodBar
      + subpane("blended", tab,
          renderRoasHero()
          + splitBlok(renderRoasDailyChart() + renderRoasAdvice(), renderRoasCallouts()))
      + subpane("kanalen", tab,
          renderRoasGroup("social", "Paid social") + renderRoasGroup("search", "Paid search"))
      + subpane("breakeven", tab, renderRoasBreakEven())
      + subpane("verantwoording", tab, renderRoasFootnote());
  }

  const ROAS_TABS = [
    { key: "blended", label: "Blended" },
    { key: "kanalen", label: "Kanalen" },
    { key: "breakeven", label: "Break-even" },
    { key: "verantwoording", label: "Verantwoording" },
  ];

  window.__roasTab = (k) => { state.roasTab = k; renderRoas(); };

  // De kanaalregistratie (label, groep) en de meting staan los van elkaar: de
  // definitie komt uit _channels.js, de cijfers uit de respons. Eén helper die ze
  // samenvoegt, zodat kop en callouts niet allebei dezelfde fout kunnen maken.
  function roasChannelRows() {
    const r = state.roas;
    if (!r || !r.current) return [];
    const cur = r.current;
    return (r.channels || []).map(c => {
      const d = (cur.channels || {})[c.key] || {};
      return {
        label: c.label,
        group: c.group,
        spend: d.spend || 0,
        roas: safeRoas(roasRevenueOf(d), d.spend),
        ga4: safeRoas(d.ga4Available === false ? null : d.ga4Revenue, d.spend),
        plat: d.platformRevenueAvailable === false ? null : safeRoas(d.platformRevenue, d.spend),
        degraded: !!d.degradedReason,
      };
    }).filter(c => c.spend > 0);
  }

  function renderRoasHead() {
    const r = state.roas;
    const cur = r.current;
    const min = roasMinTarget();
    const spend = cur.totals.spend;
    const omzet = cur.totals.revenueAvailable === false ? null : cur.totals.revenue;
    const blended = safeRoas(omzet, spend);
    const modus = roasMode();
    const modusLabel = modus === "platform" ? "platform-omzet" : "GA4-omzet";
    const uitConfig = !state.roasRevenueMode && roasConfigMode();

    let kop = "Kosten en opbrengst van deze maand";
    if (blended != null && min.value) {
      const boven = blended >= min.value;
      // Hoeveel kanalen staan aan de andere kant van de drempel? Dat maakt het
      // verschil tussen 'het loopt' en 'het loopt, maar niet overal'.
      const beoordeeld = roasChannelRows().filter(c => c.roas != null);
      const onder = beoordeeld.filter(c => c.roas < min.value).length;
      kop = boven
        ? (onder
            ? `Boven break-even op ${escapeHtml(modusLabel)}, <b>maar niet op elk kanaal</b>`
            : `<b>Boven break-even</b> op ${escapeHtml(modusLabel)}, en op elk gemeten kanaal`)
        : `<b>Onder break-even</b>: ${roasFmt.ratio(blended)} tegen een drempel van ${roasFmt.ratio(min.value)}`;
    } else if (blended != null) {
      kop = `Blended ROAS staat op <b>${roasFmt.ratio(blended)}</b>`;
    } else if (spend) {
      kop = `${roasFmt.eur(spend)} aan advertenties, <b>omzet nog niet gemeten</b>`;
    }

    return `<div class="report-head">
      <p class="eyebrow">Blended MER · ${escapeHtml(roasRange(state.roasPeriod).label)}</p>
      <h2 class="report-title">${kop}</h2>
      <p class="report-lede">Twee omzetdefinities, nooit opgeteld: wat GA4 op last click meet, en wat het kanaal zelf claimt.
      Het oordeel volgt ${escapeHtml(modusLabel)}${uitConfig ? ", zoals in de Config-tab staat" : ""}.</p>
    </div>`;
  }

  function renderRoasCallouts() {
    const r = state.roas;
    const cur = r.current;
    const min = roasMinTarget();
    const kaarten = [];
    const rijen = roasChannelRows();
    const beoordeeld = rijen.filter(c => c.roas != null);

    // Wat werkt: het sterkste kanaal boven de drempel.
    const sterk = beoordeeld.slice().sort((a, b) => (b.roas || 0) - (a.roas || 0))[0];
    if (sterk && (!min.value || sterk.roas >= min.value)) {
      kaarten.push(callout("good", "+", "Wat werkt",
        `<b>${escapeHtml(sterk.label)}</b> haalt ${roasFmt.ratio(sterk.roas)} op ${roasFmt.eur(sterk.spend)} kosten`
        + `${min.value ? ` — ${((sterk.roas / min.value - 1) * 100).toFixed(0)}% boven de drempel` : ""}.`));
    }

    // De twee meetlatten: platform claimt meer dan GA4 meet.
    const ga4 = cur.totals.revenueAvailable === false ? null : safeRoas(cur.totals.revenue, cur.totals.spend);
    const plat = cur.totals.platformRevenue != null ? safeRoas(cur.totals.platformRevenue, cur.totals.spend) : null;
    if (ga4 != null && plat != null) {
      const uiteen = min.value && ((ga4 < min.value) !== (plat < min.value));
      kaarten.push(callout("watch", "!", uiteen ? "De twee meetlatten liggen uiteen" : "Twee meetlatten",
        `GA4 meet <b>${roasFmt.ratio(ga4)}</b>, de platforms claimen <b>${roasFmt.ratio(plat)}</b> — die laatste telt view-through mee. `
        + (uiteen
          ? `De drempel van ${roasFmt.ratio(min.value)} ligt daartussen, dus welke meetlat je kiest bepaalt het oordeel.`
          : `Optellen mag nooit; het is dezelfde omzet, twee keer geteld.`)));
    }

    // Kanalen zonder omzetveld krijgen geen oordeel.
    const ongemeten = rijen.filter(c => c.roas == null);
    if (ongemeten.length) {
      kaarten.push(callout("watch", "!", "Zonder oordeel",
        `${ongemeten.map(c => `<b>${escapeHtml(c.label)}</b>`).join(", ")} `
        + `${ongemeten.length === 1 ? "levert" : "leveren"} kosten maar geen gemeten omzet. `
        + `Een ROAS van 0 zou 'uitzetten' opleveren terwijl er niets gemeten is, dus daar staat een streepje.`));
    }

    // Hoe de drempel ontstaat.
    kaarten.push(callout("info", "↗", "Hoe de drempel ontstaat",
      min.value
        ? `(1 − korting) ÷ (brutomarge − korting) = <b>${roasFmt.ratio(min.value)}</b>. `
          + `Pas marge of korting aan op het blad Break-even om een scenario door te rekenen — dat wordt niet bewaard.`
        : `Zonder <b>Brutomarge</b> in de Config-tab is er geen drempel. Alle ROAS-cijfers blijven staan, maar er komt geen oordeel bij.`));

    return kaarten.join("")
      + `<p class="callout-foot">Een kanaal verschijnt zodra er een account-id voor in de Config-tab staat. `
      + `Ontbrekende data is onbekend, nooit nul — daarom streepjes in plaats van nullen.</p>`;
  }

  function renderRoasPeriodBar() {
    const range = roasRange(state.roasPeriod);
    const cmp = roasCompareRange(range);
    const buttons = ROAS_PERIODS.map(p =>
      `<button class="${p.key === state.roasPeriod ? "on" : ""}" onclick="window.__roasPeriod('${p.key}')">${escapeHtml(p.label)}</button>`
    ).join("");
    const modes = [
      { key: "ga4", label: "GA4-omzet" },
      { key: "platform", label: "Platform-omzet" },
    ].map(m => `<button class="${m.key === roasMode() ? "on" : ""}" onclick="window.__roasRevenueMode('${m.key}')">${escapeHtml(m.label)}</button>`).join("");
    const cfgMode = roasConfigMode();
    const noGa4 = state.roas && state.roas.hasGa4 === false;
    const modeHint = (noGa4 && !state.roasRevenueMode)
      ? "geen GA4-property — platform-omzet is de enige bron"
      : cfgMode
      ? (state.roasRevenueMode && state.roasRevenueMode !== cfgMode
          ? `afwijkend van de Config-tab (daar staat ${cfgMode === "ga4" ? "GA4-omzet" : "platform-omzet"})`
          : "standaard uit de Config-tab ('Oordeel op')")
      : "standaard GA4 — zet 'Oordeel op' in de Config-tab om dit per klant vast te leggen";

    return `<section class="panel" style="padding:14px 18px; margin-bottom:16px;">
      <div class="roas-bar">
        <div>
          <div class="info-label">Periode</div>
          <div style="font-size:20px; color:var(--fg); margin-top:2px;">${escapeHtml(range.label)}</div>
          <div class="muted" style="font-size:11px; margin-top:2px;">vergeleken met ${escapeHtml(cmp.start)} → ${escapeHtml(cmp.end)}</div>
        </div>
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <div class="period-toggle">${buttons}</div>
          <div style="display:flex; flex-direction:column; gap:3px; align-items:flex-end;">
            <div class="period-toggle" title="Bepaalt welke omzetdefinitie in de kaarten en het oordeel gebruikt wordt">${modes}</div>
            <span class="muted" style="font-size:10px;">${escapeHtml(modeHint)}</span>
          </div>
          <button class="btn tiny" onclick="window.__refreshRoas()">↻ Verversen</button>
        </div>
      </div>
    </section>`;
  }

  // Omzet van een kanaal volgens de actieve definitie. Platformomzet kan ontbreken
  // (connector kent het veld niet) — dan null i.p.v. 0, zodat de ROAS '—' toont.
  function roasRevenueOf(obj) {
    if (roasMode() === "platform") {
      return obj.platformRevenueAvailable === false ? null : obj.platformRevenue;
    }
    return obj.ga4Available === false ? null : obj.ga4Revenue;
  }

  function renderRoasHero() {
    const r = state.roas;
    const cur = r.current, prev = r.previous;
    const min = roasMinTarget();

    const totalSpend = cur.totals.spend;
    // Zonder GA4 is de totale webshopomzet onbekend → geen blended ROAS, geen 0,00×.
    const totalRevenue = cur.totals.revenueAvailable === false ? null : cur.totals.revenue;
    const totalRoas = safeRoas(totalRevenue, totalSpend);
    const prevTotalRoas = prev ? safeRoas(prev.totals.revenueAvailable === false ? null : prev.totals.revenue, prev.totals.spend) : null;

    const card = (opts) => {
      const bar = (opts.roas != null && min.value)
        ? `<div class="roas-target-bar" title="${escapeHtml(opts.roas >= min.value ? "Boven" : "Onder")} de minimum-ROAS van ${roasFmt.ratio(min.value)}">
             <div class="fill ${opts.roas >= min.value ? "ok" : "under"}" style="width:${Math.min(100, (opts.roas / (min.value * 1.5)) * 100).toFixed(1)}%;"></div>
             <div class="mark" style="left:66.6%;" title="Break-even ${roasFmt.ratio(min.value)}"></div>
           </div>
           <div class="muted" style="font-size:10px; margin-top:4px;">drempel ${roasFmt.ratio(min.value)}</div>`
        : `<div class="muted" style="font-size:10px; margin-top:8px;">${min.value ? "" : "geen drempel ingesteld"}</div>`;
      return `<div class="kpi-card">
        <div class="label"><span class="dot" style="background:var(${opts.cvar})"></span>${escapeHtml(opts.label)}</div>
        <div class="value">${roasFmt.ratio(opts.roas)}</div>
        ${roasDeltaHtml(opts.roas, opts.prevRoas, "vs vorig jaar")}
        <div class="muted" style="font-size:11px; margin-top:8px;">${opts.revenue == null ? "geen omzetdata" : roasFmt.eur(opts.revenue) + " omzet"} · ${roasFmt.eur(opts.spend)} spend</div>
        ${bar}
      </div>`;
    };

    const groupCard = (grp, label, cvar) => {
      const g = cur.groups[grp];
      const pg = prev ? prev.groups[grp] : null;
      if (!g || !g.channels.length) {
        return `<div class="kpi-card" style="opacity:0.72;">
          <div class="label"><span class="dot" style="background:var(--fg-muted)"></span>${escapeHtml(label)}</div>
          <div class="value compact">Niet gekoppeld</div>
          <div class="muted" style="font-size:11px; margin-top:10px;">Geen ad-account voor dit type in de Config-tab.</div>
        </div>`;
      }
      const rev = roasRevenueOf(g);
      const prevRev = pg ? roasRevenueOf(pg) : null;
      return card({
        label, cvar,
        roas: safeRoas(rev, g.spend),
        prevRoas: pg ? safeRoas(prevRev, pg.spend) : null,
        revenue: rev, spend: g.spend,
      });
    };

    return `<div class="kpi-grid" style="margin-bottom:16px;">
      ${card({
        label: "Totale ROAS (blended)", cvar: "--kpi-1",
        roas: totalRoas, prevRoas: prevTotalRoas,
        revenue: totalRevenue, spend: totalSpend,
      })}
      ${groupCard("social", "Paid social", "--kpi-2")}
      ${groupCard("search", "Paid search", "--kpi-3")}
    </div>`;
  }

  function renderRoasDailyChart() {
    const cur = state.roas?.current;
    if (!cur || !cur.daily.length || !window.Charts) return "";
    const days = cur.daily.filter(d => d.spend > 0 || d.revenue > 0);
    if (days.length < 2) return "";
    const min = roasMinTarget();
    // Zonder GA4 is er geen omzetlijn en dus ook geen ROAS-lijn: dan alleen de
    // kosten tonen, met een titel die klopt. Een nullijn zou 0,00× suggereren.
    const hasRevenue = cur.totals.revenueAvailable !== false;

    // Geen tweede as: euro's en een verhouding zijn twee eenheden. Twee grafieken
    // onder elkaar, elk met een eigen nulas, in plaats van één met twee assen —
    // die laatste laat je de reeksen vergelijken die niets met elkaar te maken
    // hebben.
    const xDagen = days.map(d => { const [y, m, dd] = d.date.split("-"); return `${Number(dd)}/${Number(m)}`; });
    const specGeld = {
      width: 980, height: hasRevenue ? 210 : 260,
      x: xDagen,
      series: [
        ...(hasRevenue ? [{ label: "Omzet", values: days.map(d => d.revenue), kind: "area", axis: "left", color: Charts.seriesColor(0) }] : []),
        { label: "Advertentiekosten", values: days.map(d => d.spend), kind: hasRevenue ? "bar" : "area", axis: "left", color: Charts.seriesColor(1) },
      ],
      leftFormat: Charts.fmt.euroK,
      maxXLabels: 10,
    };
    const specRatio = hasRevenue ? {
      width: 980, height: 132,
      x: xDagen,
      series: [{
        label: "Blended ROAS",
        values: days.map(d => (d.spend > 0 ? d.revenue / d.spend : 0)),
        kind: "line", axis: "left", color: Charts.seriesColor(2),
      }],
      leftFormat: (v) => v.toFixed(1).replace(".", ",") + "×",
      maxXLabels: 10,
    } : null;
    return `<section class="tub-wrap" style="margin-bottom:16px;">
      <div class="panel-header" style="padding:0 2px;">
        <div>
          <h2 class="panel-title">${hasRevenue ? "Dagelijkse ROAS" : "Advertentiekosten per dag"}</h2>
          <div class="panel-sub">${hasRevenue
            ? `Totale webshopomzet vs. advertentiekosten per dag${min.value ? ` · drempel ${roasFmt.ratio(min.value)}` : ""}`
            : "Koppel een GA4-property in de Config-tab om hier de omzet en de blended ROAS bij te zien"}</div>
        </div>
      </div>
      <div class="chart-tub">
        ${chartSvg(specGeld)}
        ${specRatio ? `<h3 class="label-head" style="margin:18px 0 8px;">Blended ROAS per dag${min.value ? ` · drempel ${roasFmt.ratio(min.value)}` : ""}</h3>
        ${chartSvg(specRatio)}` : ""}
      </div>
      <p class="source-line">Bron: GA4 <b>purchase_revenue</b> per <b>session_source_medium</b>, kosten per kanaal op campagneniveau</p>
    </section>`;
  }

  function renderRoasGroup(grp, title) {
    const r = state.roas;
    const cur = r.current, prev = r.previous;
    const chans = (r.channels || []).filter(c => c.group === grp);
    const pend = (r.pending || []).filter(c => c.group === grp);
    const g = cur.groups[grp];
    const min = roasMinTarget();

    const pendLine = pend.length
      ? `<div class="muted" style="font-size:11px; margin-top:12px;">Nog niet gekoppeld: ${pend.map(c => escapeHtml(c.label)).join(" · ")} — voeg het ad-account toe in de Config-tab en het kanaal verschijnt hier automatisch.</div>`
      : "";

    if (!chans.length) {
      return `<section class="panel" style="margin-bottom:16px;">
        <div class="panel-header"><div>
          <h2 class="panel-title">${escapeHtml(title)}</h2>
          <div class="panel-sub">Geen kanaal van dit type gekoppeld</div>
        </div></div>
        ${pendLine}
      </section>`;
    }

    // Eén rij per kanaal + een restregel voor betaalde GA4-omzet die geen enkel
    // kanaal matcht (verkeerd getagde UTM's, of een platform zonder connector).
    const rows = chans.map(c => {
      const d = cur.channels[c.key] || {};
      const pd = prev ? (prev.channels[c.key] || {}) : null;
      const ga4Roas = safeRoas(d.ga4Available === false ? null : d.ga4Revenue, d.spend);
      const platRoas = d.platformRevenueAvailable === false ? null : safeRoas(d.platformRevenue, d.spend);
      const activeRoas = safeRoas(roasRevenueOf(d), d.spend);
      const prevRoas = pd ? safeRoas(roasRevenueOf(pd), pd.spend) : null;
      const verdict = roasVerdict(activeRoas, min.value, d.spend, 25);
      const delta = roasFmt.delta(activeRoas, prevRoas);
      const warn = d.error
        ? `<div class="muted" style="font-size:10px; color:var(--negative);">${escapeHtml(d.error)}</div>`
        : (d.degradedReason ? `<div class="muted" style="font-size:10px;">Platformomzet niet beschikbaar voor deze connector.</div>` : "");
      // De twee attributiebronnen kunnen aan wéérszijden van de drempel uitkomen.
      // Dat is geen detail: het bepaalt of je dit kanaal uitzet of opschaalt, dus
      // vermelden we het expliciet in plaats van de actieve definitie te laten winnen.
      const split = (min.value && ga4Roas != null && platRoas != null
        && (ga4Roas < min.value) !== (platRoas < min.value))
        ? `<div class="muted" style="font-size:10px;">⚠ GA4 en het platform zijn het oneens over de drempel — beslis niet op één bron.</div>`
        : "";
      return `<tr>
        <td><strong>${escapeHtml(c.label)}</strong>${c.verified ? "" : ` <span class="muted" style="font-size:10px;">(velden nog te bevestigen)</span>`}${warn}${split}</td>
        <td class="right">${roasFmt.eur(d.spend)}</td>
        <td class="right">${roasFmt.eurOrDash(d.ga4Available === false ? null : d.ga4Revenue)}</td>
        <td class="right"><strong>${roasFmt.ratio(ga4Roas)}</strong></td>
        <td class="right">${d.platformRevenueAvailable === false ? "—" : roasFmt.eur(d.platformRevenue)}</td>
        <td class="right">${roasFmt.ratio(platRoas)}</td>
        <td class="right">${delta == null ? "—" : `<span class="${delta >= 0 ? "delta up" : "delta down"}" style="display:inline;">${delta >= 0 ? "↑" : "↓"} ${(Math.abs(delta) * 100).toFixed(0)}%</span>`}</td>
        <td class="right">${roasBadge(verdict)}</td>
      </tr>`;
    }).join("");

    const rest = (g.unmatchedGa4Revenue || 0) > 0
      ? `<tr style="opacity:0.7;">
          <td>Overig betaald verkeer<div class="muted" style="font-size:10px;">GA4-omzet in deze channel group die aan geen gekoppeld kanaal toegewezen kon worden.</div></td>
          <td class="right">—</td>
          <td class="right">${roasFmt.eur(g.unmatchedGa4Revenue)}</td>
          <td class="right">—</td><td class="right">—</td><td class="right">—</td><td class="right">—</td><td class="right">—</td>
        </tr>`
      : "";

    const groupRev = roasRevenueOf(g);
    const total = `<tr style="border-top:2px solid var(--border); font-weight:600;">
      <td>Totaal ${escapeHtml(title.toLowerCase())}</td>
      <td class="right">${roasFmt.eur(g.spend)}</td>
      <td class="right">${roasFmt.eurOrDash(g.ga4Revenue)}</td>
      <td class="right">${roasFmt.ratio(safeRoas(g.ga4Revenue, g.spend))}</td>
      <td class="right">${g.platformRevenueAvailable === false ? "—" : roasFmt.eur(g.platformRevenue)}</td>
      <td class="right">${g.platformRevenueAvailable === false ? "—" : roasFmt.ratio(safeRoas(g.platformRevenue, g.spend))}</td>
      <td class="right">—</td>
      <td class="right">${roasBadge(roasVerdict(safeRoas(groupRev, g.spend), min.value, g.spend, 25))}</td>
    </tr>`;

    return `<section class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><div>
        <h2 class="panel-title">${escapeHtml(title)}</h2>
        <div class="panel-sub">${chans.length} kanaal${chans.length === 1 ? "" : "en"} · oordeel op ${roasMode() === "platform" ? "platform-omzet" : "GA4-omzet"} t.o.v. ${escapeHtml(min.source || "geen drempel")}</div>
      </div></div>
      <div class="lib-table"><table>
        <thead><tr>
          <th>Kanaal</th>
          <th class="right">Spend</th>
          <th class="right">GA4-omzet</th>
          <th class="right">GA4-ROAS</th>
          <th class="right">Platform-omzet</th>
          <th class="right">Platform-ROAS</th>
          <th class="right">vs vorig jaar</th>
          <th class="right">Oordeel</th>
        </tr></thead>
        <tbody>${rows}${rest}${total}</tbody>
      </table></div>
      ${pendLine}
    </section>`;
  }

  function renderRoasBreakEven() {
    const p = roasParams();
    const scenarios = roasScenarios(p);
    const min = roasMinTarget();
    const cfg = state.roas?.roasConfig || {};
    const edited = Object.entries(state.roasInputs).some(([k, v]) => v != null);

    const field = (key, label) => {
      const v = state.roasInputs[key] != null ? state.roasInputs[key] : (typeof cfg[key] === "number" ? cfg[key] : null);
      const shown = v == null ? "" : String(Math.round(v * 1000) / 10).replace(".", ",");
      return `<label class="roas-field">
        <span>${escapeHtml(label)}</span>
        <span class="roas-input"><input type="text" inputmode="decimal" value="${escapeHtml(shown)}" placeholder="—"
          onchange="window.__roasInput('${key}', this.value)"><span class="suffix">%</span></span>
      </label>`;
    };

    // Twee scenario's: volle prijs en de lopende seizoenskorting. Het geselecteerde
    // scenario is de drempel waartegen kanalen en campagnes beoordeeld worden.
    const scenarioRows = scenarios.map(w => `<tr class="${w.key === p.activeScenario ? "on" : ""}" onclick="window.__roasScenario('${w.key}')" style="cursor:pointer;">
        <td><input type="radio" ${w.key === p.activeScenario ? "checked" : ""} onclick="window.__roasScenario('${w.key}')"> ${escapeHtml(w.label)}</td>
        <td class="right">${roasFmt.pct(w.discount)}</td>
        <td class="right">${roasFmt.pct(w.netMargin)}</td>
        <td class="right"><strong>${w.loss ? "verlies" : roasFmt.ratio(w.breakEven)}</strong></td>
      </tr>`).join("");

    const body = scenarios.length
      ? `<div class="lib-table" style="margin-top:14px;"><table>
          <thead><tr><th>Scenario</th><th class="right">Korting</th><th class="right">Marge na korting</th><th class="right">Break-even ROAS</th></tr></thead>
          <tbody>${scenarioRows}</tbody>
        </table></div>
        <p class="muted" style="font-size:11px; margin:12px 0 0;">
          Break-even = (1 − korting) / (brutomarge − korting). Kies het scenario dat nu loopt; dat is de drempel
          voor het oordeel. Is de korting gelijk aan of groter dan de brutomarge, dan blijft er geen marge over
          om advertenties uit te betalen — dan is er geen haalbare ROAS.
        </p>`
      : `<p class="muted" style="margin:14px 0 0;">Vul een brutomarge in (of zet <strong>Brutomarge</strong> in de Config-tab) om de break-even-ROAS te berekenen.</p>`;

    return `<section class="panel" style="margin-bottom:16px;">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Break-even ROAS</h2>
          <div class="panel-sub">${p.fromConfig.grossMargin ? "Basis uit de Config-tab" : "Nog niets in de Config-tab"}${edited ? " · aangepast voor dit scenario" : ""}</div>
        </div>
        ${edited ? `<button class="btn tiny" onclick="window.__roasResetInputs()">↺ Terug naar Config</button>` : ""}
      </div>
      <div class="roas-fields">
        ${field("grossMargin", "Brutomarge")}
        ${field("seasonalDiscount", "Seizoenskorting")}
      </div>
      ${body}
      ${min.value ? `<div class="roas-target-note">Actieve drempel: <strong>${roasFmt.ratio(min.value)}</strong> — ${escapeHtml(min.source)}</div>` : ""}
    </section>`;
  }

  /* ---------- Advies per campagne ---------- */

  // GA4 kan omzet niet per campagne toewijzen zonder sluitende UTM-tagging, dus
  // campagnes worden beoordeeld op platformomzet. Die claimt structureel meer dan
  // GA4 meet; we schalen hem daarom met de verhouding GA4/platform van het kanaal
  // zélf, zodat de campagne-ROAS op dezelfde meetlat ligt als de break-even.
  function roasCampaignRows() {
    const r = state.roas;
    if (!r?.current) return [];
    const min = roasMinTarget();
    const out = [];
    for (const c of (r.channels || [])) {
      const d = r.current.channels[c.key];
      if (!d || !d.campaigns?.length) continue;
      // Zonder omzetveld van de connector is er per campagne géén omzet bekend.
      // Een ROAS van 0 zou dan 'uitzetten' opleveren terwijl we simpelweg niets
      // meten — die campagnes krijgen expliciet geen oordeel.
      const noRevenue = d.platformRevenueAvailable === false;
      const ratio = (!noRevenue && d.platformRevenue > 0 && d.ga4Revenue != null)
        ? d.ga4Revenue / d.platformRevenue : null;
      for (const camp of d.campaigns) {
        const platRoas = noRevenue ? null : safeRoas(camp.platformRevenue, camp.spend);
        const corrected = (platRoas != null && ratio != null) ? platRoas * ratio : null;
        const judged = corrected != null ? corrected : platRoas;
        out.push({
          channel: c.label, group: c.group, name: camp.name,
          spend: camp.spend,
          platformRevenue: noRevenue ? null : camp.platformRevenue,
          platRoas, corrected, judged, ratio, noRevenue,
          verdict: noRevenue
            ? { key: "norevenue", label: "Geen omzetdata", tone: "mute", advice: `Deze connector levert geen omzet per campagne — beoordeel ${c.label} op kanaalniveau.` }
            : roasVerdict(judged, min.value, camp.spend, 25),
        });
      }
    }
    return out.sort((a, b) => b.spend - a.spend);
  }

  function renderRoasAdvice() {
    const rows = roasCampaignRows();
    const min = roasMinTarget();
    if (!rows.length) {
      return `<section class="panel" style="margin-bottom:16px;">
        <div class="panel-header"><div>
          <h2 class="panel-title">Advies per campagne</h2>
          <div class="panel-sub">Geen campagnedata in deze periode</div>
        </div></div>
      </section>`;
    }

    const order = { off: 0, fix: 1, hold: 2, scale: 3, nodata: 4, norevenue: 5, unknown: 6 };
    const sorted = [...rows].sort((a, b) => (order[a.verdict.key] - order[b.verdict.key]) || (b.spend - a.spend));

    const counts = sorted.reduce((acc, x) => { acc[x.verdict.key] = (acc[x.verdict.key] || 0) + 1; return acc; }, {});
    const wasted = sorted.filter(x => x.verdict.key === "off").reduce((s, x) => s + x.spend, 0);

    const summary = min.value
      ? `<div class="roas-advice-summary">
          <div><strong>${counts.off || 0}</strong> uitzetten · <strong>${counts.fix || 0}</strong> bijsturen · <strong>${counts.scale || 0}</strong> schalen</div>
          ${wasted > 0 ? `<div class="muted">${roasFmt.eur(wasted)} spend zit in campagnes onder 0,8× de drempel.</div>` : ""}
        </div>`
      : `<div class="roas-advice-summary"><div class="muted">Vul een brutomarge in om campagnes tegen een break-even te beoordelen.</div></div>`;

    const body = sorted.map(x => `<tr${x.noRevenue ? ' style="opacity:0.72;"' : ''}>
      <td><strong>${escapeHtml(x.name)}</strong><div class="muted" style="font-size:10px;">${escapeHtml(x.channel)}</div></td>
      <td class="right">${roasFmt.eur(x.spend)}</td>
      <td class="right">${x.noRevenue ? "—" : roasFmt.eur(x.platformRevenue)}</td>
      <td class="right">${roasFmt.ratio(x.platRoas)}</td>
      <td class="right"><strong>${roasFmt.ratio(x.corrected)}</strong></td>
      <td class="right">${roasBadge(x.verdict)}</td>
      <td class="muted" style="font-size:11px;">${escapeHtml(x.verdict.advice)}</td>
    </tr>`).join("");

    return `<section class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><div>
        <h2 class="panel-title">Advies per campagne</h2>
        <div class="panel-sub">Beoordeeld tegen ${escapeHtml(min.source || "geen drempel")}${min.value ? ` (${roasFmt.ratio(min.value)})` : ""}</div>
      </div></div>
      ${summary}
      <div class="lib-table" style="margin-top:12px;"><table>
        <thead><tr>
          <th>Campagne</th>
          <th class="right">Spend</th>
          <th class="right">Platform-omzet</th>
          <th class="right">Platform-ROAS</th>
          <th class="right">Gecorrigeerd</th>
          <th class="right">Oordeel</th>
          <th>Waarom</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table></div>
      <p class="muted" style="font-size:11px; margin:12px 0 0;">
        Campagnes worden op platformomzet beoordeeld — GA4 kan omzet niet per campagne toewijzen zonder sluitende
        UTM-tagging. De kolom <em>Gecorrigeerd</em> schaalt de platform-ROAS met de GA4/platform-verhouding van het
        kanaal, zodat hij op dezelfde meetlat ligt als de break-even. Campagnes onder ${roasFmt.eur(25)} spend krijgen
        geen oordeel.
      </p>
    </section>`;
  }

  function renderRoasFootnote() {
    const r = state.roas;
    const errs = [];
    if (r.current?.errors?.ga4Totals) errs.push(`GA4-totalen: ${r.current.errors.ga4Totals}`);
    if (r.current?.errors?.ga4Split) errs.push(`GA4-uitsplitsing: ${r.current.errors.ga4Split}`);
    if (r.previousError) errs.push(`Vergelijkingsperiode: ${r.previousError}`);
    if (!r.hasGa4) errs.push("Geen GA4-property in de Config-tab — zonder GA4 is er geen blended omzet en geen GA4-ROAS.");

    const errHtml = errs.length
      ? `<div style="margin-top:10px; font-size:11px; color:var(--negative);">${errs.map(e => escapeHtml(e)).join("<br>")}</div>`
      : "";

    return `<section class="panel">
      <div class="panel-header"><div>
        <h2 class="panel-title">Hoe deze cijfers berekend zijn</h2>
        <div class="panel-sub">Zodat het oordeel navolgbaar blijft</div>
      </div></div>
      <ul class="roas-notes">
        <li><strong>Totale ROAS (blended)</strong> = alle webshopomzet uit GA4 gedeeld door álle advertentiekosten samen. Ook omzet uit organisch, e-mail en direct zit erin: dit is de MER, geen kanaalprestatie.</li>
        <li><strong>GA4-ROAS per kanaal</strong> = GA4-omzet op last-click-basis gedeeld door de spend van dat kanaal. Eén meetlat voor alle kanalen; telt niet dubbel.</li>
        <li><strong>Platform-ROAS</strong> = de omzet die het platform zelf claimt. Inclusief view-through en een eigen attributievenster, dus structureel hoger. Kanalen claimen dezelfde sale: optellen mag niet.</li>
        <li><strong>Break-even</strong> = (1 − korting) / (brutomarge − korting), voor volle prijs en voor de lopende seizoenskorting. Het gekozen scenario bepaalt de drempel voor het oordeel.</li>
        <li><strong>Welke omzet het oordeel bepaalt</strong> staat per klant in de Config-tab onder <strong>Oordeel op</strong> (<em>GA4</em> of <em>Platform</em>). Met sluitende server-side tracking is GA4 betrouwbaar; zonder goede consent-dekking onderschat GA4 en is platform realistischer. De toggle bovenaan overschrijft dit voor deze sessie.</li>
        <li>Een kanaal verschijnt zodra het bijbehorende ad-account in de <strong>Config-tab</strong> van de klantsheet staat.</li>
      </ul>
      ${errHtml}
    </section>`;
  }

  /* ==========================================================
     Website-tab — analytics-overzicht van de site zelf
     ==========================================================
     Bron: GA4 (verkeer, gedrag, conversie) + Search Console (organisch zoeken),
     allebei via api/windsor.js action=getWebsite. Bewust GEEN spend of ROAS:
     die horen in de ROAS-tab, anders staan er twee antwoorden op dezelfde vraag.

     Deze tab volgt WEL de periode uit de topbar (anders dan de ROAS-tab, die een
     eigen maandperiode heeft): een website-overzicht hoort bij hetzelfde ritme als
     Overview en Analysis.
     ========================================================== */

  const WEB_COMPARE = [
    { key: "prev", label: "vs vorige periode" },
    { key: "yoy", label: "vs vorig jaar" },
  ];

  // Datumrekenen zonder toISOString(): dat zet een lokale middernacht in UTC+2 op
  // de dag ervoor. Zelfde aanpak als de ROAS-tab (ymd/pad2 hierboven).
  const webAtNoon = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d, 12); };
  const webIso = (dt) => ymd(dt.getFullYear(), dt.getMonth(), dt.getDate());

  // Even lange periode, direct vóór de huidige.
  function webPrevRange(start, end) {
    const days = Math.round((webAtNoon(end) - webAtNoon(start)) / 86400000) + 1;
    const e = webAtNoon(start); e.setDate(e.getDate() - 1);
    const s = new Date(e); s.setDate(s.getDate() - (days - 1));
    return { start: webIso(s), end: webIso(e) };
  }

  function websiteFetch() {
    if (!state.session) return;
    const start = state.period.start, end = state.period.end;
    if (!start || !end) return;
    const key = `${state.session.clientId}|${start}|${end}`;
    if (state.websiteLoading) return;
    if (state.website && state.websiteKey === key) { renderWebsite(); return; }
    if (!state.session.hasWindsor) { renderWebsite(); return; }

    const prev = webPrevRange(start, end);
    const yoy = roasCompareRange({ start, end });

    state.websiteLoading = true;
    state.websiteError = null;
    state.website = null;
    state.websiteKey = key;
    renderWebsite();

    windsorCall("getWebsite", {
      startDate: start, endDate: end,
      compareStartDate: prev.start, compareEndDate: prev.end,
      yearAgoStartDate: yoy.start, yearAgoEndDate: yoy.end,
    })
      .then((res) => {
        if (state.websiteKey !== key) return;   // periode gewisseld tijdens fetch
        state.website = res;
        state.websiteLoading = false;
        renderWebsite();
      })
      .catch((err) => {
        if (state.websiteKey !== key) return;
        state.websiteLoading = false;
        state.websiteError = err.message || "Onbekende fout bij laden websitedata.";
        if (err.status === 401) { clearSession(); setTimeout(() => showScreen("login-screen"), 600); }
        renderWebsite();
      });
  }
  window.__refreshWebsite = () => { state.website = null; state.websiteKey = null; websiteFetch(); };
  window.__webCompare = (k) => { state.websiteCompare = k; renderWebsite(); };

  /* ---------- Formatters ---------- */

  // null = niet gemeten. Overal een streepje, nooit een nul: '0 sessies' en 'niet
  // gekoppeld' zijn twee verschillende antwoorden.
  const webFmt = {
    int: (n) => (n == null || !isFinite(n)) ? "—" : Math.round(n).toLocaleString("nl-NL"),
    pct1: (n) => (n == null || !isFinite(n)) ? "—" : (n * 100).toFixed(1).replace(".", ",") + "%",
    pct0: (n) => (n == null || !isFinite(n)) ? "—" : (n * 100).toFixed(0) + "%",
    pct2: (n) => (n == null || !isFinite(n)) ? "—" : (n * 100).toFixed(2).replace(".", ",") + "%",
    eur: (n) => (n == null || !isFinite(n)) ? "—" : "€ " + Math.round(n).toLocaleString("nl-NL"),
    eur2: (n) => (n == null || !isFinite(n)) ? "—" : "€ " + n.toFixed(2).replace(".", ","),
    dur: (n) => {
      if (n == null || !isFinite(n)) return "—";
      const s = Math.round(n);
      return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
    },
    pos: (n) => (n == null || !isFinite(n)) ? "—" : n.toFixed(1).replace(".", ","),
    // Verhoudingen die boven 1 kunnen uitkomen (key events per sessie): als getal
    // tonen, niet als percentage — '118%' leest als een onmogelijke conversieratio.
    ratio: (n) => (n == null || !isFinite(n)) ? "—" : n.toFixed(2).replace(".", ","),
    delta: (cur, prev) => {
      if (prev == null || !isFinite(prev) || prev === 0 || cur == null || !isFinite(cur)) return null;
      return (cur - prev) / prev;
    },
  };

  // De vergelijkingsperiode waar de deltas tegen afgezet worden.
  function webBase() {
    const w = state.website;
    if (!w) return null;
    return state.websiteCompare === "yoy" ? w.yearAgo : w.previous;
  }
  function webCompareLabel() {
    return (WEB_COMPARE.find(c => c.key === state.websiteCompare) || WEB_COMPARE[0]).label;
  }

  // invert: bij zoekpositie is lager beter, dus daar kleurt een daling groen.
  function webDeltaHtml(cur, prev, invert) {
    const d = webFmt.delta(cur, prev);
    if (d == null) return `<div class="delta"><span class="vs">geen vergelijking</span></div>`;
    const good = invert ? d < 0 : d >= 0;
    return `<div class="delta ${good ? "up" : "down"}">${d >= 0 ? "↑" : "↓"} ${(Math.abs(d) * 100).toFixed(1)}%
      <span class="vs">${escapeHtml(webCompareLabel())}</span></div>`;
  }

  // Het conversiecijfer dat de hele tab gebruikt: het ingestelde hoofddoel als dat
  // meetbaar is, anders álle key events samen. Dat verschil is groot (bij een klant
  // 2.112 formulieren tegenover 72.004 key events), dus het label zegt welk van de
  // twee je ziet.
  function webGoal() {
    const w = state.website;
    const on = !!(w && w.website && w.website.goalAvailable);
    // Een doel kan ingesteld zijn terwijl de eventnaam leeg terugkomt; dan is het
    // label null en viel elke .toLowerCase() erop om.
    const label = on
      ? (w.website.goalLabel || w.website.goalEvent || "Hoofddoel")
      : "Conversies";
    return {
      on,
      label,
      sub: on ? `GA4-event ${w.website.goalEvent}` : "alle key events samen",
      valueOf: (t) => (!t ? null : (on ? t.goalConversions : t.conversions)),
      rateOf: (t) => (!t ? null : (on ? t.goalConversionRate : t.conversionRate)),
      rowOf: (r) => (!r ? null : (on ? r.goalConversions : r.conversions)),
    };
  }

  /* ---------- Kanaalgroepering voor de donut ----------
     GA4 kent een dozijn channel groups; die vatten we samen tot zeven groepen
     die een mens in één oogopslag leest. De volgorde ligt vast, en daarmee de
     kleur: 'organisch' is altijd slice 1, ook als het een keer het kleinste
     stukje is. Kleur volgt het kanaal, niet zijn grootte. */

  const WEB_GROUPS = [
    { key: "organic",  label: "Organisch",  re: /^organic/i },
    { key: "paid",     label: "Betaald",    re: /^(paid|display|cross-network)/i },
    { key: "direct",   label: "Direct",     re: /^direct/i },
    { key: "referral", label: "Verwijzing", re: /^referral/i },
    { key: "email",    label: "E-mail",     re: /^(email|e-mail|mobile push)/i },
    { key: "ai",       label: "AI",         re: /ai\s*assistant|^ai\b|generative/i },
    { key: "other",    label: "Overig",     re: null },   // rest, incl. 'Unassigned'
  ];

  function webGroupOf(channelName) {
    const n = String(channelName || "");
    // AI vóór de rest: GA4 noemt het 'AI Assistant', wat anders onder 'Overig' valt.
    const ai = WEB_GROUPS.find(g => g.key === "ai");
    if (ai.re.test(n)) return "ai";
    for (const g of WEB_GROUPS) {
      if (g.re && g.key !== "ai" && g.re.test(n)) return g.key;
    }
    return "other";
  }

  function donutSvg(spec) {
    if (!window.Charts || !Charts.donut) return "";
    const d = document.createElement("div");
    Charts.donut(d, spec);
    return d.innerHTML;
  }

  /* ---------- Render ---------- */

  /* ---------- Sub-tabs voor pagina's die zichzelf hertekenen ----------
     De Overview-pagina heeft statische panes; de Website- en ROAS-tab bouwen hun
     HTML per keer opnieuw. Daar is een balk die zichzelf meelevert eenvoudiger dan
     panes die in leven moeten blijven: het actieve blad staat in state, dus een
     hertekening houdt hem vast.
     -------------------------------------------------------------------- */

  function subtabBar(tabs, actief, handler, rechts) {
    const knoppen = tabs.map(t =>
      `<button type="button" class="${t.key === actief ? "on" : ""}" aria-selected="${t.key === actief}" `
      + `onclick="window.${handler}('${t.key}')">${escapeHtml(t.label)}</button>`
    ).join("");
    return `<div class="subtabs">${knoppen}<span style="flex-grow:1;"></span>`
      + `${rechts ? `<span style="padding-bottom:9px;">${rechts}</span>` : ""}</div>`;
  }

  function subpane(key, actief, html) {
    return `<div class="subpane ${key === actief ? "on" : ""}" data-subpane="${key}">${html}</div>`;
  }

  // Het lampje rekent tegen vandaag: groen t/m 1 dag, oranje tot 7, daarna rood.
  function datastampHtml(laatsteDag, prefix) {
    if (!laatsteDag) return "";
    const dagen = Math.max(0, Math.round((Date.now() - new Date(laatsteDag + "T12:00:00").getTime()) / 86400000));
    const led = dagen <= 1 ? "fresh" : (dagen <= 7 ? "aging" : "stale");
    const oud = dagen === 0 ? "vandaag bijgewerkt" : (dagen === 1 ? "gisteren bijgewerkt" : `${dagen} dagen achter`);
    return `<span class="datastamp"><span class="led ${led}" aria-hidden="true"></span>`
      + `<span><b>${escapeHtml(prefix || "Data")} t/m ${escapeHtml(laatsteDag.split("-").reverse().join("-"))}</b> — ${oud}</span></span>`;
  }

  function splitBlok(links, callouts) {
    return `<div class="report-split"><div>${links}</div><div class="callouts">${callouts}</div></div>`;
  }

  function renderWebsite() {
    const root = $("#website-content");
    if (!root) return;

    if (!state.session?.hasWindsor) {
      root.innerHTML = renderAnalysisEmpty(`<p class="muted" style="margin:0;">De Website-tab draait op Windsor-data. Voor deze klant is geen Windsor-koppeling geconfigureerd.</p>`);
      return;
    }
    const bar = renderWebsiteBar();
    if (state.websiteLoading) {
      root.innerHTML = bar + renderAnalysisEmpty(`<p class="muted" style="margin:0;">Websitedata laden… (GA4 en Search Console worden parallel opgehaald)</p>`);
      return;
    }
    if (state.websiteError) {
      root.innerHTML = bar + renderAnalysisEmpty(`<p style="color:var(--negative); margin:0;">${escapeHtml(state.websiteError)}</p>
        <button class="btn primary" style="margin-top:14px;" onclick="window.__refreshWebsite()">Opnieuw proberen</button>`);
      return;
    }
    const w = state.website;
    if (!w) { root.innerHTML = bar; return; }

    if (!w.hasGa4 && !w.hasGsc) {
      root.innerHTML = bar + renderAnalysisEmpty(`
        <p class="muted" style="margin:0 0 10px;">Nog geen bronnen gekoppeld voor deze tab.</p>
        <p class="muted" style="margin:0; font-size:12px;">Zet in de <strong>Config-tab</strong> van de klantsheet een <em>GA4 property</em> (verkeer en conversie) en/of een <em>Search Console site</em> (organisch zoeken) klaar.</p>`);
      return;
    }

    // Rapportvorm: één balk met bladen, een kop die een conclusie is, en per blad
    // de blokken die erbij horen. Alles wat er stond blijft bestaan — het staat
    // alleen niet meer als één lange pagina onder elkaar.
    const tab = state.websiteTab || "overzicht";
    const stamp = datastampHtml(webLastDay(), w.current.search?.available ? "Search Console" : "GA4");

    root.innerHTML = subtabBar(WEB_TABS, tab, "__webTab", stamp)
      + renderWebsiteHead()
      + renderWebsiteControls()
      + subpane("overzicht", tab,
          renderWebsiteKpis()
          + splitBlok(renderWebsiteChart() + renderWebsiteFunnel(), renderWebsiteCallouts()))
      + subpane("kanalen", tab, renderWebsiteChannels() + renderWebsiteSources())
      + subpane("landing", tab, renderWebsiteLanding())
      + subpane("zoeken", tab, renderWebsiteSearch())
      + subpane("apparaten", tab, renderWebsiteAudience())
      + subpane("verantwoording", tab, renderWebsiteNotes());
  }

  const WEB_TABS = [
    { key: "overzicht", label: "Overzicht" },
    { key: "kanalen", label: "Kanalen" },
    { key: "landing", label: "Landingspagina's" },
    { key: "zoeken", label: "Zoeken" },
    { key: "apparaten", label: "Apparaten" },
    { key: "verantwoording", label: "Verantwoording" },
  ];

  window.__webTab = (k) => { state.websiteTab = k; renderWebsite(); };

  // De laatste dag met data: Search Console loopt 2–3 dagen achter, GA4 één.
  function webLastDay() {
    const cur = state.website?.current;
    if (!cur) return null;
    if (cur.search?.available && cur.search.lastDay) return cur.search.lastDay;
    const dagen = cur.daily || [];
    return dagen.length ? dagen[dagen.length - 1].date : (state.period?.end || null);
  }

  function webPct(cur, prev) {
    if (cur == null || prev == null || !(prev > 0)) return null;
    return (cur - prev) / prev;
  }

  // 'vs vorige periode' is het knoplabel; in een lopende zin hoort het zonder 'vs'.
  function vergelijkNaam() {
    return String(webCompareLabel() || "").replace(/^vs\s*/i, "de ");
  }

  function renderWebsiteHead() {
    const w = state.website;
    const cur = w.current.totals, base = webBase();
    const prev = base ? base.totals : null;
    const goal = webGoal();
    const dS = webPct(cur.sessions, prev && prev.sessions);
    const dG = webPct(goal.valueOf(cur), goal.valueOf(prev));

    let kop = "Verkeer en conversie over deze periode";
    const p = (v) => (v == null ? null : ((v >= 0 ? "+" : "") + (v * 100).toFixed(1).replace(".", ",") + "%"));
    if (dS != null && dG != null) {
      if (dS > 0.02 && dG < -0.02) kop = `Meer bezoek, <b>maar ${escapeHtml(goal.label.toLowerCase())} blijft achter</b>`;
      else if (dS > 0.02 && dG > 0.02) kop = `Bezoek ${p(dS)} en ${escapeHtml(goal.label.toLowerCase())} <b>${p(dG)}</b> — beide omhoog`;
      else if (dS < -0.02 && dG < -0.02) kop = `Bezoek ${p(dS)}, en <b>${escapeHtml(goal.label.toLowerCase())} zakt mee</b>`;
      else if (dS < -0.02 && dG > 0.02) kop = `Minder bezoek, <b>maar ${escapeHtml(goal.label.toLowerCase())} stijgt ${p(dG)}</b>`;
      else kop = `Bezoek en ${escapeHtml(goal.label.toLowerCase())} staan <b>vlak</b> tegenover ${escapeHtml(vergelijkNaam())}`;
    } else if (dS != null) {
      kop = `Bezoek ${dS >= 0 ? "stijgt" : "daalt"} met <b>${pctAbs(dS)}</b> tegenover ${escapeHtml(vergelijkNaam())}`;
    }

    const start = state.period.start, end = state.period.end;
    const cmp = state.websiteCompare === "yoy" ? roasCompareRange({ start, end }) : webPrevRange(start, end);
    const soort = w.website.type === "webshop" ? "Webshop" : "Leadgeneratie";
    const soortBron = w.website.typeSource === "config" ? "uit de Config-tab" : "afgeleid uit de data";

    return `<div class="report-head">
      <p class="eyebrow">GA4 &amp; Search Console · ${escapeHtml(periodLabel())}</p>
      <h2 class="report-title">${kop}</h2>
      <p class="report-lede">Vergeleken met ${escapeHtml(cmp.start)} → ${escapeHtml(cmp.end)}. `
      + `${escapeHtml(soort)}, ${escapeHtml(soortBron)}. Betaald verkeer staat hier als kanaal, zonder kosten of ROAS — `
      + `die vraag beantwoordt de ROAS-tab.</p>
    </div>`;
  }

  function renderWebsiteControls() {
    const knoppen = WEB_COMPARE.map(c =>
      `<button class="${c.key === state.websiteCompare ? "on" : ""}" onclick="window.__webCompare('${c.key}')">${escapeHtml(c.label)}</button>`
    ).join("");
    return `<div class="controls-row">
      <div class="period-toggle" title="Waartegen de veranderingen afgezet worden">${knoppen}</div>
      <span style="flex-grow:1;"></span>
      <span class="source-line" style="margin:0;">Beide vergelijkingsperiodes zitten in dezelfde aanroep — de knop hertekent zonder nieuwe fetch.</span>
      <button class="btn" onclick="window.__refreshWebsite()">Ververs data</button>
    </div>`;
  }

  function renderWebsiteCallouts() {
    const w = state.website;
    const cur = w.current.totals;
    const goal = webGoal();
    const kaarten = [];

    // Wat werkt: het kanaal dat het hardst groeit, anders het grootste kanaal.
    const chans = (w.current.channels || []).slice();
    const base = webBase();
    const prevChans = base ? (base.channels || []) : [];
    const metGroei = chans.map(c => {
      const pv = prevChans.find(x => x.label === c.label);
      return { ...c, groei: webPct(c.sessions, pv && pv.sessions) };
    }).filter(c => c.groei != null && c.sessions > 0);
    metGroei.sort((a, b) => b.groei - a.groei);
    if (metGroei.length && metGroei[0].groei > 0.02) {
      const c = metGroei[0];
      kaarten.push(callout("good", "+", "Wat werkt",
        `<b>${escapeHtml(c.label)}</b> groeit met ${((c.groei * 100).toFixed(1)).replace(".", ",")}% naar `
        + `${webFmt.int(c.sessions)} sessies — de sterkste stijger van deze periode.`));
    } else if (chans.length) {
      const grootste = chans.slice().sort((a, b) => (b.sessions || 0) - (a.sessions || 0))[0];
      kaarten.push(callout("good", "+", "Wat werkt",
        `<b>${escapeHtml(grootste.label)}</b> is het grootste kanaal met ${webFmt.int(grootste.sessions)} sessies.`));
    }

    // Welk doel je ziet: het verschil tussen hoofddoel en alle key events is groot.
    if (goal.on) {
      const alle = cur.conversions;
      kaarten.push(callout("watch", "!", "Welk doel je ziet",
        `Hierboven staat <b>${webFmt.int(goal.valueOf(cur))} ${escapeHtml(goal.label.toLowerCase())}</b> — het hoofddoel uit de Config-tab. `
        + (alle != null && alle > 0
          ? `GA4's eigen 'key events' telt alles samen en komt op <b>${webFmt.int(alle)}</b>. Dat is geen conversieratio en niet te vergelijken.`
          : `Alle key events samen zouden een hoger, minder bruikbaar cijfer geven.`)));
    } else {
      kaarten.push(callout("watch", "!", "Welk doel je ziet",
        `Je ziet <b>alle key events samen</b>, niet één doel. Zet <b>Conversiedoel</b> in de Config-tab op een GA4-eventnaam `
        + `om op één doel te sturen — dat scheelt vaak een factor tien.`));
    }

    // Waar de cijfers vandaan komen: sheet of live.
    const origin = w.current.origin || {};
    const labels = { totals: "kerncijfers", channels: "kanalen", landingPages: "landingspagina's", search: "organisch zoeken", queries: "zoekopdrachten" };
    const uitSheet = Object.keys(labels).filter(k => origin[k] === "sheet").map(k => labels[k]);
    const uitApi = Object.keys(labels).filter(k => origin[k] === "api").map(k => labels[k]);
    kaarten.push(callout("info", "↗", "Waar dit vandaan komt",
      (w.dataSheet && w.dataSheet.configured)
        ? `${uitSheet.length ? `<b>${escapeHtml(uitSheet.join(", "))}</b> uit de nachtelijke datasheet` : "Niets uit de datasheet"}`
          + `${uitApi.length ? `, <b>${escapeHtml(uitApi.join(", "))}</b> live uit Windsor` : ""}. `
          + `De sheet wordt alleen gebruikt als hij de hele periode dekt zonder ontbrekende dagen.`
        : `Alles live uit Windsor. Voor deze klant staat geen datasheet ingesteld — een sheet maakt de tab twee tot vijftig keer sneller.`));

    const voet = `<p class="callout-foot">Unieke gebruikers zijn niet over dagen op te tellen, dus waar de dagtabel de bron is `
      + `staan nieuwe gebruikers. De querytabel telt nooit op tot het totaal: Google geeft alleen zoekopdrachten boven een privacydrempel vrij. `
      + `De volledige verantwoording staat op het laatste blad.</p>`;
    return kaarten.join("") + voet;
  }

  function renderWebsiteBar() {
    const w = state.website;
    const start = state.period.start, end = state.period.end;
    const cmp = state.websiteCompare === "yoy"
      ? roasCompareRange({ start, end })
      : webPrevRange(start, end);
    const buttons = WEB_COMPARE.map(c =>
      `<button class="${c.key === state.websiteCompare ? "on" : ""}" onclick="window.__webCompare('${c.key}')">${escapeHtml(c.label)}</button>`
    ).join("");
    const typeLine = w
      ? `${w.website.type === "webshop" ? "Webshop" : "Leadgeneratie"} · ${w.website.typeSource === "config" ? "uit de Config-tab" : "afgeleid uit de data"}`
      : "";

    return `<section class="panel" style="padding:14px 18px; margin-bottom:16px;">
      <div class="roas-bar">
        <div>
          <div class="info-label">Periode</div>
          <div style="font-size:20px; color:var(--fg); margin-top:2px;">${escapeHtml(start || "—")} → ${escapeHtml(end || "—")}</div>
          <div class="muted" style="font-size:11px; margin-top:2px;">vergeleken met ${escapeHtml(cmp.start)} → ${escapeHtml(cmp.end)}${typeLine ? ` · ${escapeHtml(typeLine)}` : ""}</div>
        </div>
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <div class="period-toggle" title="Waartegen de veranderingen afgezet worden">${buttons}</div>
          <button class="btn tiny" onclick="window.__refreshWebsite()">↻ Verversen</button>
        </div>
      </div>
      <div class="muted" style="font-size:11px; margin-top:8px;">De periode komt uit de balk bovenaan — pas hem daar aan.</div>
    </section>`;
  }

  function renderWebsiteKpis() {
    const w = state.website;
    const cur = w.current.totals, base = webBase();
    const prev = base ? base.totals : null;
    const goal = webGoal();
    const isShop = w.website.type === "webshop";

    const card = (opts) => `<div class="kpi-card">
      <div class="label"><span class="dot" style="background:var(${opts.cvar})"></span>${escapeHtml(opts.label)}</div>
      <div class="value">${opts.value}</div>
      ${webDeltaHtml(opts.cur, opts.prev, opts.invert)}
      <div class="muted" style="font-size:11px;">${escapeHtml(opts.sub || "")}</div>
    </div>`;

    const cards = [
      card({
        label: "Sessies", cvar: "--kpi-1",
        value: webFmt.int(cur.sessions), cur: cur.sessions, prev: prev && prev.sessions,
        // Uit de datasheet is 'unieke gebruikers' niet te herleiden (zie de
        // voetnoot); dan tonen we nieuwe gebruikers, die wél optelbaar zijn.
        sub: cur.users != null
          ? `${webFmt.int(cur.users)} gebruikers · ${webFmt.pct0(cur.newUserShare)} nieuw`
          : cur.newUsers != null
          ? `${webFmt.int(cur.newUsers)} nieuwe gebruikers`
          : "geen GA4-data",
      }),
      card({
        label: "Betrokken sessies", cvar: "--kpi-2",
        value: webFmt.pct0(cur.engagementRate), cur: cur.engagementRate, prev: prev && prev.engagementRate,
        sub: `${webFmt.dur(cur.avgEngagementTime)} gemiddeld · ${cur.pagesPerSession == null ? "—" : cur.pagesPerSession.toFixed(1).replace(".", ",")} pagina's per sessie`,
      }),
      card({
        label: goal.label, cvar: "--kpi-3",
        value: webFmt.int(goal.valueOf(cur)), cur: goal.valueOf(cur), prev: goal.valueOf(prev),
        sub: `${webFmt.pct2(goal.rateOf(cur))} van de sessies · ${goal.sub}`,
      }),
    ];

    cards.push(isShop
      ? card({
          label: "Omzet", cvar: "--kpi-4",
          value: webFmt.eur(cur.revenue), cur: cur.revenue, prev: prev && prev.revenue,
          sub: `${webFmt.int(cur.transactions)} transacties · gemiddeld ${webFmt.eur(cur.aov)}`,
        })
      : card({
          label: "Organisch zoeken", cvar: "--kpi-4",
          value: webFmt.int(w.current.search.clicks), cur: w.current.search.clicks, prev: base && base.search ? base.search.clicks : null,
          sub: w.current.search.available
            ? `kliks · positie ${webFmt.pos(w.current.search.position)} · CTR ${webFmt.pct2(w.current.search.ctr)}`
            : "geen Search Console gekoppeld",
        }));

    return `<div class="kpi-grid" style="margin-bottom:16px;">${cards.join("")}</div>`;
  }

  function renderWebsiteChart() {
    const cur = state.website?.current;
    if (!cur || !cur.daily || cur.daily.length < 2 || !window.Charts) return "";
    const goal = webGoal();
    const days = cur.daily;
    const convValues = days.map(d => (goal.on ? (d.goal || 0) : (d.conversions || 0)));
    const hasConv = convValues.some(v => v > 0);

    // Sessies en conversies schelen een orde van grootte; op één as met twee
    // schalen lijkt elke beweging even groot. Dus twee grafieken.
    const xDagen = days.map(d => { const [, m, dd] = d.date.split("-"); return `${Number(dd)}/${Number(m)}`; });
    const specSessies = {
      width: 980, height: hasConv ? 210 : 260,
      x: xDagen,
      series: [{ label: "Sessies", values: days.map(d => d.sessions), kind: "area", axis: "left", color: Charts.seriesColor(0) }],
      leftFormat: Charts.fmt.k,
      maxXLabels: 10,
    };
    const specDoel = hasConv ? {
      width: 980, height: 132,
      x: xDagen,
      series: [{ label: goal.label, values: convValues, kind: "line", axis: "left", color: Charts.seriesColor(2) }],
      leftFormat: Charts.fmt.int,
      maxXLabels: 10,
    } : null;
    const origin = state.website?.current?.origin || {};
    const bron = origin.totals === "sheet"
      ? "de nachtelijke datasheet, tab <b>Google Analytics 4 — dag</b>"
      : "Windsor.ai, connector <b>googleanalytics4</b>";
    return `<div class="chart-tub">
      <h3 class="label-head">Verkeer per dag</h3>
      ${chartSvg(specSessies)}
      ${specDoel ? `<h3 class="label-head" style="margin:18px 0 8px;">${escapeHtml(goal.label)} per dag</h3>
      ${chartSvg(specDoel)}` : ""}
    </div>
    <p class="source-line">Bron: ${bron} · ${days.length} dagen`
      + `${hasConv ? "" : " · geen conversies gemeten in deze periode"}</p>`;
  }

  // Sessies, betrokkenheid en conversie per GA4-kanaalgroep. Betaalde kanalen staan
  // er bewust bij — maar zonder spend of ROAS: die vraag beantwoordt de ROAS-tab.
  function renderWebsiteChannels() {
    const w = state.website;
    const cur = w.current.channels || [];
    if (!cur.length) {
      return `<section class="panel" style="margin-bottom:16px;">
        <div class="panel-header"><div>
          <h2 class="panel-title">Kanalen</h2>
          <div class="panel-sub">${w.current.errors.ga4Channels ? "Kon de kanaalverdeling niet ophalen" : "Geen GA4-data in deze periode"}</div>
        </div></div>
      </section>`;
    }
    const goal = webGoal();
    const isShop = w.website.type === "webshop";
    const base = webBase();
    const prevMap = new Map((base?.channels || []).map(c => [c.channel, c]));
    const totalSessions = cur.reduce((s, c) => s + c.sessions, 0);

    const rows = cur.map(c => {
      const p = prevMap.get(c.channel);
      // Zelfde vorm als bij Bronnen: het verschil staat naast het cijfer waar het
      // over gaat, niet in een losse kolom aan het eind van de rij.
      const isNew = prevMap.size > 0 && !p && c.sessions > 0;
      return `<tr>
        <td><strong>${escapeHtml(c.channel)}</strong>${isNew ? ` <span class="cell-tag">nieuw</span>` : ""}</td>
        <td class="right">${webFmt.int(c.sessions)}${isNew ? "" : webCellDelta(c.sessions, p && p.sessions)}</td>
        <td class="right">${webFmt.pct0(totalSessions ? c.sessions / totalSessions : null)}</td>
        <td class="right">${webFmt.pct0(c.engagementRate)}</td>
        <td class="right">${webFmt.int(goal.rowOf(c))}</td>
        <td class="right"><strong>${webFmt.pct2(c.conversionRate)}</strong></td>
        ${isShop ? `<td class="right">${webFmt.eur(c.revenue)}</td>` : ""}
      </tr>`;
    }).join("");

    return `<section class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><div>
        <h2 class="panel-title">Kanalen</h2>
        <div class="panel-sub">GA4-kanaalgroepen · conversie gemeten als ${escapeHtml(goal.label.toLowerCase())}${prevMap.size ? ` · verschil in sessies ${escapeHtml(webCompareLabel())}` : ""}</div>
      </div></div>
      <div class="lib-table"><table>
        <thead><tr>
          <th>Kanaal</th>
          <th class="right">Sessies</th>
          <th class="right">Aandeel</th>
          <th class="right">Betrokken</th>
          <th class="right">${escapeHtml(goal.label)}</th>
          <th class="right">Conversieratio</th>
          ${isShop ? `<th class="right">Omzet</th>` : ""}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${renderWebsiteDonut(cur, goal)}
      <p class="muted" style="font-size:11px; margin:12px 0 0;">
        Advertentiekosten en ROAS staan bewust niet in deze tabel: die vraag beantwoordt de ROAS-tab,
        op dezelfde GA4-omzet. Eén cijfer, één plek.
      </p>
    </section>`;
  }

  // Deel-van-geheel over zeven kanaalgroepen. De legenda draagt de cijfers, want
  // met zeven segmenten zijn twee schijfjes van 8% en 6% met het oog niet uit
  // elkaar te houden — de ring toont de verhouding, de legenda de waarde.
  // Let op: krijgt de kanalenlijst zelf mee, niet het periodeobject — in
  // renderWebsiteChannels heet die lijst `cur`.
  // Kanalen optellen tot de zeven groepen. Wordt voor de huidige én de
  // vergelijkingsperiode gedraaid, zodat de legenda hetzelfde verschil kan tonen
  // als de tabellen.
  function webGroupTotals(channels, goal) {
    const totals = new Map(WEB_GROUPS.map(g => [g.key, { sessions: 0, conversions: 0, channels: [] }]));
    for (const c of (channels || [])) {
      const g = totals.get(webGroupOf(c.channel));
      g.sessions += c.sessions || 0;
      const conv = goal ? goal.rowOf(c) : null;
      if (conv != null) g.conversions += conv;
      if (c.sessions > 0) g.channels.push(c.channel);
    }
    return totals;
  }

  function renderWebsiteDonut(channels, goal) {
    const rows = channels || [];
    if (!rows.length) return "";

    const totals = webGroupTotals(rows, goal);
    const base = webBase();
    const prevTotals = (base && base.channels) ? webGroupTotals(base.channels, goal) : null;
    const total = WEB_GROUPS.reduce((s, g) => s + totals.get(g.key).sessions, 0);
    if (!total) return "";

    // Vaste volgorde = vaste kleur; lege groepen blijven in de legenda staan zodat
    // de kleurtoewijzing niet verschuift zodra een kanaal wegvalt.
    const slices = WEB_GROUPS.map((g, i) => ({
      label: g.label, value: totals.get(g.key).sessions, color: Charts.sliceColor(i),
    }));

    const legend = WEB_GROUPS.map((g, i) => {
      const t = totals.get(g.key);
      const share = total ? t.sessions / total : 0;
      // Verschil naast het sessiecijfer, in dezelfde vorm als in de tabellen.
      const prev = prevTotals ? prevTotals.get(g.key).sessions : null;
      const delta = t.sessions > 0 ? webCellDelta(t.sessions, prev) : "";
      return `<div class="web-donut-item${t.sessions ? "" : " off"}" title="${escapeHtml(t.channels.join(", ") || "geen verkeer in deze periode")}">
        <span class="swatch" style="background:${Charts.sliceColor(i)}"></span>
        <span class="name">${escapeHtml(g.label)}</span>
        <span class="val">${webFmt.pct0(share)}</span>
        <span class="sub">${webFmt.int(t.sessions)} sessies${delta} · ${webFmt.int(t.conversions)} ${escapeHtml(goal.label.toLowerCase())}</span>
      </div>`;
    }).join("");

    return `<div class="web-donut">
      <div class="chart">${donutSvg({
        size: 200, thickness: 32, slices,
        centerValue: webFmt.int(total), centerLabel: "SESSIES",
      })}</div>
      <div class="legend">${legend}</div>
    </div>`;
  }

  // Verschil naast één cijfer in een tabelcel. Bewust klein en zonder decimalen:
  // het staat naast de waarde, niet in plaats ervan.
  function webCellDelta(cur, prev, invert) {
    const d = webFmt.delta(cur, prev);
    if (d == null) return "";
    const good = invert ? d < 0 : d >= 0;
    return `<span class="cell-delta ${good ? "up" : "down"}">${d >= 0 ? "↑" : "↓"}${(Math.abs(d) * 100).toFixed(0)}%</span>`;
  }

  function renderWebsiteSources() {
    const rows = state.website?.current?.sources || [];
    if (!rows.length) return "";
    const isShop = state.website.website.type === "webshop";
    const base = webBase();
    const prevMap = new Map(((base && base.sources) || []).map(s => [s.source, s]));
    const hasCompare = prevMap.size > 0;
    const shown = rows.slice(0, 15);

    const body = shown.map(s => {
      const p = prevMap.get(s.source);
      // Een bron die vorige periode niet bestond krijgt géén '+100%', maar 'nieuw'.
      // Een deling door nul zou hier anders een nietszeggend cijfer opleveren.
      const isNew = hasCompare && !p && s.sessions > 0;
      const cell = (val, formatted, prev) =>
        `<td class="right">${formatted}${isNew ? "" : webCellDelta(val, prev)}</td>`;
      return `<tr>
        <td>${escapeHtml(s.source)}${isNew ? ` <span class="cell-tag">nieuw</span>` : ""}</td>
        ${cell(s.sessions, webFmt.int(s.sessions), p && p.sessions)}
        ${cell(s.engagementRate, webFmt.pct0(s.engagementRate), p && p.engagementRate)}
        ${cell(s.conversions, webFmt.int(s.conversions), p && p.conversions)}
        ${isShop ? cell(s.revenue, webFmt.eur(s.revenue), p && p.revenue) : ""}
      </tr>`;
    }).join("");

    return `<section class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><div>
        <h2 class="panel-title">Bronnen</h2>
        <div class="panel-sub">Top ${shown.length} op sessies · bron / medium zoals GA4 het registreert${hasCompare ? ` · verschil ${escapeHtml(webCompareLabel())}` : ""}</div>
      </div></div>
      <div class="lib-table"><table>
        <thead><tr>
          <th>Bron / medium</th><th class="right">Sessies</th><th class="right">Betrokken</th>
          <th class="right">Key events</th>${isShop ? `<th class="right">Omzet</th>` : ""}
        </tr></thead>
        <tbody>${body}</tbody>
      </table></div>
      <p class="muted" style="font-size:11px; margin:12px 0 0;">
        Key events is hier het GA4-totaal over álle doelen — een uitsplitsing per doel bestaat op
        bronniveau niet zonder extra configuratie.${hasCompare ? "" : " Er is geen vergelijkingsperiode geladen, dus er staan geen verschillen bij."}
      </p>
    </section>`;
  }

  // Rijen van de landingspagina-tabel, los van de rest zodat de zoekbalk alleen
  // dit stuk hertekent. Een volledige re-render zou het invoerveld vervangen en
  // daarmee de focus en de cursorpositie kwijtraken bij elke aanslag.
  const WEB_LANDING_LIMIT = 15;

  function webLandingRows() {
    const w = state.website;
    const all = w?.current?.landingPages || [];
    const q = (state.websiteLandingQuery || "").trim().toLowerCase();
    const isShop = w.website.type === "webshop";
    const hits = q ? all.filter(p => String(p.page).toLowerCase().includes(q)) : all;
    const shown = hits.slice(0, WEB_LANDING_LIMIT);

    if (!shown.length) {
      return `<tr><td colspan="${isShop ? 6 : 5}" class="muted" style="padding:18px 0;">Geen pagina met “${escapeHtml(q)}” in de top ${all.length}.</td></tr>`;
    }
    return shown.map(p => `<tr>
      <td class="row-caption" title="${escapeHtml(p.page)}">${escapeHtml(p.page)}</td>
      <td class="right">${webFmt.int(p.sessions)}</td>
      <td class="right">${webFmt.pct0(p.engagementRate)}</td>
      <td class="right">${webFmt.int(p.conversions)}</td>
      <td class="right"><strong>${webFmt.ratio(p.conversionRate)}</strong></td>
      ${isShop ? `<td class="right">${webFmt.eur(p.revenue)}</td>` : ""}
    </tr>`).join("");
  }

  function webLandingCount() {
    const all = state.website?.current?.landingPages || [];
    const q = (state.websiteLandingQuery || "").trim().toLowerCase();
    const hits = q ? all.filter(p => String(p.page).toLowerCase().includes(q)) : all;
    return q
      ? `${Math.min(hits.length, WEB_LANDING_LIMIT)} van ${hits.length} treffers`
      : `top ${Math.min(all.length, WEB_LANDING_LIMIT)} van ${all.length} pagina's`;
  }

  window.__webLandingSearch = (v) => {
    state.websiteLandingQuery = v;
    const body = $("#web-landing-rows");
    const count = $("#web-landing-count");
    if (body) body.innerHTML = webLandingRows();
    if (count) count.textContent = webLandingCount();
  };

  function renderWebsiteLanding() {
    const w = state.website;
    const rows = w?.current?.landingPages || [];
    if (!rows.length) return "";
    const goal = webGoal();
    const isShop = w.website.type === "webshop";
    const win = w.current.pageLevelWindow;
    const body = webLandingRows();

    return `<section class="panel" style="margin-bottom:16px;">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Landingspagina's</h2>
          <div class="panel-sub">Waar bezoekers binnenkomen · <span id="web-landing-count">${escapeHtml(webLandingCount())}</span></div>
        </div>
        <label class="web-search">
          <span class="ico">⌕</span>
          <input type="search" placeholder="Zoek een pad, bv. /nl/te-huur" value="${escapeHtml(state.websiteLandingQuery || "")}"
            oninput="window.__webLandingSearch(this.value)" autocomplete="off">
        </label>
      </div>
      <div class="lib-table"><table>
        <thead><tr>
          <th>Pagina</th><th class="right">Sessies</th><th class="right">Betrokken</th>
          <th class="right">Key events</th><th class="right">Per sessie</th>${isShop ? `<th class="right">Omzet</th>` : ""}
        </tr></thead>
        <tbody id="web-landing-rows">${body}</tbody>
      </table></div>
      <p class="muted" style="font-size:11px; margin:12px 0 0;">
        <strong>Per sessie</strong> is het aantal key events per sessie, niet een conversieratio: GA4 telt hier álle
        key events van de property samen, dus de waarde kan boven 1 uitkomen. Het hoofddoel apart per pagina levert
        GA4 niet zonder extra configuratie.
      </p>
      ${win ? `<p class="muted" style="font-size:11px; margin:12px 0 0;">
        Deze tabel dekt ${escapeHtml(win.startDate)} → ${escapeHtml(win.endDate)} (${win.maxDays} dagen), korter dan de gekozen periode.
        Paginadata komt ongeaggregeerd binnen; over langere periodes duurt dat te lang. De cijfers hierboven dekken wél de hele periode.
      </p>` : ""}
    </section>`;
  }

  // E-commerce-funnel. Alleen voor webshops én alleen als GA4 de stappen levert:
  // een funnel van nullen zou lezen als 'niemand legt iets in de winkelmand'.
  function renderWebsiteFunnel() {
    const w = state.website;
    if (w.website.type !== "webshop") return "";
    const f = w.current.funnel;
    if (!f || !f.available) {
      return `<section class="panel" style="margin-bottom:16px;">
        <div class="panel-header"><div>
          <h2 class="panel-title">Verkoopfunnel</h2>
          <div class="panel-sub">Geen e-commerce-events gemeten in deze periode</div>
        </div></div>
        <p class="muted" style="margin:0; font-size:12px;">
          GA4 leverde geen winkelmand- of checkout-events. Meestal betekent dat dat de
          e-commerce-tracking (view_item, add_to_cart, begin_checkout, purchase) nog niet volledig staat.
        </p>
      </section>`;
    }
    const steps = [
      { label: "Productweergaven", value: f.itemViews },
      { label: "In winkelmand", value: f.addToCarts, rate: f.cartRate, rateLabel: "van weergaven" },
      { label: "Checkout gestart", value: f.checkouts, rate: f.checkoutRate, rateLabel: "van winkelmand" },
      { label: "Aankopen", value: f.purchases, rate: f.purchaseRate, rateLabel: "van checkouts" },
    ].filter(s => s.value != null);
    const max = Math.max(...steps.map(s => s.value), 1);

    const bars = steps.map(s => `<div class="web-funnel-step">
      <div class="web-funnel-head">
        <span>${escapeHtml(s.label)}</span>
        <span><strong>${webFmt.int(s.value)}</strong>${s.rate != null ? ` <span class="muted">${webFmt.pct1(s.rate)} ${escapeHtml(s.rateLabel)}</span>` : ""}</span>
      </div>
      <div class="web-funnel-bar"><div class="fill" style="width:${Math.max(1, (s.value / max) * 100).toFixed(1)}%;"></div></div>
    </div>`).join("");

    return `<section class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><div>
        <h2 class="panel-title">Verkoopfunnel</h2>
        <div class="panel-sub">Gemiddelde orderwaarde ${webFmt.eur(f.aov)}${f.firstTimePurchasers != null ? ` · ${webFmt.int(f.firstTimePurchasers)} eerste kopers van ${webFmt.int(f.purchasers)}` : ""}</div>
      </div></div>
      <div class="web-funnel">${bars}</div>
    </section>`;
  }

  function renderWebsiteSearch() {
    const w = state.website;
    if (!w.hasGsc) {
      return `<section class="panel" style="margin-bottom:16px;">
        <div class="panel-header"><div>
          <h2 class="panel-title">Organisch zoeken</h2>
          <div class="panel-sub">Geen Search Console gekoppeld</div>
        </div></div>
        <p class="muted" style="margin:0; font-size:12px;">
          Zet <strong>Search Console site</strong> in de Config-tab van de klantsheet om hier vertoningen,
          kliks, posities en zoekopdrachten te zien. Gebruik exact de property zoals Google hem noemt:
          <em>sc-domain:merk.be</em> of <em>https://www.merk.be/</em>.
        </p>
      </section>`;
    }
    const s = w.current.search;
    const base = webBase();
    const ps = base ? base.search : null;
    if (!s.available) {
      return `<section class="panel" style="margin-bottom:16px;">
        <div class="panel-header"><div>
          <h2 class="panel-title">Organisch zoeken</h2>
          <div class="panel-sub">Search Console leverde geen rijen voor deze periode</div>
        </div></div>
        <p class="muted" style="margin:0; font-size:12px;">${escapeHtml(w.current.errors.gscEmpty || w.current.errors.gscTotals || "Controleer de property in de Config-tab.")}</p>
      </section>`;
    }

    const kpi = (label, value, cur, prev, invert, sub) => `<div class="kpi-card">
      <div class="label"><span class="dot"></span>${escapeHtml(label)}</div>
      <div class="value compact">${value}</div>
      ${webDeltaHtml(cur, prev, invert)}
      ${sub ? `<div class="muted" style="font-size:11px;">${escapeHtml(sub)}</div>` : ""}
    </div>`;

    const b = w.current.branded;
    const brandTotal = b ? (b.branded.clicks + b.nonbranded.clicks) : 0;
    const brandedBlock = (b && brandTotal > 0) ? `<div class="web-brand-split">
      <div><strong>${webFmt.pct0(b.branded.clicks / brandTotal)}</strong> merkgebonden
        <span class="muted">${webFmt.int(b.branded.clicks)} kliks · CTR ${webFmt.pct1(b.branded.ctr)}</span></div>
      <div><strong>${webFmt.pct0(b.nonbranded.clicks / brandTotal)}</strong> niet-merkgebonden
        <span class="muted">${webFmt.int(b.nonbranded.clicks)} kliks · CTR ${webFmt.pct1(b.nonbranded.ctr)}</span></div>
      <div class="muted" style="font-size:11px;">Merkgebonden = de zoekopdracht bevat ${b.tokens.map(t => `<em>${escapeHtml(t)}</em>`).join(" of ")}. Berekend over de zoekopdrachten die Google vrijgeeft, niet over alle kliks.</div>
    </div>` : "";

    const qRows = (w.current.queries || []).map(q => `<tr>
      <td class="row-caption" title="${escapeHtml(q.query)}">${escapeHtml(q.query)}</td>
      <td class="right">${webFmt.int(q.clicks)}</td>
      <td class="right">${webFmt.int(q.impressions)}</td>
      <td class="right">${webFmt.pct1(q.ctr)}</td>
      <td class="right">${webFmt.pos(q.position)}</td>
    </tr>`).join("");

    const wins = w.current.quickWins || [];
    const winRows = wins.map(q => `<tr>
      <td class="row-caption" title="${escapeHtml(q.query)}">${escapeHtml(q.query)}</td>
      <td class="right">${webFmt.int(q.impressions)}</td>
      <td class="right">${webFmt.int(q.clicks)}</td>
      <td class="right">${webFmt.pct1(q.ctr)}</td>
      <td class="right"><strong>${webFmt.pos(q.position)}</strong></td>
    </tr>`).join("");

    const pRows = (w.current.searchPages || []).map(p => `<tr>
      <td class="row-caption" title="${escapeHtml(p.page)}">${escapeHtml(p.page)}</td>
      <td class="right">${webFmt.int(p.clicks)}</td>
      <td class="right">${webFmt.int(p.impressions)}</td>
      <td class="right">${webFmt.pct1(p.ctr)}</td>
      <td class="right">${webFmt.pos(p.position)}</td>
    </tr>`).join("");

    // Search Console loopt twee tot drie dagen achter. Zonder die melding lijkt een
    // periode die tot vandaag loopt een daling te tonen die er niet is.
    const last = (w.current.searchDaily || []).slice(-1)[0];
    const lagDays = last ? Math.round((webAtNoon(state.period.end) - webAtNoon(last.date)) / 86400000) : null;
    const lagNote = (lagDays != null && lagDays > 0)
      ? `<div class="muted" style="font-size:11px; margin-top:10px;">Search Console loopt achter: laatste dag met data is ${escapeHtml(last.date)} (${lagDays} dag${lagDays === 1 ? "" : "en"} vóór het einde van de periode). Google levert die dagen nog na.</div>`
      : "";

    return `<section class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><div>
        <h2 class="panel-title">Organisch zoeken</h2>
        <div class="panel-sub">Google Search Console · wat mensen intypen voordat ze op de site komen</div>
      </div></div>
      <div class="kpi-grid" style="margin-bottom:16px;">
        ${kpi("Kliks", webFmt.int(s.clicks), s.clicks, ps && ps.clicks, false)}
        ${kpi("Vertoningen", webFmt.int(s.impressions), s.impressions, ps && ps.impressions, false)}
        ${kpi("CTR", webFmt.pct2(s.ctr), s.ctr, ps && ps.ctr, false, "kliks gedeeld door vertoningen")}
        ${kpi("Positie", webFmt.pos(s.position), s.position, ps && ps.position, true, "gewogen naar vertoningen")}
      </div>
      ${brandedBlock}
      ${wins.length ? `<h3 class="web-subhead">Kansen — net buiten de eerste pagina</h3>
      <div class="lib-table"><table>
        <thead><tr><th>Zoekopdracht</th><th class="right">Vertoningen</th><th class="right">Kliks</th><th class="right">CTR</th><th class="right">Positie</th></tr></thead>
        <tbody>${winRows}</tbody>
      </table></div>
      <p class="muted" style="font-size:11px; margin:10px 0 0;">Zoekopdrachten op positie 8 tot 20 met minstens 50 vertoningen: hier levert een paar plaatsen stijgen het meeste verkeer op.</p>` : ""}
      ${qRows ? `<h3 class="web-subhead">Meeste kliks</h3>
      <div class="lib-table"><table>
        <thead><tr><th>Zoekopdracht</th><th class="right">Kliks</th><th class="right">Vertoningen</th><th class="right">CTR</th><th class="right">Positie</th></tr></thead>
        <tbody>${qRows}</tbody>
      </table></div>` : ""}
      ${pRows ? `<h3 class="web-subhead">Pagina's in de zoekresultaten</h3>
      <div class="lib-table"><table>
        <thead><tr><th>Pagina</th><th class="right">Kliks</th><th class="right">Vertoningen</th><th class="right">CTR</th><th class="right">Positie</th></tr></thead>
        <tbody>${pRows}</tbody>
      </table></div>` : ""}
      ${lagNote}
    </section>`;
  }

  function renderWebsiteAudience() {
    const c = state.website?.current;
    if (!c) return "";
    const goal = webGoal();
    const devices = c.devices || [], returning = c.newVsReturning || [], countries = c.countries || [];
    if (!devices.length && !returning.length && !countries.length) return "";

    const mini = (title, rows) => `<div class="web-mini">
      <div class="info-label">${escapeHtml(title)}</div>
      <table>${rows}</table>
    </div>`;

    const totalDev = devices.reduce((s, d) => s + d.sessions, 0);
    const devRows = devices.map(d => `<tr>
      <td>${escapeHtml(d.device)}</td>
      <td class="right">${webFmt.pct0(totalDev ? d.sessions / totalDev : null)}</td>
      <td class="right">${webFmt.pct0(d.engagementRate)}</td>
    </tr>`).join("");

    const totalRet = returning.reduce((s, d) => s + d.sessions, 0);
    const retRows = returning.map(d => `<tr>
      <td>${escapeHtml(d.group === "new" ? "nieuw" : d.group === "returning" ? "terugkerend" : d.group)}</td>
      <td class="right">${webFmt.pct0(totalRet ? d.sessions / totalRet : null)}</td>
      <td class="right">${webFmt.int(d.sessions)}</td>
    </tr>`).join("");

    const totalC = countries.reduce((s, d) => s + d.sessions, 0);
    const cRows = countries.map(d => `<tr>
      <td>${escapeHtml(d.country)}</td>
      <td class="right">${webFmt.pct0(totalC ? d.sessions / totalC : null)}</td>
      <td class="right">${webFmt.int(d.sessions)}</td>
    </tr>`).join("");

    return `<section class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><div>
        <h2 class="panel-title">Publiek</h2>
        <div class="panel-sub">Aandeel van de sessies, en betrokkenheid waar die iets toevoegt</div>
      </div></div>
      <div class="web-mini-grid">
        ${devices.length ? mini("Apparaat — aandeel en betrokkenheid", devRows) : ""}
        ${returning.length ? mini("Nieuw vs. terugkerend (sessies)", retRows) : ""}
        ${countries.length ? mini("Land (sessies)", cRows) : ""}
      </div>
      <p class="muted" style="font-size:11px; margin:12px 0 0;">
        Bij apparaat staat de betrokkenheid en niet de conversieratio: ${escapeHtml(goal.on
          ? `GA4 splitst ${goal.label.toLowerCase()} op dit niveau niet uit, en een ratio over álle key events zou een veel te hoog cijfer geven`
          : "zonder ingesteld hoofddoel zou een ratio over álle key events een veel te hoog cijfer geven")}.
      </p>
    </section>`;
  }

  function renderWebsiteNotes() {
    const w = state.website;
    const e = w.current.errors || {};
    const msgs = [];
    const add = (label, v) => { if (v) msgs.push(`${label}: ${v}`); };
    add("GA4-totalen", e.ga4Totals);
    add("GA4-dagreeks", e.ga4Daily);
    add("GA4-kanalen", e.ga4Channels);
    add("GA4-doel", e.ga4Goal);
    add("GA4-bronnen", e.ga4Sources);
    add("GA4-landingspagina's", e.ga4Landing);
    add("GA4-funnel", e.ga4Funnel);
    add("Search Console", e.gscTotals || e.gscEmpty);
    add("Search Console — zoekopdrachten", e.gscQueries);
    add("Search Console — pagina's", e.gscPages);
    if (w.previousError) add("Vergelijkingsperiode", w.previousError);
    if (w.yearAgoError) add("Vorig jaar", w.yearAgoError);
    for (const m of (w.dataSheet && w.dataSheet.warnings) || []) add("Datasheet", m);

    const errHtml = msgs.length
      ? `<div style="margin-top:10px; font-size:11px; color:var(--negative);">${msgs.map(m => escapeHtml(m)).join("<br>")}</div>`
      : "";

    const goal = webGoal();

    // Waar kwam elk blok vandaan? De datasheet is de snelle route, Windsor de
    // live route. Een verschil met GA4's eigen interface is meestal hiermee te
    // verklaren, dus het hoort zichtbaar te zijn.
    const origin = w.current.origin || {};
    const labels = { totals: "kerncijfers", channels: "kanalen", landingPages: "landingspagina's", search: "organisch zoeken", queries: "zoekopdrachten" };
    const fromSheet = Object.keys(labels).filter(k => origin[k] === "sheet");
    const fromApi = Object.keys(labels).filter(k => origin[k] === "api");
    const ds = w.dataSheet || {};
    const originLine = !ds.configured
      ? `<li><strong>Bron:</strong> alles live uit Windsor. Voor deze klant staat geen datasheet ingesteld.</li>`
      : `<li><strong>Bron:</strong> ${fromSheet.length ? `${escapeHtml(fromSheet.map(k => labels[k]).join(", "))} uit de dagelijkse datasheet` : "niets uit de datasheet"}${fromApi.length ? `, ${escapeHtml(fromApi.map(k => labels[k]).join(", "))} live uit Windsor` : ""}. De sheet wordt alleen gebruikt als hij de hele periode dekt zonder ontbrekende dagen.</li>`;

    // Per blok dat terugviel op de API: waaróm de sheet afviel.
    const cov = w.current.sheetCoverage || {};
    const tabLabels = {
      ga4Daily: "kerncijfers", ga4Channel: "kanalen", ga4Landing: "landingspagina's",
      gscDaily: "organisch zoeken", gscQuery: "zoekopdrachten",
    };
    const covMsgs = Object.entries(cov)
      .filter(([, v]) => v && !v.ok && v.reason)
      .map(([k, v]) => `${tabLabels[k] || k} (${v.reason})`);
    const covLine = covMsgs.length
      ? `<li><strong>Datasheet niet gebruikt voor:</strong> ${escapeHtml(covMsgs.join(" · "))}. Die blokken komen live uit Windsor, dus de cijfers kloppen — het duurt alleen langer.</li>`
      : "";

    const sheetNotes = ds.used
      ? `<li><strong>Uit een dagtabel is 'unieke gebruikers' niet te berekenen.</strong> Iemand die vijf dagen langskomt zou vijf keer meetellen. Daarom staan er nieuwe gebruikers, die wél optelbaar zijn: je bent maar één keer nieuw. Sessies liggen om dezelfde reden ongeveer een procent hoger dan in GA4 zelf, want een sessie over middernacht telt in twee dagen.</li>`
      : "";

    return `<section class="panel">
      <div class="panel-header"><div>
        <h2 class="panel-title">Hoe deze cijfers berekend zijn</h2>
        <div class="panel-sub">Zodat de tab navolgbaar blijft</div>
      </div></div>
      <ul class="roas-notes">
        <li><strong>Sessies en gebruikers</strong> komen uit GA4. Gebruikers worden over de hele periode ontdubbeld: iemand die op vijf dagen langskomt telt één keer. Optellen per dag zou hem vijf keer tellen.</li>
        <li><strong>Betrokken sessies</strong> is GA4's engagement rate: sessies die langer dan tien seconden duren, een key event opleveren of minstens twee pagina's zien. Dit verving bouncepercentage.</li>
        <li><strong>${escapeHtml(goal.label)}</strong> — ${goal.on
          ? `het hoofddoel uit de Config-tab (GA4-event <em>${escapeHtml(w.website.goalEvent)}</em>). Alle key events samen zouden een veel hoger, minder bruikbaar cijfer geven.`
          : `alle key events van de property samen. Zet <strong>Conversiedoel</strong> in de Config-tab om op één doel te sturen — dat scheelt vaak een factor tien.`}</li>
        <li><strong>Organisch zoeken</strong> komt uit Search Console, niet uit GA4. CTR en positie zijn opnieuw berekend uit kliks en vertoningen; een gemiddelde van gemiddelden zou hier niet kloppen. Google geeft alleen zoekopdrachten vrij boven een privacydrempel, dus de querytabellen tellen niet op tot het totaal.</li>
        <li><strong>Betaald verkeer</strong> staat hier als kanaal, maar zonder kosten of ROAS. Die staan in de ROAS-tab, op dezelfde GA4-omzet.</li>
        <li>GA4-property en Search Console-site komen uit de <strong>Config-tab</strong> van de klantsheet. Ontbreekt er één, dan blijft de rest gewoon werken.</li>
        ${originLine}
        ${covLine}
        ${sheetNotes}
      </ul>
      ${errHtml}
    </section>`;
  }

  /* ==========================================================
     SEO-tab — zoekvolume, concurrentie, CPC en positie per keyword
     ==========================================================
     Bron: DataForSEO via api/seo.js. Twee aparte knoppen, omdat de twee calls
     een factor duizend in prijs schelen: volumes zijn één batch-call voor de
     hele lijst, een rank-check kost ~€0,002 per keyword.

     Géén periode uit de topbar: zoekvolume is een maandcijfer van Google Ads en
     een positie is een momentopname. Een dagfilter zou hier niets betekenen.

     Domein, markt, taal en de standaard-keywordlijst komen uit de Config-tab
     (server-side). De klant mag keywords toevoegen; die lijst staat per klant in
     localStorage, nooit gedeeld — precies de cache-botsing waar de handover van
     de template voor waarschuwt.
     ========================================================== */

  const SEO_MAX_CHART_SERIES = 6;

  const seoLsKey = (what) => `spa.seo.${what}.${state.session?.clientId || "?"}`;

  // Zelfde dagafbakening als de server (Europe/Brussels), anders vervalt de ene
  // cache om middernacht UTC en de andere twee uur later.
  const seoToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Brussels" });

  const seoSameList = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    [...a].sort().join("\n") === [...b].sort().join("\n");

  function seoReadLs(what) {
    try { return JSON.parse(localStorage.getItem(seoLsKey(what)) || "null"); } catch { return null; }
  }
  function seoWriteLs(what, value) {
    try { localStorage.setItem(seoLsKey(what), JSON.stringify(value)); } catch {}
  }

  // Dagcache in de browser. Dit is de echte rem op de kosten: de servercache leeft
  // maar zolang een serverless-instantie warm blijft.
  function seoCacheGet(what, keywords) {
    const c = seoReadLs(what);
    if (!c || c.day !== seoToday()) return null;
    if (!seoSameList(c.keywords, keywords)) return null;
    return c.payload;
  }
  function seoCacheSet(what, keywords, payload) {
    seoWriteLs(what, { day: seoToday(), keywords, payload });
  }

  /* ---------- Fetch ---------- */

  function seoFetch(force) {
    if (!state.session) return;
    if (state.seoLoading) return;

    // Eigen keywordlijst van deze klant, indien de gebruiker er ooit een aanpaste.
    // Anders null → de server gebruikt de lijst uit de Config-tab.
    if (state.seoKeywords == null) {
      const stored = seoReadLs("kws");
      if (Array.isArray(stored) && stored.length) state.seoKeywords = stored;
    }
    const list = state.seoKeywords;

    if (!force && state.seo && (list == null || seoSameList(state.seo.keywords, list))) { renderSeo(); return; }

    if (!force && list) {
      const cached = seoCacheGet("vol", list);
      if (cached) {
        state.seo = cached;
        state.seoSettings = cached.settings || state.seoSettings;
        const cachedRanks = seoCacheGet("rank", list);
        if (cachedRanks) state.seoRanks = cachedRanks;
        renderSeo();
        return;
      }
    }

    state.seoLoading = true;
    state.seoError = null;
    renderSeo();

    apiPost("/api/seo", {
      action: "volumes",
      clientId: state.session.clientId,
      token: state.session.token,
      ...(list ? { keywords: list } : {}),
      ...(force ? { force: true } : {}),
    })
      .then((res) => {
        state.seoLoading = false;
        state.seo = res;
        state.seoSettings = res.settings || null;
        // Eerste keer: de lijst komt uit de Config-tab. Die nemen we over in de
        // state, maar bewaren we niet — anders bevriest een latere wijziging in
        // de sheet achter een oude kopie in de browser.
        if (state.seoKeywords == null) state.seoKeywords = res.keywords || [];
        if (!seoSameList(state.seoRanks?.keywords, state.seoKeywords)) state.seoRanks = null;
        seoCacheSet("vol", state.seoKeywords, res);
        renderSeo();
        // Komt de meting uit een vastgelegd bestand, dan kosten posities niets
        // en zijn ze al gemeten — dan is een knop een overbodige drempel. Die
        // staat er alleen voor de live-laag, waar elke keyword een SERP-call is.
        // Zonder dit blijven de posities ook buiten de data die de agent krijgt.
        if (res.settings?.source === "drive" && !state.seoRanks && !state.seoRanksLoading) {
          seoRankFetch(false);
        }
      })
      .catch((err) => {
        state.seoLoading = false;
        // Ook een mislukte call vertelt ons hoe de klant geconfigureerd staat —
        // daarmee kan de tab uitleggen wát er ontbreekt in plaats van alleen dat
        // het misging.
        if (err.data?.settings) state.seoSettings = err.data.settings;
        state.seoError = err.message || "Onbekende fout bij laden van de SEO-data.";
        if (err.status === 401) { clearSession(); setTimeout(() => showScreen("login-screen"), 600); }
        renderSeo();
      });
  }

  function seoRankFetch(force) {
    if (!state.session || state.seoRanksLoading) return;
    const list = state.seoKeywords;
    if (!list || !list.length) return;

    if (!force) {
      const cached = seoCacheGet("rank", list);
      if (cached) { state.seoRanks = cached; renderSeo(); return; }
    }

    state.seoRanksLoading = true;
    state.seoRanksError = null;
    renderSeo();

    apiPost("/api/seo", {
      action: "ranks",
      clientId: state.session.clientId,
      token: state.session.token,
      keywords: list,
      ...(force ? { force: true } : {}),
    })
      .then((res) => {
        state.seoRanksLoading = false;
        state.seoRanks = res;
        if (res.settings) state.seoSettings = res.settings;
        // Een gedeeltelijke run niet in de dagcache: dan blijft een halve meting
        // tot morgen staan en denkt iedereen dat het klopt.
        if (!res.skipped) seoCacheSet("rank", list, res);
        renderSeo();
      })
      .catch((err) => {
        state.seoRanksLoading = false;
        if (err.data?.settings) state.seoSettings = err.data.settings;
        state.seoRanksError = err.message || "Rank-check mislukt.";
        if (err.status === 401) { clearSession(); setTimeout(() => showScreen("login-screen"), 600); }
        renderSeo();
      });
  }

  /* ---------- Keywordlijst bewerken ---------- */

  function seoSetKeywords(list) {
    state.seoKeywords = list;
    seoWriteLs("kws", list);
    // De geladen cijfers slaan nu op een andere lijst — weggooien, niet mengen.
    state.seo = null;
    state.seoRanks = null;
    state.seoError = null;
    state.seoRanksError = null;
  }

  window.__seoAddKw = (input) => {
    const raw = String(input?.value || "").trim().toLowerCase();
    if (!raw) return;
    input.value = "";
    const max = state.seoSettings?.maxVolumeKeywords || 100;
    const list = [...(state.seoKeywords || [])];
    if (raw.length > 80 || list.includes(raw) || list.length >= max) { renderSeo(); return; }
    list.push(raw);
    seoSetKeywords(list);
    seoFetch();
  };
  window.__seoKwKey = (ev, input) => {
    if (ev.key === "Enter") { ev.preventDefault(); window.__seoAddKw(input); }
  };
  window.__seoRemoveKw = (i) => {
    const list = [...(state.seoKeywords || [])];
    if (i < 0 || i >= list.length) return;
    list.splice(i, 1);
    seoSetKeywords(list);
    if (list.length) seoFetch(); else renderSeo();
  };
  window.__seoResetKw = () => {
    // Terug naar de lijst uit de Config-tab: eigen lijst weg, dan opnieuw halen.
    state.seoKeywords = null;
    try { localStorage.removeItem(seoLsKey("kws")); } catch {}
    state.seo = null;
    state.seoRanks = null;
    seoFetch(true);
  };
  window.__seoRefresh = () => seoFetch(true);
  window.__seoRank = () => seoRankFetch(true);
  window.__seoSort = (key) => {
    const s = state.seoSort;
    state.seoSort = { key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" };
    renderSeo();
  };

  /* ---------- Formatters + afgeleiden ---------- */

  const seoFmt = {
    int: (n) => (n == null || !isFinite(n)) ? "—" : Math.round(n).toLocaleString("nl-NL"),
    eur: (n) => (n == null || !isFinite(n)) ? "—" : "€" + n.toFixed(2).replace(".", ","),
    pos: (n) => (n == null || !isFinite(n)) ? "—" : "#" + Math.round(n),
  };

  // Trend = gemiddelde van de laatste drie maanden tegen de drie daarvoor. Met
  // minder dan zes maanden historiek zeggen we niets: een half jaar seizoen is
  // geen trend.
  function seoTrend(monthly) {
    const ms = (monthly || []).filter(m => m && m.volume != null);
    if (ms.length < 6) return null;
    const last3 = ms.slice(-3).reduce((s, m) => s + m.volume, 0) / 3;
    const prev3 = ms.slice(-6, -3).reduce((s, m) => s + m.volume, 0) / 3;
    if (!prev3) return null;
    return Math.round((last3 - prev3) / prev3 * 100);
  }

  function seoTrendHtml(pct) {
    if (pct == null) return `<span class="muted">—</span>`;
    // Stijgende vraag is goed nieuws, dalende slecht — los van de positie.
    const cls = pct > 10 ? "up" : pct < -10 ? "down" : "flat";
    const arrow = pct > 10 ? "▲" : pct < -10 ? "▼" : "●";
    return `<span class="seo-trend ${cls}">${arrow} ${pct >= 0 ? "+" : ""}${pct}%</span>`;
  }

  function seoRankOf(keyword) {
    const r = state.seoRanks?.ranks?.[keyword];
    return r || null;
  }

  function seoRankHtml(keyword) {
    const r = seoRankOf(keyword);
    if (!r) return `<span class="muted">?</span>`;
    if (r.skipped) return `<span class="muted" title="Niet gecontroleerd: tijdsbudget van de run was op">overgeslagen</span>`;
    if (r.error) return `<span class="muted" title="${escapeHtml(r.error)}">fout</span>`;
    if (r.pos == null) return `<span class="muted" title="Niet in de top ${state.seoRanks?.depth || 20}">—</span>`;
    const cls = r.pos <= 3 ? "good" : r.pos <= 10 ? "mid" : "low";
    const title = r.url ? `${r.url}` : "";
    return `<span class="seo-pos ${cls}"${title ? ` title="${escapeHtml(title)}"` : ""}>#${r.pos}</span>`;
  }

  /* ---------- Render ---------- */

  function renderSeo() {
    const root = $("#seo-content");
    if (!root) return;

    const s = state.seoSettings;

    // Geen koppeling: dat is geen fout maar een ontbrekende instelling, en de
    // sleutels staan in de env var — niet iets wat de klant zelf oplost.
    if (s && !s.hasCredentials) {
      root.innerHTML = renderAnalysisEmpty(`
        <p class="muted" style="margin:0 0 10px;">Deze tab draait op DataForSEO. Voor deze omgeving is nog geen koppeling ingesteld.</p>
        <p class="muted" style="margin:0; font-size:12px;">Zet <strong>DATAFORSEO_LOGIN</strong> en <strong>DATAFORSEO_PASSWORD</strong> in de omgevingsvariabelen (of per klant <em>dataforseo_login</em> / <em>dataforseo_password</em> in <strong>CLIENTS</strong>).</p>`);
      return;
    }

    const bar = renderSeoBar();

    // Lege keywordlijst is een normale begintoestand: de balk hierboven toont al
    // het invoerveld en verwijst naar de Config-tab. Geen rode foutmelding.
    const noKeywords = !!state.seoError && !(state.seoKeywords || []).length && /keywords/i.test(state.seoError);
    if (noKeywords) {
      root.innerHTML = bar + renderAnalysisEmpty(
        `<p class="muted" style="margin:0;">Nog geen keywords om te meten. Vul ze hierboven aan, of zet een startlijst in de Config-tab bij <strong>SEO keywords</strong>.</p>`);
      return;
    }

    if (state.seoError && !state.seo) {
      root.innerHTML = bar + renderAnalysisEmpty(
        `<p style="color:var(--negative); margin:0;">${escapeHtml(state.seoError)}</p>
         <button class="btn primary" style="margin-top:14px;" onclick="window.__seoRefresh()">Opnieuw proberen</button>`);
      return;
    }
    if (state.seoLoading && !state.seo) {
      root.innerHTML = bar + renderAnalysisEmpty(
        `<p class="muted" style="margin:0;">Zoekvolumes ophalen bij DataForSEO…</p>`);
      return;
    }
    if (!state.seo) { root.innerHTML = bar; return; }

    root.innerHTML = bar
      + renderSeoKpis()
      + renderSeoChart()
      + renderSeoTable()
      + renderSeoNotes();
  }

  function renderSeoBar() {
    const s = state.seoSettings;
    const list = state.seoKeywords || [];
    const max = s?.maxVolumeKeywords || 100;
    const maxRank = s?.maxRankKeywords || 25;

    const chips = list.map((k, i) => `<span class="seo-chip">${escapeHtml(k)}
      <button type="button" aria-label="Verwijder ${escapeHtml(k)}" onclick="window.__seoRemoveKw(${i})">✕</button></span>`).join("");

    const settingsLine = s
      ? `Domein ${s.domain ? `<strong>${escapeHtml(s.domain)}</strong>` : `<em>niet ingesteld</em>`}
         · markt <strong>${escapeHtml(s.location)}</strong>${s.locationSource === "default" ? " <span class=\"muted\">(standaard)</span>" : ""}
         · taal <strong>${escapeHtml(String(s.language).toUpperCase())}</strong>${s.languageSource === "default" ? " <span class=\"muted\">(standaard)</span>" : ""}`
      : "Instellingen laden…";

    // Waar kwamen de cijfers vandaan en wat kostte de laatste run? Kosten zijn
    // hier zichtbaar omdat ze per rank-check echt oplopen.
    const bits = [];
    if (state.seo) bits.push(state.seo.fromCache ? "volumes uit de cache van vandaag" : "volumes zojuist opgehaald");
    if (state.seoRanks) {
      bits.push(state.seoRanks.fromCache
        ? "posities uit de cache van vandaag"
        : `posities zojuist gemeten${state.seoRanks.cost ? ` (${seoFmt.eur(state.seoRanks.cost)})` : ""}`);
    }
    if (state.seoRanks?.skipped) bits.push(`${state.seoRanks.skipped} keyword(s) overgeslagen — tijdsbudget op`);
    const statusLine = bits.length ? `<div class="muted" style="font-size:11px; margin-top:8px;">${escapeHtml(bits.join(" · "))}</div>` : "";

    const rankDisabled = !s?.canRank || !list.length || state.seoRanksLoading;
    const rankTitle = !s?.hasCredentials
      ? "Geen DataForSEO-koppeling ingesteld"
      : !s?.domain
        ? "Zet 'SEO domein' in de Config-tab van de klantsheet"
        : `Kost ongeveer €0,002 per keyword · maximaal ${maxRank} per run`;

    const errLine = state.seoRanksError
      ? `<div style="font-size:11px; color:var(--negative); margin-top:8px;">${escapeHtml(state.seoRanksError)}</div>`
      : "";

    return `<section class="panel" style="padding:14px 18px; margin-bottom:16px;">
      <div class="roas-bar">
        <div>
          <div class="info-label">Keywords</div>
          <div class="muted" style="font-size:12px; margin-top:4px;">${settingsLine}</div>
        </div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <button class="btn tiny" onclick="window.__seoRefresh()"${state.seoLoading ? " disabled" : ""}>↻ Volumes</button>
          <button class="btn tiny" onclick="window.__seoRank()"${rankDisabled ? " disabled" : ""} title="${escapeHtml(rankTitle)}">${state.seoRanksLoading ? "Posities meten…" : "◎ Rank-check"}</button>
          <button class="btn tiny" onclick="window.__seoResetKw()" title="Terug naar de lijst uit de Config-tab">Reset</button>
        </div>
      </div>
      <div id="seo-chips" class="seo-chips">${chips || `<span class="muted" style="font-size:12px;">Nog geen keywords. Zet ze in de Config-tab bij <strong>SEO keywords</strong>, of voeg ze hieronder toe.</span>`}</div>
      <label class="web-search" style="margin-top:8px; max-width:340px;">
        <span class="ico">+</span>
        <input type="text" placeholder="Keyword toevoegen… (Enter)" autocomplete="off"
          onkeydown="window.__seoKwKey(event, this)"${list.length >= max ? " disabled" : ""}>
      </label>
      <div class="muted" style="font-size:11px; margin-top:8px;">
        Volumes zijn één goedkope batch-call voor de hele lijst. De rank-check is één SERP-call
        per keyword (~€0,002 per stuk) en zit daarom achter een eigen knop. Beide worden per dag
        gecached; verversen doet een echte call.
        <strong>De periodekiezer bovenaan geldt hier niet</strong> — zoekvolume is een maandcijfer
        en een positie is een momentopname.
      </div>
      ${statusLine}
      ${errLine}
    </section>`;
  }

  function renderSeoKpis() {
    const items = state.seo?.items || [];
    const withVol = items.filter(i => i.volume != null);
    const total = withVol.reduce((s, i) => s + i.volume, 0);
    const cpcs = items.filter(i => i.cpc != null);
    const avgCpc = cpcs.length ? cpcs.reduce((s, i) => s + i.cpc, 0) / cpcs.length : null;

    // Totaaltrend over alle keywords samen, op dezelfde meetlat als per rij.
    // Alleen maanden die élk keyword-met-data heeft: een maand waarin er één
    // ontbreekt zou anders als een daling meetellen.
    const withHist = items.filter(i => (i.monthly || []).some(m => m.volume != null));
    const valOf = (it, m) => {
      const hit = (it.monthly || []).find(x => x.month === m);
      return hit && hit.volume != null ? hit.volume : null;
    };
    const months = [...new Set(withHist.flatMap(i => i.monthly.map(m => m.month)))]
      .sort()
      .filter(m => withHist.every(it => valOf(it, m) != null));
    let totalTrend = null;
    if (months.length >= 6) {
      const sumM = (m) => withHist.reduce((s, i) => s + valOf(i, m), 0);
      const last3 = months.slice(-3).reduce((s, m) => s + sumM(m), 0) / 3;
      const prev3 = months.slice(-6, -3).reduce((s, m) => s + sumM(m), 0) / 3;
      if (prev3) totalTrend = Math.round((last3 - prev3) / prev3 * 100);
    }

    const ranks = state.seoRanks?.ranks || null;
    const rankedCount = ranks ? Object.values(ranks).filter(r => r && r.pos != null).length : null;
    const checked = ranks ? Object.keys(ranks).length : 0;

    const card = (label, value, sub, extra) => `<div class="kpi-card">
      <div class="label"><span class="dot"></span>${escapeHtml(label)}</div>
      <div class="value compact">${value}</div>
      ${extra || ""}
      ${sub ? `<div class="muted" style="font-size:11px;">${sub}</div>` : ""}
    </div>`;

    return `<div class="kpi-grid" style="margin-bottom:16px;">
      ${card("Zoekvolume per maand", seoFmt.int(total), `som over ${withVol.length} keyword${withVol.length === 1 ? "" : "s"} met data`, totalTrend != null ? `<div style="margin-top:2px;">${seoTrendHtml(totalTrend)} <span class="muted" style="font-size:11px;">vs vorige 3 maanden</span></div>` : "")}
      ${card("Keywords", String((state.seoKeywords || []).length), "eigen lijst, per klant gescheiden")}
      ${card("Gemiddelde CPC", seoFmt.eur(avgCpc), "wat adverteerders per klik betalen — indicatie van commerciële waarde")}
      ${card("In de top " + (state.seoRanks?.depth || 20), rankedCount == null ? "—" : `${rankedCount}/${checked}`, rankedCount == null ? "nog geen rank-check gedaan" : `organisch, ${escapeHtml(state.seoRanks.domain || "")}`)}
    </div>`;
  }

  function renderSeoChart() {
    const items = (state.seo?.items || []).filter(i => (i.monthly || []).some(m => m.volume != null));
    if (!items.length || !window.Charts) return "";

    // Alleen maanden die élk getekend keyword heeft. Charts.render kent geen
    // gaten — een ontbrekende maand zou als nul getekend worden, en dat is een
    // dal dat er niet is. De doorsnede is in de praktijk het volledige
    // twaalfmaandsvenster: DataForSEO levert voor elk keyword dezelfde reeks.
    const valueOf = (it, m) => {
      const hit = (it.monthly || []).find(x => x.month === m);
      return hit && hit.volume != null ? hit.volume : null;
    };
    const months = [...new Set(items.flatMap(i => i.monthly.map(m => m.month)))]
      .sort()
      .filter(m => items.every(it => valueOf(it, m) != null));
    if (months.length < 3) return "";

    const byVol = [...items].sort((a, b) => (b.volume || 0) - (a.volume || 0));
    const top = byVol.slice(0, SEO_MAX_CHART_SERIES);
    const rest = byVol.slice(SEO_MAX_CHART_SERIES);

    const series = top.map((it, idx) => ({
      label: it.keyword,
      values: months.map(m => valueOf(it, m)),
      kind: "line",
      axis: "left",
      color: Charts.seriesColor(idx),
    }));
    if (rest.length) {
      series.push({
        label: `overige (${rest.length})`,
        values: months.map(m => rest.reduce((s, it) => s + valueOf(it, m), 0)),
        kind: "line",
        axis: "left",
        color: Charts.seriesColor(SEO_MAX_CHART_SERIES),
      });
    }

    const spec = {
      width: 980, height: 260,
      x: months.map(m => { const [y, mm] = m.split("-"); return `${Number(mm)}/${y.slice(2)}`; }),
      series,
      leftFormat: Charts.fmt.k,
      maxXLabels: 12,
    };

    // Eigen legenda in plaats van Charts.legend(): die zet het label ongeëscapet
    // in innerHTML, en een keyword is door de gebruiker ingetypte tekst.
    const legend = series.map(s =>
      `<span class="item"><span class="swatch" style="background:${s.color}"></span>${escapeHtml(s.label)}</span>`
    ).join("");

    return `<section class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><div>
        <h2 class="panel-title">Zoekvolume per maand</h2>
        <div class="panel-sub">Twaalf maanden Google Ads-data · waar de vraag piekt en zakt</div>
      </div></div>
      ${chartSvg(spec)}
      <div class="chart-legend" style="margin-top:10px;">${legend}</div>
    </section>`;
  }

  function renderSeoTable() {
    const items = state.seo?.items || [];
    if (!items.length) return "";

    const rankVal = (kw) => {
      const r = seoRankOf(kw);
      // Niet-gerankt en niet-gemeten horen onderaan, niet bovenaan als '0'.
      return (r && r.pos != null) ? r.pos : Number.POSITIVE_INFINITY;
    };
    const val = (it) => {
      switch (state.seoSort.key) {
        case "keyword": return it.keyword;
        case "competition": return it.competitionIndex == null ? -1 : it.competitionIndex;
        case "cpc": return it.cpc == null ? -1 : it.cpc;
        case "trend": { const t = seoTrend(it.monthly); return t == null ? -Infinity : t; }
        case "pos": return rankVal(it.keyword);
        default: return it.volume == null ? -1 : it.volume;
      }
    };
    const dir = state.seoSort.dir === "asc" ? 1 : -1;
    const sorted = [...items].sort((a, b) => {
      const x = val(a), y = val(b);
      if (typeof x === "string") return dir * x.localeCompare(y, "nl");
      // Positie oplopend is 'beter' — omgekeerd aan de rest, dus Infinity blijft
      // in beide richtingen achteraan staan.
      if (state.seoSort.key === "pos") {
        if (x === y) return 0;
        if (!isFinite(x)) return 1;
        if (!isFinite(y)) return -1;
        return -dir * (x - y);
      }
      return dir * (x - y);
    });

    const arrow = (key) => state.seoSort.key === key ? (state.seoSort.dir === "desc" ? " ↓" : " ↑") : "";
    const th = (key, label, cls) =>
      `<th class="${cls || ""}" style="cursor:pointer;" onclick="window.__seoSort('${key}')">${escapeHtml(label)}${arrow(key)}</th>`;

    const compLabel = { HIGH: "hoog", MEDIUM: "midden", LOW: "laag" };
    const rows = sorted.map(it => {
      const comp = it.competition
        ? `<span class="seo-comp ${escapeHtml(it.competition.toLowerCase())}">${escapeHtml(compLabel[it.competition] || it.competition)}</span>`
        : `<span class="muted">—</span>`;
      return `<tr>
        <td class="row-caption" title="${escapeHtml(it.keyword)}">${escapeHtml(it.keyword)}</td>
        <td class="right">${seoFmt.int(it.volume)}</td>
        <td>${comp}</td>
        <td class="right">${seoFmt.eur(it.cpc)}</td>
        <td class="right">${seoTrendHtml(seoTrend(it.monthly))}</td>
        <td class="right">${seoRankHtml(it.keyword)}</td>
      </tr>`;
    }).join("");

    return `<section class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><div>
        <h2 class="panel-title">Per keyword</h2>
        <div class="panel-sub">Volume, concurrentie, CPC, trend en de positie van het merk-domein</div>
      </div></div>
      <div class="lib-table"><table>
        <thead><tr>
          ${th("keyword", "Keyword")}
          ${th("volume", "Volume/mnd", "right")}
          ${th("competition", "Concurrentie")}
          ${th("cpc", "CPC", "right")}
          ${th("trend", "Trend 3m", "right")}
          ${th("pos", "Positie", "right")}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>`;
  }

  function renderSeoNotes() {
    const s = state.seoSettings;
    const depth = state.seoRanks?.depth || 20;
    const missing = [];
    if (s && !s.domain) missing.push(`<li><strong>Geen merk-domein.</strong> Zet <em>SEO domein</em> in de Config-tab van de klantsheet; zonder dat veld kan de rank-check niet bepalen welk resultaat van deze klant is.</li>`);
    if (s && s.locationSource === "default") missing.push(`<li><strong>Markt staat op de standaard (${escapeHtml(s.location)}).</strong> Zet <em>SEO markt</em> in de Config-tab als de klant elders verkoopt — volumes en posities verschillen per land.</li>`);

    return `<section class="panel">
      <div class="panel-header"><div>
        <h2 class="panel-title">Hoe deze cijfers berekend zijn</h2>
        <div class="panel-sub">Zodat de tab navolgbaar blijft</div>
      </div></div>
      <ul class="roas-notes">
        <li><strong>Zoekvolume</strong> is Google Ads' gemiddelde aantal zoekopdrachten per maand in de ingestelde markt en taal, niet het verkeer naar de site. Google rondt die cijfers af en clustert varianten van dezelfde term.</li>
        <li><strong>Concurrentie en CPC</strong> komen ook uit Google Ads en gaan over <em>adverteerders</em>, niet over hoe moeilijk het is organisch te ranken. Een hoge CPC zegt vooral dat de term commercieel iets waard is.</li>
        <li><strong>Trend 3m</strong> vergelijkt het gemiddelde van de laatste drie maanden met de drie daarvoor. Met minder dan zes maanden historiek staat er een streepje: een half jaar is geen trend.</li>
        <li><strong>Positie</strong> is de organische plek van het merk-domein in de top ${depth}, gemeten op het moment dat je op Rank-check klikt. Subdomeinen tellen mee. Staat het domein er niet bij, dan zie je een streepje — dat is 'niet in de top ${depth}', niet 'geen ranking'.</li>
        <li><strong>Geen periode.</strong> Zoekvolume is een maandcijfer en een positie is een momentopname, dus de periodekiezer bovenaan geldt hier niet. Voor kliks en vertoningen uit Search Console: zie de Website-tab.</li>
        <li><strong>Kosten.</strong> Volumes zijn één batch-call voor de hele lijst en verwaarloosbaar. Een rank-check kost ongeveer €0,002 per keyword per run. Beide worden per dag gecached, per klant en per keywordlijst.</li>
        ${missing.join("")}
      </ul>
    </section>`;
  }

  /* ==========================================================
     GEO-tab — AI-zichtbaarheid (hoe LLM's over het merk praten)
     ==========================================================
     Geport van TEMPLATE_geo-dashboard.html uit Drive. Vijf sub-tabs, twee
     bronnen:

       Overzicht / Prompts / Website / Acties → de GEMETEN baseline uit
         geo-dashboard.json in de Drive-map van de klant (api/geo.js action
         'baseline'). Statisch: een audit heeft een datum en een methode, en
         verandert niet omdat iemand de pagina opent.
       Sources → live bij DataForSEO: welke domeinen en pagina's voeden
         AI-antwoorden in deze markt. Marktdata, geen uitspraak over de klant.

     Geen periode uit de topbar: een audit is een momentopname met een eigen
     datum. Zonder auditbestand staat er een uitleg, nooit nullen of demo-data
     ("geen audit = geen cijfers", zie agents/GEO_Dashboard_Schema.md).
     ========================================================== */

  const GEO_TABS = [
    { key: "overzicht", label: "Overzicht" },
    { key: "prompts", label: "Prompts" },
    { key: "sources", label: "Sources · live" },
    { key: "website", label: "Website" },
    { key: "acties", label: "Acties" },
  ];

  /* ---------- Fetch ---------- */

  function geoFetch(force) {
    if (!state.session || state.geoLoading) return;
    if (!force && (state.geo || state.geoMeta)) { renderGeo(); return; }

    state.geoLoading = true;
    state.geoError = null;
    renderGeo();

    apiPost("/api/geo", {
      action: "baseline",
      clientId: state.session.clientId,
      token: state.session.token,
      ...(force ? { force: true } : {}),
    })
      .then((res) => {
        state.geoLoading = false;
        state.geo = res.baseline || null;
        state.geoMeta = {
          reason: res.reason || null,
          searched: res.searched || [],
          warnings: res.warnings || [],
          file: res.file || null,
          otherFiles: res.otherFiles || 0,
          hasSources: !!res.hasSources,
        };
        renderGeo();
      })
      .catch((err) => {
        state.geoLoading = false;
        state.geoError = err.message || "Onbekende fout bij laden van de GEO-baseline.";
        if (err.status === 401) { clearSession(); setTimeout(() => showScreen("login-screen"), 600); }
        renderGeo();
      });
  }

  function geoSourcesFetch(force) {
    if (!state.session || state.geoSourcesLoading) return;
    state.geoSourcesLoading = true;
    state.geoSourcesError = null;
    renderGeo();

    apiPost("/api/geo", {
      action: "sources",
      clientId: state.session.clientId,
      token: state.session.token,
      ...(state.geoSourcesPlatform ? { platform: state.geoSourcesPlatform } : {}),
      ...(force ? { force: true } : {}),
    })
      .then((res) => {
        state.geoSourcesLoading = false;
        state.geoSources = res;
        renderGeo();
      })
      .catch((err) => {
        state.geoSourcesLoading = false;
        state.geoSourcesError = err.message || "Ophalen van de bronnen mislukt.";
        if (err.status === 401) { clearSession(); setTimeout(() => showScreen("login-screen"), 600); }
        renderGeo();
      });
  }

  window.__geoTab = (k) => { state.geoTab = k; renderGeo(); };
  window.__geoRefresh = () => geoFetch(true);
  window.__geoSources = (force) => geoSourcesFetch(force === true);
  window.__geoPlatform = (p) => {
    state.geoSourcesPlatform = p;
    state.geoSources = null;   // ander platform = andere dataset, niet mengen
    renderGeo();
  };

  /* ---------- Formatters ---------- */

  const geoFmt = {
    pct: (n) => (n == null || !isFinite(n)) ? "—" : (Number.isInteger(n) ? n : n.toFixed(1).replace(".", ",")) + "%",
    int: (n) => (n == null || !isFinite(n)) ? "—" : Math.round(n).toLocaleString("nl-NL"),
    date: (iso) => {
      if (!iso) return "—";
      const [y, m, d] = iso.split("-").map(Number);
      const mm = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
      return `${d} ${mm[m - 1]} ${y}`;
    },
  };

  // Horizontale balk. Bewust geen charts.js: dat tekent reeksen over een x-as,
  // en dit zijn losse waarden naast elkaar. Een balk vanaf nul met het cijfer
  // ernaast leest bovendien beter bij vijf engines dan een assenstelsel.
  function geoBar(label, value, max, display, title) {
    const w = (max > 0 && value != null) ? Math.max(1, Math.round((value / max) * 100)) : 0;
    return `<div class="geo-bar"${title ? ` title="${escapeHtml(title)}"` : ""}>
      <div class="lbl">${escapeHtml(label)}</div>
      <div class="track"><div class="fill" style="width:${w}%"></div></div>
      <div class="val">${escapeHtml(display)}</div>
    </div>`;
  }

  /* ---------- Render ---------- */

  function renderGeo() {
    const root = $("#geo-content");
    if (!root) return;

    if (state.geoLoading && !state.geo) {
      root.innerHTML = renderAnalysisEmpty(`<p class="muted" style="margin:0;">Auditbestand ophalen uit Drive…</p>`);
      return;
    }
    if (state.geoError) {
      root.innerHTML = renderAnalysisEmpty(
        `<p style="color:var(--negative); margin:0;">${escapeHtml(state.geoError)}</p>
         <button class="btn primary" style="margin-top:14px;" onclick="window.__geoRefresh()">Opnieuw proberen</button>`);
      return;
    }
    if (!state.geo) { root.innerHTML = renderGeoMissing(); return; }

    root.innerHTML = renderGeoBar() + renderGeoTabs() + renderGeoPane();
  }

  // Geen bestand = geen cijfers. Dit scherm legt uit wat er moet gebeuren en
  // wáár gekeken is; het toont nooit voorbeeld- of demo-data, want een klant
  // kan het verschil niet zien.
  function renderGeoMissing() {
    const m = state.geoMeta || {};
    const where = (m.searched || []).length
      ? `<p class="muted" style="margin:10px 0 0; font-size:12px;">Gezocht in: ${escapeHtml(m.searched.join(" · "))}.</p>`
      : "";
    return renderAnalysisEmpty(`
      <p class="muted" style="margin:0 0 10px;">Nog geen GEO-audit voor deze klant.</p>
      <p class="muted" style="margin:0; font-size:12px;">
        Deze tab toont een <em>gemeten</em> nulmeting: hoe de vijf AI-engines over het merk praten.
        Draai de <strong>geo-visibility-audit</strong> en zet het resultaat als
        <strong>geo-dashboard.json</strong> in de Drive-map van de klant
        (of in de submap <em>GEO</em>). Het schema staat in
        <em>agents/GEO_Dashboard_Schema.md</em>, met een ingevuld voorbeeld ernaast.
      </p>
      ${m.reason ? `<p class="muted" style="margin:10px 0 0; font-size:12px;">Reden: ${escapeHtml(m.reason)}</p>` : ""}
      ${where}
      <button class="btn primary" style="margin-top:14px;" onclick="window.__geoRefresh()">Opnieuw zoeken</button>`);
  }

  function renderGeoBar() {
    const g = state.geo, m = state.geoMeta || {};
    const bits = [];
    if (g.promptCount) bits.push(`${g.promptCount} prompts`);
    if (g.engines.length) bits.push(`${g.engines.length} engines`);
    if (m.file) bits.push(`bron: ${m.file.name}`);
    if (m.otherFiles) bits.push(`${m.otherFiles} ouder${m.otherFiles === 1 ? "" : "e"} bestand${m.otherFiles === 1 ? "" : "en"} genegeerd`);

    const warn = (m.warnings || []).length
      ? `<div style="font-size:11px; color:#b45309; margin-top:8px;">${m.warnings.map(w => escapeHtml(w)).join("<br>")}</div>`
      : "";

    return `<section class="panel" style="padding:14px 18px; margin-bottom:16px;">
      <div class="roas-bar">
        <div>
          <div class="info-label">Nulmeting</div>
          <div style="font-size:20px; color:var(--fg); margin-top:2px;">
            ${escapeHtml(geoFmt.date(g.auditDate))}${g.label ? ` · ${escapeHtml(g.label)}` : ""}
          </div>
          <div class="muted" style="font-size:11px; margin-top:2px;">${escapeHtml(bits.join(" · "))}</div>
        </div>
        <button class="btn tiny" onclick="window.__geoRefresh()">↻ Opnieuw inlezen</button>
      </div>
      ${g.passNote ? `<div class="muted" style="font-size:11px; margin-top:8px;">${escapeHtml(g.passNote)}</div>` : ""}
      ${warn}
    </section>`;
  }

  function renderGeoTabs() {
    return `<div class="geo-tabs">${GEO_TABS.map(t =>
      `<button class="${t.key === state.geoTab ? "on" : ""}" onclick="window.__geoTab('${t.key}')">${escapeHtml(t.label)}</button>`
    ).join("")}</div>`;
  }

  function renderGeoPane() {
    switch (state.geoTab) {
      case "prompts": return renderGeoPrompts();
      case "sources": return renderGeoSources();
      case "website": return renderGeoWebsite();
      case "acties": return renderGeoActions();
      default: return renderGeoOverview();
    }
  }

  /* ---------- 1. Overzicht ---------- */

  function renderGeoOverview() {
    const g = state.geo;
    const out = [];

    if (g.status) {
      out.push(`<div class="geo-callout ${escapeHtml(g.status.level)}">
        ${g.status.title ? `<strong>${escapeHtml(g.status.title)}.</strong> ` : ""}${escapeHtml(g.status.text || "")}
      </div>`);
    }

    if (g.kpis.length) {
      const prev = g.previous?.kpis || [];
      out.push(`<div class="kpi-grid" style="margin-bottom:16px;">${g.kpis.map(k => {
        const was = prev.find(p => p.label === k.label);
        return `<div class="kpi-card">
          <div class="label"><span class="dot"></span>${escapeHtml(k.label)}</div>
          <div class="value compact">${escapeHtml(k.value)}</div>
          ${k.delta ? `<div class="geo-delta ${escapeHtml(k.tone)}">${escapeHtml(k.delta)}</div>` : ""}
          ${was ? `<div class="muted" style="font-size:11px;">was ${escapeHtml(was.value)} op ${escapeHtml(geoFmt.date(g.previous.auditDate))}</div>` : ""}
          ${k.sub ? `<div class="muted" style="font-size:11px;">${escapeHtml(k.sub)}</div>` : ""}
        </div>`;
      }).join("")}</div>`);
    }

    if (g.engines.length) {
      const measured = g.engines.filter(e => e.mentionRatePct != null);
      const max = Math.max(100, ...measured.map(e => e.mentionRatePct));
      out.push(`<section class="panel" style="margin-bottom:16px;">
        <div class="panel-header"><div>
          <h2 class="panel-title">Mention rate per engine</h2>
          <div class="panel-sub">Op hoeveel van de prompts het merk genoemd wordt</div>
        </div></div>
        ${measured.length
          ? measured.map(e => geoBar(e.name, e.mentionRatePct, max, geoFmt.pct(e.mentionRatePct),
              [e.runs != null ? `${e.runs} runs` : "", e.note || ""].filter(Boolean).join(" · "))).join("")
          : `<p class="muted" style="margin:0; font-size:12px;">Geen mention rate per engine in dit auditbestand.</p>`}
        <div class="lib-table" style="margin-top:14px;"><table>
          <thead><tr>
            <th>Engine</th><th class="right">Runs</th><th class="right">Mention rate</th>
            <th class="right">Share of voice</th><th class="right">Descriptor</th>
            <th>Top concurrent</th><th>Meest geciteerd brontype</th>
          </tr></thead>
          <tbody>${g.engines.map(e => `<tr>
            <td class="row-caption">${escapeHtml(e.name)}</td>
            <td class="right">${geoFmt.int(e.runs)}</td>
            <td class="right">${geoFmt.pct(e.mentionRatePct)}</td>
            <td class="right">${geoFmt.pct(e.shareOfVoicePct)}</td>
            <td class="right">${geoFmt.pct(e.descriptorAccuracyPct)}</td>
            <td>${escapeHtml(e.topCompetitor || "—")}</td>
            <td class="row-caption" title="${escapeHtml(e.sourceType || "")}">${escapeHtml(e.sourceType || "—")}</td>
          </tr>`).join("")}</tbody>
        </table></div>
        <div class="muted" style="font-size:11px; margin-top:10px;">
          Een leeg vak bij Descriptor betekent <em>niets te beoordelen</em>: zonder mentions is er geen beschrijving om juist of fout te noemen. Dat is niet hetzelfde als 0%.
        </div>
      </section>`);
    }

    const cols = [];
    if (g.byType.length) {
      const max = Math.max(100, ...g.byType.map(t => t.ratePct || 0));
      cols.push(`<section class="panel">
        <div class="panel-header"><div>
          <h2 class="panel-title">Per prompt-type</h2>
          <div class="panel-sub">Waar in de koopreis het merk wel en niet opduikt</div>
        </div></div>
        ${g.byType.map(t => geoBar(t.type, t.ratePct, max, geoFmt.pct(t.ratePct), t.note || "")).join("")}
      </section>`);
    }
    if (g.competitors.length) {
      const max = Math.max(1, ...g.competitors.map(c => c.engines || 0));
      cols.push(`<section class="panel">
        <div class="panel-header"><div>
          <h2 class="panel-title">Wie de plek inneemt</h2>
          <div class="panel-sub">Op hoeveel engines dit merk de top-mention is</div>
        </div></div>
        ${g.competitors.map(c => geoBar(c.name, c.engines, max, `${c.engines ?? "—"}×`, c.note || "")).join("")}
      </section>`);
    }
    if (cols.length) out.push(`<div class="geo-grid2" style="margin-bottom:16px;">${cols.join("")}</div>`);

    if (g.phases.length) {
      out.push(`<section class="panel" style="margin-bottom:16px;">
        <div class="panel-header"><div>
          <h2 class="panel-title">Waar het merk staat</h2>
          <div class="panel-sub">Elke fase heeft een poort; die haal je voordat de volgende zin heeft</div>
        </div></div>
        <div class="geo-phases">${g.phases.map(p => `<div class="geo-phase${p.here ? " here" : ""}">
          <div class="n">${escapeHtml(p.n || "")}</div>
          <div class="t">${escapeHtml(p.title)}</div>
          <div class="g">${escapeHtml(p.gate || "")}</div>
        </div>`).join("")}</div>
      </section>`);
    }

    if (g.method) {
      out.push(`<section class="panel">
        <div class="panel-header"><div>
          <h2 class="panel-title">Hoe dit gemeten is</h2>
          <div class="panel-sub">Zodat een her-meting vergelijkbaar blijft</div>
        </div></div>
        <p class="muted" style="margin:0; font-size:13px; line-height:1.7;">${escapeHtml(g.method)}</p>
        <div class="muted" style="font-size:11px; margin-top:10px;">
          Een her-audit is alleen vergelijkbaar met dezelfde promptset én hetzelfde aantal passes. Een 1-pass nulmeting naast een 3-pass hermeting leggen is geen trend.
        </div>
      </section>`);
    }

    return out.join("");
  }

  /* ---------- 2. Prompts ---------- */

  function renderGeoPrompts() {
    const g = state.geo;
    if (!g.prompts.length) {
      return renderAnalysisEmpty(`<p class="muted" style="margin:0;">Geen promptmatrix in dit auditbestand. Voeg een <em>prompts</em>-blok toe (zie het schema).</p>`);
    }
    const engines = g.engines.length ? g.engines.map(e => e.name) : [...new Set(g.prompts.flatMap(p => Object.keys(p.cells)))];

    const cell = (v) => {
      if (v === 1) return `<td class="c geo-cell yes" title="genoemd">✓</td>`;
      if (v === 2) return `<td class="c geo-cell warn" title="genoemd maar fout beschreven">⚠</td>`;
      if (v === 0) return `<td class="c geo-cell no" title="niet genoemd">–</td>`;
      return `<td class="c geo-cell unk" title="niet gemeten">·</td>`;
    };

    const rows = g.prompts.map(p => `<tr>
      <td class="right">${p.n}</td>
      <td class="row-caption" title="${escapeHtml(p.text)}">${escapeHtml(p.text)}</td>
      <td><span class="geo-tag">${escapeHtml(p.type || "—")}</span></td>
      ${engines.map(e => cell(p.cells[e])).join("")}
    </tr>`).join("");

    // Tel per toestand, zodat 'niet gemeten' zichtbaar blijft in plaats van in
    // de nullen te verdwijnen.
    const flat = g.prompts.flatMap(p => engines.map(e => p.cells[e]));
    const n = (v) => flat.filter(x => x === v).length;
    const unmeasured = flat.filter(x => x !== 0 && x !== 1 && x !== 2).length;

    return `<section class="panel">
      <div class="panel-header"><div>
        <h2 class="panel-title">${g.prompts.length} buyer prompts × ${engines.length} engines</h2>
        <div class="panel-sub">De vragen die kopers stellen, en of het merk in het antwoord zit</div>
      </div></div>
      <div class="lib-table"><table>
        <thead><tr>
          <th class="right">#</th><th>Prompt</th><th>Type</th>
          ${engines.map(e => `<th class="c">${escapeHtml(e)}</th>`).join("")}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="geo-legend">
        <span><b class="geo-cell yes">✓</b> genoemd — ${n(1)}</span>
        <span><b class="geo-cell warn">⚠</b> genoemd maar fout beschreven — ${n(2)}</span>
        <span><b class="geo-cell no">–</b> niet genoemd — ${n(0)}</span>
        <span><b class="geo-cell unk">·</b> niet gemeten — ${unmeasured}</span>
      </div>
      <div class="muted" style="font-size:11px; margin-top:8px;">
        'Niet gemeten' is bewust een eigen toestand: bij een deelmeting (niet elke engine draaide elke prompt)
        zou het anders als 'niet genoemd' meetellen en de mention rate structureel te laag maken.
      </div>
    </section>`;
  }

  /* ---------- 3. Sources (live) ---------- */

  function renderGeoSources() {
    const g = state.geo;
    const m = state.geoMeta || {};
    if (!m.hasSources) {
      return renderAnalysisEmpty(`
        <p class="muted" style="margin:0 0 10px;">Deze sub-tab haalt live op bij DataForSEO; er is geen koppeling ingesteld.</p>
        <p class="muted" style="margin:0; font-size:12px;">Zet <strong>DATAFORSEO_LOGIN</strong> en <strong>DATAFORSEO_PASSWORD</strong> in de omgevingsvariabelen.</p>`);
    }
    if (!g.sources || !g.sources.keyword) {
      return renderAnalysisEmpty(`<p class="muted" style="margin:0;">Geen <em>sources</em>-blok in het auditbestand. Zet daar een keyword, platform, markt en taal.</p>`);
    }

    const s = state.geoSources;
    const plat = state.geoSourcesPlatform || g.sources.platform;
    const platBtn = (k, label) => `<button class="btn tiny ${plat === k ? "primary" : ""}" onclick="window.__geoPlatform('${k}')">${escapeHtml(label)}</button>`;

    // De BE-database kent alleen platform 'google'; de ChatGPT-database bestaat
    // enkel voor VS/EN. Die combinatie levert stilzwijgend niets op, dus zeggen
    // we het vóór de call in plaats van erna.
    const loc = (g.sources.location || "").toLowerCase();
    const mismatch = plat === "chat_gpt" && loc && loc !== "united states"
      ? `<div class="geo-callout warn" style="margin-top:12px;">De ChatGPT-database bestaat alleen voor de Verenigde Staten en het Engels. Met markt <strong>${escapeHtml(g.sources.location)}</strong> komt er niets terug — kies Google AI, of zet de markt in het auditbestand op United States.</div>`
      : "";

    const head = `<section class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><div>
        <h2 class="panel-title">Welke bronnen voeden AI-antwoorden</h2>
        <div class="panel-sub">Live bij DataForSEO · marktdata voor "${escapeHtml(g.sources.keyword)}", niet over dit merk</div>
      </div></div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        ${platBtn("chat_gpt", "ChatGPT")}
        ${platBtn("google", "Google AI")}
        <button class="btn tiny" onclick="window.__geoSources(true)"${state.geoSourcesLoading ? " disabled" : ""}>
          ${state.geoSourcesLoading ? "Ophalen…" : "◎ Ophalen"}
        </button>
        <span class="muted" style="font-size:11px;">markt ${escapeHtml(g.sources.location || "—")} · taal ${escapeHtml((g.sources.language || "—").toUpperCase())}</span>
      </div>
      <div class="muted" style="font-size:11px; margin-top:8px;">
        Eén pull kost ongeveer $0,10 op het gedeelde DataForSEO-saldo en mag tot twee minuten duren — daarom een knop en een dagcache.
        Het keyword staat vast in het auditbestand.
      </div>
      ${mismatch}
      ${state.geoSourcesError ? `<div style="font-size:11px; color:var(--negative); margin-top:8px;">${escapeHtml(state.geoSourcesError)}</div>` : ""}
      ${s ? `<div class="muted" style="font-size:11px; margin-top:8px;">${escapeHtml(
          s.fromCache ? "uit de cache van vandaag" : `zojuist opgehaald${s.cost ? ` ($${s.cost})` : ""}`
        )}${s.totals?.mentions != null ? ` · ${escapeHtml(geoFmt.int(s.totals.mentions))} mentions in de dataset` : ""}</div>` : ""}
    </section>`;

    if (!s) return head;

    const blocks = [];

    if (s.domains?.length) {
      const max = Math.max(...s.domains.map(d => d.mentions), 1);
      blocks.push(`<section class="panel" style="margin-bottom:16px;">
        <div class="panel-header"><div>
          <h2 class="panel-title">Meest geciteerde domeinen</h2>
          <div class="panel-sub">Je digital-PR-targetlijst: hier wordt de markt beslist</div>
        </div></div>
        ${s.domains.map(d => geoBar(d.key, d.mentions, max, geoFmt.int(d.mentions),
          d.aiSearchVolume != null ? `AI-zoekvolume ${geoFmt.int(d.aiSearchVolume)}` : "")).join("")}
      </section>`);
    } else if (s.errors?.domains) {
      blocks.push(`<section class="panel" style="margin-bottom:16px;"><p class="muted" style="margin:0; font-size:12px;">Domeinen ophalen mislukt: ${escapeHtml(s.errors.domains)}</p></section>`);
    }

    if (s.totals?.brands?.length) {
      const max = Math.max(...s.totals.brands.map(b => b.mentions), 1);
      blocks.push(`<section class="panel" style="margin-bottom:16px;">
        <div class="panel-header"><div>
          <h2 class="panel-title">Merken die AI noemt</h2>
          <div class="panel-sub">Wie in deze markt als entiteit bestaat voor de modellen</div>
        </div></div>
        ${s.totals.brands.map(b => geoBar(b.key, b.mentions, max, geoFmt.int(b.mentions))).join("")}
      </section>`);
    }

    if (s.pages?.length) {
      blocks.push(`<section class="panel">
        <div class="panel-header"><div>
          <h2 class="panel-title">Meest gebruikte pagina's</h2>
          <div class="panel-sub">Welk paginatype AI citeert — het formaat om na te bouwen</div>
        </div></div>
        <div class="lib-table"><table>
          <thead><tr><th>URL</th><th class="right">Mentions</th><th class="right">AI-volume</th></tr></thead>
          <tbody>${s.pages.map(p => `<tr>
            <td class="row-caption" title="${escapeHtml(p.url)}">${escapeHtml(p.url)}</td>
            <td class="right">${geoFmt.int(p.mentions)}</td>
            <td class="right">${geoFmt.int(p.aiSearchVolume)}</td>
          </tr>`).join("")}</tbody>
        </table></div>
      </section>`);
    } else if (s.errors?.pages) {
      blocks.push(`<section class="panel"><p class="muted" style="margin:0; font-size:12px;">Pagina's ophalen mislukt: ${escapeHtml(s.errors.pages)}</p></section>`);
    }

    if (!blocks.length) {
      blocks.push(renderAnalysisEmpty(`<p class="muted" style="margin:0;">Geen data voor deze combinatie. Probeer het andere platform, of een breder keyword in het auditbestand.</p>`));
    }

    return head + blocks.join("");
  }

  /* ---------- 4. Website (readiness) ---------- */

  function renderGeoWebsite() {
    const g = state.geo;
    if (!g.readiness.length) {
      return renderAnalysisEmpty(`<p class="muted" style="margin:0;">Geen readiness-checks in dit auditbestand. Voeg een <em>readiness</em>-blok toe (zie het schema).</p>`);
    }
    const pass = g.readiness.filter(c => c.status === "pass").length;
    const fail = g.readiness.filter(c => c.status === "fail").length;
    const unk = g.readiness.filter(c => c.status === "unknown").length;
    const icon = { pass: "✓", fail: "✕", unknown: "?" };

    return `<div class="kpi-grid" style="grid-template-columns:repeat(2,1fr); margin-bottom:16px;">
      <div class="kpi-card">
        <div class="label"><span class="dot"></span>Readiness-score</div>
        <div class="value compact">${pass}/${g.readiness.length}</div>
        <div class="muted" style="font-size:11px;">${fail} gezakt · ${unk} onmeetbaar</div>
      </div>
      <div class="kpi-card">
        <div class="label"><span class="dot"></span>Onmeetbaar</div>
        <div class="value compact">${unk}</div>
        <div class="muted" style="font-size:11px;">Apart geteld: onmeetbaar is geen gezakte check. Zolang een site niet bereikbaar is valt er niets te controleren.</div>
      </div>
    </div>
    <section class="panel">
      <div class="panel-header"><div>
        <h2 class="panel-title">GEO/AEO readiness</h2>
        <div class="panel-sub">Kan een AI-crawler het merk überhaupt lezen</div>
      </div></div>
      <div class="geo-checks">${g.readiness.map(c => `<div class="geo-check">
        <div class="dot ${escapeHtml(c.status)}">${icon[c.status]}</div>
        <div style="flex:1;">${escapeHtml(c.check)}</div>
        <div class="why">${escapeHtml(c.note || "")}</div>
      </div>`).join("")}</div>
      <div class="muted" style="font-size:11px; margin-top:12px;">
        Status op auditdatum ${escapeHtml(geoFmt.date(g.auditDate))}. Deze checks worden niet live herhaald — ze horen bij de meting waar de rest van deze tab op slaat.
      </div>
    </section>`;
  }

  /* ---------- 5. Acties ---------- */

  function renderGeoActions() {
    const g = state.geo;
    if (!g.actions.length) {
      return renderAnalysisEmpty(`<p class="muted" style="margin:0;">Geen acties in dit auditbestand. Voeg een <em>actions</em>-blok toe (zie het schema).</p>`);
    }
    return `<div class="geo-actions">${g.actions.map(a => `<div class="geo-action${/^p2/i.test(a.priority || "") ? " p2" : ""}">
      <div class="meta">
        ${a.priority ? `<span>${escapeHtml(a.priority)}</span>` : ""}
        ${a.effort ? `<span>effort ${escapeHtml(a.effort)}</span>` : ""}
        ${a.skill ? `<span>${escapeHtml(a.skill)}</span>` : ""}
      </div>
      <h3>${escapeHtml(a.title)}</h3>
      ${a.text ? `<p>${escapeHtml(a.text)}</p>` : ""}
      ${a.done ? `<div class="done">✓ Klaar als: ${escapeHtml(a.done)}</div>` : ""}
    </div>`).join("")}</div>`;
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
      pushBot({ text: `Hoi! Ik ben je <strong>Performance Agent</strong>. Ik kan vragen beantwoorden over je content en groei. Probeer een prompt hieronder, of stel je eigen vraag.`, html: true });
    } else {
      // Re-render bestaande geschiedenis in de DOM
      for (const m of state.chatMessages) appendMsg(m.role === "bot" ? "bot" : "user", m.text, m.stats, m.html);
    }
  }
  function pushUser(text) { state.chatMessages.push({ role: "user", text }); appendMsg("user", text); }
  function pushBot(payload) { state.chatMessages.push({ role: "bot", ...payload }); appendMsg("bot", payload.text, payload.stats, payload.html); }
  // isTrustedHtml: alleen true voor door ONS opgestelde markup (welkomstbericht, foutmelding
  // met vooraf-ge-escapete inhoud). LLM-antwoorden en gebruikersinvoer NOOIT: die kunnen door
  // een aanvaller beïnvloede tekst bevatten (advertentienamen, captions) → anders stored XSS.
  function appendMsg(role, text, stats, isTrustedHtml) {
    const body = $("#chat-body");
    const wrap = document.createElement("div");
    wrap.className = `msg ${role}`;
    let stubs = "";
    if (stats) {
      stubs = `<div class="meta-stats">${stats.map(s => `<span class="stat-chip"><span class="n">${s.n}</span><span class="l">${s.l}</span></span>`).join("")}</div>`;
    }
    const safeText = isTrustedHtml ? text : escapeHtml(text).replace(/\n/g, "<br>");
    wrap.innerHTML = `<div class="author">${role === "user" ? "Jij" : "Agent"}</div><div class="bubble">${safeText}${stubs}</div>`;
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

    // Geef de chat-agent de geaggregeerde dashboard-data van de huidige periode mee,
    // zodat vragen over performance op echte cijfers steunen i.p.v. enkel merkcontext.
    // Stateless/single-shot: elke turn krijgt de data opnieuw mee.
    let dashboardData = null;
    try { dashboardData = buildAnalysisSummary(); } catch (_) {}

    // Merk-/strategiecontext uit Drive (merk-brief, do's & don'ts, pijlers, concurrentie)
    // zodat antwoorden op de merkstem en pijlers zijn afgestemd. Best-effort; per klant gecachet.
    const contextFiles = await fetchDriveContext();
    const driveFiles = contextFiles.length ? { contextFiles } : undefined;

    try {
      const data = await apiPost("/api/chat", {
        messages: apiMessages,
        clientId: state.session.clientId,
        token: state.session.token,
        clientContext: state.session.clientContext || "",
        dashboardData,
        driveFiles,
      });
      typing.remove();
      pushBot({ text: data.text || "Geen antwoord ontvangen." });
    } catch (err) {
      typing.remove();
      pushBot({ text: `<em>Er ging iets mis: ${escapeHtml(err.message || "onbekende fout")}</em>`, html: true });
      if (err.status === 401) {
        clearSession();
        setTimeout(() => showScreen("login-screen"), 600);
      }
    } finally {
      if (inputField) { inputField.disabled = false; inputField.focus(); }
      if (submitBtn) submitBtn.disabled = false;
    }
  }
  /* ---------- Navigatie: rail, uitschuiflade en de keuze onthouden ----------
     Eén attribuut op <html> bepaalt de stand; de CSS doet de layout. Zonder
     expliciete keuze van de gebruiker volgt de zijbalk het scherm: rail onder
     1180px, lade onder 900px. Een eigen keuze blijft staan, ook na een reload.
     ------------------------------------------------------------------------ */

  const NAV_KEY = "mayday.nav";
  const NAV_NARROW = window.matchMedia("(max-width: 1180px)");
  const NAV_DRAWER = window.matchMedia("(max-width: 900px)");

  function navChoice() {
    try { return localStorage.getItem(NAV_KEY); } catch { return null; }
  }

  function setNavChoice(v) {
    try { v ? localStorage.setItem(NAV_KEY, v) : localStorage.removeItem(NAV_KEY); } catch {}
  }

  function applyNav() {
    const root = document.documentElement;
    // In de lade-modus zegt het attribuut alleen of de lade open staat.
    if (NAV_DRAWER.matches) {
      if (root.getAttribute("data-nav") !== "open") root.setAttribute("data-nav", "closed");
      return;
    }
    const choice = navChoice() || (NAV_NARROW.matches ? "collapsed" : "expanded");
    root.setAttribute("data-nav", choice);
    const btn = $("#nav-toggle");
    if (btn) {
      const open = choice !== "collapsed";
      btn.setAttribute("aria-expanded", String(open));
      btn.setAttribute("aria-label", open ? "Menu inklappen" : "Menu uitklappen");
    }
  }

  function setDrawer(open) {
    document.documentElement.setAttribute("data-nav", open ? "open" : "closed");
    const opener = $("#nav-open");
    if (opener) opener.setAttribute("aria-expanded", String(open));
  }

  function bindSidebarNav() {
    const root = document.documentElement;
    const toggle = $("#nav-toggle");
    if (toggle) toggle.addEventListener("click", () => {
      setNavChoice(root.getAttribute("data-nav") === "collapsed" ? "expanded" : "collapsed");
      applyNav();
    });
    const opener = $("#nav-open");
    if (opener) opener.addEventListener("click", () => setDrawer(root.getAttribute("data-nav") !== "open"));
    const backdrop = $("#nav-backdrop");
    if (backdrop) backdrop.addEventListener("click", () => setDrawer(false));
    // Een sectie kiezen sluit de lade: die staat anders over de inhoud die je
    // net hebt opgevraagd.
    $$(".nav-link").forEach(b => b.addEventListener("click", () => {
      if (NAV_DRAWER.matches) setDrawer(false);
    }));
    NAV_NARROW.addEventListener("change", applyNav);
    NAV_DRAWER.addEventListener("change", applyNav);
    applyNav();
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
    setDensity(t.density); setTheme(t.theme);
    $$("[data-tweak-density]").forEach(b => { b.onclick = () => { setDensity(b.dataset.tweakDensity); persist({ density: b.dataset.tweakDensity }); }; });
    $$("[data-tweak-theme]").forEach(b => { b.onclick = () => { setTheme(b.dataset.tweakTheme); persist({ theme: b.dataset.tweakTheme }); }; });
    $("#tweaks-close").onclick = () => { closeTweaks(); window.parent.postMessage({ type: "__edit_mode_dismissed" }, "*"); };
  }
  function openTweaks() { $("#tweaks-panel").classList.add("on"); }
  function closeTweaks() { $("#tweaks-panel").classList.remove("on"); }
  function persist(edits) { window.parent.postMessage({ type: "__edit_mode_set_keys", edits }, "*"); }
  // Grafieken bakken hun kleuren in de SVG op het moment van tekenen, dus na een
  // thema- of accentwissel moeten de pagina's met grafieken opnieuw getekend
  // worden — anders blijft de donut in de oude kleuren staan.
  function repaintCharts() {
    if (!dashboardInited) return;
    if (state.overview) renderOverview();
    if (state.website && typeof renderWebsite === "function") renderWebsite();
  }
  function setDensity(v) { document.documentElement.setAttribute("data-density", v); $$("[data-tweak-density]").forEach(b => b.classList.toggle("on", b.dataset.tweakDensity === v)); }
  function setTheme(v) {
    document.documentElement.setAttribute("data-theme", v);
    $$("[data-tweak-theme]").forEach(b => b.classList.toggle("on", b.dataset.tweakTheme === v));
    // De afleiding heeft in dark mode een ander eindpunt, dus eerst opnieuw
    // rekenen en daarna hertekenen — grafieken bakken hun kleuren in de SVG.
    applyDerivedTokens();
    repaintCharts();
  }

  /* ---------- Rapportbrug ----------
     De Rapport-tab (report.js) bouwt zijn slides uit precies dezelfde
     render-functies als het dashboard. Dat is de kern van het ontwerp: één
     cijfer heeft één herkomst, dus een slide kan nooit iets anders beweren dan
     de tab waar hij vandaan komt.

     Die renderers lezen allemaal uit `state` en niet uit hun argumenten. Daarom
     geeft de brug state zélf door, plus `borrow()`: dat zet de state-sleutels
     synchroon om naar de rapportperiode, roept de renderer aan en zet alles in
     een finally weer terug. Synchroon is hier de hele veiligheidsgarantie — er
     mag niets tussen zitten dat await't, anders ziet het dashboard even de
     rapportdata. Bewust één smal object in plaats van tientallen losse
     window.__-functies. */
  window.__reportBridge = {
    state,
    escapeHtml,
    chartSvg,
    apiPost,
    windsorCall,
    webPrevRange,
    roasCompareRange,
    buildAnalysisSummary,
    buildWebsiteSummary,
    fmt,
    webFmt,
    seriesColor: (i) => (window.Charts ? Charts.seriesColor(i) : "#400745"),
    analysisPeriodKey,
    periodDays,
    // Laad-aanzetten. Ze geven niets terug — de tabs zijn fire-and-forget
    // geschreven en zetten hun resultaat in state. report.js wacht daarom op de
    // state zelf (zie waitFor), wat ook meteen het geval dekt dat de data er al
    // stond en er niets te wachten valt.
    ensure: {
      overview: () => refreshOverview(),
      analysis: () => generateAnalysis(),
      website:  () => websiteFetch(),
      email:    () => refreshEmail(),
      seo:      () => seoFetch(),
      geo:      () => geoFetch(),
    },
    // De renderers die een HTML-string teruggeven. De Overview-renderers staan
    // er bewust niet bij: die schrijven rechtstreeks in DOM-knopen met een vast
    // id (#kpi-grid, #trend-chart) en geven niets terug, dus report.js bouwt die
    // vier blokken opnieuw op uit state.overview.
    render: {
      analysisInsights:  (a) => renderAnalysisInsights(a),
      analysisAds:       () => renderAnalysisAdsRanking(),
      websiteKpis:       () => renderWebsiteKpis(),
      websiteChart:      () => renderWebsiteChart(),
      websiteChannels:   () => renderWebsiteChannels(),
      websiteSources:    () => renderWebsiteSources(),
      websiteLanding:    () => renderWebsiteLanding(),
      websiteFunnel:     () => renderWebsiteFunnel(),
      websiteSearch:     () => renderWebsiteSearch(),
      websiteAudience:   () => renderWebsiteAudience(),
      websiteNotes:      () => renderWebsiteNotes(),
      roasHero:          () => renderRoasHero(),
      roasDaily:         () => renderRoasDailyChart(),
      roasGroup:         (grp, title) => renderRoasGroup(grp, title),
      roasBreakEven:     () => renderRoasBreakEven(),
      roasAdvice:        () => renderRoasAdvice(),
      roasFootnote:      () => renderRoasFootnote(),
      seoKpis:           () => renderSeoKpis(),
      seoChart:          () => renderSeoChart(),
      seoTable:          () => renderSeoTable(),
      seoNotes:          () => renderSeoNotes(),
      geoOverview:       () => renderGeoOverview(),
      geoPrompts:        () => renderGeoPrompts(),
      geoWebsite:        () => renderGeoWebsite(),
      geoActions:        () => renderGeoActions(),
      email:             (e) => (e.connector === "klaviyo" ? renderEmailKlaviyo(e)
                                : e.connector === "mailerlite" ? renderEmailMailerLite(e)
                                : renderEmailConvertKit(e)),
    },
    borrow(patch, fn) {
      const saved = {};
      for (const k of Object.keys(patch)) saved[k] = state[k];
      Object.assign(state, patch);
      try { return fn(); } finally { Object.assign(state, saved); }
    },
  };

  /* ---------- Boot ---------- */

  function bindLogin() {
    // Eén submit-handler: Enter in beide velden en de knop lopen via het formulier.
    // Vroeger hingen er een onclick én een click-listener aan de knop, waardoor
    // elke login twee keer naar /api/auth ging.
    const form = $("#login-form");
    if (form) form.addEventListener("submit", login);
    ["#brand-input", "#code-input"].forEach(sel => {
      const el = $(sel);
      if (el) el.addEventListener("input", () => el.removeAttribute("aria-invalid"));
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindLogin();
    bindTweaks();
    bindSidebarNav();
    bindOverviewTabs();
    bindManualContext();

    const existing = loadSession();
    if (existing && existing.token) {
      $("#sidebar-brand").textContent = `Klant: ${existing.brandName}`;
      $("#sidebar-brand-sub").textContent = existing.hasMetricool ? "Connected · Metricool live" : "Connected";
      updateSidebarContext();
      applyBrandConfig(existing.brand);   // uit de sessie: geen flits van de standaardkleur
      fetchBrandConfig();                 // en meteen verversen voor wijzigingen in de sheet
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
