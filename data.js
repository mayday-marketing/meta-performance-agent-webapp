/* Mock data — vervangen door live Metricool API in stap 3 */
const DATA = {
  brand: "Spotto",

  kpis: [
    {
      label: "Totale reach", value: "487K",
      delta: 18.3, direction: "up", vs: "vs vorige periode", unit: "pct",
      spark: [220, 240, 255, 260, 280, 295, 310, 305, 330, 355, 375, 390, 487]
    },
    {
      label: "Engagement rate", value: "6.8%",
      delta: 0.6, direction: "up", vs: "vs vorige periode", unit: "pp",
      spark: [5.8, 6.0, 5.9, 6.1, 6.3, 6.2, 6.4, 6.5, 6.6, 6.6, 6.7, 6.8, 6.8]
    },
    {
      label: "Posts gepubliceerd", value: "47",
      delta: 12.4, direction: "up", vs: "vs vorige periode", unit: "pct",
      spark: [9, 11, 10, 12, 11, 13, 11, 13, 12, 14, 13, 15, 14]
    },
    {
      label: "Clicks", value: "12.4K",
      delta: 4.2, direction: "down", vs: "vs vorige periode", unit: "pct",
      spark: [14, 13, 14, 12, 13, 11, 12, 11, 12, 10, 11, 12, 12.4]
    }
  ],

  timeseries: {
    weeks: [
      "wk 1","wk 2","wk 3","wk 4","wk 5","wk 6","wk 7","wk 8",
      "wk 9","wk 10","wk 11","wk 12","wk 13","wk 14","wk 15","wk 16","wk 17"
    ],
    series: [
      {
        label: "Instagram", color: "#ff683b",
        values: [18, 22, 20, 25, 28, 24, 30, 35, 32, 38, 40, 36, 42, 45, 44, 52, 48]
      },
      {
        label: "Facebook", color: "#351f69",
        values: [12, 11, 13, 10, 12, 11, 10, 9, 11, 10, 9, 8, 9, 8, 7, 9, 8]
      },
      {
        label: "Meta Ads", color: "#1f9b8a",
        values: [5, 6, 5, 7, 6, 8, 7, 9, 8, 10, 9, 11, 10, 12, 11, 13, 12]
      }
    ]
  },

  channels: [
    { label: "Instagram", color: "#ff683b", value: 68 },
    { label: "Facebook", color: "#351f69", value: 20 },
    { label: "Meta Ads", color: "#1f9b8a", value: 12 }
  ],

  topPosts: [
    {
      id: 1, caption: "Behind the scenes van de Lissabon shoot",
      type: "Reel", date: "12 apr", engagement: "11.2%",
      thumb: "linear-gradient(135deg, #ff683b, #351f69)"
    },
    {
      id: 2, caption: "Mira blouse — stylinggids",
      type: "Carrousel", date: "5 apr", engagement: "9.8%",
      thumb: "linear-gradient(135deg, #351f69, #1f9b8a)"
    },
    {
      id: 3, caption: "Capsule launch — nieuwe collectie",
      type: "Reel", date: "1 apr", engagement: "8.4%",
      thumb: "linear-gradient(135deg, #1f9b8a, #ff683b)"
    },
    {
      id: 4, caption: "Materiaaldetails voorjaarsjas",
      type: "Foto", date: "22 mrt", engagement: "5.1%",
      thumb: "linear-gradient(135deg, #6a3bff, #ff683b)"
    },
    {
      id: 5, caption: "Weekend look inspiratie",
      type: "Carrousel", date: "15 mrt", engagement: "4.9%",
      thumb: "linear-gradient(135deg, #ff683b, #6a3bff)"
    }
  ],

  cadenceDays: ["Ma", "Di", "Wo", "Do", "Vr", "Za", "Zo"],
  cadence: [
    [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
    [0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0],
    [1, 0, 0, 2, 0, 0, 1, 0, 0, 2, 0, 0, 1],
    [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0],
    [2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2],
    [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1]
  ],

  library: [
    {
      id: 1, caption: "Behind the scenes van de Lissabon shoot",
      type: "Reel", platform: "ig", date: "12 apr 2026", dateRange: "12 apr 2026",
      views: 61400, reach: 48200, likes: 3840, comments: 142, shares: 310, saves: 342,
      engagement: 11.2, ctr: 1.8, performance: "Good",
      retention: { p3: 82, p25: 71, p50: 58, p75: 42, p95: 28 },
      thumb: "linear-gradient(135deg, #ff683b 0%, #351f69 100%)"
    },
    {
      id: 2, caption: "Mira blouse — stylinggids",
      type: "Carrousel", platform: "ig", date: "5 apr 2026", dateRange: "5 apr 2026",
      views: 39400, reach: 39400, likes: 2870, comments: 98, shares: 201, saves: 289,
      engagement: 9.8, ctr: 2.1, performance: "Good",
      retention: null,
      thumb: "linear-gradient(135deg, #351f69 0%, #1f9b8a 100%)"
    },
    {
      id: 3, caption: "Capsule launch — nieuwe collectie",
      type: "Reel", platform: "ig", date: "1 apr 2026", dateRange: "1 apr 2026",
      views: 68200, reach: 52100, likes: 3100, comments: 187, shares: 445, saves: 421,
      engagement: 8.4, ctr: 1.6, performance: "Good",
      retention: { p3: 78, p25: 64, p50: 51, p75: 38, p95: 22 },
      thumb: "linear-gradient(135deg, #1f9b8a 0%, #ff683b 100%)"
    },
    {
      id: 4, caption: "Materiaaldetails voorjaarsjas",
      type: "Foto", platform: "ig", date: "22 mrt 2026", dateRange: "22 mrt 2026",
      views: 18700, reach: 18700, likes: 720, comments: 31, shares: 44, saves: 89,
      engagement: 5.1, ctr: 0.9, performance: "Average",
      retention: null,
      thumb: "linear-gradient(135deg, #6a3bff 0%, #ff683b 100%)"
    },
    {
      id: 5, caption: "Weekend look inspiratie",
      type: "Carrousel", platform: "ig", date: "15 mrt 2026", dateRange: "15 mrt 2026",
      views: 17200, reach: 17200, likes: 641, comments: 28, shares: 61, saves: 76,
      engagement: 4.9, ctr: 1.1, performance: "Average",
      retention: null,
      thumb: "linear-gradient(135deg, #ff683b 0%, #6a3bff 100%)"
    },
    {
      id: 6, caption: "Achter de naaimachine",
      type: "Reel", platform: "ig", date: "8 mrt 2026", dateRange: "8 mrt 2026",
      views: 27800, reach: 21400, likes: 1020, comments: 54, shares: 132, saves: 145,
      engagement: 6.2, ctr: 1.3, performance: "Good",
      retention: { p3: 74, p25: 60, p50: 46, p75: 31, p95: 18 },
      thumb: "linear-gradient(135deg, #351f69 0%, #ff683b 100%)"
    },
    {
      id: 7, caption: "How to style: neutrale basics",
      type: "Reel", platform: "ig", date: "20 mrt 2026", dateRange: "20 mrt 2026",
      views: 25600, reach: 19800, likes: 880, comments: 42, shares: 118, saves: 132,
      engagement: 5.8, ctr: 1.2, performance: "Good",
      retention: { p3: 71, p25: 57, p50: 43, p75: 29, p95: 15 },
      thumb: "linear-gradient(135deg, #1f9b8a 0%, #351f69 100%)"
    },
    {
      id: 8, caption: "Lente editie — lookbook",
      type: "Carrousel", platform: "ig", date: "25 feb 2026", dateRange: "25 feb 2026",
      views: 16400, reach: 16400, likes: 520, comments: 22, shares: 89, saves: 98,
      engagement: 4.3, ctr: 0.8, performance: "Average",
      retention: null,
      thumb: "linear-gradient(135deg, #ff683b 0%, #1f9b8a 100%)"
    },
    {
      id: 9, caption: "Onze favoriete lentecombo",
      type: "Foto", platform: "ig", date: "18 jan 2026", dateRange: "18 jan 2026",
      views: 11200, reach: 11200, likes: 310, comments: 14, shares: 32, saves: 54,
      engagement: 3.8, ctr: 0.7, performance: "Average",
      retention: null,
      thumb: "linear-gradient(135deg, #6a3bff 0%, #1f9b8a 100%)"
    },
    {
      id: 10, caption: "Nieuwe collectie aankondiging",
      type: "Foto", platform: "fb", date: "28 mrt 2026", dateRange: "28 mrt 2026",
      views: 12300, reach: 12300, likes: 241, comments: 18, shares: 67, saves: 34,
      engagement: 3.2, ctr: 0.6, performance: "Average",
      retention: null,
      thumb: "linear-gradient(135deg, #351f69 0%, #6a3bff 100%)"
    },
    {
      id: 11, caption: "Facebook wekelijkse update",
      type: "Foto", platform: "fb", date: "14 feb 2026", dateRange: "14 feb 2026",
      views: 8200, reach: 8200, likes: 98, comments: 7, shares: 21, saves: 12,
      engagement: 2.4, ctr: 0.4, performance: "Bad",
      retention: null,
      thumb: "linear-gradient(135deg, #351f69 0%, #1f9b8a 100%)"
    },
    {
      id: 12, caption: "Flash sale — 48 uur",
      type: "Foto", platform: "ads", date: "10 apr 2026", dateRange: "10 apr 2026",
      views: 31000, reach: 31000, likes: 410, comments: 22, shares: 54, saves: 0,
      engagement: 2.1, ctr: 3.8, performance: "Average",
      retention: null,
      thumb: "linear-gradient(135deg, #ff683b 0%, #6a3bff 100%)"
    },
    {
      id: 13, caption: "Spring campaign — brand awareness",
      type: "Video", platform: "ads", date: "1 mrt 2026", dateRange: "1 mrt 2026",
      views: 44000, reach: 44000, likes: 520, comments: 31, shares: 78, saves: 0,
      engagement: 1.8, ctr: 2.9, performance: "Average",
      retention: { p3: 62, p25: 44, p50: 28, p75: 14, p95: 6 },
      thumb: "linear-gradient(135deg, #1f9b8a 0%, #6a3bff 100%)"
    },
    {
      id: 14, caption: "Sale retargeting campagne",
      type: "Video", platform: "ads", date: "14 mrt 2026", dateRange: "14 mrt 2026",
      views: 28000, reach: 28000, likes: 380, comments: 18, shares: 42, saves: 0,
      engagement: 1.9, ctr: 4.2, performance: "Average",
      retention: { p3: 58, p25: 40, p50: 24, p75: 12, p95: 4 },
      thumb: "linear-gradient(135deg, #6a3bff 0%, #ff683b 100%)"
    }
  ],

  libraryFilters: [
    { key: "all", label: "Alle", count: 14 },
    { key: "ig", label: "Instagram", count: 9 },
    { key: "fb", label: "Facebook", count: 2 },
    { key: "ads", label: "Meta Ads", count: 3 }
  ],

  insights: {
    winners: [
      {
        delta: "+47%",
        heading: "BTS Reels",
        body: "Behind-the-scenes Reels halen 11.2% engagement — 2.7× hoger dan productfoto's. Format en authenticiteit trekken.",
        tag: "Format · Reel"
      },
      {
        delta: "+28%",
        heading: "Carrousels met stylinggidsen",
        body: "Educatieve carrousels met stylingtips genereren significant meer saves en profile visits.",
        tag: "Format · Carrousel"
      }
    ],
    losers: [
      {
        delta: "–31%",
        heading: "Facebook-only posts",
        body: "Posts die alleen op Facebook worden geplaatst presteren ver onder gemiddelde. Bereik daalt period-over-period.",
        tag: "Platform · Facebook"
      },
      {
        delta: "–18%",
        heading: "Sale-advertenties",
        body: "Sale Ads leveren CTR maar nauwelijks brand-engagement of saves. Contribueert niet aan merkopbouw.",
        tag: "Betaald · Ads"
      }
    ],
    recs: [
      {
        heading: "Verdubbel BTS Reels in mei",
        body: "Verhoog cadens van BTS-content naar 2× per week. Format werkt aantoonbaar — meer data helpt bij optimalisering.",
        tag: "Actie · Direct"
      },
      {
        heading: "Shift naar 70/30 brand/sale-mix",
        body: "Huidige mix is te zwaar op conversie-ads. Meer brand content versterkt het engagement-fundament.",
        tag: "Strategie · Betaald"
      },
      {
        heading: "Facebook beperken tot cross-posts",
        body: "Stop Facebook-only content. Bespaar productietijd en plaats enkel cross-posts met lichte format-aanpassing.",
        tag: "Efficiëntie"
      }
    ]
  },

  prompts: [
    "Welke content heeft het hoogste engagement?",
    "Vergelijk Instagram en Facebook performance",
    "Wat zijn de beste posting tijden?",
    "Analyseer de betaalde campagnes"
  ]
};
