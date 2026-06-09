// Stock Scanner API - Dynamic small-cap screener
// Uses Financial Modeling Prep + Finnhub + Claude AI

async function getSmallCapStocks(fmpKey) {
  const [gainers, active] = await Promise.all([
    fetch(`https://financialmodelingprep.com/api/v3/stock_market/gainers?apikey=${fmpKey}`).then(r=>r.json()),
    fetch(`https://financialmodelingprep.com/api/v3/stock_market/actives?apikey=${fmpKey}`).then(r=>r.json()),
  ]);

  const combined = [
    ...(Array.isArray(gainers) ? gainers : []),
    ...(Array.isArray(active)  ? active  : []),
  ];

  const seen = new Set();
  const unique = combined.filter(s => {
    if (!s.symbol || seen.has(s.symbol)) return false;
    seen.add(s.symbol);
    return true;
  });

  return unique
    .filter(s => s.price > 1 && s.price < 50 && s.symbol && s.name)
    .sort((a, b) => Math.abs(b.changesPercentage||0) - Math.abs(a.changesPercentage||0))
    .slice(0, 15)
    .map(s => ({
      symbol:        s.symbol,
      name:          s.name,
      sector:        s.sector || "Unknown",
      market:        s.exchange || "NASDAQ",
      price:         s.price,
      volume:        s.volume || 0,
      marketCap:     s.marketCap || null,
      changePercent: s.changesPercentage || 0,
    }));
}

async function getQuote(symbol, finnhubKey) {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${finnhubKey}`);
    return await r.json();
  } catch { return {}; }
}

async function getNews(symbol, finnhubKey) {
  try {
    const to   = new Date().toISOString().split("T")[0];
    const from = new Date(Date.now() - 7*86400000).toISOString().split("T")[0];
    const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${from}&to=${to}&token=${finnhubKey}`);
    const arr = await r.json();
    return Array.isArray(arr) ? arr.slice(0, 3).map(a => a.headline).join(" | ") : "";
  } catch { return ""; }
}

async function analyzeWithAI(ticker, news, anthropicKey) {
  const chg = ticker.changePercent;
  const chgStr = chg != null ? `${chg > 0 ? "+" : ""}${Number(chg).toFixed(2)}%` : "onbekend";
  const mcap = ticker.marketCap ? `$${(ticker.marketCap / 1e6).toFixed(0)}M` : "onbekend";

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
          `Analyze small-cap stock ${ticker.symbol} (${ticker.name}), sector: ${ticker.sector}.\n` +
          `Price: $${ticker.price} (${chgStr} today), Market cap: ${mcap}, Volume: ${(ticker.volume/1e6).toFixed(1)}M\n` +
          `Recent news: ${news || "geen nieuws gevonden"}\n\n` +
          `Return ONLY raw JSON (no markdown):\n` +
          `{"signal":"BUY","confidence":70,"summary":"2-3 zinnen Nederlandse analyse","catalysts":["a","b","c"],"risks":["x","y"],"newsHeadline":"meest relevante headline","priceTarget":"$X-$Y","timeframe":"1-3 months"}\n` +
          `signal: STRONG_BUY BUY WATCH NEUTRAL AVOID`
      }]
    })
  });

  const raw = await r.text();
  if (!r.ok) {
    const err = JSON.parse(raw);
    throw new Error(`Claude ${r.status}: ${err.error?.message}`);
  }

  const data = JSON.parse(raw);
  const txt = data.content?.[0]?.text || "";
  const clean = txt.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON. Got: ${txt.slice(0, 100)}`);
  return JSON.parse(match[0]);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const FMP_KEY       = process.env.FMP_API_KEY;
  const FINNHUB_KEY   = process.env.FINNHUB_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  if (!FMP_KEY || !FINNHUB_KEY || !ANTHROPIC_KEY) {
    return res.status(500).json({
      error: "Missing API keys",
      fmp: !!FMP_KEY, finnhub: !!FINNHUB_KEY, anthropic: !!ANTHROPIC_KEY
    });
  }

  try {
    const tickers = await getSmallCapStocks(FMP_KEY);

    if (tickers.length === 0) {
      return res.status(500).json({ error: "Geen aandelen gevonden. Mogelijk buiten markturen." });
    }

    const results = [];
    for (const ticker of tickers) {
      try {
        const [quote, news] = await Promise.all([
          getQuote(ticker.symbol, FINNHUB_KEY),
          getNews(ticker.symbol, FINNHUB_KEY)
        ]);

        const price = quote.c || ticker.price;
        const changePercent = quote.dp ?? ticker.changePercent;

        const analysis = await analyzeWithAI(
          { ...ticker, price, changePercent },
          news,
          ANTHROPIC_KEY
        );

        const valid = ["STRONG_BUY","BUY","WATCH","NEUTRAL","AVOID"];
        results.push({
          ...ticker,
          price,
          changePercent,
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
        results.push({
          ...ticker, ok: false, error: e.message,
          signal: "NEUTRAL", confidence: 0,
          summary: e.message, catalysts: [], risks: [],
          newsHeadline: "—", priceTarget: "—", timeframe: "—"
        });
      }
    }

    const order = { STRONG_BUY: 0, BUY: 1, WATCH: 2, NEUTRAL: 3, AVOID: 4 };
    results.sort((a, b) => {
      const sigDiff = (order[a.signal] ?? 5) - (order[b.signal] ?? 5);
      if (sigDiff !== 0) return sigDiff;
      return b.confidence - a.confidence;
    });

    return res.status(200).json({
      results,
      scannedAt: new Date().toISOString(),
      source: "FMP Gainers/Actives + Finnhub + Claude AI",
      totalScanned: tickers.length
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
