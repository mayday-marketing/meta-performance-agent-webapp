/* ==========================================================
   Charts — one uniform renderer for every graph in the app.
   Token-driven: all colors come from CSS variables so charts
   follow the active palette automatically. Add a new graph by
   calling Charts.render(el, spec) — never hand-roll SVG again.
   ========================================================== */

(function () {
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback || "";
  }
  // Reekspalet: reeks 1 is de datakleur van het merk (het accent, afgetopt op
  // lichtheid zodat een geel of lime merk niet verdwijnt), reeks 2 de lichtere
  // stap daarvan, en daarna een vast kleurenblind-veilig palet. Bewust maximaal
  // zes reeksen: daarboven is een grafiek niet meer te lezen en hoort er een
  // restpost te zijn. Een accentramp draagt niet meer dan twee reeksen.
  const SERIES_TOKENS = ["--accent-data", "--s2", "--chart-3", "--chart-4", "--chart-5", "--chart-6"];
  function seriesColor(i) {
    return cssVar(SERIES_TOKENS[i % SERIES_TOKENS.length], "#0072b2");
  }
  const softColor = () => cssVar("--fg-muted", "#6b6560");
  const surfaceColor = () => cssVar("--surface", "#ffffff");
  // Raster en nullijn komen uit de panelfamilie: het raster licht, de as één stap
  // donkerder. Zo blijft het onderscheid tussen 'hulplijn' en 'nul' zichtbaar.
  const gridColor = () => cssVar("--panel-grid", "#d8dcea");
  const axisColor = () => cssVar("--panel-axis", "#c2c7da");

  // Round an axis maximum up to a clean number
  function niceMax(v) {
    if (!isFinite(v) || v <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / pow;
    // Vaste stappenladder, zodat een as altijd op een rond getal eindigt en er
    // nooit een tick op 6.847 staat.
    const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    const m = steps.find(s => s >= n - 1e-9) || 10;
    return m * pow;
  }

  const fmt = {
    k: (v) => {
      if (Math.abs(v) >= 1000) {
        const n = v / 1000;
        return (Number.isInteger(n) ? n : n.toFixed(1)) + "K";
      }
      return String(Math.round(v));
    },
    pct: (v) => (Number.isInteger(v) ? v : v.toFixed(0)) + "%",
    euroK: (v) => "€" + (Math.abs(v) >= 1000 ? ((v / 1000) % 1 === 0 ? v / 1000 : (v / 1000).toFixed(1)) + "K" : Math.round(v)),
    int: (v) => Math.round(v).toLocaleString("nl-NL")
  };

  let uid = 0;

  /* ---------- Core renderer ----------
     spec = {
       width, height,
       x: [labels],
       series: [
         { label, values, kind: "area"|"line"|"bar", axis: "left"|"right", color? }
       ],
       leftFormat: fn(v)->string,     // default fmt.k
       rightFormat: fn(v)->string,    // default fmt.pct
       maxXLabels: number,            // default 8
       incompleteFrom: number,        // index vanaf waar de periode nog loopt
       labelLast: boolean             // label op de laatste volledige waarde
     }

     incompleteFrom: een maand of dag die nog loopt telt niet mee in een
     conclusie, dus hij mag er ook niet volledig uitzien. Staven vanaf die index
     krijgen arcering, lijnen worden gestreept, en er komt 'loopt nog' onder.
     De aanroeper moet de index aanleveren — de renderer kan niet weten welke
     dag onvolledig is, en een gok zou een onwaarheid tekenen.

     labelLast: de laatste volledige waarde krijgt een label in de grafiek zelf,
     niet alleen in de tooltip.
  */
  function render(el, spec) {
    if (!el) return;
    const W = spec.width || 760;
    const H = spec.height || 260;
    const x = spec.x || [];
    const n = x.length;
    const series = (spec.series || []).map((s, i) => ({
      kind: "line",
      axis: "left",
      color: s.color || seriesColor(i),
      ...s
    }));

    const hasRight = series.some(s => s.axis === "right");
    const padL = 46;
    const padR = hasRight ? 50 : 16;
    const padT = 14;
    const padB = 30;
    const iW = W - padL - padR;
    const iH = H - padT - padB;

    const leftVals = series.filter(s => s.axis !== "right").flatMap(s => s.values);
    const rightVals = series.filter(s => s.axis === "right").flatMap(s => s.values);
    const leftMax = niceMax(Math.max(0, ...leftVals));
    const rightMax = hasRight ? niceMax(Math.max(0, ...rightVals)) : 1;

    const xAt = (i) => padL + (n <= 1 ? iW / 2 : (iW * i) / (n - 1));
    const yL = (v) => padT + iH * (1 - v / leftMax);
    const yR = (v) => padT + iH * (1 - v / rightMax);
    const yFor = (s) => (s.axis === "right" ? yR : yL);

    const leftFormat = spec.leftFormat || fmt.k;
    const rightFormat = spec.rightFormat || fmt.pct;
    const maxXLabels = spec.maxXLabels || 8;
    // Alleen een geldige index binnen de reeks doet iets; alles daarbuiten wordt
    // stil genegeerd i.p.v. half getekend.
    const incFrom = Number.isInteger(spec.incompleteFrom) && spec.incompleteFrom > 0
      && spec.incompleteFrom < n ? spec.incompleteFrom : null;
    const lastFull = incFrom === null ? n - 1 : incFrom - 1;

    const cid = "c" + (uid++);
    const parts = [];

    // Grid + left axis labels (4 intervals)
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const v = (leftMax * i) / steps;
      const y = yL(v);
      // i === 0 is de nullijn: die krijgt de askleur, de rest het raster.
      parts.push(`<line x1="${padL}" x2="${W - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${i === 0 ? axisColor() : gridColor()}"/>`);
      parts.push(`<text x="${padL - 10}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${softColor()}">${leftFormat(v)}</text>`);
    }
    // Right axis labels
    if (hasRight) {
      for (let i = 0; i <= steps; i++) {
        const v = (rightMax * i) / steps;
        const y = yR(v);
        parts.push(`<text x="${W - padR + 10}" y="${(y + 3).toFixed(1)}" text-anchor="start" font-size="10" fill="${softColor()}">${rightFormat(v)}</text>`);
      }
    }
    // X axis labels
    const every = Math.max(1, Math.ceil(n / maxXLabels));
    x.forEach((lab, i) => {
      if (i % every === 0 || i === n - 1) {
        parts.push(`<text x="${xAt(i).toFixed(1)}" y="${H - 9}" text-anchor="middle" font-size="10" fill="${softColor()}">${lab}</text>`);
      }
    });

    // Draw order: bars (back) -> areas -> lines (front)
    const order = { bar: 0, area: 1, line: 2 };
    const sorted = series.map((s, i) => ({ s, i })).sort((a, b) => order[a.s.kind] - order[b.s.kind]);

    // Bar geometry: share slot width among bar series
    const barSeries = series.filter(s => s.kind === "bar");
    const slot = n > 1 ? iW / (n - 1) : iW;
    const barGroupW = Math.min(slot * 0.6, 42);
    const barW = barSeries.length ? barGroupW / barSeries.length : barGroupW;

    sorted.forEach(({ s, i }) => {
      const yf = yFor(s);
      if (s.kind === "bar") {
        const bi = barSeries.indexOf(s);
        const y0 = yf(0);
        const hid = `${cid}-h${i}`;
        if (incFrom !== null) {
          // Arcering in dezelfde kleur: het is dezelfde reeks, alleen nog niet af.
          parts.push(`<defs><pattern id="${hid}" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">`
            + `<rect width="6" height="6" fill="${s.color}" fill-opacity="0.16"/>`
            + `<line x1="0" y1="0" x2="0" y2="6" stroke="${s.color}" stroke-width="2.4" stroke-opacity="0.7"/></pattern></defs>`);
        }
        s.values.forEach((v, k) => {
          const h = Math.max(0, y0 - yf(v));
          const cx = xAt(k);
          const bx = cx - barGroupW / 2 + bi * barW;
          const r = Math.min(4, barW / 2);
          const loopt = incFrom !== null && k >= incFrom;
          const fill = loopt ? `url(#${hid})` : s.color;
          parts.push(`<rect x="${bx.toFixed(1)}" y="${yf(v).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${r}" fill="${fill}"${loopt ? "" : ' fill-opacity="0.85"'}/>`);
        });
      } else {
        const pts = s.values.map((v, k) => `${k === 0 ? "M" : "L"}${xAt(k).toFixed(2)},${yf(v).toFixed(2)}`).join(" ");
        if (s.kind === "area") {
          const gid = `${cid}-g${i}`;
          const area = `${pts} L${xAt(s.values.length - 1).toFixed(2)},${yf(0).toFixed(2)} L${xAt(0).toFixed(2)},${yf(0).toFixed(2)} Z`;
          parts.push(`<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${s.color}" stop-opacity="0.20"/><stop offset="100%" stop-color="${s.color}" stop-opacity="0"/></linearGradient></defs>`);
          parts.push(`<path d="${area}" fill="url(#${gid})"/>`);
        }
        if (incFrom === null) {
          parts.push(`<path d="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`);
        } else {
          // Twee paden: het volledige deel doorlopend, het lopende deel gestreept.
          const seg = (from, to) => s.values.slice(from, to + 1)
            .map((v, j) => `${j === 0 ? "M" : "L"}${xAt(from + j).toFixed(2)},${yf(v).toFixed(2)}`).join(" ");
          parts.push(`<path d="${seg(0, lastFull)}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`);
          parts.push(`<path d="${seg(lastFull, n - 1)}" fill="none" stroke="${s.color}" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round" stroke-linejoin="round"/>`);
        }
        const lx = xAt(s.values.length - 1);
        const ly = yf(s.values[s.values.length - 1]);
        parts.push(`<circle cx="${lx.toFixed(2)}" cy="${ly.toFixed(2)}" r="3.5" fill="${s.color}" stroke="${surfaceColor()}" stroke-width="1.5"/>`);
      }
    });

    // Direct label: identiteit hangt niet alleen aan de tooltip.
    if (spec.labelLast && n) {
      const s0 = series.find(s => s.axis !== "right") || series[0];
      if (s0) {
        const v = s0.values[lastFull];
        const fmtL = s0.axis === "right" ? rightFormat : leftFormat;
        parts.push(`<text x="${xAt(lastFull).toFixed(1)}" y="${(yFor(s0)(v) - 9).toFixed(1)}" text-anchor="middle" font-size="11.5" font-weight="600" fill="${cssVar("--fg", "#1a1a1a")}">${fmtL(v)}</text>`);
      }
    }
    if (incFrom !== null) {
      // Bij één lopend punt ligt het midden op de rechterrand; dan tegen de rand
      // aan uitlijnen in plaats van er half buiten te vallen.
      const mid = (xAt(incFrom) + xAt(n - 1)) / 2;
      const edge = W - padR;
      const bijRand = mid > edge - 32;
      parts.push(`<text x="${(bijRand ? edge : mid).toFixed(1)}" y="${(H - 20).toFixed(1)}" text-anchor="${bijRand ? "end" : "middle"}" font-size="10.5" fill="${softColor()}">loopt nog</text>`);
    }

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}"" width="100%" height="${H}" preserveAspectRatio="xMidYMid meet" style="display:block;">${parts.join("")}</svg>`;
    return series; // so caller can build a matching legend
  }

  /* ---------- Donut (deel-van-geheel) ----------
     spec = {
       size, thickness,
       slices: [{ label, value, color? }],   // vaste volgorde = vaste kleur
       centerValue, centerLabel,
       format: fn(v)->string
     }
     De kleur volgt het item, niet zijn grootte: slice i krijgt altijd --slice-(i+1),
     ook als de volgorde in de data verandert. Tussen de segmenten zit een gaatje
     van ~2px in de oppervlaktekleur, zodat aangrenzende tinten niet in elkaar
     overlopen — dat is ook het 'tweede signaal' naast kleur voor wie kleuren
     moeilijk onderscheidt. De legenda met cijfers hoort ernaast en staat in de
     tekstkleur, niet in de slice-kleur. */
  function sliceColor(i) {
    return cssVar("--slice-" + ((i % 7) + 1), seriesColor(i));
  }

  function annularSector(cx, cy, rOuter, rInner, a0, a1) {
    const p = (r, a) => `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    return `M${p(rOuter, a0)} A${rOuter},${rOuter} 0 ${large} 1 ${p(rOuter, a1)}`
         + ` L${p(rInner, a1)} A${rInner},${rInner} 0 ${large} 0 ${p(rInner, a0)} Z`;
  }

  function donut(el, spec) {
    const size = spec.size || 220;
    const th = spec.thickness || 34;
    const cx = size / 2, cy = size / 2;
    const rOuter = size / 2 - 1;
    const rInner = Math.max(4, rOuter - th);
    const rMid = (rOuter + rInner) / 2;

    const slices = (spec.slices || []).filter(s => (s.value || 0) > 0);
    const total = slices.reduce((a, b) => a + (b.value || 0), 0);
    const parts = [];

    if (!total) {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${rMid.toFixed(1)}" fill="none" stroke="${softColor()}" stroke-opacity="0.25" stroke-width="${th}"/>`);
    } else {
      const gap = Math.min(0.07, 2 / rMid);   // ~2px hart-op-hart
      let a = -Math.PI / 2;
      slices.forEach((s, i) => {
        const sweep = (s.value / total) * Math.PI * 2;
        // Een segment dat smaller is dan het gaatje zou verdwijnen; dat tekenen
        // we dan zonder marge, anders valt een klein kanaal stilletjes weg.
        const g = (slices.length > 1 && sweep > gap * 2.5) ? gap / 2 : 0;
        const a0 = a + g, a1 = a + sweep - g;
        if (a1 > a0) {
          parts.push(`<path d="${annularSector(cx, cy, rOuter, rInner, a0, a1)}" fill="${s.color || sliceColor(i)}"/>`);
        }
        a += sweep;
      });
    }

    if (spec.centerValue != null) {
      parts.push(`<text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="20" font-weight="600" fill="currentColor">${spec.centerValue}</text>`);
    }
    if (spec.centerLabel) {
      parts.push(`<text x="${cx}" y="${cy + 15}" text-anchor="middle" font-size="10" letter-spacing="0.08em" fill="${softColor()}">${spec.centerLabel}</text>`);
    }

    el.innerHTML = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="display:block;">${parts.join("")}</svg>`;
    return slices;
  }

  /* ---------- Legend ---------- */
  function legend(el, series) {
    if (!el) return;
    el.innerHTML = series.map((s, i) =>
      `<span class="item"><span class="swatch" style="background:${s.color || seriesColor(i)}"></span>${s.label}</span>`
    ).join("");
  }

  /* ---------- Sparkline (mini, for KPI cards) ---------- */
  function sparkline(values, color) {
    const w = 160, h = 38, pad = 2;
    const min = Math.min(...values), max = Math.max(...values);
    const span = (max - min) || 1;
    const stepX = (w - pad * 2) / (values.length - 1);
    const pts = values.map((v, i) => {
      const px = pad + i * stepX;
      const py = pad + (h - pad * 2) * (1 - (v - min) / span);
      return `${i === 0 ? "M" : "L"}${px.toFixed(2)},${py.toFixed(2)}`;
    }).join(" ");
    const area = `${pts} L${w - pad},${h - pad} L${pad},${h - pad} Z`;
    const id = "spk" + (uid++);
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.30"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#${id})"/>
      <path d="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  window.Charts = { render, donut, legend, sparkline, seriesColor, sliceColor, cssVar, fmt };
})();
