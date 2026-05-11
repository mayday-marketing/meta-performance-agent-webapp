/* ==========================================================
   Social Performance Agent — App logic
   ========================================================== */

(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const fmt = {
    int: (n) => n.toLocaleString("nl-NL"),
    k: (n) => n >= 1000 ? (n/1000).toFixed(1).replace(".0","") + "K" : String(n),
    pct: (n) => n.toFixed(1) + "%"
  };

  const state = {
    brand: "",
    page: "overview",
    libraryView: "grid", // "grid" | "table"
    libraryFilter: "all",
    librarySort: { key: "reach", dir: "desc" },
    chatMessages: [],
    period: "4mnd"
  };

  /* ---------- Screen flow ---------- */

  function showScreen(id) {
    $$(".screen").forEach((s) => s.classList.toggle("on", s.id === id));
    if (id === "app-screen") initDashboard();
  }
  window.showScreen = showScreen;

  function chooseSource(type) {
    if (type === "handmatig") showScreen("manual-screen");
    else showScreen("app-screen");
  }
  window.chooseSource = chooseSource;

  function logout() {
    state.brand = "";
    $("#brand-input").value = "";
    $("#code-input").value = "";
    $("#source-brand").textContent = "—";
    showScreen("login-screen");
  }
  window.logout = logout;

  /* ---------- Dashboard init ---------- */

  let dashboardInited = false;
  function initDashboard() {
    if (dashboardInited) return;
    dashboardInited = true;
    renderOverview();
    renderLibrary();
    renderAnalysis();
    renderChat();
    bindNav();
    bindChatPanel();
  }

  function bindNav() {
    $$(".nav-link").forEach((btn) => {
      btn.addEventListener("click", () => {
        const page = btn.dataset.page;
        switchPage(page);
      });
    });
  }

  function switchPage(page) {
    state.page = page;
    $$(".nav-link").forEach((l) => l.classList.toggle("on", l.dataset.page === page));
    $$(".dash-page").forEach((p) => p.style.display = p.id === `page-${page}` ? "block" : "none");
    const titles = {
      overview: { title: "Overview", crumbs: ["Dashboard", "Overview"] },
      library: { title: "Library", crumbs: ["Dashboard", "Library"] },
      analysis: { title: "Analysis", crumbs: ["Dashboard", "Analysis"] }
    };
    const t = titles[page];
    $(".page-title").textContent = t.title;
    const crumbs = t.crumbs.map((c, i) => i === 0 ? `<span>${c}</span>` : `<span class="sep">/</span><span>${c}</span>`).join("");
    $(".crumbs").innerHTML = crumbs;
  }

  /* ---------- Overview ---------- */

  function sparkPath(values, w, h, pad = 2) {
    const min = Math.min(...values), max = Math.max(...values);
    const span = (max - min) || 1;
    const stepX = (w - pad*2) / (values.length - 1);
    return values.map((v, i) => {
      const x = pad + i * stepX;
      const y = pad + (h - pad*2) * (1 - (v - min) / span);
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(" ");
  }

  function sparkArea(values, w, h, pad = 2) {
    const path = sparkPath(values, w, h, pad);
    return `${path} L${w-pad},${h-pad} L${pad},${h-pad} Z`;
  }

  function renderSpark(values, color) {
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

  function renderKpis() {
    const colors = ["var(--accent)", "#6a3bff", "var(--accent-2)", "#1f9b8a"];
    const root = $("#kpi-grid");
    root.innerHTML = DATA.kpis.map((k, i) => {
      const arrow = k.direction === "up" ? "↑" : "↓";
      const delta = k.unit === "pp" ? `${k.delta.toFixed(1)}pp` : `${k.delta.toFixed(1)}%`;
      const color = colors[i % colors.length];
      return `
        <div class="kpi-card">
          <div class="label"><span class="dot" style="background:${color}"></span>${k.label}</div>
          <div class="value">${k.value}</div>
          <div class="delta ${k.direction}">${arrow} ${delta} ${k.sub ? `<span class="vs">· ${k.sub}</span>` : `<span class="vs">${k.vs}</span>`}</div>
          ${renderSpark(k.spark, color.startsWith("var") ? getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() : color)}
        </div>
      `;
    }).join("");
  }

  function renderTrendChart() {
    const ts = DATA.timeseries;
    const w = 760, h = 260;
    const padL = 36, padR = 12, padT = 10, padB = 26;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const all = ts.series.flatMap(s => s.values);
    const max = Math.ceil(Math.max(...all) / 10) * 10;
    const min = 0;
    const stepX = innerW / (ts.weeks.length - 1);
    const xAt = (i) => padL + i * stepX;
    const yAt = (v) => padT + innerH * (1 - (v - min) / (max - min));

    // Y grid + labels
    const ySteps = 4;
    let grid = "";
    let ylabels = "";
    for (let i = 0; i <= ySteps; i++) {
      const v = min + (max - min) * (i / ySteps);
      const y = yAt(v);
      grid += `<line x1="${padL}" x2="${w - padR}" y1="${y}" y2="${y}" stroke="currentColor" stroke-opacity="0.08"/>`;
      ylabels += `<text x="${padL - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="currentColor" opacity="0.5">${Math.round(v)}K</text>`;
    }
    // X labels (every 4th week)
    let xlabels = "";
    ts.weeks.forEach((wk, i) => {
      if (i % 4 === 0 || i === ts.weeks.length - 1) {
        xlabels += `<text x="${xAt(i)}" y="${h - 8}" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55">${wk}</text>`;
      }
    });

    // Series paths (areas + lines)
    let paths = "";
    ts.series.forEach((s, idx) => {
      const pathPts = s.values.map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(2)},${yAt(v).toFixed(2)}`).join(" ");
      const areaPath = `${pathPts} L${xAt(s.values.length - 1)},${yAt(0)} L${xAt(0)},${yAt(0)} Z`;
      const gid = `g${idx}`;
      paths += `
        <defs>
          <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${s.color}" stop-opacity="0.22"/>
            <stop offset="100%" stop-color="${s.color}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="${areaPath}" fill="url(#${gid})"/>
        <path d="${pathPts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      `;
      // End-point dot
      const lastX = xAt(s.values.length - 1);
      const lastY = yAt(s.values[s.values.length - 1]);
      paths += `<circle cx="${lastX}" cy="${lastY}" r="3.5" fill="${s.color}" stroke="var(--surface)" stroke-width="1.5"/>`;
    });

    $("#trend-chart").innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="xMidYMid meet" style="display:block;">
        ${grid}
        ${ylabels}
        ${xlabels}
        ${paths}
      </svg>
    `;
    $("#trend-legend").innerHTML = ts.series.map(s =>
      `<span class="item"><span class="swatch" style="background:${s.color}"></span>${s.label}</span>`
    ).join("");
  }

  function renderChannelMix() {
    $("#channel-mix").innerHTML = DATA.channels.map(c => `
      <div class="channel-row">
        <div class="label"><span class="swatch" style="background:${c.color}"></span>${c.label}</div>
        <div class="pct">${c.value}%</div>
        <div class="channel-bar"><div class="fill" style="width:${c.value}%; background:${c.color}"></div></div>
      </div>
    `).join("");
  }

  function renderTopPosts() {
    $("#top-posts").innerHTML = DATA.topPosts.map((p, i) => `
      <div class="top-post" data-post="${p.id}">
        <div class="post-thumb thumb-pattern" style="background:${p.thumb}">
          <span class="glyph">${i + 1}</span>
          ${p.type === "Reel" ? `<span class="play-icon">▶</span>` : ""}
        </div>
        <div class="meta">
          <div class="caption">${p.caption}</div>
          <div class="submeta">
            <span>${p.type}</span>
            <span>·</span>
            <span>${p.date}</span>
            <span>·</span>
            <span>IG</span>
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
    let html = "";
    // Header row: empty + 13 week labels
    html += `<div></div>`;
    for (let w = 0; w < 13; w++) {
      html += `<div class="day-label" style="font-size:9px;">${w % 4 === 0 ? `wk ${w + 1}` : ""}</div>`;
    }
    // 7 day rows
    DATA.cadenceDays.forEach((day, i) => {
      html += `<div class="day-label">${day}</div>`;
      for (let w = 0; w < 13; w++) {
        const v = DATA.cadence[i][w] || 0;
        html += `<div class="cell" data-v="${v}" title="${day} wk ${w + 1}: ${v} posts"></div>`;
      }
    });
    root.innerHTML = html;
  }

  function renderOverview() {
    renderKpis();
    renderTrendChart();
    renderChannelMix();
    renderTopPosts();
    renderCadence();
  }

  /* ---------- Library ---------- */

  function platformLabel(p) {
    return { ig: "Instagram", fb: "Facebook", ads: "Meta Ads" }[p];
  }
  function platformShort(p) {
    return { ig: "IG", fb: "FB", ads: "ADS" }[p];
  }

  function getFilteredLibrary() {
    let list = DATA.library.slice();
    if (state.libraryFilter !== "all") list = list.filter(p => p.platform === state.libraryFilter);
    const dir = state.librarySort.dir === "asc" ? 1 : -1;
    const field = state.librarySort.key;
    list.sort((a, b) => {
      const av = a[field];
      const bv = b[field];
      if (av === undefined || av === null) return 1 * dir;
      if (bv === undefined || bv === null) return -1 * dir;
      if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });
    return list;
  }

  function performanceExplanation(level) {
    const brand = DATA.brand || "de klant";
    if (level === "Good") {
      return `Deze post doet het beter dan ${brand}s gemiddelde. Een goede hook en een duidelijke waardepropositie helpen hier. Houd dit format aan en bouw voort op dezelfde contentstijl.`;
    }
    if (level === "Average") {
      return `Deze post zit rond de klantbenchmark. Er is voldoende engagement om mee te werken, maar de eerste 3 seconden kunnen sterker. Focus op een snellere belofte en een duidelijkere ‘waarom dit relevant is’ voor je doelgroep.`;
    }
    if (level === "Bad") {
      return `Deze post presteert duidelijk onder ${brand}s benchmark. Meestal komt dat door een zwakke opening, te veel productfocus zonder context, of een te generieke boodschap voor het merk. Begin bij de hook en het format, niet bij de copy alleen.`;
    }
    return `Deze performantie-indicator is bedoeld om je snel te laten zien hoe de post presteert ten opzichte van de klantbenchmark.`;
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
    if (!retention) return `
      <div class="retention-row">
        ${Array(5).fill('<span class="block inactive"></span>').join('')}
      </div>
    `;
    const checkpoints = [
      { label: '3s', value: retention.p3, threshold: 3 },
      { label: '25%', value: retention.p25, threshold: 25 },
      { label: '50%', value: retention.p50, threshold: 50 },
      { label: '75%', value: retention.p75, threshold: 75 },
      { label: '95%', value: retention.p95, threshold: 95 }
    ];
    return `
      <div class="retention-row">
        ${checkpoints.map(cp => `
          <span class="block ${cp.value >= cp.threshold ? 'active' : 'inactive'}" title="${cp.label}: ${cp.value}%"></span>
        `).join('')}
      </div>
    `;
  }

  function renderBenchmarkRow(list) {
    if (!list.length) return '';
    const avg = (field) => Math.round(list.reduce((sum, item) => sum + (item[field] || 0), 0) / list.length);
    const avgPerf = list.reduce((sum, item) => sum + (item.engagement || 0), 0) / list.length;
    const platformName = state.libraryFilter === 'all' ? 'Globaal gemiddelde' : `${platformLabel(state.libraryFilter)} gemiddelde`;
    return `
      <tr class="benchmark-row">
        <td>CLIENT BENCHMARK — ${platformName}</td>
        <td></td>
        <td></td>
        <td></td>
        <td class="right">${fmt.int(avg('views'))}</td>
        <td class="right">${fmt.int(avg('reach'))}</td>
        <td class="right">${fmt.int(avg('likes'))}</td>
        <td class="right">${fmt.int(avg('comments'))}</td>
        <td class="right">${fmt.int(avg('shares'))}</td>
        <td class="right">${fmt.int(avg('saves'))}</td>
        <td></td>
        <td class="right">${avgPerf.toFixed(1)}%</td>
        <td></td>
        <td></td>
      </tr>
    `;
  }

  function renderLibraryTable(list) {
    return `<div class="lib-table">
      <table>
        <thead>
            <tr>
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
            </tr>
        </thead>
        <tbody>
          ${renderBenchmarkRow(list)}
          ${list.map(p => `
            <tr data-post="${p.id}">
              <td>
                <span class="row-thumb thumb-pattern" style="background:${p.thumb}"></span>
                <span class="row-caption">${p.caption}</span>
              </td>
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
      </table>
    </div>`;
  }

  function renderLibrary() {
    // Filter chips
    $("#lib-filters").innerHTML = DATA.libraryFilters.map(f => `
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

    // Sort
    $("#lib-sort").value = state.librarySort.key;
    $("#lib-sort").onchange = (e) => { state.librarySort.key = e.target.value; renderLibrary(); };

    // View toggle
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

  /* ---------- Analysis ---------- */

  function renderAnalysis() {
    const ins = DATA.insights;
    $("#analysis-content").innerHTML = `
      <div class="insight-grid">
        <div class="insight-card win">
          <div class="head">
            <span class="pill">Wat werkt</span>
            <h3>Winners</h3>
          </div>
          <div class="insight-list">
            ${ins.winners.map(w => `
              <div class="insight-item">
                <div class="delta up">${w.delta}</div>
                <div class="heading">${w.heading}</div>
                <div class="body">${w.body}</div>
                <div class="tag">${w.tag}</div>
              </div>
            `).join("")}
          </div>
        </div>
        <div class="insight-card lose">
          <div class="head">
            <span class="pill">Onder presteert</span>
            <h3>Losers</h3>
          </div>
          <div class="insight-list">
            ${ins.losers.map(w => `
              <div class="insight-item">
                <div class="delta down">${w.delta}</div>
                <div class="heading">${w.heading}</div>
                <div class="body">${w.body}</div>
                <div class="tag">${w.tag}</div>
              </div>
            `).join("")}
          </div>
        </div>
        <div class="insight-card rec">
          <div class="head">
            <span class="pill">Aanbevelingen</span>
            <h3>Next steps</h3>
          </div>
          <div class="insight-list">
            ${ins.recs.map(w => `
              <div class="insight-item">
                <div class="heading">${w.heading}</div>
                <div class="body">${w.body}</div>
                <div class="tag">${w.tag}</div>
              </div>
            `).join("")}
          </div>
        </div>
      </div>

      <section class="panel analysis-narrative">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Periode-samenvatting</h2>
            <div class="panel-sub">Automatisch gegenereerd op basis van data tussen 1 jan en 30 apr</div>
          </div>
          <div class="panel-actions">
            <button class="btn tiny">Kopieer</button>
            <button class="btn tiny">Exporteer PDF</button>
          </div>
        </div>
        <div class="narrative-body">
          De afgelopen vier maanden lieten een duidelijke versnelling zien op <strong>Instagram</strong>, gedreven door <span class="tag-pill">Reels</span> en achter-de-schermen content. De totale reach steeg met <strong>+18.3%</strong> tot <strong>487K</strong>, met de capsule-launch in april als duidelijkste piek (week 16). De engagement-rate klom mee naar <strong>6.8%</strong> — ruim boven de fashion benchmark van 4.2%.
          <br><br>
          De grootste winst zit in <strong>format-keuze</strong>: BTS Reels haalden 11.2% engagement waar productfoto's bleven hangen rond 4.1%. <span class="tag-pill">Mira blouse stylinggids</span> en <span class="tag-pill">Lissabon shoot</span> waren de twee posts met de hoogste save-rate, een sterk signaal voor latente conversie.
          <br><br>
          Twee zorgpunten: <strong>Facebook-only posts</strong> blijven achter (–31% reach period-over-period), en de <strong>sale-Ads</strong> leveren wel CTR maar weinig brand-engagement. De aanbeveling is om in mei te schuiven richting een 70/30 brand/sale-mix en de FB-distributie te beperken tot cross-posts met format-aanpassing.
        </div>
      </section>
    `;
  }

  /* ---------- Chat panel ---------- */

  function renderChat() {
    $("#chat-prompts").innerHTML = DATA.prompts.map(p => `
      <button class="chat-prompt" data-prompt="${p}">${p}</button>
    `).join("");
    $$("#chat-prompts .chat-prompt").forEach(b => {
      b.onclick = () => sendUserMsg(b.dataset.prompt);
    });
    $("#chat-form").onsubmit = (e) => {
      e.preventDefault();
      const v = $("#chat-input-field").value.trim();
      if (!v) return;
      $("#chat-input-field").value = "";
      sendUserMsg(v);
    };

    // Initial bot message
    if (state.chatMessages.length === 0) {
      pushBot({
        text: `Hoi! Ik ben je <strong>Performance Agent</strong>. Ik kan vragen beantwoorden over je content, advertenties en groei. Probeer een van de prompts hieronder, of stel je eigen vraag.`,
        stats: null
      });
    }
  }

  function pushUser(text) {
    state.chatMessages.push({ role: "user", text });
    appendMsg("user", text);
  }
  function pushBot(payload) {
    state.chatMessages.push({ role: "bot", ...payload });
    appendMsg("bot", payload.text, payload.stats);
  }

  function appendMsg(role, text, stats) {
    const body = $("#chat-body");
    const wrap = document.createElement("div");
    wrap.className = `msg ${role}`;
    let stubs = "";
    if (stats) {
      stubs = `<div class="meta-stats">${stats.map(s => `
        <span class="stat-chip"><span class="n">${s.n}</span><span class="l">${s.l}</span></span>
      `).join("")}</div>`;
    }
    wrap.innerHTML = `
      <div class="author">${role === "user" ? "Jij" : "Agent"}</div>
      <div class="bubble">${text}${stubs}</div>
    `;
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
      const reply = mockReply(text);
      pushBot(reply);
    }, 850 + Math.random() * 400);
  }

  function mockReply(text) {
    const t = text.toLowerCase();
    if (/(best|top|posts?|reels?)/.test(t)) {
      return {
        text: `In de huidige periode zijn dit de top 3 posts, gerangschikt op engagement-rate:<br><br>
          <strong>1.</strong> "Achter de schermen bij de fotoshoot" — Carousel — <strong>11.2%</strong><br>
          <strong>2.</strong> "Stylinggids: Mira blouse" — Carousel — <strong>9.4%</strong><br>
          <strong>3.</strong> "Hoe wij linnen kiezen" — Reel — <strong>8.2%</strong><br><br>
          Wat ze gemeen hebben: een verhalende caption en een gezicht uit het team. Wil je dat ik een briefing genereer voor mei?`,
        stats: [
          { n: "11.2%", l: "Top engage" },
          { n: "84K", l: "Best reach" },
          { n: "1.8×", l: "Vs. avg" }
        ]
      };
    }
    if (/(facebook|fb|ig|instagram|kanaal|channel|verge)/.test(t)) {
      return {
        text: `Instagram is duidelijk dominant in deze periode: <strong>62%</strong> van de reach. Facebook is gezakt naar <strong>21%</strong> (–31% PoP) en Meta Ads pakken nu <strong>17%</strong> in de mix.<br><br>
          Mijn advies: behoud Facebook alleen voor cross-posts met format-aanpassing en verschuif 30% van het FB-budget richting IG Stories.`,
        stats: [
          { n: "62%", l: "IG share" },
          { n: "–31%", l: "FB PoP" },
          { n: "+24%", l: "Ads" }
        ]
      };
    }
    if (/(plaats|tim|wanneer|cadens|moment)/.test(t)) {
      return {
        text: `Donderdagavond rond <strong>19u</strong> is consistent het sterkste slot voor save-rate. Zaterdagochtend werkt goed voor Reels met BTS-content. Maandag en zondag presteren ondergemiddeld.<br><br>
          Ik raad aan om <strong>2 Reels per week</strong> in te plannen met een vast slot op donderdag.`,
        stats: [
          { n: "do 19u", l: "Beste slot" },
          { n: "2/wk", l: "Reels" },
          { n: "+18K", l: "Verwacht" }
        ]
      };
    }
    if (/(format|content|werk)/.test(t)) {
      return {
        text: `Drie formats die werken: <strong>BTS Reels</strong> (engage 11.2%), <strong>storytelling carousels</strong> (saves 1.8K gem.) en <strong>stylinggids posts</strong>. Solo productfoto's onder presteren — gebruik die alleen rond launches met context.`,
        stats: [
          { n: "BTS", l: "Reels" },
          { n: "Story", l: "Carousel" },
          { n: "Style", l: "Gids" }
        ]
      };
    }
    if (/(campagne|ad|spend|roas|ads)/.test(t)) {
      return {
        text: `De Capsule SS26-campagne loopt sterk: <strong>96K</strong> reach, CTR <strong>5.2%</strong>. De winter sale-Ads scoren op CTR (4.8%) maar onder gemiddeld op brand-engagement.<br><br>
          Ik zou de mix in mei naar <strong>70% brand / 30% sale</strong> brengen — de huidige verhouding is omgekeerd.`,
        stats: [
          { n: "5.2%", l: "Top CTR" },
          { n: "€2.4K", l: "Extra ROAS" },
          { n: "70/30", l: "Mix" }
        ]
      };
    }
    return {
      text: `Goede vraag — ik zie geen specifieke datapunten die hier direct op aansluiten. Probeer iets specifiekers, bijvoorbeeld <em>"hoe presteren mijn Reels?"</em> of <em>"wat moet ik doen met mijn Facebook-strategie?"</em>.`,
      stats: null
    };
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
    // Listen for host activate/deactivate before announcing availability
    window.addEventListener("message", (e) => {
      const data = e.data || {};
      if (data.type === "__activate_edit_mode") openTweaks();
      else if (data.type === "__deactivate_edit_mode") closeTweaks();
    });
    window.parent.postMessage({ type: "__edit_mode_available" }, "*");

    // Restore from defaults
    const t = window.TWEAK_DEFAULTS;
    setAccent(t.accent);
    setDensity(t.density);
    setTheme(t.theme);

    // Wire controls
    $$("[data-tweak-accent]").forEach(b => {
      b.onclick = () => {
        setAccent(b.dataset.tweakAccent);
        persist({ accent: b.dataset.tweakAccent });
      };
    });
    $$("[data-tweak-density]").forEach(b => {
      b.onclick = () => {
        setDensity(b.dataset.tweakDensity);
        persist({ density: b.dataset.tweakDensity });
      };
    });
    $$("[data-tweak-theme]").forEach(b => {
      b.onclick = () => {
        setTheme(b.dataset.tweakTheme);
        persist({ theme: b.dataset.tweakTheme });
      };
    });

    $("#tweaks-close").onclick = () => {
      closeTweaks();
      window.parent.postMessage({ type: "__edit_mode_dismissed" }, "*");
    };
  }

  function openTweaks() { $("#tweaks-panel").classList.add("on"); }
  function closeTweaks() { $("#tweaks-panel").classList.remove("on"); }

  function persist(edits) {
    window.parent.postMessage({ type: "__edit_mode_set_keys", edits }, "*");
  }

  function setAccent(v) {
    document.documentElement.setAttribute("data-accent", v);
    $$("[data-tweak-accent]").forEach(b => b.classList.toggle("on", b.dataset.tweakAccent === v));
    if (dashboardInited) renderOverview();
  }
  function setDensity(v) {
    document.documentElement.setAttribute("data-density", v);
    $$("[data-tweak-density]").forEach(b => b.classList.toggle("on", b.dataset.tweakDensity === v));
  }
  function setTheme(v) {
    document.documentElement.setAttribute("data-theme", v);
    $$("[data-tweak-theme]").forEach(b => b.classList.toggle("on", b.dataset.tweakTheme === v));
    if (dashboardInited) renderOverview();
  }

  /* ---------- Login init ---------- */

  function bindLogin() {
    const loginBtn = $("#login-button");
    if (!loginBtn) {
      console.warn("Login button not found");
      return;
    }
    loginBtn.addEventListener("click", login);
  }

  function login(e) {
    if (e && e.preventDefault) e.preventDefault();
    const brand = $("#brand-input").value.trim() || DATA.brand;
    const code = $("#code-input").value.trim() || "agent123";
    if (!brand || !code) {
      alert("Vul zowel brandnaam als logincode in om door te gaan.");
      return;
    }
    state.brand = brand;
    $("#source-brand").textContent = brand;
    $("#sidebar-brand").textContent = `Klant: ${brand}`;
    $("#sidebar-brand-sub").textContent = "Connected · 4 mnd";
    showScreen("source-screen");
  }
  window.login = login;

  /* ---------- Boot ---------- */

  document.addEventListener("DOMContentLoaded", () => {
    bindLogin();
    bindTweaks();
    // Pre-fill demo brand
    $("#brand-input").value = DATA.brand;
    $("#code-input").value = "agent123";
    $("#sidebar-brand").textContent = `Klant: ${DATA.brand}`;
  });

})();
