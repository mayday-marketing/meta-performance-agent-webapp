/* ==========================================================
   Rapport — stelt een presentatie samen uit de blokken van
   de andere tabs.

   Het uitgangspunt: een slide wordt gebouwd door dezelfde
   render-functie als de tab waar hij vandaan komt. Eén cijfer
   heeft dus één herkomst, en een deck kan nooit iets anders
   beweren dan het dashboard. Wat hier bij komt is de keuze
   (welke pagina's, welke blokken), de opdeling in slides en
   twee uitvoervormen: slides in de browser (en via printen
   een PDF) en een .pptx-bestand.

   Periode: het rapport volgt de dashboardperiode uit de
   topbar — één periode voor alles, geen tweede waarheid.
   ROAS is de uitzondering: die tab heeft een eigen
   maandperiode, dus het rapport haalt ROAS apart op voor de
   rapportperiode (zie loadRoas).
   ========================================================== */

(function () {
  const B = window.__reportBridge;
  if (!B) return;                       // app.js niet geladen — niets te doen
  const state = B.state;
  const esc = B.escapeHtml;
  const R = B.render;
  const $ = (sel, root = document) => root.querySelector(sel);

  const SLIDE_W = 1280, SLIDE_H = 720;  // 16:9, in CSS-px
  const MAX_ROWS = 11;                 // tabelrijen per slide
  const PPTX_CDN = "https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js";

  /* ---------- 1. Wat er te kiezen valt ---------- */

  const PAGES = [
    { key: "overview", label: "Overview", sub: "Organisch en ads samengevat" },
    { key: "analysis", label: "Analyse",  sub: "AI-analyse van de periode" },
    { key: "website",  label: "Website",  sub: "GA4 en Search Console" },
    { key: "roas",     label: "ROAS",     sub: "Blended MER en kanalen" },
    { key: "email",    label: "E-mail",   sub: "Klaviyo of ConvertKit" },
    { key: "seo",      label: "SEO",      sub: "Zoekvolume en posities · momentopname" },
    { key: "geo",      label: "GEO",      sub: "AI-zichtbaarheid · momentopname" },
  ];

  // De renderers lezen sub-state: welke vergelijking staat aan, op welke
  // sub-tab stond de gebruiker. In een rapport moet dat vastliggen, anders
  // hangt de inhoud van een slide af van waar iemand toevallig was blijven
  // staan. borrow() zet die sleutels synchroon om en daarna terug.
  const web  = (fn, ...a) => B.borrow({ websiteCompare: "prev" }, () => fn(...a));
  const roas = (fn, ...a) => B.borrow({ roas: RS.roas || state.roas }, () => fn(...a));

  const BLOCKS = [
    // Overview. De renderers van die tab schrijven rechtstreeks in DOM-knopen
    // met een vast id (#kpi-grid, #trend-chart) en geven niets terug, dus deze
    // vier bouwen we hier opnieuw op uit state.overview — zelfde velden,
    // zelfde opmaak, zelfde kleurtokens.
    { id: "overview.kpis",  page: "overview", label: "Kerncijfers",           html: ovKpis },
    { id: "overview.trend", page: "overview", label: "Performance over tijd", html: ovTrend },
    { id: "overview.mix",   page: "overview", label: "Kanaal-mix",            html: ovMix },
    { id: "overview.top",   page: "overview", label: "Top performers",        html: ovTop },

    { id: "analysis.insights", page: "analysis", label: "AI-analyse",   html: anInsights },
    { id: "analysis.ads",      page: "analysis", label: "Ads-ranking",  html: () => R.analysisAds() },

    { id: "website.kpis",     page: "website", label: "Kerncijfers",     html: () => web(R.websiteKpis) },
    { id: "website.chart",    page: "website", label: "Verkeer per dag", html: () => web(R.websiteChart) },
    { id: "website.channels", page: "website", label: "Kanalen",         html: () => web(R.websiteChannels) },
    { id: "website.sources",  page: "website", label: "Bronnen",         html: () => web(R.websiteSources) },
    { id: "website.demo",     page: "website", label: "Doelgroep",       html: () => web(R.websiteDemo) },
    { id: "website.landing",  page: "website", label: "Landingspagina's", html: () => web(R.websiteLanding) },
    { id: "website.funnel",   page: "website", label: "Funnel",          html: () => web(R.websiteFunnel) },
    { id: "website.search",   page: "website", label: "Organisch zoeken", html: () => web(R.websiteSearch) },
    { id: "website.audience", page: "website", label: "Publiek",         html: () => web(R.websiteAudience) },

    { id: "roas.hero",      page: "roas", label: "Kerncijfers",   html: () => roas(R.roasHero) },
    { id: "roas.daily",     page: "roas", label: "Per dag",       html: () => roas(R.roasDaily) },
    { id: "roas.social",    page: "roas", label: "Paid social",   html: () => roas(R.roasGroup, "social", "Paid social") },
    { id: "roas.search",    page: "roas", label: "Paid search",   html: () => roas(R.roasGroup, "search", "Paid search") },
    { id: "roas.breakeven", page: "roas", label: "Break-even",    html: () => roas(R.roasBreakEven) },
    { id: "roas.advice",    page: "roas", label: "Advies per campagne", html: () => roas(R.roasAdvice) },

    { id: "email.all", page: "email", label: "E-mailprestaties", html: emailAll },

    { id: "seo.kpis",  page: "seo", label: "Kerncijfers",   html: () => R.seoKpis() },
    { id: "seo.chart", page: "seo", label: "Zoekvolume",    html: () => R.seoChart() },
    { id: "seo.table", page: "seo", label: "Keywords",      html: () => R.seoTable() },

    { id: "geo.overview", page: "geo", label: "Overzicht",  html: () => R.geoOverview() },
    { id: "geo.prompts",  page: "geo", label: "Prompts",    html: () => R.geoPrompts() },
    { id: "geo.website",  page: "geo", label: "Website",    html: () => R.geoWebsite() },
    { id: "geo.actions",  page: "geo", label: "Acties",     html: () => R.geoActions() },
  ];

  const blocksOf = (page) => BLOCKS.filter(b => b.page === page);
  const blockById = (id) => BLOCKS.find(b => b.id === id);

  /* ---------- 2. State ---------- */

  const RS = {
    clientId: null,        // voor welke klant deze state geldt
    picked: null,          // Set van block-ids
    withAnalysis: true,
    view: "config",        // 'config' | 'deck'
    building: false,
    steps: [],             // [{key, label, status, note}] — voortgang per pagina
    slides: null,
    notes: null,           // { summary, blocks: { [id]: {caption, bullets} } }
    notesError: null,
    roas: null,            // eigen getRoas voor de rapportperiode
    exporting: false,
    exportError: null,
    ds: null,              // design system uit Drive: { found, name, tokens, dark, ... }
    dsLoaded: false,
    tpl: null,             // rapportsjabloon uit Drive: { found, name, template, ... }
    tplLoaded: false,
  };

  // De keuze blijft per klant bewaard: een rapport maak je elke maand opnieuw,
  // en dan wil je niet elke keer dertig vinkjes terugzetten. localStorage, want
  // dit is een voorkeur van deze browser — niet iets voor de sheet.
  const storeKey = () => `mayday.report.${state.session?.clientId || "-"}`;

  function loadPicked() {
    const fallback = () => new Set(BLOCKS.filter(b => b.page === "overview" || b.page === "website").map(b => b.id));
    try {
      const raw = localStorage.getItem(storeKey());
      if (!raw) return fallback();
      const saved = JSON.parse(raw);
      if (typeof saved.withAnalysis === "boolean") RS.withAnalysis = saved.withAnalysis;
      const ids = (saved.blocks || []).filter(id => blockById(id));
      return ids.length ? new Set(ids) : fallback();
    } catch { return fallback(); }
  }

  function savePicked() {
    try {
      localStorage.setItem(storeKey(), JSON.stringify({
        blocks: Array.from(RS.picked),
        withAnalysis: RS.withAnalysis,
      }));
    } catch {}
  }

  /* ---------- 3. Overview-blokken (hier opnieuw opgebouwd) ---------- */

  const KPI_VARS = ["--kpi-1", "--kpi-2", "--kpi-3", "--kpi-4"];

  // Zelfde uitleg als op de Overview-tab: een ontbrekende vergelijking is
  // informatie en wordt uitgeschreven, niet weggelaten.
  function kpiDelta(k) {
    if (k.state === "delta") {
      const arrow = k.direction === "up" ? "↑" : "↓";
      const dv = k.unit === "pp" ? `${k.delta.toFixed(1)}pp` : `${k.delta.toFixed(1)}%`;
      return `<div class="delta ${esc(k.direction)}">${arrow} ${esc(dv)} <span class="vs">${esc(k.vs)}</span></div>`;
    }
    if (k.state === "flat")  return `<div class="delta flat">± ${k.unit === "pp" ? "0,0pp" : "0,0%"} <span class="vs">${esc(k.vs)}</span></div>`;
    if (k.state === "empty") return `<div class="delta none">geen activiteit <span class="vs">in beide periodes</span></div>`;
    if (k.state === "new")   return `<div class="delta new">nieuw <span class="vs">vorige periode geen data</span></div>`;
    return `<div class="delta none">geen vergelijking <span class="vs">vorige periode ontbreekt</span></div>`;
  }

  function ovKpis() {
    const ov = state.overview;
    if (!ov || !(ov.kpis || []).length) return "";
    const cards = ov.kpis.map((k, i) => `
      <div class="kpi-card">
        <div class="label"><span class="dot" style="background:var(${KPI_VARS[i % KPI_VARS.length]})"></span>${esc(k.label)}</div>
        <div class="value">${esc(k.value)}</div>
        ${kpiDelta(k)}
      </div>`).join("");
    return `<div class="kpi-grid">${cards}</div>`;
  }

  function ovTrend() {
    const ts = state.overview?.timeseries;
    if (!ts || !(ts.series || []).length || !window.Charts) return "";
    const series = ts.series
      .map((s, i) => ({ label: s.label, values: s.values, kind: "area", color: B.seriesColor(i) }))
      .filter(s => s.values.some(v => v > 0));
    if (!series.length) return "";
    const legend = series.map((s, i) => `<span class="item"><span class="swatch" style="background:${esc(s.color)}"></span>${esc(s.label)}</span>`).join("");
    return `<section class="panel">
      <div class="panel-header"><div>
        <h2 class="panel-title">Performance over tijd</h2>
        <div class="panel-sub">Reach per kanaal over de periode</div>
      </div></div>
      <div class="chart-legend">${legend}</div>
      ${B.chartSvg({ width: 1120, height: 300, x: ts.weeks, series, leftFormat: (v) => Charts.fmt.k(v), maxXLabels: 8 })}
    </section>`;
  }

  function ovMix() {
    const ch = state.overview?.channels || [];
    if (!ch.length) return "";
    const rows = ch.map(c => `
      <div class="channel-row">
        <div class="label"><span class="swatch" style="background:${esc(c.color)}"></span>${esc(c.label)}</div>
        <div class="pct">${esc(String(c.value))}%</div>
        <div class="channel-bar"><div class="fill" style="width:${Number(c.value) || 0}%; background:${esc(c.color)}"></div></div>
      </div>`).join("");
    return `<section class="panel">
      <div class="panel-header"><div>
        <h2 class="panel-title">Kanaal-mix</h2>
        <div class="panel-sub">Aandeel van de totale reach</div>
      </div></div>
      <div class="channel-mix">${rows}</div>
    </section>`;
  }

  function ovTop() {
    const list = (state.overview?.topPosts || []).slice(0, 8);
    if (!list.length) return "";
    const rows = list.map(p => `<tr>
      <td>${esc(p.channel || "")}</td>
      <td>${esc((p.caption || p.title || "—").slice(0, 90))}</td>
      <td class="right">${esc(fmtInt(p.reach))}</td>
      <td class="right">${esc(fmtInt(p.engagement))}</td>
    </tr>`).join("");
    return `<section class="panel">
      <div class="panel-header"><div>
        <h2 class="panel-title">Top performers</h2>
        <div class="panel-sub">Best presterende posts in deze periode</div>
      </div></div>
      <div class="lib-table"><table>
        <thead><tr><th>Kanaal</th><th>Post</th><th class="right">Reach</th><th class="right">Engagement</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>`;
  }

  function anInsights() {
    const a = state.analysisCache?.[B.analysisPeriodKey()];
    return a ? R.analysisInsights(a) : "";
  }

  function emailAll() {
    const e = state.email;
    return (e && e.connector) ? R.email(e) : "";
  }

  const fmtInt = (n) => (n == null || !isFinite(n)) ? "—" : Math.round(n).toLocaleString("nl-NL");

  /* ---------- 4. Data laden ----------
     De tabs zijn fire-and-forget geschreven: hun fetch-functies geven niets
     terug en zetten hun resultaat in state. In plaats van die functies te
     herschrijven wachten we hier op de state zelf. Dat dekt meteen het geval
     dat de data er al stond en er niets te wachten valt. */

  function waitFor(ready, failed, ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (ready()) return resolve({ ok: true });
        const f = failed && failed();
        if (f) return resolve({ ok: false, note: String(f) });
        if (Date.now() - t0 > ms) return resolve({ ok: false, note: "duurde te lang" });
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  const LOADERS = {
    overview: {
      start: () => { if (!state.overview && !state.overviewLoading) B.ensure.overview(); },
      ready: () => !!state.overview,
      failed: () => state.overviewError,
      ms: 90000,
    },
    website: {
      start: () => B.ensure.website(),
      ready: () => !!state.website,
      failed: () => state.websiteError,
      ms: 90000,     // koude Windsor-fetch over 90 dagen is ~18 s, Search Console ~28 s
    },
    email: {
      start: () => B.ensure.email(),
      ready: () => !!state.email,
      failed: () => state.emailError,
      ms: 60000,
    },
    seo: {
      start: () => B.ensure.seo(),
      ready: () => !!state.seo,
      failed: () => state.seoError,
      ms: 60000,
    },
    geo: {
      start: () => B.ensure.geo(),
      ready: () => !!state.geo,
      failed: () => state.geoError,
      ms: 45000,
    },
  };

  // ROAS heeft op zijn eigen tab een maandperiode (month-to-date). Voor een
  // rapport telt de rapportperiode, dus die halen we apart op en zetten we in
  // RS.roas; de renderers krijgen hem via borrow() te zien.
  async function loadRoas() {
    const start = state.period.start, end = state.period.end;
    const cmp = B.roasCompareRange({ start, end });
    RS.roas = await B.windsorCall("getRoas", {
      startDate: start, endDate: end,
      compareStartDate: cmp.start, compareEndDate: cmp.end,
    });
  }

  async function loadPage(key) {
    const step = RS.steps.find(s => s.key === key);
    const done = (ok, note) => { step.status = ok ? "ok" : "fail"; step.note = note || ""; paint(); };

    if (key === "roas") {
      if (!state.session?.hasWindsor) return done(false, "geen Windsor-koppeling");
      try { await loadRoas(); return done(true); }
      catch (e) { return done(false, e.message || "fout bij ophalen"); }
    }

    if (key === "analysis") {
      // De analyse draait op de Overview-data, dus die moet er eerst zijn.
      const base = await runLoader("overview");
      if (!base.ok) return done(false, "Overview-data ontbreekt");
      const cached = state.analysisCache?.[B.analysisPeriodKey()];
      if (!cached) B.ensure.analysis();
      const r = await waitFor(
        () => !!state.analysisCache?.[B.analysisPeriodKey()],
        () => state.analysisError,
        180000);   // analysis.js staat op maxDuration 300
      return done(r.ok, r.note);
    }

    const r = await runLoader(key);
    return done(r.ok, r.note);
  }

  function runLoader(key) {
    const L = LOADERS[key];
    if (!L) return Promise.resolve({ ok: true });
    try { L.start(); } catch (e) { return Promise.resolve({ ok: false, note: e.message }); }
    return waitFor(L.ready, L.failed, L.ms);
  }

  /* ---------- 5. Van blok naar slides ----------
     Elk blok levert de HTML van zijn tab. Die knippen we op de panelen die er
     al in zitten: één paneel is één slide. Een tabel die niet op één slide
     past wordt over meerdere slides verdeeld — afkappen zou rijen weglaten
     zonder het te zeggen. */

  // Alles wat je op een slide niet kunt indrukken gaat eruit. De sub-tabs van
  // GEO horen daar ook bij: op papier bestaat 'de actieve tab' niet, elk blok
  // staat er als eigen slide.
  const STRIP = [
    "button", "input", "select", "textarea",
    ".panel-actions", ".subtabs", ".geo-tabs", ".toggle-group",
    ".period-toggle", ".search-input", ".roas-bar > button",
  ].join(", ");

  function strip(root) {
    root.querySelectorAll(STRIP).forEach(n => n.remove());
    root.querySelectorAll("[onclick]").forEach(n => n.removeAttribute("onclick"));
    root.querySelectorAll("a").forEach(n => { n.removeAttribute("href"); n.removeAttribute("target"); });
  }

  const txt = (n) => (n ? n.textContent.replace(/\s+/g, " ").trim() : "");

  // Eén extractor voor twee afnemers: de pptx-bouwer en de samenvatting die
  // naar de analyse-agent gaat. Een met de hand geschreven datamodel per blok
  // zou bij elke dashboardwijziging stilletjes verouderen; dit leest wat er
  // werkelijk op de slide staat.
  function extract(el) {
    const kpis = Array.from(el.querySelectorAll(".kpi-card")).map(c => ({
      label: txt(c.querySelector(".label")),
      value: txt(c.querySelector(".value")),
      delta: txt(c.querySelector(".delta")),
    })).filter(k => k.label || k.value);

    const tables = Array.from(el.querySelectorAll("table")).map(t => ({
      head: Array.from(t.querySelectorAll("thead th")).map(txt),
      rows: Array.from(t.querySelectorAll("tbody tr")).map(tr => Array.from(tr.querySelectorAll("td")).map(txt)),
    })).filter(t => t.rows.length);

    const charts = Array.from(el.querySelectorAll("svg"));

    const notes = [];
    el.querySelectorAll("p, li, .geo-callout, .channel-row").forEach(n => {
      if (n.closest(".kpi-card") || n.closest("table")) return;
      const t = txt(n);
      if (t.length > 3 && notes.length < 14) notes.push(t);
    });

    return { kpis, tables, charts, notes };
  }

  function makeSlide(block, title, sub, el, part, parts) {
    return {
      blockId: block.id,
      page: block.page,
      title: parts > 1 ? `${title} (${part}/${parts})` : title,
      sub,
      el,
      model: extract(el),
      kind: "content",
    };
  }

  function splitPanel(block, el) {
    const title = txt(el.querySelector(".panel-title")) || block.label;
    const sub = txt(el.querySelector(".panel-sub"));
    const table = el.querySelector("table");
    const rows = table ? Array.from(table.querySelectorAll("tbody tr")) : [];
    if (rows.length <= MAX_ROWS) return [makeSlide(block, title, sub, el, 1, 1)];

    const chunks = [];
    for (let i = 0; i < rows.length; i += MAX_ROWS) chunks.push(rows.slice(i, i + MAX_ROWS));
    return chunks.map((chunk, i) => {
      const clone = el.cloneNode(true);
      const tb = clone.querySelector("table tbody");
      tb.innerHTML = "";
      chunk.forEach(r => tb.appendChild(r.cloneNode(true)));
      return makeSlide(block, title, sub, clone, i + 1, chunks.length);
    });
  }

  function blockSlides(block) {
    let html = "";
    try { html = block.html() || ""; } catch (e) { html = ""; }
    if (!html.trim()) return [];

    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    strip(tmp);

    const panels = [];
    for (const el of Array.from(tmp.children)) {
      if (!txt(el) && !el.querySelector("svg")) continue;
      // Twee panelen naast elkaar passen niet op één slide; elk krijgt de zijne.
      if (el.classList.contains("row-2") || el.classList.contains("insight-grid")) {
        Array.from(el.children).forEach(sub => { if (txt(sub)) panels.push(sub); });
      } else {
        panels.push(el);
      }
    }
    const out = [];
    panels.forEach(el => out.push(...splitPanel(block, el)));
    return out;
  }

  function buildSlides() {
    const out = [];
    out.push({ kind: "title" });
    if (RS.withAnalysis) out.push({ kind: "summary" });

    for (const page of PAGES) {
      const picked = blocksOf(page.key).filter(b => RS.picked.has(b.id));
      if (!picked.length) continue;
      const step = RS.steps.find(s => s.key === page.key);

      // Is het ophalen mislukt, dan slaan we de blokken van deze pagina
      // helemaal over. De renderers geven namelijk óók zonder data nog HTML
      // terug — een break-even-paneel vol streepjes, een KPI-rij met nullen.
      // Op het dashboard is dat goed (je ziet dat de tab aan het laden is of
      // niets heeft), maar in een rapport dat een klant los doorneemt is het
      // een slide die meet wat nooit gemeten is.
      const slides = [];
      if (!step || step.status !== "fail") picked.forEach(b => slides.push(...blockSlides(b)));

      if (!slides.length) {
        // Data ontbreekt of het blok is leeg voor deze periode. Dat is
        // informatie, geen reden om de deck te laten mislukken.
        out.push({ kind: "gap", page: page.key, title: page.label,
                   note: step && step.status === "fail" ? step.note : "geen data in deze periode" });
        continue;
      }
      out.push({ kind: "divider", page: page.key, title: page.label, sub: page.sub });
      out.push(...slides);
    }
    out.push({ kind: "sources" });
    return out;
  }

  /* ---------- 6. Duiding per blok (optioneel) ----------
     Eén call voor de hele deck in plaats van één per blok: goedkoper, en de
     samenvatting kan dan niet iets anders beweren dan de losse duidingen. */

  async function loadNotes(slides) {
    const seen = new Set();
    const blocks = [];
    for (const s of slides) {
      if (s.kind !== "content" || seen.has(s.blockId)) continue;
      seen.add(s.blockId);
      const b = blockById(s.blockId);
      const m = s.model;
      blocks.push({
        id: s.blockId,
        page: b ? b.page : s.page,
        label: b ? b.label : s.title,
        kpis: m.kpis.slice(0, 8),
        // Genoeg rijen om een patroon te zien, niet zoveel dat de prompt
        // omvalt. De volgorde is die van de tabel zelf, dus de bovenste rijen
        // zijn de relevante.
        table: m.tables[0] ? { head: m.tables[0].head, rows: m.tables[0].rows.slice(0, 10) } : null,
        notes: m.notes.slice(0, 6),
      });
    }
    if (!blocks.length) return;

    const res = await B.apiPost("/api/report", {
      clientId: state.session.clientId,
      token: state.session.token,
      brandName: state.session.brandName,
      period: { startDate: state.period.start, endDate: state.period.end, days: B.periodDays() },
      blocks,
      clientContext: state.session.clientContext || "",
      template: (RS.tpl && RS.tpl.found) ? RS.tpl.template : "",
      templateName: (RS.tpl && RS.tpl.found) ? RS.tpl.name : "",
    });
    RS.notes = res.report;
  }

  /* ---------- 7. Samenstellen ---------- */

  async function build() {
    if (RS.building) return;
    const pages = PAGES.filter(p => blocksOf(p.key).some(b => RS.picked.has(b.id)));
    if (!pages.length) return;

    RS.building = true;
    RS.notes = null;
    RS.notesError = null;
    RS.slides = null;
    RS.steps = pages.map(p => ({ key: p.key, label: p.label, status: "busy", note: "" }));
    if (RS.withAnalysis) RS.steps.push({ key: "__notes", label: "Duiding", status: "wacht", note: "" });
    paint();

    // Parallel: elke pagina raakt een ander endpoint. Analyse wacht intern op
    // de Overview-data.
    await Promise.all(pages.map(p => loadPage(p.key)));

    RS.slides = metDsKleuren(buildSlides);

    if (RS.withAnalysis) {
      const step = RS.steps.find(s => s.key === "__notes");
      step.status = "busy"; paint();
      try { await loadNotes(RS.slides); step.status = "ok"; }
      catch (e) {
        // Zonder duiding blijft de deck bruikbaar; de cijfers staan er al.
        RS.notesError = e.message || "duiding mislukt";
        step.status = "fail"; step.note = RS.notesError;
      }
    }

    RS.building = false;
    RS.view = "deck";
    paint();
  }

  /* ---------- 8. Configurator ---------- */

  const nlDate = (iso) => {
    if (!iso) return "—";
    const [y, m, d] = iso.split("-").map(Number);
    const mn = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
    return `${d} ${mn[m - 1]} ${y}`;
  };
  const periodLabel = () => `${nlDate(state.period.start)} – ${nlDate(state.period.end)}`;

  function renderConfig() {
    const cards = PAGES.map(p => {
      const list = blocksOf(p.key);
      const on = list.filter(b => RS.picked.has(b.id)).length;
      const rows = list.map(b => `
        <label class="rp-block">
          <input type="checkbox" data-rp-block="${esc(b.id)}" ${RS.picked.has(b.id) ? "checked" : ""}>
          <span>${esc(b.label)}</span>
        </label>`).join("");
      return `<section class="panel rp-card${on ? " on" : ""}">
        <div class="rp-card-head">
          <label class="rp-page">
            <input type="checkbox" data-rp-page="${esc(p.key)}" ${on === list.length ? "checked" : ""}>
            <span>
              <strong>${esc(p.label)}</strong>
              <em>${esc(p.sub)}</em>
            </span>
          </label>
          <span class="rp-count">${on}/${list.length}</span>
        </div>
        <div class="rp-blocks">${rows}</div>
      </section>`;
    }).join("");

    const total = RS.picked.size;
    const busy = RS.building;

    return `
      <section class="panel rp-bar">
        <div class="roas-bar">
          <div>
            <div class="info-label">Periode</div>
            <div style="font-size:20px; color:var(--fg); margin-top:2px;">${esc(periodLabel())}</div>
            <div class="muted" style="font-size:11px; margin-top:2px;">Volgt de periode in de topbar — één periode voor het hele rapport.</div>
          </div>
          <div class="rp-presets">${PRESETS.map(p =>
            `<button class="btn tiny${activePreset() === p.key ? " on" : ""}" data-rp-period="${esc(p.key)}">${esc(p.label)}</button>`
          ).join("")}</div>
        </div>
      </section>

      <div class="rp-grid">${cards}</div>

      <section class="panel rp-actions">
        <label class="rp-toggle">
          <input type="checkbox" id="rp-analysis" ${RS.withAnalysis ? "checked" : ""}>
          <span>
            <strong>Met analyse</strong>
            <em>Een samenvatting vooraan en per blok een korte duiding. Zonder vinkje bevat het rapport alleen de cijfers.</em>
            <em class="rp-tpl">${tplNote()}</em>
          </span>
        </label>
        <div class="rp-go">
          <span class="muted" style="font-size:12px;">${total} blok${total === 1 ? "" : "ken"} gekozen</span>
          <button class="btn primary" id="rp-build" ${total && !busy ? "" : "disabled"}>
            ${busy ? "Bezig…" : "Stel presentatie samen →"}
          </button>
        </div>
      </section>

      ${RS.steps.length ? renderSteps() : ""}`;
  }

  // Wat de duiding als sjabloon volgt. Expliciet, ook als er niets is: anders
  // zie je niet dat een ingestelde Rapportlink onleesbaar bleek.
  function tplNote() {
    const t = RS.tpl;
    if (!RS.tplLoaded) return "";
    if (!t) return "Sjabloon niet opgehaald.";
    if (!t.found) return `Zonder klantsjabloon · ${esc(t.reason || "geen Rapportlink in de Config-tab")}`;
    return `Volgt het sjabloon ${esc(t.name)}${t.truncated ? " (ingekort)" : ""}`;
  }

  function renderSteps() {
    const icon = { busy: "◐", ok: "✓", fail: "×", wacht: "·" };
    const rows = RS.steps.map(s => `
      <div class="rp-step ${esc(s.status)}">
        <span class="mark">${icon[s.status] || "·"}</span>
        <span class="label">${esc(s.label)}</span>
        <span class="note">${esc(s.note || (s.status === "busy" ? "ophalen…" : s.status === "ok" ? "klaar" : ""))}</span>
      </div>`).join("");
    return `<section class="panel rp-steps">
      <div class="info-label">Voortgang</div>
      ${rows}
    </section>`;
  }

  /* ---------- 9. De slides ---------- */

  function slideShell(inner, opts) {
    const o = opts || {};
    return `<div class="rp-slide-wrap">
      <section class="rp-slide${o.kind ? " " + o.kind : ""}">
        ${inner}
        <footer class="rp-foot">
          <span>${esc(state.session?.brandName || "")}</span>
          <span>${esc(periodLabel())}</span>
          <span>${o.n != null ? o.n : ""}</span>
        </footer>
      </section>
    </div>`;
  }

  function noteHtml(id) {
    const n = RS.notes?.blocks?.[id];
    if (!n) return "";
    const bullets = (n.bullets || []).slice(0, 3);
    return `<div class="rp-note">
      ${n.caption ? `<p>${esc(n.caption)}</p>` : ""}
      ${bullets.length ? `<ul>${bullets.map(b => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
    </div>`;
  }

  function renderDeck() {
    let n = 0;
    const parts = RS.slides.map(s => {
      if (s.kind === "title") {
        return slideShell(`<div class="rp-title-body">
          <div class="rp-eyebrow">Performance-rapport</div>
          <h1>${esc(state.session?.brandName || state.session?.clientId || "")}</h1>
          <div class="rp-period">${esc(periodLabel())}</div>
          <div class="rp-made">Samengesteld op ${esc(nlDate(todayIso()))} · mayday marketing</div>
        </div>`, { kind: "cover" });
      }
      if (s.kind === "summary") {
        const sum = RS.notes?.summary;
        n++;
        return slideShell(`
          <header class="rp-head"><div class="rp-eyebrow">Samenvatting</div><h2>In het kort</h2></header>
          <div class="rp-body rp-summary">${
            sum ? esc(sum).replace(/\n+/g, "</p><p>").replace(/^/, "<p>") + "</p>"
                : `<p class="muted">${esc(RS.notesError || "Geen duiding beschikbaar.")}</p>`
          }</div>`, { n });
      }
      if (s.kind === "divider") {
        n++;
        return slideShell(`<div class="rp-divider-body">
          <div class="rp-eyebrow">Onderdeel</div>
          <h1>${esc(s.title)}</h1>
          <div class="rp-period">${esc(s.sub || "")}</div>
        </div>`, { kind: "divider", n });
      }
      if (s.kind === "gap") {
        n++;
        return slideShell(`
          <header class="rp-head"><div class="rp-eyebrow">${esc(s.title)}</div><h2>Geen data</h2></header>
          <div class="rp-body"><p class="muted">Voor dit onderdeel is in deze periode niets opgehaald: ${esc(s.note)}.</p>
          <p class="muted" style="font-size:13px;">Het rapport laat dit bewust leeg in plaats van een nul te tonen — ontbrekende data is onbekend, niet nul.</p></div>`, { n });
      }
      if (s.kind === "sources") {
        n++;
        return slideShell(`
          <header class="rp-head"><div class="rp-eyebrow">Verantwoording</div><h2>Bronnen en meetlat</h2></header>
          <div class="rp-body rp-sources">${sourcesHtml()}</div>`, { n });
      }
      n++;
      return slideShell(`
        <header class="rp-head">
          <div class="rp-eyebrow">${esc(pageLabel(s.page))}</div>
          <h2>${esc(s.title)}</h2>
          ${s.sub ? `<div class="rp-sub">${esc(s.sub)}</div>` : ""}
        </header>
        <div class="rp-body">${s.el.outerHTML}</div>
        ${noteHtml(s.blockId)}`, { n });
    }).join("");

    return `
      <section class="panel rp-bar rp-deckbar">
        <div class="roas-bar">
          <div>
            <div class="info-label">Presentatie</div>
            <div style="font-size:20px; color:var(--fg); margin-top:2px;">${RS.slides.length} slides · ${esc(periodLabel())}</div>
            <div class="muted" style="font-size:11px; margin-top:2px;">${esc(RS.notesError ? "Zonder duiding: " + RS.notesError : (RS.withAnalysis ? "Met analyse" : "Zonder analyse"))}${dsNote() ? " · " + dsNote() : ""}</div>
          </div>
          <div class="rp-presets">
            <button class="btn tiny" id="rp-back">← Selectie</button>
            <button class="btn tiny" id="rp-print">⎙ PDF</button>
            <button class="btn primary" id="rp-pptx" ${RS.exporting ? "disabled" : ""}>${RS.exporting ? "Bezig…" : "⤓ PowerPoint"}</button>
          </div>
        </div>
        ${RS.exportError ? `<div style="font-size:11px; color:#c0392b; margin-top:8px;">${esc(RS.exportError)}</div>` : ""}
      </section>
      <div class="rp-deck" id="rp-deck">${parts}</div>`;
  }

  const pageLabel = (k) => (PAGES.find(p => p.key === k) || {}).label || "";

  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // De caveats die in dit dashboard echt gemeten zijn. Alleen tonen wat op deze
  // deck van toepassing is — een verantwoording die dingen noemt die er niet in
  // staan, leest als een sjabloon.
  function sourcesHtml() {
    const used = new Set(RS.slides.filter(s => s.page).map(s => s.page));
    const items = [];
    if (used.has("overview") || used.has("analysis"))
      items.push(["Social en ads", "Instagram-organisch en Meta Ads via Windsor.ai. Ad-niveau is gemaximeerd op de laatste 35 dagen; campagne-niveau en organisch beslaan de volle periode."]);
    if (used.has("analysis"))
      items.push(["Analyse", "Gegenereerd door Claude op de geaggregeerde dashboardcijfers van deze periode, niet op de ruwe posts."]);
    if (used.has("website"))
      items.push(["Website", "GA4 en Search Console via Windsor.ai. Unieke gebruikers zijn niet optelbaar over dagen; Search Console loopt 2 tot 3 dagen achter. Landingspagina's en zoekopdrachten beslaan hoogstens 30 dagen."]);
    if (used.has("roas"))
      items.push(["ROAS", "GA4-omzet (last click) en platform-omzet staan naast elkaar en worden nooit opgeteld. Deze slides volgen de rapportperiode; de ROAS-tab in het dashboard toont standaard de lopende maand."]);
    if (used.has("email"))
      items.push(["E-mail", "Klaviyo of ConvertKit via Windsor.ai. Klaviyo is gemaximeerd op de laatste 30 dagen."]);
    if (used.has("seo"))
      items.push(["SEO", "DataForSEO. Zoekvolume is een maandgemiddelde en een positie een momentopname — geen periodecijfer."]);
    if (used.has("geo"))
      items.push(["GEO", "Nulmeting uit het auditbestand in Drive, met de datum van die meting. Geen live cijfer."]);
    items.push(["Ontbrekende data", "Een streepje betekent niet gemeten, geen nul. Onderdelen zonder data staan als zodanig in het rapport."]);
    return `<dl>${items.map(([t, d]) => `<dt>${esc(t)}</dt><dd>${esc(d)}</dd>`).join("")}</dl>`;
  }

  /* ---------- 10. PowerPoint ----------
     De pptx wordt in de browser gebouwd, niet op Vercel: server-side zou een
     dependency én een headless renderer voor de SVG's vragen (een functie heeft
     geen DOM). Hier staat de getekende grafiek al in de pagina.

     Cijfers en tabellen worden echte PowerPoint-objecten, dus bewerkbaar.
     Grafieken worden een PNG: ze pixelgelijk aan het dashboard houden weegt
     zwaarder dan ze in PowerPoint kunnen naslepen. */

  const PPT = {
    W: 13.333, H: 7.5,
    M: 0.62,                      // marge
    display: "Georgia",           // dichtst bij --font-display dat overal bestaat
    data: "Arial",                // dichtst bij Inter dat overal bestaat
  };
  const SVG_FONT = "Helvetica, Arial, sans-serif";

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.PptxGenJS) return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("PowerPoint-bibliotheek kon niet geladen worden."));
      document.head.appendChild(s);
    });
  }

  // CSS-kleur → RRGGBB. Gaat via een proefelement omdat de tokens color-mix()
  // gebruiken: getComputedStyle lost dat op naar rgb(), wat we wél kunnen lezen.
  function hexOf(value, fallback) {
    try {
      const probe = document.createElement("span");
      probe.style.color = value;
      document.body.appendChild(probe);
      const rgb = getComputedStyle(probe).color;
      probe.remove();
      const m = rgb.match(/[\d.]+/g);
      if (!m || m.length < 3) return fallback;
      return m.slice(0, 3).map(v => Math.round(+v).toString(16).padStart(2, "0")).join("").toUpperCase();
    } catch { return fallback; }
  }

  // Eerste familie uit een font-stack: '"Bodoni Moda",serif' → 'Bodoni Moda'.
  // PowerPoint wil één naam, geen stack. Staat de letter niet op het apparaat
  // van de lezer, dan kiest PowerPoint zelf een vervanger — de binaries uit
  // Drive kunnen niet mee in een pptx.
  function firstFamily(stack, fallback) {
    if (!stack) return fallback;
    const first = String(stack).split(",")[0].trim().replace(/^["']|["']$/g, "");
    return first || fallback;
  }

  function palette() {
    const v = (n, f) => hexOf(getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f, f);
    // Het design system van de klant wint, per token. Wat het niet levert komt
    // uit het dashboard — dezelfde gedeeltelijke-invulling-regel als in de CSS.
    const ds = (RS.ds && RS.ds.found) ? RS.ds : null;
    const t = ds ? (ds.tokens || {}) : {};
    const d = ds ? (ds.dark || {}) : {};
    const dsHex = (val, fallback) => (val ? hexOf(val, fallback) : fallback);
    if (ds) {
      PPT.display = firstFamily(t.fontDisplay, PPT.display);
      PPT.data = firstFamily(t.fontBody, PPT.data);
    }
    return {
      ink:    dsHex(t.ink,   v("--fg", "#1a1a1a")),
      muted:  dsHex(t.muted, v("--fg-muted", "#6b6560")),
      accent: dsHex(t.head,  v("--accent-data", "#400745")),
      line:   dsHex(t.rule,  v("--border", "#e3ded6")),
      // Een design system dat 'geen gevulde kaarten' voorschrijft krijgt de
      // paginakleur als kaartvulling: dan blijft alleen de hairline over.
      soft:   dsHex(t.surface, v("--surface-mute", "#f6f3ee")),
      paper:  dsHex(t.surface, v("--bg", "#ffffff")),
      // Titelslide: merkvlak met negatieve tekst. --on-accent is in app.js al
      // omgeklapt naar inkt als het accent te licht is voor wit.
      accentFlat: dsHex(d.surface, v("--accent", "#400745")),
      onAccent:   dsHex(d.ink, v("--on-accent", "#ffffff")),
    };
  }

  // Een losse SVG erft geen paginastijl: zonder expliciete font-family valt de
  // tekst terug op het standaard-serif van de browser. De merkletter zelf kan
  // niet mee — die komt uit een @font-face die in een geïsoleerde SVG niet laadt.
  function svgToPng(svg) {
    return new Promise((resolve) => {
      const vb = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
      const w = vb[2] || 760, h = vb[3] || 260;
      const clone = svg.cloneNode(true);
      // Een attribuut met een ongeldige naam maakt de losse SVG onparseerbaar en
      // laat de grafiek stilletjes uit élke deck vallen. De HTML-parser is daar
      // tolerant in, een <img> niet. Eén dwaalteken in een template kostte dit
      // eerder alle grafieken; daarom hier weggooien in plaats van vertrouwen.
      const geldig = /^[A-Za-z_:][-A-Za-z0-9_:.]*$/;
      clone.querySelectorAll("*").forEach(node => {
        Array.from(node.attributes).forEach(a => {
          if (!geldig.test(a.name)) node.removeAttributeNode(a);
        });
      });
      Array.from(clone.attributes).forEach(a => {
        if (!geldig.test(a.name)) clone.removeAttributeNode(a);
      });
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("width", String(w));
      clone.setAttribute("height", String(h));
      clone.setAttribute("style", `font-family:${SVG_FONT}`);
      const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone));
      const img = new Image();
      img.onload = () => {
        const scale = 2;                        // scherp op een beamer
        const c = document.createElement("canvas");
        c.width = w * scale; c.height = h * scale;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#FFFFFF";              // de SVG is doorzichtig, een slide niet
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        try { resolve({ data: c.toDataURL("image/png"), w, h }); }
        catch { resolve(null); }
      };
      img.onerror = () => {
        // Niet fataal: de slide verschijnt zonder grafiek. Wel zichtbaar maken,
        // anders mist er stil een beeld in het rapport.
        console.warn("[rapport] grafiek kon niet naar PNG worden omgezet");
        resolve(null);
      };
      img.src = url;
    });
  }

  function pptHead(slide, P, eyebrow, title, sub) {
    if (eyebrow) slide.addText(eyebrow.toUpperCase(), {
      x: PPT.M, y: 0.34, w: PPT.W - 2 * PPT.M, h: 0.26,
      fontSize: 10, bold: true, charSpacing: 1.6, color: P.accent, fontFace: PPT.data,
    });
    slide.addText(title, {
      x: PPT.M, y: 0.6, w: PPT.W - 2 * PPT.M, h: 0.55,
      fontSize: 27, color: P.ink, fontFace: PPT.display,
    });
    if (sub) slide.addText(sub, {
      x: PPT.M, y: 1.14, w: PPT.W - 2 * PPT.M, h: 0.3,
      fontSize: 12, color: P.muted, fontFace: PPT.data,
    });
    slide.addShape("rect", {
      x: PPT.M, y: sub ? 1.5 : 1.28, w: PPT.W - 2 * PPT.M, h: 0.013, fill: { color: P.line },
    });
  }

  function pptFoot(slide, P, n) {
    slide.addText(state.session?.brandName || "", {
      x: PPT.M, y: PPT.H - 0.52, w: 4, h: 0.28, fontSize: 9, color: P.muted, fontFace: PPT.data,
    });
    slide.addText(periodLabel(), {
      x: PPT.W / 2 - 2, y: PPT.H - 0.52, w: 4, h: 0.28, fontSize: 9, color: P.muted,
      fontFace: PPT.data, align: "center",
    });
    if (n != null) slide.addText(String(n), {
      x: PPT.W - PPT.M - 1, y: PPT.H - 0.52, w: 1, h: 0.28, fontSize: 9, color: P.muted,
      fontFace: PPT.data, align: "right",
    });
  }

  function pptKpis(slide, P, kpis, y) {
    const list = kpis.slice(0, 4);
    const gap = 0.22;
    const w = (PPT.W - 2 * PPT.M - gap * (list.length - 1)) / list.length;
    list.forEach((k, i) => {
      const x = PPT.M + i * (w + gap);
      slide.addShape("rect", { x, y, w, h: 1.5, fill: { color: P.soft }, line: { color: P.line, width: 0.5 } });
      slide.addText(k.label, { x: x + 0.18, y: y + 0.16, w: w - 0.36, h: 0.3, fontSize: 10, color: P.muted, fontFace: PPT.data });
      slide.addText(k.value, { x: x + 0.18, y: y + 0.46, w: w - 0.36, h: 0.55, fontSize: 24, color: P.ink, fontFace: PPT.display });
      if (k.delta) slide.addText(k.delta, { x: x + 0.18, y: y + 1.04, w: w - 0.36, h: 0.3, fontSize: 9, color: P.muted, fontFace: PPT.data });
    });
    return y + 1.78;
  }

  function pptTable(slide, P, table, y, maxH) {
    const head = (table.head || []).map(h => ({ text: h, options: { bold: true, color: P.ink, fill: P.soft } }));
    const body = table.rows.map(r => r.map(c => ({ text: c })));
    const rows = head.length ? [head, ...body] : body;
    if (!rows.length) return y;
    slide.addTable(rows, {
      x: PPT.M, y, w: PPT.W - 2 * PPT.M,
      fontSize: 10.5, fontFace: PPT.data, color: P.ink,
      border: { type: "solid", color: P.line, pt: 0.5 },
      autoPage: false,
      rowH: Math.min(0.34, Math.max(0.24, maxH / Math.max(rows.length, 1))),
      valign: "middle",
    });
    return y + Math.min(maxH, rows.length * 0.34);
  }

  async function exportPptx() {
    if (RS.exporting || !RS.slides) return;
    RS.exporting = true; RS.exportError = null; paint();
    try {
      await loadScript(PPTX_CDN);
      const P = palette();
      const pptx = new window.PptxGenJS();
      pptx.defineLayout({ name: "MAYDAY16x9", width: PPT.W, height: PPT.H });
      pptx.layout = "MAYDAY16x9";
      pptx.author = "mayday marketing";
      pptx.title = `${state.session?.brandName || ""} — performance ${periodLabel()}`;

      let n = 0;
      for (const s of RS.slides) {
        const slide = pptx.addSlide();
        slide.background = { color: P.paper };

        if (s.kind === "title") {
          slide.background = { color: P.accentFlat };
          slide.addText("PERFORMANCE-RAPPORT", { x: PPT.M, y: 2.5, w: PPT.W - 2 * PPT.M, h: 0.3, fontSize: 11, bold: true, charSpacing: 2, color: P.onAccent, fontFace: PPT.data });
          slide.addText(state.session?.brandName || state.session?.clientId || "", { x: PPT.M, y: 2.85, w: PPT.W - 2 * PPT.M, h: 1.1, fontSize: 44, color: P.onAccent, fontFace: PPT.display });
          slide.addText(periodLabel(), { x: PPT.M, y: 3.95, w: PPT.W - 2 * PPT.M, h: 0.4, fontSize: 16, color: P.onAccent, fontFace: PPT.data, transparency: 15 });
          slide.addText(`Samengesteld op ${nlDate(todayIso())} · mayday marketing`, { x: PPT.M, y: PPT.H - 0.9, w: PPT.W - 2 * PPT.M, h: 0.3, fontSize: 10, color: P.onAccent, fontFace: PPT.data, transparency: 30 });
          continue;
        }

        if (s.kind === "divider") {
          n++;
          slide.addShape("rect", { x: 0, y: 0, w: PPT.W, h: PPT.H, fill: { color: P.soft } });
          slide.addText("ONDERDEEL", { x: PPT.M, y: 3.0, w: PPT.W - 2 * PPT.M, h: 0.3, fontSize: 10, bold: true, charSpacing: 2, color: P.accent, fontFace: PPT.data });
          slide.addText(s.title, { x: PPT.M, y: 3.3, w: PPT.W - 2 * PPT.M, h: 0.9, fontSize: 36, color: P.ink, fontFace: PPT.display });
          if (s.sub) slide.addText(s.sub, { x: PPT.M, y: 4.2, w: PPT.W - 2 * PPT.M, h: 0.4, fontSize: 13, color: P.muted, fontFace: PPT.data });
          pptFoot(slide, P, n);
          continue;
        }

        if (s.kind === "summary") {
          n++;
          pptHead(slide, P, "Samenvatting", "In het kort", "");
          slide.addText(RS.notes?.summary || (RS.notesError || "Geen duiding beschikbaar."), {
            x: PPT.M, y: 1.6, w: PPT.W - 2 * PPT.M, h: 4.6, fontSize: 15, color: P.ink,
            fontFace: PPT.display, lineSpacingMultiple: 1.35, valign: "top",
          });
          pptFoot(slide, P, n);
          continue;
        }

        if (s.kind === "gap") {
          n++;
          pptHead(slide, P, s.title, "Geen data", "");
          slide.addText(`Voor dit onderdeel is in deze periode niets opgehaald: ${s.note}.\n\nHet rapport laat dit bewust leeg in plaats van een nul te tonen — ontbrekende data is onbekend, niet nul.`, {
            x: PPT.M, y: 1.7, w: PPT.W - 2 * PPT.M, h: 3, fontSize: 13, color: P.muted, fontFace: PPT.data, lineSpacingMultiple: 1.4,
          });
          pptFoot(slide, P, n);
          continue;
        }

        if (s.kind === "sources") {
          n++;
          pptHead(slide, P, "Verantwoording", "Bronnen en meetlat", "");
          const tmp = document.createElement("div");
          tmp.innerHTML = sourcesHtml();
          const pairs = [];
          const dts = Array.from(tmp.querySelectorAll("dt"));
          const dds = Array.from(tmp.querySelectorAll("dd"));
          dts.forEach((dt, i) => pairs.push([{ text: txt(dt), options: { bold: true } }, { text: txt(dds[i]) }]));
          slide.addTable(pairs, {
            x: PPT.M, y: 1.55, w: PPT.W - 2 * PPT.M, colW: [2.6, PPT.W - 2 * PPT.M - 2.6],
            fontSize: 10, fontFace: PPT.data, color: P.ink, valign: "top",
            border: { type: "solid", color: P.line, pt: 0.5 },
          });
          pptFoot(slide, P, n);
          continue;
        }

        n++;
        pptHead(slide, P, pageLabel(s.page), s.title, s.sub);
        let y = (s.sub ? 1.5 : 1.28) + 0.28;
        const m = s.model;
        const note = RS.notes?.blocks?.[s.blockId];
        const noteH = note ? 0.95 : 0;
        const bottom = PPT.H - 0.72 - noteH;

        if (m.kpis.length) y = pptKpis(slide, P, m.kpis, y);

        if (m.charts.length && y < bottom - 1) {
          const png = await svgToPng(m.charts[0]);
          if (png) {
            const availW = PPT.W - 2 * PPT.M;
            const availH = bottom - y - 0.1;
            const scale = Math.min(availW / png.w, availH / png.h);
            slide.addImage({ data: png.data, x: PPT.M, y, w: png.w * scale, h: png.h * scale });
            y += png.h * scale + 0.16;
          }
        }

        if (m.tables.length && y < bottom - 0.5) {
          y = pptTable(slide, P, m.tables[0], y, bottom - y);
        } else if (!m.kpis.length && !m.charts.length && m.notes.length) {
          slide.addText(m.notes.slice(0, 8).join("\n"), {
            x: PPT.M, y, w: PPT.W - 2 * PPT.M, h: bottom - y, fontSize: 12,
            color: P.ink, fontFace: PPT.data, lineSpacingMultiple: 1.3, valign: "top",
          });
        }

        if (note) {
          const lines = [note.caption, ...(note.bullets || []).slice(0, 2).map(b => "· " + b)].filter(Boolean).join("\n");
          slide.addShape("rect", { x: PPT.M, y: PPT.H - 0.72 - noteH, w: PPT.W - 2 * PPT.M, h: 0.017, fill: { color: P.line } });
          slide.addText(lines, {
            x: PPT.M, y: PPT.H - 0.66 - noteH, w: PPT.W - 2 * PPT.M, h: noteH,
            fontSize: 10.5, color: P.muted, fontFace: PPT.data, lineSpacingMultiple: 1.25, valign: "top",
          });
        }

        pptFoot(slide, P, n);
      }

      const stamp = `${state.session?.clientId || "rapport"}-${state.period.start}-${state.period.end}`;
      await pptx.writeFile({ fileName: `${stamp}.pptx` });
    } catch (e) {
      RS.exportError = e.message || "Export mislukt.";
    }
    RS.exporting = false;
    paint();
  }

  /* ---------- 10b. Design system uit Drive ----------
     De klant kan een presentatie-design-system in zijn Drive-map hebben. Wat we
     daaruit halen zijn tokens — kleuren, letters, en de omgekeerde grond voor de
     titelslide — en die winnen op de slides van onze eigen paneelstijl.

     Bewust geen componenten: twee echte systemen bleken niet hetzelfde formaat
     te hebben (Just Jane uitgeklapt met React-slides, BAJA één .dc.html zonder
     enig slidetype), dus een integratie op een component als SlideFrame werkt
     bij de ene klant en doet bij de andere stil niets. De slide-opbouw die hun
     systeem beschrijft — hairlines in plaats van kaders, radius 0, geen schaduw,
     mono eyebrow linksboven — staat daarom als CSS in styles.css en draait op
     deze tokens. Zie api/_designsystem.js. */

  async function loadDesignSystem() {
    if (RS.dsLoaded || !state.session) return;
    RS.dsLoaded = true;
    try {
      const q = new URLSearchParams({
        clientId: state.session.clientId, token: state.session.token, action: "design-system",
      });
      const res = await fetch(`/api/drive?${q}`);
      RS.ds = res.ok ? await res.json() : null;
    } catch { RS.ds = null; }
    paint();
  }

  // Het rapportsjabloon van deze klant: een markdown in Drive waar de Config-tab
  // met 'Rapportlink' naar wijst. Die beschrijft zijn eigen secties, definities
  // en toon — bij één klant staat er letterlijk "Shopify is de waarheid voor
  // omzet, GA4 voor de verdeling. Meng ze niet in dezelfde zin." Dat hoort de
  // duiding te volgen, anders schrijft de agent een generiek rapport.
  async function loadTemplate() {
    if (RS.tplLoaded || !state.session) return;
    RS.tplLoaded = true;
    try {
      const q = new URLSearchParams({
        clientId: state.session.clientId, token: state.session.token, action: "report-template",
      });
      const res = await fetch(`/api/drive?${q}`);
      RS.tpl = res.ok ? await res.json() : null;
    } catch { RS.tpl = null; }
    paint();
  }

  const DS_VARS = [
    ["--ds-surface", "surface"], ["--ds-ink", "ink"], ["--ds-head", "head"],
    ["--ds-muted", "muted"], ["--ds-rule", "rule"], ["--ds-label", "label"],
    ["--ds-font-display", "fontDisplay"], ["--ds-font-body", "fontBody"],
    ["--ds-font-label", "fontLabel"],
  ];

  // Grafiekkleuren liggen anders dan de rest. charts.js leest zijn kleuren met
  // getComputedStyle(document.documentElement) en bákt ze in de SVG, dus een
  // waarde op de deck zetten komt te laat: de SVG is dan al getekend. Daarom
  // gaan deze vijf tijdens het bouwen van de slides even op :root staan
  // (dsKleuren()) én blijven ze op de deck staan voor wat de CSS live tekent —
  // het paneelvlak achter een grafiek is CSS, de lijnen erin zijn SVG.
  function dsChartVars() {
    const ds = RS.ds;
    if (!ds || !ds.found || !ds.chart) return [];
    const c = ds.chart;
    const uit = [];
    if (c.panel)   uit.push(["--panel", c.panel]);
    // Geen eigen raster? Dan de aslijnkleur, zodat raster en as uit hetzelfde
    // palet komen in plaats van half merk, half dashboard.
    const raster = c.grid || c.axis;
    if (raster)    uit.push(["--panel-grid", raster]);
    if (c.axis)    uit.push(["--panel-axis", c.axis]);
    if (c.series1) uit.push(["--accent-data", c.series1]);
    if (c.series2) uit.push(["--s2", c.series2]);
    return uit;
  }

  // fn() draaien met de grafiekkleuren van het design system op :root, en ze
  // daarna terugzetten. Synchroon, net als borrow(): er mag niets tussen zitten
  // dat await't, anders tekent het dashboard eromheen even in merkkleuren.
  function metDsKleuren(fn) {
    const vars = dsChartVars();
    if (!vars.length) return fn();
    const root = document.documentElement;
    const oud = vars.map(([naam]) => [naam, root.style.getPropertyValue(naam)]);
    vars.forEach(([naam, waarde]) => root.style.setProperty(naam, waarde));
    try { return fn(); }
    finally {
      oud.forEach(([naam, waarde]) => {
        if (waarde) root.style.setProperty(naam, waarde);
        else root.style.removeProperty(naam);
      });
    }
  }

  // De echte letters. Alleen de familienaam doorgeven werkt niet: de binaries
  // staan in Drive, niet op het apparaat van de kijker. _designsystem.js stuurt
  // ze als data-URL mee, hier worden ze één keer als @font-face ingehangen.
  function applyDsFonts() {
    const ds = RS.ds;
    const id = "rp-ds-fonts";
    const bestaand = document.getElementById(id);
    const naam = ds && ds.found ? ds.name : "";
    if (!ds || !ds.found || !(ds.fonts || []).length) { if (bestaand) bestaand.remove(); return; }
    if (bestaand && bestaand.dataset.ds === naam) return;
    if (bestaand) bestaand.remove();
    const el = document.createElement("style");
    el.id = id;
    el.dataset.ds = naam;
    el.textContent = ds.fonts.map(f =>
      `@font-face{font-family:${JSON.stringify(f.family)};src:url(${f.dataUrl}) format(${JSON.stringify(f.format)});`
      + `font-weight:${f.weight || "400"};font-style:normal;font-display:swap;}`).join("\n");
    document.head.appendChild(el);
  }

  // Tokens op de deck zetten, niet op :root — het dashboard eromheen houdt zijn
  // eigen stijl. Een token dat het systeem niet kent wordt niet gezet, zodat de
  // CSS-terugval op de dashboardwaarde blijft staan.
  function applyDs() {
    const deck = $("#rp-deck");
    if (!deck) return;
    const ds = RS.ds;
    applyDsFonts();   // ook als er géén systeem is: dan haalt hij een oude <style> weg
    if (!ds || !ds.found) { deck.removeAttribute("data-ds"); return; }
    const t = ds.tokens || {}, d = ds.dark || {};
    for (const [cssVar, key] of DS_VARS) {
      if (t[key]) deck.style.setProperty(cssVar, t[key]);
    }
    // Wat de CSS live tekent (het vlak achter een grafiek) hoort ook op de deck;
    // de SVG-kleuren zijn tijdens buildSlides() al gebakken.
    dsChartVars().forEach(([naam, waarde]) => deck.style.setProperty(naam, waarde));
    // De titelslide staat op de omgekeerde grond van hún systeem.
    if (d.surface) deck.style.setProperty("--ds-cover-bg", d.surface);
    if (d.ink) deck.style.setProperty("--ds-cover-fg", d.ink);
    deck.setAttribute("data-ds", "on");
  }

  function dsNote() {
    const ds = RS.ds;
    if (!ds) return "";
    if (!ds.found) return `Eigen opmaak · ${esc(ds.reason || "geen design system gevonden")}`;
    const mist = DS_VARS.filter(([, k]) => !(ds.tokens || {})[k]).length;
    return `Design system: ${esc(ds.name)}${mist ? ` · ${mist} token${mist === 1 ? "" : "s"} niet gevonden, daarvoor de dashboardstijl` : ""}`;
  }

  /* ---------- 11. Periode ----------
     Het rapport zet de periode via de datumvelden in de topbar, zodat er maar
     één plek is die de periode bepaalt en alle tabs meebewegen. */

  const PRESETS = [
    { key: "prevmonth", label: "Vorige maand" },
    { key: "thismonth", label: "Deze maand" },
    { key: "30", label: "30 dagen" },
    { key: "90", label: "90 dagen" },
  ];

  function presetRange(kind) {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    const iso = (yy, mm, dd) => `${yy}-${String(mm + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    const lastDay = (yy, mm) => new Date(yy, mm + 1, 0).getDate();
    if (kind === "prevmonth") {
      const py = m === 0 ? y - 1 : y, pm = m === 0 ? 11 : m - 1;
      return { start: iso(py, pm, 1), end: iso(py, pm, lastDay(py, pm)) };
    }
    if (kind === "thismonth") return { start: iso(y, m, 1), end: iso(y, m, d) };
    const days = Number(kind);
    const st = new Date(y, m, d - (days - 1), 12);
    return { start: iso(st.getFullYear(), st.getMonth(), st.getDate()), end: iso(y, m, d) };
  }

  // Welke knop hoort bij de periode die nu geldt. Bewust vergeleken met de
  // échte state en niet onthouden bij het klikken: de periode kan ook in de
  // topbar veranderen, en dan moet de markering meebewegen.
  function activePreset() {
    const p = PRESETS.find(x => {
      const r = presetRange(x.key);
      return r.start === state.period.start && r.end === state.period.end;
    });
    return p ? p.key : null;
  }

  function applyPeriod(kind) {
    const { start, end } = presetRange(kind);
    const inputs = document.querySelectorAll(".date-filter input[type=date]");
    if (inputs.length < 2) return;
    inputs[0].value = start;
    inputs[1].value = end;
    // De topbar-handler is ontdubbeld met 400 ms en leest dan beide velden;
    // state.period zetten we meteen zodat de labels hier niet achterlopen.
    state.period.start = start;
    state.period.end = end;
    inputs[1].dispatchEvent(new Event("change"));
    // Nieuwe periode = de opgehaalde ROAS en de duiding zijn niet meer geldig.
    periodChanged();
    paint();
  }

  /* ---------- 12. Tekenen en binden ---------- */

  // De slides hebben een vaste maat (1280×720) zodat een slide op elk scherm
  // dezelfde verhoudingen houdt; de schaal naar de beschikbare breedte gebeurt
  // met een transform. Bij printen staat die schaal op 1.
  function fitSlides() {
    const deck = $("#rp-deck");
    if (!deck) return;
    const avail = deck.clientWidth;
    const scale = Math.min(1, avail / SLIDE_W);
    deck.style.setProperty("--rp-scale", String(scale));
    deck.style.setProperty("--rp-h", `${SLIDE_H * scale}px`);
  }

  // Alles in RS hangt aan één klant: de gekozen blokken, de opgehaalde ROAS, de
  // duiding, de slides en het design system. Blijft dat staan na een wissel, dan
  // kijkt de nieuwe klant naar de selectie én de cijfers van de vorige — het
  // ergste dat een multi-tenant dashboard kan doen. De sessie leeft in
  // sessionStorage en overleeft een nieuwe login in hetzelfde tabblad, dus de
  // klant-id is hier de enige betrouwbare trigger.
  function resetIfOtherClient() {
    const id = state.session?.clientId || null;
    if (RS.clientId === id) return;
    wipe(id);
  }

  // Alles weg en het scherm leeg. Apart van resetIfOtherClient omdat uitloggen
  // niet kan wachten tot er iemand tekent: tussen 'uitgelogd' en 'de nieuwe
  // klant klikt op Rapport' staat de deck van de vorige klant gewoon in de DOM.
  function wipe(id) {
    RS.clientId = id === undefined ? null : id;
    RS.picked = null;
    RS.withAnalysis = true;
    RS.view = "config";
    RS.building = false;
    RS.steps = [];
    RS.slides = null;
    RS.notes = null;
    RS.notesError = null;
    RS.roas = null;
    RS.exporting = false;
    RS.exportError = null;
    RS.ds = null;
    RS.dsLoaded = false;
    RS.tpl = null;
    RS.tplLoaded = false;
    pageSize(false);
    const root = $("#report-content");
    if (root) root.innerHTML = "";
  }

  function paint() {
    const root = $("#report-content");
    if (!root) return;
    if (!state.session) { root.innerHTML = ""; return; }
    resetIfOtherClient();
    if (RS.picked === null) RS.picked = loadPicked();

    const deck = RS.view === "deck" && RS.slides;
    root.innerHTML = deck ? renderDeck() : renderConfig();
    bind(root);
    pageSize(deck);
    if (deck) { applyDs(); fitSlides(); }
  }

  // Het papierformaat geldt per document, niet per element: @page kan niet op
  // een selector worden begrensd. Stond die regel in styles.css, dan zou ook
  // een geprinte Website- of ROAS-tab ineens op 1280x720 liggend uitkomen.
  // Daarom hangt hij er alleen in zolang de deck op het scherm staat.
  function pageSize(aan) {
    const id = "rp-page-size";
    const bestaand = document.getElementById(id);
    if (!aan) { if (bestaand) bestaand.remove(); return; }
    if (bestaand) return;
    const el = document.createElement("style");
    el.id = id;
    el.textContent = `@page { size: ${SLIDE_W}px ${SLIDE_H}px; margin: 0; }`;
    document.head.appendChild(el);
  }

  function bind(root) {
    root.querySelectorAll("[data-rp-block]").forEach(cb => {
      cb.onchange = () => {
        const id = cb.dataset.rpBlock;
        if (cb.checked) RS.picked.add(id); else RS.picked.delete(id);
        savePicked();
        paint();
      };
    });
    root.querySelectorAll("[data-rp-page]").forEach(cb => {
      cb.onchange = () => {
        const list = blocksOf(cb.dataset.rpPage);
        list.forEach(b => { if (cb.checked) RS.picked.add(b.id); else RS.picked.delete(b.id); });
        savePicked();
        paint();
      };
    });
    root.querySelectorAll("[data-rp-period]").forEach(btn => {
      btn.onclick = () => applyPeriod(btn.dataset.rpPeriod);
    });
    const an = $("#rp-analysis", root);
    if (an) an.onchange = () => { RS.withAnalysis = an.checked; savePicked(); };
    const go = $("#rp-build", root);
    if (go) go.onclick = () => build();
    const back = $("#rp-back", root);
    if (back) back.onclick = () => { RS.view = "config"; paint(); };
    const print = $("#rp-print", root);
    if (print) print.onclick = () => window.print();
    const pptx = $("#rp-pptx", root);
    if (pptx) pptx.onclick = () => exportPptx();
  }

  let resizeBound = false;

  function open() {
    if (!resizeBound) {
      window.addEventListener("resize", () => { if (state.page === "report") fitSlides(); });
      resizeBound = true;
    }
    paint();          // reset eerst, zodat dsLoaded klopt voor déze klant
    loadDesignSystem();
    loadTemplate();
  }

  // Ook weghalen als de gebruiker de tab verlaat terwijl de deck open staat;
  // switchPage() roept dit aan via de brug in app.js.
  function close() { pageSize(false); }

  // De periode kan ook buiten deze tab veranderen (datumvelden of de knoppen in
  // de topbar). Zonder dit bleef de balk hier de oude periode tonen terwijl het
  // dashboard al op de nieuwe stond — twee waarheden op één scherm.
  function periodChanged() {
    RS.roas = null;
    RS.notes = null;
    RS.slides = null;
    RS.steps = [];
    RS.view = "config";
    if (state.page === "report") paint();
  }

  // Door app.js aangeroepen bij uitloggen. Niet wachten op de volgende paint:
  // de slides van de vorige klant mogen geen seconde langer in de DOM staan.
  function reset() { wipe(null); }

  window.__report = { open, close, periodChanged, reset };
})();
