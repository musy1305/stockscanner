// Stock Scanner - Hybrid: Curated base + Alpha Vantage daily movers

const BASE_WATCHLIST = [
  "SOUN","LUNR","RKLB","IONQ","ACMR","MARA","HIVE","RXRX","GRRR","CELH",
  "MBLY","CIFR","ASTS","MVIS","SLDP","GMRS","MNTS","ARQT","SPIR","KRUS",
  "EVGO","BLNK","CHPT","INDI","AEVA","LAZR","PRAX","VERA","KROS","ADMA",
  "RVNC","FOLD","AVXL","CORT","IMVT","NRIX","ALEC","ANAB","FLGT","FTRE"
];

async function getDailyMovers(alphaKey) {
  try {
    const url = `https://www.alphavantage.co/query?function=TOP_GAINERS_LOSERS&apikey=${alphaKey}`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const data = await r.json();
    const gainers = data.top_gainers || [];
    return gainers
      .filter(s => {
        const price = parseFloat(s.price);
        const pct   = parseFloat(s.change_percentage);
        const vol   = parseInt(s.volume) || 0;
        return (
          price >= 2 && price <= 50 &&
          pct > 2 && pct < 40 &&
          vol > 200000 &&
          !s.ticker.includes(".") &&
          s.ticker.length <= 5
        );
      })
      .slice(0, 8)
      .map(s => s.ticker);
  } catch { return []; }
}

async function getQuote(symbol, key) {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${key}`);
    if (!r.ok) return null;
    const q = await r.json();
    return q.c > 0 ? q : null;
  } catch { return null; }
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
          `Price: $${ticker.price} (${Number(chg).toFixed(2)}% today)\n` +
          `News: ${news || "geen nieuws"}\n\n` +
          `Return ONLY raw JSON:\n` +
          `{"signal":"BUY","confidence":70,"summary":"2 zinnen NL analyse","catalysts":["a","b"],"risks":["x"],"newsHeadline":"h","priceTarget":"$X-$Y","timeframe":"1-3 months"}\n` +
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

  if (!FINNHUB_KEY || !ANTHROPIC_KEY) {
    return res.status(500).json({ error: "Missing API keys" });
  }

  try {
    const dailyMovers = ALPHA_KEY ? await getDailyMovers(ALPHA_KEY) : [];
    const combined = [...new Set([...dailyMovers, ...BASE_WATCHLIST])];

    const withQuotes = [];
    for (let i = 0; i < combined.length; i += 10) {
      const batch = combined.slice(i, i + 10);
      const quotes = await Promise.all(
        batch.map(async symbol => {
          const q = await getQuote(symbol, FINNHUB_KEY);
          return q ? { symbol, quote: q, isDaily: dailyMovers.includes(symbol) } : null;
        })
      );
      withQuotes.push(...quotes.filter(Boolean));
    }

    const movers = withQuotes
      .filter(s => s.quote.c >= 1 && Math.abs(s.quote.dp) > 0.3)
      .sort((a, b) => {
        if (a.isDaily && !b.isDaily) return -1;
        if (!a.isDaily && b.isDaily) return 1;
        return b.quote.dp - a.quote.dp;
      })
      .slice(0, 8);

    if (movers.length === 0) {
      return res.status(500).json({ error: "Geen bewegende aandelen. Buiten markturen (15:30-22:00 NL)?" });
    }

    const enriched = await Promise.all(
      movers.map(async s => {
        const [news, profile] = await Promise.all([
          getNews(s.symbol, FINNHUB_KEY),
          getProfile(s.symbol, FINNHUB_KEY)
        ]);
        return {
          symbol:        s.symbol,
          name:          profile.name            || s.symbol,
          sector:        profile.finnhubIndustry || "—",
          market:        profile.exchange        || "NASDAQ",
          price:         s.quote.c,
          changePercent: s.quote.dp,
          isNewFind:     s.isDaily,
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
      scannedAt:    new Date().toISOString(),
      source:       "Alpha Vantage Daily Movers + Curated Watchlist + Claude AI",
      totalScanned: results.length,
      newFinds:     results.filter(r => r.isNewFind).length,
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
