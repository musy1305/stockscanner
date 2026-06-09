async function getTopMovers(alphaKey) {
  const url = `https://www.alphavantage.co/query?function=TOP_GAINERS_LOSERS&apikey=${alphaKey}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Alpha Vantage HTTP ${r.status}`);
  const data = await r.json();
  const gainers = data.top_gainers || [];
  return gainers
    .filter(s => {
      const price = parseFloat(s.price);
      const pct = parseFloat(s.change_percentage);
      return price >= 2 && price <= 50 && pct > 1 && pct < 25 && !s.ticker.includes(".");
    })
    .slice(0, 6)
    .map(s => ({
      symbol:        s.ticker,
      price:         parseFloat(s.price),
      changePercent: parseFloat(s.change_percentage),
      volume:        parseInt(s.volume) || 0,
      name:          s.ticker,
      sector:        "—",
      market:        "NASDAQ/NYSE",
    }));
}

async function getNews(symbol, key) {
  try {
    const to   = new Date().toISOString().split("T")[0];
    const from = new Date(Date.now() - 7*86400000).toISOString().split("T")[0];
    const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${from}&to=${to}&token=${key}`);
    if (!r.ok) return "";
    const arr = await r.json();
    return Array.isArray(arr) ? arr.slice(0,3).map(a=>a.headline).filter(Boolean).join(" | ") : "";
  } catch { return ""; }
}

async function getProfile(symbol, key) {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${key}`);
    if (!r.ok) return {};
    return await r.json();
  } catch { return {}; }
}

async function analyzeWithAI(ticker, news, anthropicKey) {
  const chg = ticker.changePercent ?? 0;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 350,
      messages: [{
        role: "user",
        content:
          `Stock: ${ticker.symbol} (${ticker.name}), ${ticker.sector}.\n` +
          `Price: $${ticker.price} (+${Number(chg).toFixed(2)}% today)\n` +
          `News: ${news || "geen nieuws"}\n\n` +
          `Return ONLY raw JSON:\n` +
          `{"signal":"BUY","confidence":70,"summary":"2 zinnen NL","catalysts":["a","b"],"risks":["x"],"newsHeadline":"h","priceTarget":"$X-$Y","timeframe":"1-3 months"}\n` +
          `signal: STRONG_BUY BUY WATCH NEUTRAL AVOID`
      }]
    })
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(`Claude ${r.status}`);
  const data = JSON.parse(raw);
  const txt = data.content?.[0]?.text || "";
  const match = txt.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim().match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON");
  return JSON.parse(match[0]);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const ALPHA_KEY     = process.env.ALPHA_VANTAGE_KEY;
  const FINNHUB_KEY   = process.env.FINNHUB_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  if (!ALPHA_KEY || !FINNHUB_KEY || !ANTHROPIC_KEY) {
    return res.status(500).json({ error: "Missing API keys" });
  }

  try {
    const tickers = await getTopMovers(ALPHA_KEY);

    if (tickers.length === 0) {
      return res.status(500).json({ error: "Geen geschikte aandelen gevonden. Buiten markturen (15:30-22:00 NL) of probeer opnieuw." });
    }

    const enriched = await Promise.all(
      tickers.map(async ticker => {
        const [news, profile] = await Promise.all([
          getNews(ticker.symbol, FINNHUB_KEY),
          getProfile(ticker.symbol, FINNHUB_KEY)
        ]);
        return {
          ...ticker,
          name:   profile.name             || ticker.symbol,
          sector: profile.finnhubIndustry  || "—",
          market: profile.exchange         || "NASDAQ",
          news,
        };
      })
    );

    const analyses = await Promise.all(
      enriched.map(async ticker => {
        try {
          const analysis = await analyzeWithAI(ticker, ticker.news, ANTHROPIC_KEY);
          const valid = ["STRONG_BUY","BUY","WATCH","NEUTRAL","AVOID"];
          return {
            ...ticker,
            ok: true,
            signal:       valid.includes(analysis.signal) ? analysis.signal : "WATCH",
            confidence:   typeof analysis.confidence === "number" ? Math.max(0,Math.min(100,analysis.confidence)) : 50,
            summary:      analysis.summary      || "—",
            catalysts:    Array.isArray(analysis.catalysts) ? analysis.catalysts : [],
            risks:        Array.isArray(analysis.risks)     ? analysis.risks     : [],
            newsHeadline: analysis.newsHeadline || "—",
            priceTarget:  analysis.priceTarget  || "—",
            timeframe:    analysis.timeframe    || "—",
          };
        } catch { return null; }
      })
    );

    const results = analyses.filter(Boolean);

    if (results.length === 0) {
      return res.status(500).json({ error: "Geen resultaten. Probeer opnieuw." });
    }

    const order = { STRONG_BUY:0, BUY:1, WATCH:2, NEUTRAL:3, AVOID:4 };
    results.sort((a,b) => {
      const d = (order[a.signal]??5) - (order[b.signal]??5);
      return d !== 0 ? d : b.confidence - a.confidence;
    });

    return res.status(200).json({
      results,
      scannedAt: new Date().toISOString(),
      source: "Alpha Vantage Top Gainers + Claude AI",
      totalScanned: results.length
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
