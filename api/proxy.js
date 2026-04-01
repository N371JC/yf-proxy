/**
 * Yahoo Finance proxy — runs on Vercel Edge, bypasses Railway IP blocks.
 * Handles cookie+crumb auth flow transparently.
 *
 * Routes:
 *   GET /quote/:symbol         → single quote (price, change%, currency, etc.)
 *   GET /quotes?symbols=A,B,C  → batch quotes
 *   GET /chart/:symbol?range=  → historical OHLCV
 *   GET /fx?currencies=CAD,EUR → USD-based FX rates
 *   GET /ticker-info/:symbol   → longName, currency, exchange
 */

// In-memory crumb cache (persists for the lifetime of this serverless instance)
let cachedCrumb = null;
let cachedCookies = null;
let crumbFetchedAt = 0;
const CRUMB_TTL_MS = 60 * 60 * 1000; // 1 hour

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

async function refreshCrumb() {
  // Step 1: hit fc.yahoo.com to get a session cookie
  const r1 = await fetch("https://fc.yahoo.com/", {
    headers: YF_HEADERS,
    redirect: "follow",
  });
  const rawCookies = r1.headers.getSetCookie ? r1.headers.getSetCookie() : [];
  const cookieStr = rawCookies.map((c) => c.split(";")[0]).join("; ");

  // Step 2: get crumb using that cookie
  const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { ...YF_HEADERS, Cookie: cookieStr },
  });
  const crumb = await r2.text();
  if (!crumb || crumb.includes("<")) throw new Error("Failed to get crumb");

  cachedCrumb = crumb;
  cachedCookies = cookieStr;
  crumbFetchedAt = Date.now();
  return { crumb, cookieStr };
}

async function getCrumb() {
  if (cachedCrumb && Date.now() - crumbFetchedAt < CRUMB_TTL_MS) {
    return { crumb: cachedCrumb, cookieStr: cachedCookies };
  }
  return refreshCrumb();
}

async function yfFetch(path) {
  const { crumb, cookieStr } = await getCrumb();
  const sep = path.includes("?") ? "&" : "?";
  const url = `https://query1.finance.yahoo.com${path}${sep}crumb=${encodeURIComponent(crumb)}`;
  const r = await fetch(url, {
    headers: { ...YF_HEADERS, Cookie: cookieStr },
  });
  // If crumb expired (401/404), refresh once and retry
  if (r.status === 401 || r.status === 404) {
    const fresh = await refreshCrumb();
    const url2 = `https://query1.finance.yahoo.com${path}${sep}crumb=${encodeURIComponent(fresh.crumb)}`;
    const r2 = await fetch(url2, {
      headers: { ...YF_HEADERS, Cookie: fresh.cookieStr },
    });
    return r2;
  }
  return r;
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
}

export default async function handler(req, res) {
  const origin = req.headers["origin"] || "*";
  const headers = corsHeaders(origin);

  // OPTIONS preflight
  if (req.method === "OPTIONS") {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    return res.status(204).end();
  }

  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader("Content-Type", "application/json");

  // Parse route from URL
  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.pathname.replace(/^\/+/, ""); // strip leading slashes
  const parts = path.split("/");

  try {
    // GET /quote/:symbol
    if (parts[0] === "quote" && parts[1]) {
      const symbol = decodeURIComponent(parts[1]).toUpperCase();
      const r = await yfFetch(`/v8/finance/chart/${symbol}?interval=1d&range=1d`);
      const data = await r.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta) return res.status(404).json({ error: "Symbol not found" });
      const quotes = data?.chart?.result?.[0]?.indicators?.quote?.[0];
      const closes = quotes?.close?.filter((v) => v != null) ?? [];
      const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice;
      const price = meta.regularMarketPrice ?? (closes.length ? closes[closes.length - 1] : null);
      const change = price != null && prevClose != null ? price - prevClose : 0;
      const changePercent = prevClose ? (change / prevClose) * 100 : 0;
      return res.json({
        symbol,
        price,
        currency: meta.currency ?? "USD",
        changePercent,
        change,
        previousClose: prevClose ?? 0,
        open: meta.regularMarketOpen ?? 0,
        dayHigh: meta.regularMarketDayHigh ?? 0,
        dayLow: meta.regularMarketDayLow ?? 0,
        volume: meta.regularMarketVolume ?? 0,
        marketCap: meta.marketCap ?? 0,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? 0,
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? 0,
        longName: meta.longName ?? meta.shortName ?? symbol,
        exchange: meta.fullExchangeName ?? meta.exchangeName ?? "",
      });
    }

    // GET /quotes?symbols=A,B,C
    if (parts[0] === "quotes") {
      const symbolsParam = url.searchParams.get("symbols") ?? "";
      const symbols = symbolsParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (!symbols.length) return res.json([]);

      const results = await Promise.allSettled(
        symbols.map(async (symbol) => {
          const r = await yfFetch(`/v8/finance/chart/${symbol}?interval=1d&range=1d`);
          const data = await r.json();
          const meta = data?.chart?.result?.[0]?.meta;
          if (!meta) throw new Error(`No data for ${symbol}`);
          const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice;
          const price = meta.regularMarketPrice ?? 0;
          const change = price && prevClose ? price - prevClose : 0;
          const changePercent = prevClose ? (change / prevClose) * 100 : 0;
          return {
            symbol,
            price,
            currency: meta.currency ?? "USD",
            changePercent,
            change,
            previousClose: prevClose ?? 0,
            open: meta.regularMarketOpen ?? 0,
            dayHigh: meta.regularMarketDayHigh ?? 0,
            dayLow: meta.regularMarketDayLow ?? 0,
            volume: meta.regularMarketVolume ?? 0,
            marketCap: meta.marketCap ?? 0,
            fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? 0,
            fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? 0,
          };
        })
      );

      const quotes = results
        .filter((r) => r.status === "fulfilled")
        .map((r) => r.value);
      return res.json(quotes);
    }

    // GET /chart/:symbol?range=1m
    if (parts[0] === "chart" && parts[1]) {
      const symbol = decodeURIComponent(parts[1]).toUpperCase();
      const range = url.searchParams.get("range") ?? "1m";

      const now = new Date();
      let period1, interval;
      switch (range) {
        case "1d": period1 = new Date(now - 1 * 86400000); interval = "1m"; break;
        case "1w": period1 = new Date(now - 7 * 86400000); interval = "30m"; break;
        case "1m": period1 = new Date(now - 30 * 86400000); interval = "1d"; break;
        case "1y": period1 = new Date(now - 365 * 86400000); interval = "1d"; break;
        case "ytd": period1 = new Date(now.getFullYear(), 0, 1); interval = "1d"; break;
        case "all": period1 = new Date(now - 5 * 365 * 86400000); interval = "1wk"; break;
        default: period1 = new Date(now - 30 * 86400000); interval = "1d";
      }

      const tomorrow = new Date(now.getTime() + 86400000);
      const p1 = period1.toISOString().split("T")[0];
      const p2 = tomorrow.toISOString().split("T")[0];

      const r = await yfFetch(`/v8/finance/chart/${symbol}?interval=${interval}&period1=${p1}&period2=${p2}`);
      const data = await r.json();
      const result = data?.chart?.result?.[0];
      if (!result) return res.status(404).json({ error: "No chart data" });

      const rawQuotes = result.indicators?.quote?.[0] ?? {};
      const timestamps = [];
      const prices = [];

      (result.timestamp ?? []).forEach((ts, i) => {
        const close = rawQuotes.close?.[i];
        if (close == null) return;
        const d = new Date(ts * 1000);
        if (range === "1w") {
          const totalMin = d.getUTCHours() * 60 + d.getUTCMinutes();
          if (totalMin < 13 * 60 + 30) return; // skip pre-market
        }
        timestamps.push(d.getTime());
        prices.push(close);
      });

      return res.json({
        timestamps,
        prices,
        currency: result.meta?.currency ?? "USD",
      });
    }

    // GET /fx?currencies=CAD,EUR,GBP
    if (parts[0] === "fx") {
      const currenciesParam = url.searchParams.get("currencies") ?? "";
      const currencies = currenciesParam.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
      const result = {};

      await Promise.allSettled(
        currencies.map(async (cur) => {
          if (cur === "USD") { result[cur] = 1; return; }
          const symbol = `${cur}USD=X`;
          const r = await yfFetch(`/v8/finance/chart/${symbol}?interval=1d&range=1d`);
          const data = await r.json();
          const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
          if (price != null) result[cur] = price;
        })
      );

      return res.json(result);
    }

    // GET /fx-pair?from=CAD&to=USD
    if (parts[0] === "fx-pair") {
      const from = (url.searchParams.get("from") ?? "USD").toUpperCase();
      const to = (url.searchParams.get("to") ?? "USD").toUpperCase();
      if (from === to) return res.json({ rate: 1, from, to });
      const symbol = `${from}${to}=X`;
      const r = await yfFetch(`/v8/finance/chart/${symbol}?interval=1d&range=1d`);
      const data = await r.json();
      const rate = data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
      return res.json({ rate, from, to, symbol });
    }

    // GET /ticker-info/:symbol
    if (parts[0] === "ticker-info" && parts[1]) {
      const symbol = decodeURIComponent(parts[1]).toUpperCase();
      const r = await yfFetch(`/v8/finance/chart/${symbol}?interval=1d&range=1d`);
      const data = await r.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta) return res.status(404).json({ error: "Symbol not found" });
      return res.json({
        longName: meta.longName ?? meta.shortName ?? symbol,
        currency: meta.currency ?? "USD",
        exchange: meta.fullExchangeName ?? meta.exchangeName ?? "",
      });
    }

    return res.status(404).json({ error: "Unknown route" });
  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ error: err.message });
  }
}
