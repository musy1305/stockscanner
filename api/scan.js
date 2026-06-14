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
  { symbol: "ASTS",  name: "AST SpaceMobile",            sector: "Space Tech",         market: "NASDAQ" },
  { symbol: "QUBT",  name: "Quantum Computing Inc",      sector: "Quantum Computing",  market: "NASDAQ" },
  { symbol: "RGTI",  name: "Rigetti Computing",          sector: "Quantum Computing",  market: "NASDAQ" },
  { symbol: "CLSK",  name: "CleanSpark",                 sector: "Crypto Mining",      market: "NASDAQ" },
  { symbol: "RIOT",  name: "Riot Platforms",             sector: "Crypto Mining",      market: "NASDAQ" },
  { symbol: "BBAI",  name: "BigBear.ai",                 sector: "AI/Defense",         market: "NYSE"   },
  { symbol: "PLTR",  name: "Palantir Technologies",      sector: "AI/Big Data",        market: "NASDAQ" },
  { symbol: "AI",    name: "C3.ai",                      sector: "AI/SaaS",            market: "NYSE"   },
  { symbol: "PATH",  name: "UiPath",                     sector: "AI/Automation",      market: "NYSE"   },
  { symbol: "UPST",  name: "Upstart Holdings",           sector: "AI/Fintech",         market: "NASDAQ" },
  { symbol: "SMR",   name: "NuScale Power",              sector: "Nuclear/SMR",        market: "NYSE"   },
  { symbol: "OKLO",  name: "Oklo",                       sector: "Nuclear/SMR",        market: "NYSE"   },
  { symbol: "SYM",   name: "Symbotic",                   sector: "AI Robotics",        market: "NASDAQ" },
  { symbol: "ACHR",  name: "Archer Aviation",            sector: "eVTOL",              market: "NYSE"   },
  { symbol: "JOBY",  name: "Joby Aviation",              sector: "eVTOL",              market: "NYSE"   },
  { symbol: "WOLF",  name: "Wolfspeed",                  sector: "Semiconductors",     market: "NYSE"   },
];

const DEFAULT_TOP_N = 12;
const MAX_TOP_N     = 20;
const NEWS_BONUS    = 3; // score boost (in "%-move equivalent") for having recent headlines

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Splits an array into chunks of a given size
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Runs `fn` over `items` in batches of `batchSize`, waiting `delayMs`
// between batches. Used to stay under Finnhub's free-tier rate limit
// (60 calls/min, ~30/sec burst).
async function processBatches(items, batchSize, delayMs, fn) {
  const results = [];
  const batches = chunk(items, batchSize);
  for (let i = 0; i < batches.length; i++) {
    const batchResults = await Promise.all(batches[i].map(fn));
    results.push(...batchResults);
    if (i < batches.length - 1 && delayMs) await sleep(delayMs);
  }
  return results;
}

// Fetches JSON with retry on Finnhub 429 (rate limit) responses
async function fetchJSON(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 429) {
        await sleep(1200 * (attempt + 1));
        continue;
      }
      return await r.json();
    } catch {
      return null;
    }
  }
  return null;
}

async function getQuote(symbol, key) {
  const data = await fetchJSON(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${key}`);
  return data || {};
}

async function getNews(symbol, key) {
  const to   = new Date().toISOString().split("T")[0];
  const from = new Date(Date.now() - 7*86400000).toISOString().split("T")[0];
  const arr  = await fetchJSON(`https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${from}&to=${to}&token=${key}`);
  return Array.isArray(arr) ? arr.slice(0,3).map(a=>a.headline).join(" | ") : "";
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

  const single = req.query.symbol?.toUpperCase();
  const topN   = Math.min(MAX_TOP_N, Math.max(1, parseInt(req.query.top, 10) || DEFAULT_TOP_N));
  const valid  = ["STRONG_BUY","BUY","WATCH","NEUTRAL","AVOID"];

  const targets = single ? TICKERS.filter(t => t.symbol === single) : TICKERS;

  // ── Step 1: screening pass for the WHOLE watchlist — quote + news
  // for every ticker (2 Finnhub calls each). For 28 tickers that's 56
  // calls, batched to stay under the 60/min free-tier limit. This way
  // news is tracked for everything, not just the eventual top movers —
  // a stock with a fresh headline but a quiet price still gets flagged.
  const SCREEN_BATCH_SIZE  = 7;  // 7 tickers x 2 calls = 14 calls/batch
  const SCREEN_BATCH_DELAY = 1000; // ms

  const screened = await processBatches(targets, SCREEN_BATCH_SIZE, SCREEN_BATCH_DELAY, async (ticker) => {
    const [quote, news] = await Promise.all([
      getQuote(ticker.symbol, FINNHUB_KEY),
      getNews(ticker.symbol, FINNHUB_KEY)
    ]);
    return { ticker, quote, news, hasNews: !!news };
  });

  // ── Step 2: score = |% move| + bonus if there's fresh news.
  // This lets a quiet stock with breaking news still surface, not
  // only the biggest price movers.
  const scored = screened.map(item => ({
    ...item,
    score: Math.abs(item.quote.dp || 0) + (item.hasNews ? NEWS_BONUS : 0),
  }));

  let toAnalyze, rest;
  if (single) {
    toAnalyze = scored;
    rest = [];
  } else {
    const ranked = [...scored].sort((a, b) => b.score - a.score);
    toAnalyze = ranked.slice(0, topN);
    rest      = ranked.slice(topN);
  }

  // ── Step 3: AI analysis only for the selected tickers.
  // News was already fetched in step 1, so no extra Finnhub calls here.
  const CLAUDE_BATCH_SIZE = 6;

  const analyzed = await processBatches(toAnalyze, CLAUDE_BATCH_SIZE, 0, async ({ ticker, quote, news }) => {
    try {
      const analysis = await analyzeWithAI(ticker, quote, news, ANTHROPIC_KEY);
      return {
        ...ticker,
        price:         quote.c || null,
        changePercent: quote.dp || null,
        ok: true,
        analyzed: true,
        signal:       valid.includes(analysis.signal) ? analysis.signal : "WATCH",
        confidence:   typeof analysis.confidence === "number" ? Math.max(0, Math.min(100, analysis.confidence)) : 50,
        summary:      analysis.summary      || "—",
        catalysts:    Array.isArray(analysis.catalysts) ? analysis.catalysts : [],
        risks:        Array.isArray(analysis.risks)     ? analysis.risks     : [],
        newsHeadline: analysis.newsHeadline || "—",
        priceTarget:  analysis.priceTarget  || "—",
        timeframe:    analysis.timeframe    || "—",
      };
    } catch (e) {
      return {
        ...ticker,
        price:         quote.c || null,
        changePercent: quote.dp || null,
        ok: false, analyzed: true, error: e.message, signal: "NEUTRAL", confidence: 0,
        summary: e.message, catalysts: [], risks: [], newsHeadline: news || "—", priceTarget: "—", timeframe: "—"
      };
    }
  });

  // ── The rest: price + news already known, but no AI cost spent.
  // If they have fresh news, surface the headline anyway so it's
  // visible even without a full AI take.
  const skipped = rest.map(({ ticker, quote, news, hasNews }) => ({
    ...ticker,
    price:         quote.c || null,
    changePercent: quote.dp || null,
    ok: true,
    analyzed: false,
    hasNews,
    signal: "SCANNED",
    confidence: null,
    summary: hasNews
      ? "Recent nieuws gevonden, maar buiten de top movers — geen AI-analyse uitgevoerd."
      : "Geen opvallende beweging of nieuws — geen AI-analyse uitgevoerd.",
    catalysts: [], risks: [],
    newsHeadline: news || "—",
    priceTarget: "—", timeframe: "—",
  }));

  return res.status(200).json({
    results: [...analyzed, ...skipped],
    scannedAt: new Date().toISOString(),
    totalScanned: targets.length,
    analyzedCount: analyzed.length,
    topN,
  });
}
