const TICKERS = [
  { symbol: "HIVE",  name: "HIVE Digital Technologies", sector: "Crypto/AI",          market: "NASDAQ" },
  { symbol: "RZLV",  name: "Rezolve AI",                 sector: "AI/SaaS",            market: "NASDAQ" },
  { symbol: "GRRR",  name: "Gorilla Technology",         sector: "AI Video Analytics", market: "NASDAQ" },
  { symbol: "IONQ",  name: "IonQ",                       sector: "Quantum Computing",  market: "NYSE"   },
  { symbol: "LUNR",  name: "Intuitive Machines",         sector: "Space Tech",         market: "NASDAQ" },
  { symbol: "RXRX",  name: "Recursion Pharma",           sector: "AI Biotech",         market: "NASDAQ" },
  { symbol: "SOUN",  name: "SoundHound AI",              sector: "Voice AI",           market: "NASDAQ" },
  { symbol: "ACMR",  name: "ACM Research",               sector: "Semiconductors",     market: "NASDAQ" },
  { symbol: "RKLB",  name: "Rocket Lab",                 sector: "Space Tech",         market: "NASDAQ" },
  { symbol: "MARA",  name: "Marathon Digital",           sector: "Crypto Mining",      market: "NASDAQ" },
  { symbol: "CELH",  name: "Celsius Holdings",           sector: "Consumer/Health",    market: "NASDAQ" },
  { symbol: "MBLY",  name: "Mobileye Global",            sector: "Autonomous Driving", market: "NASDAQ" },
];

async function getQuote(symbol, key) {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${key}`);
    return await r.json();
  } catch { return {}; }
}

async function getNews(symbol, key) {
  try {
    const to   = new Date().toISOString().split("T")[0];
    const from = new Date(Date.now() - 7*86400000).toISOString().split("T")[0];
    const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${from}&to=${to}&token=${key}`);
    const arr = await r.json();
    return Array.isArray(arr) ? arr.slice(0,3).map(a=>a.headline).join(" | ") : "";
  } catch { return ""; }
}

async function analyzeWithAI(ticker, quote, news, anthropicKey) {
  const change = quote.dp ? `${quote.dp>0?"+":""}${Number(quote.dp).toFixed(2)}%` : "onbekend";
  
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
        content: `Analyze ${ticker.symbol} (${ticker.name}, ${ticker.sector}).
Price: $${quote.c || "?"} (${change})
News: ${news || "geen"}

Return ONLY this JSON (no markdown, no explanation):
{"signal":"BUY","confidence":70,"summary":"2 zinnen NL analyse","catalysts":["a","b"],"risks":["x"],"newsHeadline":"headline","priceTarget":"$X-$Y","timeframe":"1-3 months"}

signal must be one of: STRONG_BUY BUY WATCH NEUTRAL AVOID`
      }]
    })
  });

  const raw = await r.text();
  
  if (!r.ok) {
    const err = JSON.parse(raw);
    throw new Error(`Anthropic ${r.status}: ${err.error?.message}`);
  }

  const data = JSON.parse(raw);
  const txt = data.content?.[0]?.text || "";
  
  // Strip any markdown
  const clean = txt.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON found. Got: ${txt.slice(0,100)}`);
  
  return JSON.parse(match[0]);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const FINNHUB_KEY   = process.env.FINNHUB_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  if (!FINNHUB_KEY || !ANTHROPIC_KEY) {
    return res.status(500).json({ error: "Missing API keys", finnhub: !!FINNHUB_KEY, anthropic: !!ANTHROPIC_KEY });
  }

  const single  = req.query.symbol?.toUpperCase();
  const targets = single ? TICKERS.filter(t => t.symbol === single) : TICKERS;
  const results = [];

  for (const ticker of targets) {
    try {
      const [quote, news] = await Promise.all([
        getQuote(ticker.symbol, FINNHUB_KEY),
        getNews(ticker.symbol, FINNHUB_KEY)
      ]);
      const analysis = await analyzeWithAI(ticker, quote, news, ANTHROPIC_KEY);
      const valid = ["STRONG_BUY","BUY","WATCH","NEUTRAL","AVOID"];
      results.push({
        ...ticker,
        price:         quote.c || null,
        changePercent: quote.dp || null,
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
      results.push({ ...ticker, ok: false, error: e.message, signal: "NEUTRAL", confidence: 0,
        summary: e.message, catalysts: [], risks: [], newsHeadline: "—", priceTarget: "—", timeframe: "—" });
    }
  }

  return res.status(200).json({ results, scannedAt: new Date().toISOString() });
}
