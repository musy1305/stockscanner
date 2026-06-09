async function getDynamicTickers(finnhubKey) {
  const url = `https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${finnhubKey}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Finnhub symbols HTTP ${r.status}`);
  const all = await r.json();
  if (!Array.isArray(all)) throw new Error("Geen symbolen ontvangen");

  // Only real NASDAQ/NYSE stocks, no OTC, no foreign listings
  const filtered = all.filter(s =>
    s.type === "Common Stock" &&
    s.symbol &&
    !s.symbol.includes(".") &&
    !s.symbol.includes("-") &&
    s.symbol.length <= 4 &&
    (s.mic === "XNAS" || s.mic === "XNYS")
  );

  // Take random 80 candidates
  const shuffled = filtered.sort(() => Math.random() - 0.5).slice(0, 80);

  // Fetch quotes in batches of 10
  const withQuotes = [];
  for (let i = 0; i < shuffled.length; i += 10) {
    const batch = shuffled.slice(i, i + 10);
    const quotes = await Promise.all(
      batch.map(async s => {
        try {
          const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${s.symbol}&token=${finnhubKey}`);
          const q = await r.json();
          return { ...s, quote: q };
        } catch { return { ...s, quote: {} }; }
      })
    );
    withQuotes.push(...quotes);
  }

  // Filter: price $2-$30, positive momentum today (>1%), has volume
  const active = withQuotes.filter(s =>
    s.quote.c >= 2 &&
    s.quote.c <= 30 &&
    s.quote.dp > 1 &&
    s.quote.v > 100000 &&
    s.quote.c > s.quote.pc
  );

  // Sort by % change descending
  active.sort((a, b) => b.quote.dp - a.quote.dp);

  return active.slice(0, 8).map(s => ({
    symbol:        s.symbol,
    name:          s.description || s.symbol,
    sector:        "—",
    market:        s.mic === "XNAS" ? "NASDAQ" : "NYSE",
    price:         s.quote.c,
    changePercent: s.quote.dp,
    volume:        s.quote.v,
  }));
}

async function getNews(symbol, key) {
  try {
    const to   = new Date().toISOString().split("T")[0];
    const from = new Date(Date.now() - 7*86400000).toISOString().split("T")[0];
    const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${from}&to=${to}&token=${key}`);
    if (!r.ok) return "";
    const arr = await r.json();
    return Array.isArray(arr) ? arr.slice(0, 3).map(a => a.headline).filter(Boolean).join(" | ") : "";
  } catch { return ""; }
}

async function getSectorProfile(symbol, key) {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${key}`);
    if (!r.ok) return {};
    return await r.json();
  } catch { return {}; }
}

async function analyzeWithAI(ticker, news, anthropicKey) {
  const chg = ticker.changePercent ?? 0;
  const chgStr = `+${Number(chg).toFixed(2)}%`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{
        role: "user",
        content:
          `Analyze stock ${ticker.symbol} (${ticker.name}), sector: ${ticker.sector}, exchange: ${ticker.market}.\n` +
          `Current price: $${ticker.price} (${chgStr} today), Volume: ${(ticker.volume/1e6).toFixed(2)}M\n` +
          `Recent news: ${news || "geen nieuws gevonden"}\n\n` +
          `Return ONLY raw JSON, no markdown:\n` +
          `{"signal":"BUY","confidence":70,"summary":"2-3 zinnen Nederlandse analyse","catalysts":["a","b","c"],"risks":["x","y"],"newsHeadline":"headline","priceTarget":"$X-$Y","timeframe":"1-3 months"}\n` +
          `signal must be one of: STRONG_BUY BUY WATCH NEUTRAL AVOID`
      }]
    })
  });

  const raw = await r.text();
  if (!r.ok) {
    let msg = `Claude HTTP ${r.status}`;
    try { msg = JSON.parse(raw).error?.message || msg; } catch {}
    throw new Error(msg);
  }

  const data = JSON.parse(raw);
  const txt = data.content?.[0]?.text || "";
  const clean = txt.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in response");
  return JSON.parse(match[0]);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const FINNHUB_KEY   = process.env.FINNHUB_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  if (!FINNHUB_KEY || !ANTHROPIC_KEY) {
    return res.status(500).json({ error: "Missing API keys" });
  }

  try {
    const tickers = await getDynamicTickers(FINNHUB_KEY);

    if (tickers.length === 0) {
      return res.status(500).json({ error: "Geen actieve aandelen gevonden. Mogelijk buiten markturen (15:30-22:00 NL tijd)." });
    }

    const results = [];
    for (const ticker of tickers) {
      try {
        const [news, profile] = await Promise.all([
          getNews(ticker.symbol, FINNHUB_KEY),
          getSectorProfile(ticker.symbol, FINNHUB_KEY)
        ]);

        if (profile.finnhubIndustry) ticker.sector = profile.finnhubIndustry;
        if (profile.name) ticker.name = profile.name;

        // Skip if market cap too large (>$2B) or too small (<$50M)
        if (profile.marketCapitalization) {
          const mcapM = profile.marketCapitalization;
          if (mcapM > 2000 || mcapM < 50) {
            continue;
          }
        }

        // Skip if no recent news
        if (!news) continue;

        const analysis = await analyzeWithAI(ticker, news, ANTHROPIC_KEY);
        const valid = ["STRONG_BUY","BUY","WATCH","NEUTRAL","AVOID"];

        results.push({
          ...ticker,
          ok: true,
          signal:       valid.includes(analysis.signal) ? analysis.signal : "WATCH",
          confidence:   typeof analysis.confidence === "number" ? Math.max(0, Math.min(100, analysis.confidence)) : 50,
          summary:      analysis.summary      || "—",
          catalysts:    Array.isArray(analysis.catalysts) ? analysis.catalysts : [],
          risks:        Array.isArray(analysis.risks)     ? analysis.risks     : [],
          newsHeadline: analysis.newsHeadline || "—",
          priceTarget:  analysis.priceTarget  || "—",
          timeframe:    analysis.timeframe    || "—",
        });
      } catch(e) {
        // Skip failed tickers silently
      }
    }

    if (results.length === 0) {
      return res.status(500).json({ error: "Geen geschikte small-caps gevonden met nieuws. Probeer opnieuw." });
    }

    const order = { STRONG_BUY: 0, BUY: 1, WATCH: 2, NEUTRAL: 3, AVOID: 4 };
    results.sort((a, b) => {
      const d = (order[a.signal] ?? 5) - (order[b.signal] ?? 5);
      return d !== 0 ? d : b.confidence - a.confidence;
    });

    return res.status(200).json({
      results,
      scannedAt: new Date().toISOString(),
      source: "Finnhub NASDAQ/NYSE + Claude AI",
      totalScanned: results.length
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
